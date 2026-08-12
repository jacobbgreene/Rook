// ═══════════════════════════════════════════════════════════════
// Lc0 Batch Evaluator & Policy Probe
//
// A single persistent Lc0 child process (Lc0Session) is shared by
// both passes:
//   - run_lc0_pass          — deep WDL evaluation of critical positions
//   - run_lc0_policy_probe  — policy-head priors ("what would a human
//                             be tempted to play?") for trap detection
//
// No worker pool — Lc0 is GPU-bound so a single process already
// saturates the device.
//
// UCI options are tuned for GPU throughput:
//   Threads 2        — two CPU threads to manage the MCTS tree
//   MinibatchSize 256 — large batches to keep the GPU busy
//   MaxPrefetch 32   — pipeline the next batches while GPU works
//   NNCacheSize 2000000 — cache NN evals across positions
// ═══════════════════════════════════════════════════════════════

use crate::engine::{extract_i32, extract_pv};
use crate::live_engine::uci_pv_to_san;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::watch;

/// Maximum wall-clock milliseconds per position.  Acts as a safety
/// net for CPU-only backends where 75k nodes could take minutes.
/// On GPU this is never hit — 75k nodes finish in <1s.
const MOVETIME_CEILING_MS: u32 = 15_000;

// ═══════════════════════════════════════════════════════════════
// Result Types
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lc0Eval {
    pub wdl: [u32; 3],
    pub score_cp: Option<i32>,
    pub top_move_san: String,
    pub pv_san: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lc0PolicyMove {
    pub uci: String,
    pub san: String,
    /// Policy-head probability in percent (0-100).
    pub policy: f64,
}

// ═══════════════════════════════════════════════════════════════
// Progress Event
// ═══════════════════════════════════════════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Lc0Progress {
    current: usize,
    total: usize,
    backend: String,
}

// ═══════════════════════════════════════════════════════════════
// WDL / Policy Parsing
// ═══════════════════════════════════════════════════════════════

/// Extract WDL triple from an Lc0 info line.
///
/// Lc0 emits `info ... wdl 523 300 177 ...` where the three integers
/// are win/draw/loss in permille (sum ≈ 1000).
fn extract_wdl(line: &str) -> Option<[u32; 3]> {
    let idx = line.find(" wdl ")?;
    let rest = &line[idx + 5..];
    let mut parts = rest.split_whitespace();
    let w: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    let l: u32 = parts.next()?.parse().ok()?;
    Some([w, d, l])
}

/// Parse a VerboseMoveStats per-move line:
///   `info string f1f2  (131 ) N:  1011 (+256) (P: 50.00%) (WL: ...) ...`
/// Returns (uci_move, policy_percent).  The root summary line
/// (`info string node ...`) is skipped.
fn parse_policy_move(line: &str) -> Option<(String, f64)> {
    let rest = line.strip_prefix("info string ")?;
    let mv = rest.split_whitespace().next()?;
    if mv == "node" {
        return None;
    }
    let p_start = line.find("(P:")? + 3;
    let p_end = line[p_start..].find('%')? + p_start;
    let pct: f64 = line[p_start..p_end].trim().parse().ok()?;
    Some((mv.to_string(), pct))
}

// ═══════════════════════════════════════════════════════════════
// Stderr drain — log Lc0 errors for diagnostics
// ═══════════════════════════════════════════════════════════════

/// Spawn a background task that drains Lc0's stderr so the pipe
/// doesn't fill up and block the process.  Collected lines are
/// returned when the task finishes (on process exit).
///
/// Also signals the detected backend name via `backend_tx` — the
/// first line matching `Creating backend [<name>]...` triggers it.
fn drain_stderr(
    stderr: tokio::process::ChildStderr,
    backend_tx: watch::Sender<String>,
) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut lines = Vec::new();
        let mut buf = String::new();
        let mut backend_sent = false;
        loop {
            buf.clear();
            match reader.read_line(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = buf.trim().to_string();
                    if !trimmed.is_empty() {
                        eprintln!("[lc0 stderr] {}", trimmed);

                        // Detect backend from "Creating backend [eigen]..."
                        if !backend_sent {
                            if let Some(start) = trimmed.find("Creating backend [") {
                                let rest = &trimmed[start + 18..];
                                if let Some(end) = rest.find(']') {
                                    let _ = backend_tx.send(rest[..end].to_string());
                                    backend_sent = true;
                                }
                            }
                        }

                        lines.push(trimmed);
                    }
                }
            }
        }
        lines
    })
}

