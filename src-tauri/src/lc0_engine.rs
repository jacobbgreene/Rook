// ═══════════════════════════════════════════════════════════════
// Lc0 Batch Evaluator — Pass 2: The Strategic Deep Dive
//
// Spawns a SINGLE persistent Lc0 child process and feeds turning-
// point FENs through it sequentially.  No worker pool — Lc0 is
// GPU-bound so a single process already saturates the device.
//
// UCI options are tuned for GPU throughput:
//   Threads 2        — two CPU threads to manage the MCTS tree
//   MinibatchSize 256 — large batches to keep the GPU busy
//   MaxPrefetch 32   — pipeline the next batches while GPU works
//   NNCacheSize 2000000 — cache NN evals across positions
//
// Each position uses `go nodes <N> movetime <T>`, where movetime
// acts as a safety ceiling so CPU-only backends don't hang for
// minutes.  The `bestmove` line is the authoritative signal that
// the search is done; we then issue `isready` / `readyok` as a
// sync barrier before the next FEN.
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
// Result Type
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lc0Eval {
    pub wdl: [u32; 3],
    pub score_cp: Option<i32>,
    pub top_move_san: String,
    pub pv_san: Vec<String>,
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
// WDL Parsing
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

// ═══════════════════════════════════════════════════════════════
// UCI I/O Helpers
// ═══════════════════════════════════════════════════════════════

async fn send(
    writer: &mut tokio::io::BufWriter<tokio::process::ChildStdin>,
    cmd: &str,
) -> Result<(), String> {
    writer
        .write_all(format!("{}\n", cmd).as_bytes())
        .await
        .map_err(|e| format!("Lc0 stdin write error: {}", e))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("Lc0 stdin flush error: {}", e))?;
    Ok(())
}

/// Read lines until we see `target`, with a timeout.
/// Returns Err if the process dies or the timeout expires.
async fn wait_for_with_timeout(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    target: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let deadline = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        wait_for_inner(reader, target),
    );
    match deadline.await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Lc0 timed out waiting for '{}' after {}s",
            target, timeout_secs,
        )),
    }
}