// ═══════════════════════════════════════════════════════════════
// GPU Environment Augmentation
// ═══════════════════════════════════════════════════════════════

/// Augment a Command's environment so lc0 can discover GPU libraries.
///
/// GUI-launched processes often lack the `LD_LIBRARY_PATH` entries that
/// a user's shell profile provides (CUDA toolkit paths, cuDNN, OpenCL).
/// We add well-known locations that exist on disk so lc0's backend
/// auto-detection can find GPU libraries and avoid falling back to the
/// CPU-only `eigen` backend.
#[cfg(unix)]
fn augment_gpu_env(cmd: &mut Command) {
    // Start from the current LD_LIBRARY_PATH (may be empty in GUI context)
    let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let mut paths: Vec<String> = existing
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();

    // Derive paths from CUDA_HOME if set (e.g. /usr/local/cuda)
    if let Ok(cuda_home) = std::env::var("CUDA_HOME") {
        let lib64 = format!("{}/lib64", cuda_home);
        let cupti = format!("{}/extras/CUPTI/lib64", cuda_home);
        for p in [lib64, cupti] {
            if Path::new(&p).is_dir() && !paths.contains(&p) {
                paths.push(p);
            }
        }
    }

    // Well-known GPU library locations on Linux
    let candidates: &[&str] = &[
        "/usr/local/cuda/lib64",
        "/usr/local/cuda/extras/CUPTI/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/opt/cuda/lib64",
    ];

    for &p in candidates {
        let s = p.to_string();
        if Path::new(p).is_dir() && !paths.contains(&s) {
            paths.push(s);
        }
    }

    let joined = paths.join(":");
    eprintln!("[lc0] Augmented LD_LIBRARY_PATH: {}", joined);
    cmd.env("LD_LIBRARY_PATH", joined);

    // Ensure the CUDA JIT cache directory exists and is set.
    // Without this, PTX → native recompilation happens every launch.
    let cache_dir = std::env::var("HOME")
        .map(|h| Path::new(&h).join(".nv").join("ComputeCache"))
        .unwrap_or_else(|_| Path::new("/tmp/.nv/ComputeCache").to_path_buf());
    let _ = std::fs::create_dir_all(&cache_dir);
    cmd.env("CUDA_CACHE_PATH", &cache_dir);
    cmd.env("CUDA_CACHE_DISABLE", "0");
    cmd.env("CUDA_CACHE_MAXSIZE", "268435456"); // 256 MB
}

#[cfg(not(unix))]
fn augment_gpu_env(_cmd: &mut Command) {
    // Windows: CUDA installer adds to PATH; no extra help needed.
}

// ═══════════════════════════════════════════════════════════════
// Lc0Session — persistent process with handshake + warm-up
// ═══════════════════════════════════════════════════════════════

struct Lc0Session {
    child: tokio::process::Child,
    writer: tokio::io::BufWriter<tokio::process::ChildStdin>,
    reader: BufReader<tokio::process::ChildStdout>,
    stderr_task: tokio::task::JoinHandle<Vec<String>>,
    backend: String,
    buf: String,
}

impl Lc0Session {
    /// Spawn Lc0, negotiate UCI, load the weights, and run a 1-node
    /// warm-up search so the GPU backend (and its expensive OpenCL kernel
    /// tuning, on first-ever run) is fully initialised before real work.
    async fn spawn(lc0_path: &str, weights_path: &str) -> Result<Self, String> {
        let mut cmd = Command::new(lc0_path);
        augment_gpu_env(&mut cmd);
        // Error paths return early — never leave a GPU process behind.
        cmd.kill_on_drop(true);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn Lc0 at '{}': {}. Check your Lc0 installation.",
                lc0_path, e
            )
        })?;

        let stdin_handle = child
            .stdin
            .take()
            .ok_or("Failed to capture Lc0 stdin")?;
        let stdout_handle = child
            .stdout
            .take()
            .ok_or("Failed to capture Lc0 stdout")?;
        let stderr_handle = child
            .stderr
            .take()
            .ok_or("Failed to capture Lc0 stderr")?;

        let writer = tokio::io::BufWriter::new(stdin_handle);
        let reader = BufReader::new(stdout_handle);

        // Drain stderr in background so the pipe doesn't block Lc0.
        // The watch channel lets us detect the backend before analysis starts.
        let (backend_tx, backend_rx) = watch::channel("unknown".to_string());
        let stderr_task = drain_stderr(stderr_handle, backend_tx);

        let mut session = Self {
            child,
            writer,
            reader,
            stderr_task,
            backend: String::new(),
            buf: String::new(),
        };

        // ── UCI Handshake ─────────────────────────────────────────
        session.send("uci").await?;
        session
            .wait_for_with_timeout("uciok", 30)
            .await
            .map_err(|e| format!("{}.  Is '{}' a valid Lc0 binary?", e, lc0_path))?;

        // ── Engine Options ────────────────────────────────────────
        // WeightsFile — passed via UCI so it works regardless of
        // whether the binary supports --weights CLI arg.
        session
            .send(&format!("setoption name WeightsFile value {}", weights_path))
            .await?;

        // GPU-saturating options (unknown options are ignored per UCI):
        //   Threads 2        — CPU threads for MCTS tree management
        //   MinibatchSize 256 — large NN eval batches keep GPU full
        //   MaxPrefetch 32   — pipeline future batches while GPU works
        //   NNCacheSize 2000000 — ~2M entries, helps shared subtrees
        session.send("setoption name Threads value 2").await?;
        session.send("setoption name MinibatchSize value 256").await?;
        session.send("setoption name MaxPrefetch value 32").await?;
        session
            .send("setoption name NNCacheSize value 2000000")
            .await?;

        // Sync: wait for engine to absorb all options and load the net.
        // The weights load can take several seconds on first run.
        session.send("isready").await?;
        session
            .wait_for_with_timeout("readyok", 120)
            .await
            .map_err(|e| {
                format!(
                    "Lc0 failed to initialise ({}). Check that '{}' is a valid weights file.",
                    e, weights_path
                )
            })?;

        // ── Warm-up search ────────────────────────────────────────
        // Lc0 creates the GPU backend lazily during the FIRST search, not
        // during `isready`.  For OpenCL, this includes:
        //   1. Initialising the GPU device
        //   2. Running the SGEMM kernel tuner (578 configurations, ~4 min)
        //   3. Loading network weights onto the GPU
        // The tuner results are cached, so subsequent runs skip step 2.
        eprintln!("[lc0] Warm-up: forcing backend initialisation...");
        session.send("ucinewgame").await?;
        session.send("position startpos").await?;
        session.send("go nodes 1").await?;

        // Wait for bestmove with a very generous timeout — the first-ever
        // OpenCL run needs ~4 min for the SGEMM tuner (578 kernel configs).
        {
            let warmup_deadline =
                tokio::time::Instant::now() + std::time::Duration::from_secs(600);
            loop {
                session.buf.clear();
                let read = tokio::time::timeout_at(
                    warmup_deadline,
                    session.reader.read_line(&mut session.buf),
                )
                .await;
                match read {
                    Err(_) => {
                        return Err("Lc0 warm-up timed out after 10 minutes. \
                            GPU backend initialisation may have failed — check GPU drivers."
                            .to_string());
                    }
                    Ok(Err(e)) => return Err(format!("Lc0 warm-up read error: {}", e)),
                    Ok(Ok(0)) => return Err("Lc0 process died during warm-up".to_string()),
                    Ok(Ok(_)) => {
                        if session.buf.trim().starts_with("bestmove") {
                            break;
                        }
                    }
                }
            }
        }

        // Sync after warm-up
        session.sync(30).await?;

        session.backend = backend_rx.borrow().clone();
        eprintln!("[lc0] Warm-up complete. Backend: {}", session.backend);

        // If lc0 fell back to a CPU backend, log diagnostics so the user
        // can figure out what's missing.
        let cpu_backends = ["eigen", "trivial", "random"];
        if cpu_backends.iter().any(|b| session.backend == *b) {
            eprintln!(
                "[lc0] WARNING: CPU-only backend '{}' detected. \
                 GPU acceleration is NOT active.",
                session.backend
            );
            eprintln!(
                "[lc0]   LD_LIBRARY_PATH = {:?}",
                std::env::var("LD_LIBRARY_PATH").unwrap_or_default()
            );
            let gpu_libs: &[(&str, &str)] = &[
                ("libcuda.so", "NVIDIA driver (CUDA)"),
                ("libcudart.so", "CUDA runtime toolkit"),
                ("libcudnn.so", "cuDNN"),
                ("libOpenCL.so", "OpenCL runtime"),
            ];
            for (lib, desc) in gpu_libs {
                let found = std::process::Command::new("ldconfig")
                    .args(["-p"])
                    .output()
                    .ok()
                    .map(|o| String::from_utf8_lossy(&o.stdout).contains(lib))
                    .unwrap_or(false);
                eprintln!(
                    "[lc0]   {} ({}): {}",
                    lib,
                    desc,
                    if found { "FOUND" } else { "NOT FOUND" }
                );
            }
            eprintln!(
                "[lc0]   Ensure your lc0 binary was compiled with GPU support \
                 and that the matching runtime libraries are installed."
            );
        }

        Ok(session)
    }

    async fn send(&mut self, cmd: &str) -> Result<(), String> {
        self.writer
            .write_all(format!("{}\n", cmd).as_bytes())
            .await
            .map_err(|e| format!("Lc0 stdin write error: {}", e))?;
        self.writer
            .flush()
            .await
            .map_err(|e| format!("Lc0 stdin flush error: {}", e))?;
        Ok(())
    }

    /// Read lines until we see `target`, with a timeout.
    async fn wait_for_with_timeout(
        &mut self,
        target: &str,
        timeout_secs: u64,
    ) -> Result<(), String> {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(timeout_secs);
        let mut line = String::new();
        loop {
            line.clear();
            let read =
                tokio::time::timeout_at(deadline, self.reader.read_line(&mut line)).await;
            match read {
                Err(_) => {
                    return Err(format!(
                        "Lc0 timed out waiting for '{}' after {}s",
                        target, timeout_secs
                    ))
                }
                Ok(Err(e)) => return Err(format!("Lc0 read error: {}", e)),
                Ok(Ok(0)) => return Err("Lc0 process terminated unexpectedly".to_string()),
                Ok(Ok(_)) => {
                    if line.trim() == target {
                        return Ok(());
                    }
                }
            }
        }
    }

    /// isready/readyok barrier — guarantees the engine is quiescent.
    async fn sync(&mut self, timeout_secs: u64) -> Result<(), String> {
        self.send("isready").await?;
        self.wait_for_with_timeout("readyok", timeout_secs).await
    }

    /// Run a search on `fen` and return all trimmed output lines up to
    /// `bestmove`.  On hard timeout the search is force-stopped and
    /// drained; the session stays usable for the next position.
    async fn search(
        &mut self,
        fen: &str,
        go_cmd: &str,
        timeout_secs: u64,
    ) -> Result<Vec<String>, String> {
        self.send(&format!("position fen {}", fen)).await?;
        self.send(go_cmd).await?;

        let mut lines = Vec::new();
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

        loop {
            let read = tokio::time::timeout_at(deadline, self.reader.read_line(&mut self.buf)).await;
            match read {
                Err(_) => {
                    // Hard timeout — force-stop and drain to bestmove.
                    let _ = self.send("stop").await;
                    let drain_deadline = tokio::time::Instant::now()
                        + std::time::Duration::from_secs(5);
                    loop {
                        // No buf.clear() before the read: a timed-out read
                        // leaves partial bytes that complete the same line.
                        let drain = tokio::time::timeout_at(
                            drain_deadline,
                            self.reader.read_line(&mut self.buf),
                        )
                        .await;
                        match drain {
                            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
                            Ok(Ok(_)) => {
                                let trimmed = self.buf.trim().to_string();
                                self.buf.clear();
                                let done = trimmed.starts_with("bestmove");
                                lines.push(trimmed);
                                if done {
                                    break;
                                }
                            }
                        }
                    }
                    // Discard any partial line left by a cancelled read.
                    self.buf.clear();
                    break;
                }
                Ok(Err(e)) => return Err(format!("Lc0 read error: {}", e)),
                Ok(Ok(0)) => {
                    // Process died — collect stderr for diagnostics
                    let stderr_lines = (&mut self.stderr_task).await.unwrap_or_default();
                    let hint = if stderr_lines.is_empty() {
                        String::new()
                    } else {
                        format!("\nLc0 stderr: {}", stderr_lines.join(" | "))
                    };
                    return Err(format!("Lc0 process terminated during analysis{}", hint));
                }
                Ok(Ok(_)) => {
                    let trimmed = self.buf.trim().to_string();
                    self.buf.clear();
                    let done = trimmed.starts_with("bestmove");
                    lines.push(trimmed);
                    if done {
                        break;
                    }
                }
            }
        }

        Ok(lines)
    }

    async fn quit(mut self) {
        let _ = self.send("quit").await;
        let _ = self.child.wait().await;
        let _ = (&mut self.stderr_task).await;
    }
}