async fn wait_for_inner(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    target: &str,
) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Lc0 read error: {}", e))?;
        if n == 0 {
            return Err("Lc0 process terminated unexpectedly".to_string());
        }
        if line.trim() == target {
            return Ok(());
        }
    }
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
// Core: Sequential GPU Evaluation
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

    let total = positions.len();

    // ── Spawn single Lc0 process ────────────────────────────────
    // Weights are passed via UCI setoption, not CLI args, for
    // maximum compatibility across Lc0 versions.
    let mut cmd = Command::new(lc0_path);
    augment_gpu_env(&mut cmd);
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

    let mut writer = tokio::io::BufWriter::new(stdin_handle);
    let mut reader = BufReader::new(stdout_handle);

    // Drain stderr in background so the pipe doesn't block Lc0.
    // The watch channel lets us detect the backend before analysis starts.
    let (backend_tx, backend_rx) = watch::channel("unknown".to_string());
    let stderr_task = drain_stderr(stderr_handle, backend_tx);

    // ── UCI Handshake ───────────────────────────────────────────
    send(&mut writer, "uci").await?;
    wait_for_with_timeout(&mut reader, "uciok", 30).await
        .map_err(|e| format!("{}.  Is '{}' a valid Lc0 binary?", e, lc0_path))?;

    // ── Engine Options ──────────────────────────────────────────
    // WeightsFile — passed via UCI so it works regardless of
    // whether the binary supports --weights CLI arg.
    send(
        &mut writer,
        &format!("setoption name WeightsFile value {}", weights_path),
    )
    .await?;

    // GPU-saturating options:
    //   Threads 2        — CPU threads for MCTS tree management
    //   MinibatchSize 256 — large NN eval batches keep GPU full
    //   MaxPrefetch 32   — pipeline future batches while GPU works
    //   NNCacheSize 2000000 — ~2M entries, helps shared subtrees
    //
    // Unknown options are silently ignored per UCI protocol.
    send(&mut writer, "setoption name Threads value 2").await?;
    send(&mut writer, "setoption name MinibatchSize value 256").await?;
    send(&mut writer, "setoption name MaxPrefetch value 32").await?;
    send(&mut writer, "setoption name NNCacheSize value 2000000").await?;

    // Sync: wait for engine to absorb all options and load the net.
    // The weights load can take several seconds on first run.
    send(&mut writer, "isready").await?;
    wait_for_with_timeout(&mut reader, "readyok", 120).await
        .map_err(|e| {
            format!(
                "Lc0 failed to initialise ({}). Check that '{}' is a valid weights file.",
                e, weights_path
            )
        })?;

    // ── Warm-up search ──────────────────────────────────────────
    // Lc0 creates the GPU backend lazily during the FIRST search, not
    // during `isready`.  For OpenCL, this includes:
    //   1. Initialising the GPU device
    //   2. Running the SGEMM kernel tuner (578 configurations, ~4 min)
    //   3. Loading network weights onto the GPU
    // The tuner results are cached, so subsequent runs skip step 2.
    // We do a 1-node warm-up so this all happens before real analysis
    // (with a generous timeout), rather than during a real search where
    // the movetime ceiling would kill it prematurely.
    eprintln!("[lc0] Warm-up: forcing backend initialisation...");
    let _ = app.emit(
        "lc0-eval-progress",
        Lc0Progress { current: 0, total, backend: "initialising GPU...".to_string() },
    );
    send(&mut writer, "ucinewgame").await?;
    send(&mut writer, "position startpos").await?;
    send(&mut writer, "go nodes 1").await?;

    // Wait for bestmove with a very generous timeout — the first-ever
    // OpenCL run needs ~4 min for the SGEMM tuner (578 kernel configs).
    // Subsequent runs use cached tuner results and finish in seconds.
    {
        let warmup_deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(600);
        let mut warmup_buf = String::new();
        loop {
            warmup_buf.clear();
            let read = tokio::time::timeout_at(
                warmup_deadline,
                reader.read_line(&mut warmup_buf),
            ).await;
            match read {
                Err(_) => {
                    return Err("Lc0 warm-up timed out after 10 minutes. \
                        GPU backend initialisation may have failed — check GPU drivers."
                        .to_string());
                }
                Ok(Err(e)) => return Err(format!("Lc0 warm-up read error: {}", e)),
                Ok(Ok(0)) => return Err("Lc0 process died during warm-up".to_string()),
                Ok(Ok(_)) => {
                    if warmup_buf.trim().starts_with("bestmove") {
                        break;
                    }
                }
            }
        }
    }

    // Sync after warm-up
    send(&mut writer, "isready").await?;
    wait_for_with_timeout(&mut reader, "readyok", 30).await?;

    // Now the backend is live — read its name from the stderr drain
    let detected_backend = backend_rx.borrow().clone();
    eprintln!(
        "[lc0] Warm-up complete. Backend: {}, analysing {} positions at {} nodes each",
        detected_backend, total, nodes,
    );

    // If lc0 fell back to a CPU backend, log diagnostics so the user
    // can figure out what's missing.
    let cpu_backends = ["eigen", "trivial", "random"];
    if cpu_backends.iter().any(|b| detected_backend == *b) {
        eprintln!(
            "[lc0] WARNING: CPU-only backend '{}' detected. \
             GPU acceleration is NOT active.",
            detected_backend
        );
        eprintln!(
            "[lc0]   LD_LIBRARY_PATH = {:?}",
            std::env::var("LD_LIBRARY_PATH").unwrap_or_default()
        );
        // Check for common CUDA/OpenCL libraries
        let gpu_libs: &[(&str, &str)] = &[
            ("libcuda.so",    "NVIDIA driver (CUDA)"),
            ("libcudart.so",  "CUDA runtime toolkit"),
            ("libcudnn.so",   "cuDNN"),
            ("libOpenCL.so",  "OpenCL runtime"),
        ];
        for (lib, desc) in gpu_libs {
            let found = std::process::Command::new("ldconfig")
                .args(["-p"])
                .output()
                .ok()
                .and_then(|o| {
                    let out = String::from_utf8_lossy(&o.stdout).to_string();
                    if out.contains(lib) { Some(true) } else { None }
                })
                .is_some();
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

    // ── Sequential position evaluation ──────────────────────────
    let mut results = Vec::with_capacity(total);
    let mut buf = String::new();

    for (i, fen) in positions.iter().enumerate() {
        eprintln!("[lc0] Position {}/{}: {}", i + 1, total, &fen[..fen.len().min(60)]);
        // Set up the position
        send(&mut writer, &format!("position fen {}", fen)).await?;

        // Fixed-node search with a movetime ceiling as a safety net.
        // On GPU, 75k nodes finishes in <1s and movetime never fires.
        // On CPU-only backends (eigen), movetime prevents multi-minute
        // hangs — the engine stops at whichever limit is reached first.
        send(
            &mut writer,
            &format!("go nodes {} movetime {}", nodes, MOVETIME_CEILING_MS),
        )
        .await?;

        // Accumulate the deepest info line's data
        let mut best_wdl: Option<[u32; 3]> = None;
        let mut best_cp: Option<i32> = None;
        let mut best_pv: Vec<String> = Vec::new();

        // ── Read until bestmove (with per-position timeout) ─────
        let search_deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(60);

        loop {
            let read_result = tokio::time::timeout_at(
                search_deadline,
                reader.read_line(&mut buf),
            )
            .await;

            match read_result {
                Err(_) => {
                    // Hard timeout — Lc0 hasn't produced bestmove in 60s.
                    // Force-stop the search and drain to bestmove.
                    let _ = send(&mut writer, "stop").await;
                    // Give it 5s to respond with bestmove after stop
                    let drain_deadline = tokio::time::Instant::now()
                        + std::time::Duration::from_secs(5);
                    loop {
                        buf.clear();
                        let drain = tokio::time::timeout_at(
                            drain_deadline,
                            reader.read_line(&mut buf),
                        )
                        .await;
                        match drain {
                            Ok(Ok(0)) | Err(_) => break,
                            Ok(Ok(_)) => {
                                let trimmed = buf.trim();
                                // Still collect any final data
                                if trimmed.starts_with("info") && trimmed.contains(" pv ") {
                                    if let Some(wdl) = extract_wdl(trimmed) {
                                        best_wdl = Some(wdl);
                                    }
                                    if let Some(cp) = extract_i32(trimmed, " score cp ") {
                                        best_cp = Some(cp);
                                    }
                                    let pv = extract_pv(trimmed);
                                    if !pv.is_empty() {
                                        best_pv = pv;
                                    }
                                }
                                if trimmed.starts_with("bestmove") {
                                    break;
                                }
                            }
                            Ok(Err(_)) => break,
                        }
                    }
                    break;
                }
                Ok(Err(e)) => {
                    return Err(format!(
                        "Lc0 read error on position {}: {}",
                        i + 1, e
                    ));
                }
                Ok(Ok(0)) => {
                    // Process died — collect stderr for diagnostics
                    let stderr_lines = stderr_task.await.unwrap_or_default();
                    let hint = if stderr_lines.is_empty() {
                        String::new()
                    } else {
                        format!("\nLc0 stderr: {}", stderr_lines.join(" | "))
                    };
                    return Err(format!(
                        "Lc0 process terminated during analysis of position {}/{}{}",
                        i + 1, total, hint,
                    ));
                }
                Ok(Ok(_)) => {
                    let trimmed = buf.trim();

                    // bestmove is the definitive end-of-search signal
                    if trimmed.starts_with("bestmove") {
                        buf.clear();
                        break;
                    }

                    // Parse info lines that contain a principal variation
                    if trimmed.starts_with("info") && trimmed.contains(" pv ") {
                        if let Some(wdl) = extract_wdl(trimmed) {
                            best_wdl = Some(wdl);
                        }
                        if let Some(cp) = extract_i32(trimmed, " score cp ") {
                            best_cp = Some(cp);
                        }
                        let pv = extract_pv(trimmed);
                        if !pv.is_empty() {
                            best_pv = pv;
                        }
                    }

                    buf.clear();
                }
            }
        }

        // ── Sync barrier: ensure engine is quiescent ────────────
        send(&mut writer, "isready").await?;
        wait_for_with_timeout(&mut reader, "readyok", 30).await?;

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

    // ── Graceful shutdown ───────────────────────────────────────
    let _ = send(&mut writer, "quit").await;
    let _ = child.wait().await;
    let _ = stderr_task.await;

    Ok(results)
}