// ═══════════════════════════════════════════════════════════════
// Pass 2: The Strategic Deep Dive (WDL evaluation)
// ═══════════════════════════════════════════════════════════════

/// Evaluate turning-point FENs with a single persistent Lc0 process.
///
/// Positions are fed sequentially — one `go nodes <N>` per FEN —
/// to avoid GPU VRAM contention.  The `bestmove` response marks
/// the end of each search, followed by an `isready`/`readyok`
/// barrier to guarantee the engine is quiescent before the next
/// position.
pub async fn run_lc0_pass(
    positions: Vec<String>,
    nodes: u32,
    lc0_path: &str,
    weights_path: &str,
    app: AppHandle,
) -> Result<Vec<Lc0Eval>, String> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }

    // Validate all FENs up front — fail fast instead of confusing Lc0.
    for (i, fen) in positions.iter().enumerate() {
        crate::live_engine::validate_fen(fen)
            .map_err(|e| format!("Invalid position #{}: {}", i + 1, e))?;
    }

    let total = positions.len();

    let _ = app.emit(
        "lc0-eval-progress",
        Lc0Progress { current: 0, total, backend: "initialising GPU...".to_string() },
    );

    let mut session = Lc0Session::spawn(lc0_path, weights_path).await?;
    let detected_backend = session.backend.clone();
    eprintln!(
        "[lc0] Analysing {} positions at {} nodes each",
        total, nodes,
    );

    // ── Sequential position evaluation ──────────────────────────
    let mut results = Vec::with_capacity(total);

    for (i, fen) in positions.iter().enumerate() {
        eprintln!("[lc0] Position {}/{}: {}", i + 1, total, &fen[..fen.len().min(60)]);

        // Fixed-node search with a movetime ceiling as a safety net.
        // On GPU, 75k nodes finishes in <1s and movetime never fires.
        // On CPU-only backends (eigen), movetime prevents multi-minute
        // hangs — the engine stops at whichever limit is reached first.
        let lines = session
            .search(
                fen,
                &format!("go nodes {} movetime {}", nodes, MOVETIME_CEILING_MS),
                60,
            )
            .await
            .map_err(|e| format!("{} (position {}/{})", e, i + 1, total))?;

        // Accumulate the deepest info line's data
        let mut best_wdl: Option<[u32; 3]> = None;
        let mut best_cp: Option<i32> = None;
        let mut best_pv: Vec<String> = Vec::new();

        for line in &lines {
            if line.starts_with("info") && line.contains(" pv ") {
                if let Some(wdl) = extract_wdl(line) {
                    best_wdl = Some(wdl);
                }
                if let Some(cp) = extract_i32(line, " score cp ") {
                    best_cp = Some(cp);
                }
                let pv = extract_pv(line);
                if !pv.is_empty() {
                    best_pv = pv;
                }
            }
        }

        // ── Sync barrier: ensure engine is quiescent ────────────
        session.sync(30).await?;

        // ── Convert UCI PV → SAN ────────────────────────────────
        let (san_moves, _valid_uci) = uci_pv_to_san(fen, &best_pv);
        let top_move_san = san_moves.first().cloned().unwrap_or_default();

        results.push(Lc0Eval {
            wdl: best_wdl.unwrap_or([333, 334, 333]),
            score_cp: best_cp,
            top_move_san,
            pv_san: san_moves,
        });

        // ── Emit progress ───────────────────────────────────────
        let _ = app.emit(
            "lc0-eval-progress",
            Lc0Progress {
                current: i + 1,
                total,
                backend: detected_backend.clone(),
            },
        );
    }

    session.quit().await;

    Ok(results)
}

// ═══════════════════════════════════════════════════════════════
// Policy Probe — what would a human be tempted to play?
// ═══════════════════════════════════════════════════════════════

/// For each position, return the top-N moves by Lc0's policy prior.
///
/// The policy head is trained on human games, so its probabilities model
/// *human-like* move choice — exactly what we need to find the "tempting
/// reply" an opponent might grab when walking into a trap.
///
/// Uses `VerboseMoveStats`, which prints per-root-move statistics
/// (`info string <move> ... (P: 12.34%) ...`) when the search ends.
pub async fn run_lc0_policy_probe(
    positions: Vec<String>,
    nodes: u32,
    lc0_path: &str,
    weights_path: &str,
    app: AppHandle,
    top_n: usize,
) -> Result<Vec<Vec<Lc0PolicyMove>>, String> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }

    for (i, fen) in positions.iter().enumerate() {
        crate::live_engine::validate_fen(fen)
            .map_err(|e| format!("Invalid position #{}: {}", i + 1, e))?;
    }

    let total = positions.len();

    let _ = app.emit(
        "lc0-eval-progress",
        Lc0Progress { current: 0, total, backend: "initialising GPU...".to_string() },
    );

    let mut session = Lc0Session::spawn(lc0_path, weights_path).await?;
    let detected_backend = session.backend.clone();

    // Ask for per-move policy statistics at the end of each search.
    session
        .send("setoption name VerboseMoveStats value true")
        .await?;
    session.sync(30).await?;

    let mut results: Vec<Vec<Lc0PolicyMove>> = Vec::with_capacity(total);

    for (i, fen) in positions.iter().enumerate() {
        let lines = session
            .search(fen, &format!("go nodes {}", nodes), 60)
            .await
            .map_err(|e| format!("{} (policy probe {}/{})", e, i + 1, total))?;

        // Keep the latest policy value per move (stats are emitted once
        // at the end of the search, but be tolerant of repeats).
        let mut policy_map: std::collections::HashMap<String, f64> =
            std::collections::HashMap::new();
        for line in &lines {
            if let Some((mv, pct)) = parse_policy_move(line) {
                policy_map.insert(mv, pct);
            }
        }

        let mut ranked: Vec<(String, f64)> = policy_map.into_iter().collect();
        ranked
            .sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked.truncate(top_n);

        let ucis: Vec<String> = ranked.iter().map(|(u, _)| u.clone()).collect();
        let (sans, valid_ucis) = uci_pv_to_san(fen, &ucis);

        let moves: Vec<Lc0PolicyMove> = valid_ucis
            .iter()
            .zip(sans.iter())
            .filter_map(|(uci, san)| {
                ranked
                    .iter()
                    .find(|(u, _)| u == uci)
                    .map(|(_, pct)| Lc0PolicyMove {
                        uci: uci.clone(),
                        san: san.clone(),
                        policy: *pct,
                    })
            })
            .collect();

        results.push(moves);

        session.sync(30).await?;

        let _ = app.emit(
            "lc0-eval-progress",
            Lc0Progress {
                current: i + 1,
                total,
                backend: detected_backend.clone(),
            },
        );
    }

    session.quit().await;

    Ok(results)
}
