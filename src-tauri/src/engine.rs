// ═══════════════════════════════════════════════════════════════
// Parallelized Stockfish Worker Pool
//
// Spawns multiple native Stockfish child processes, distributes
// FEN positions across them, and reassembles results in order.
// ═══════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use sysinfo::System;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// ═══════════════════════════════════════════════════════════════
// Data Types (mirrors the TypeScript PositionEval / EngineLine)
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLine {
    pub score_cp: Option<i32>,
    pub score_mate: Option<i32>,
    pub pv: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionEval {
    pub score_cp: Option<i32>,
    pub score_mate: Option<i32>,
    pub top_lines: Vec<EngineLine>,
}

// ═══════════════════════════════════════════════════════════════
// System Resource Detection
// ═══════════════════════════════════════════════════════════════

pub struct SystemResources {
    pub logical_cores: usize,
    pub total_ram_mb: u64,
}

/// Detect the host machine's logical CPU cores and total RAM.
pub fn detect_system_resources() -> SystemResources {
    let sys = System::new_all();
    SystemResources {
        logical_cores: sys.cpus().len().max(1),
        total_ram_mb: sys.total_memory() / (1024 * 1024),
    }
}

// ═══════════════════════════════════════════════════════════════
// Worker Pool Configuration
// ═══════════════════════════════════════════════════════════════

#[derive(Clone, Copy, Debug)]
pub struct WorkerPoolConfig {
    pub num_workers: usize,
    pub threads_per_worker: usize,
    pub hash_mb_per_worker: usize,
}

/// Compute an optimal worker layout based on available hardware.
///
/// Uses half the available cores and ~10% of RAM to stay responsive.
/// Each Stockfish instance gets 2 threads (or 1 on constrained machines).
/// Hash is capped at 128 MB/worker.
pub fn calculate_worker_config(resources: &SystemResources) -> WorkerPoolConfig {
    let available_cores = (resources.logical_cores / 2).max(1);

    let threads_per_worker = if available_cores >= 4 { 2 } else { 1 };
    let num_workers = (available_cores / threads_per_worker).max(1);

    let available_ram_mb = (resources.total_ram_mb / 10) as usize;
    let hash_mb_per_worker = if num_workers > 0 {
        (available_ram_mb / num_workers).clamp(64, 128)
    } else {
        64
    };

    WorkerPoolConfig {
        num_workers,
        threads_per_worker,
        hash_mb_per_worker,
    }
}

// ═══════════════════════════════════════════════════════════════
// Stockfish Binary Discovery
// ═══════════════════════════════════════════════════════════════

/// Locate the native Stockfish binary.
///
/// Resolution order:
///   1. `STOCKFISH_PATH` environment variable
///   2. Common OS installation paths
///   3. Bare `"stockfish"` (relies on PATH)
pub fn find_stockfish_path() -> Result<String, String> {
    if let Ok(path) = std::env::var("STOCKFISH_PATH") {
        if std::path::Path::new(&path).exists() {
            return Ok(path);
        }
    }

    let candidates: &[&str] = if cfg!(windows) {
        &["stockfish.exe"]
    } else {
        &[
            "/usr/local/bin/stockfish",
            "/usr/bin/stockfish",
            "/opt/homebrew/bin/stockfish",
        ]
    };

    for &path in candidates {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    // Fall back to bare name — spawn will fail with a clear message
    // if it isn't on PATH.
    Ok("stockfish".to_string())
}

// ═══════════════════════════════════════════════════════════════
// Stockfish Worker — manages a single child process
// ═══════════════════════════════════════════════════════════════

struct StockfishWorker {
    child: tokio::process::Child,
    stdin: tokio::io::BufWriter<tokio::process::ChildStdin>,
    reader: BufReader<tokio::process::ChildStdout>,
}

impl Drop for StockfishWorker {
    fn drop(&mut self) {
        // Ensure the child process is killed if we're dropped without quit().
        let _ = self.child.start_kill();
    }
}

impl StockfishWorker {
    /// Spawn a new Stockfish child process with elevated priority and
    /// full UCI initialisation.
    async fn spawn(config: &WorkerPoolConfig, stockfish_path: &str) -> Result<Self, String> {
        let mut cmd = Command::new(stockfish_path);

        // ── OS-specific CPU priority elevation ──────────────────
        #[cfg(unix)]
        // SAFETY: The pre_exec closure only calls libc::nice which is
        // async-signal-safe.  No shared state is accessed.
        unsafe {
            cmd.pre_exec(|| {
                // Elevate scheduling priority (ignored if unprivileged).
                libc::nice(-5);
                Ok(())
            });
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const HIGH_PRIORITY_CLASS: u32 = 0x0000_0080;
            cmd.creation_flags(HIGH_PRIORITY_CLASS);
        }

        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn Stockfish at '{}': {}. \
                 Install Stockfish or set the STOCKFISH_PATH environment variable.",
                stockfish_path, e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to capture Stockfish stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture Stockfish stdout")?;

        let mut worker = Self {
            child,
            stdin: tokio::io::BufWriter::new(stdin),
            reader: BufReader::new(stdout),
        };

        // ── UCI handshake ───────────────────────────────────────
        worker.send("uci").await?;
        worker.wait_for("uciok").await?;

        // ── Engine options ──────────────────────────────────────
        worker
            .send(&format!(
                "setoption name Threads value {}",
                config.threads_per_worker
            ))
            .await?;
        worker
            .send(&format!(
                "setoption name Hash value {}",
                config.hash_mb_per_worker
            ))
            .await?;
        worker
            .send("setoption name Use NNUE value true")
            .await?;

        worker.send("isready").await?;
        worker.wait_for("readyok").await?;

        Ok(worker)
    }

    /// Write a UCI command to the engine's stdin.
    async fn send(&mut self, cmd: &str) -> Result<(), String> {
        self.stdin
            .write_all(format!("{}\n", cmd).as_bytes())
            .await
            .map_err(|e| format!("Stockfish stdin write error: {}", e))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Stockfish stdin flush error: {}", e))?;
        Ok(())
    }

    /// Block until the engine emits a line exactly equal to `target`.
    async fn wait_for(&mut self, target: &str) -> Result<(), String> {
        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("Stockfish read error: {}", e))?;
            if n == 0 {
                return Err("Stockfish process terminated unexpectedly".to_string());
            }
            if line.trim() == target {
                return Ok(());
            }
        }
    }

    /// Evaluate a single FEN position to the given depth with MultiPV lines.
    async fn evaluate_position(
        &mut self,
        fen: &str,
        depth: u32,
        multipv: u32,
    ) -> Result<PositionEval, String> {
        // Flush any stale state from a previous search
        self.send("stop").await?;
        self.send("isready").await?;
        self.wait_for("readyok").await?;

        // Configure and kick off the search
        self.send(&format!("setoption name MultiPV value {}", multipv))
            .await?;
        self.send(&format!("position fen {}", fen)).await?;
        self.send(&format!("go depth {}", depth)).await?;

        // Collect info lines, keyed by MultiPV index.
        // For each multipv slot we keep only the deepest info line.
        let mut lines: HashMap<u32, (u32, Option<i32>, Option<i32>, Vec<String>)> =
            HashMap::new();
        let mut buf = String::new();

        loop {
            buf.clear();
            let n = self
                .reader
                .read_line(&mut buf)
                .await
                .map_err(|e| format!("Stockfish read error: {}", e))?;
            if n == 0 {
                return Err("Stockfish process terminated during analysis".to_string());
            }

            let trimmed = buf.trim();

            if trimmed.starts_with("bestmove") {
                break;
            }

            // Parse "info depth …" lines, skipping currmove progress spam
            if trimmed.starts_with("info depth") && !trimmed.contains("currmove") {
                if let Some(d) = extract_u32(trimmed, " depth ") {
                    let mpv = extract_u32(trimmed, " multipv ").unwrap_or(1);
                    let score_cp = extract_i32(trimmed, " score cp ");
                    let score_mate = extract_i32(trimmed, " score mate ");
                    let pv = extract_pv(trimmed);

                    // Accept if we have a score (terminal positions may lack a PV)
                    if score_cp.is_some() || score_mate.is_some() || !pv.is_empty() {
                        let dominated =
                            lines.get(&mpv).map_or(true, |(existing_d, _, _, _)| d > *existing_d);
                        if dominated {
                            lines.insert(mpv, (d, score_cp, score_mate, pv));
                        }
                    }
                }
            }
        }

        // Assemble results sorted by multipv index
        let mut sorted: Vec<_> = lines.into_iter().collect();
        sorted.sort_by_key(|(k, _)| *k);

        let top_lines: Vec<EngineLine> = sorted
            .into_iter()
            .map(|(_, (_, cp, mate, pv))| EngineLine {
                score_cp: cp,
                score_mate: mate,
                pv,
            })
            .collect();

        let best = top_lines.first();
        Ok(PositionEval {
            score_cp: best.and_then(|l| l.score_cp),
            score_mate: best.and_then(|l| l.score_mate),
            top_lines,
        })
    }

    /// Evaluate a contiguous batch of indexed positions.
    async fn evaluate_batch(
        &mut self,
        chunk: &[(usize, String)],
        depth: u32,
        multipv: u32,
        completed: &Arc<AtomicUsize>,
    ) -> Result<Vec<(usize, PositionEval)>, String> {
        let mut results = Vec::with_capacity(chunk.len());
        for (idx, fen) in chunk {
            let eval = self.evaluate_position(fen, depth, multipv).await?;
            results.push((*idx, eval));
            completed.fetch_add(1, Ordering::Relaxed);
        }
        Ok(results)
    }

    /// Gracefully shut down the Stockfish process.
    async fn quit(mut self) {
        let _ = self.send("quit").await;
        let _ = self.child.wait().await;
    }
}

// ═══════════════════════════════════════════════════════════════
// UCI Output Parsing Helpers
// ═══════════════════════════════════════════════════════════════

/// Extract the whitespace-delimited token immediately following `token` in `line`.
pub(crate) fn extract_after<'a>(line: &'a str, token: &str) -> Option<&'a str> {
    let idx = line.find(token)?;
    let rest = &line[idx + token.len()..];
    rest.split_whitespace().next()
}

pub(crate) fn extract_u32(line: &str, token: &str) -> Option<u32> {
    extract_after(line, token)?.parse().ok()
}

pub(crate) fn extract_i32(line: &str, token: &str) -> Option<i32> {
    extract_after(line, token)?.parse().ok()
}

/// Extract all moves after " pv " to the end of the line.
pub(crate) fn extract_pv(line: &str) -> Vec<String> {
    match line.find(" pv ") {
        Some(idx) => line[idx + 4..]
            .split_whitespace()
            .map(String::from)
            .collect(),
        None => Vec::new(),
    }
}

// ═══════════════════════════════════════════════════════════════
// Work Distribution
// ═══════════════════════════════════════════════════════════════

/// Split `items` into `n` contiguous chunks.
///
/// Contiguous chunking keeps adjacent game positions together, which
/// benefits Stockfish's transposition-table hit rate between positions.
fn distribute_work<T>(items: Vec<T>, n: usize) -> Vec<Vec<T>> {
    if n == 0 || items.is_empty() {
        return vec![items];
    }
    let chunk_size = (items.len() + n - 1) / n;
    let mut chunks = Vec::with_capacity(n);
    let mut iter = items.into_iter().peekable();
    while iter.peek().is_some() {
        chunks.push(iter.by_ref().take(chunk_size).collect());
    }
    chunks
}

// ═══════════════════════════════════════════════════════════════
// Public API — Run the full engine pass
// ═══════════════════════════════════════════════════════════════

/// Evaluate every position in `positions` using a parallel pool of
/// native Stockfish processes.
///
/// The `completed` counter is atomically incremented after each position
/// finishes, enabling callers to track progress.
///
/// Returns `PositionEval`s in the same order as the input `positions`.
pub async fn run_engine_pass(
    positions: Vec<String>,
    depth: u32,
    multipv: u32,
    stockfish_path: &str,
    completed: Arc<AtomicUsize>,
) -> Result<Vec<PositionEval>, String> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }

    let resources = detect_system_resources();
    let config = calculate_worker_config(&resources);

    // Tag each position with its original index so results can be
    // reassembled in order after parallel evaluation.
    let indexed: Vec<(usize, String)> = positions.into_iter().enumerate().collect();
    let actual_workers = config.num_workers.min(indexed.len()).max(1);
    let chunks = distribute_work(indexed, actual_workers);

    // Spawn one async task per Stockfish worker
    let mut handles = Vec::with_capacity(actual_workers);

    for chunk in chunks {
        let sf_path = stockfish_path.to_string();
        let completed = completed.clone();

        let handle = tokio::spawn(async move {
            let mut worker = StockfishWorker::spawn(&config, &sf_path).await?;
            let results = worker.evaluate_batch(&chunk, depth, multipv, &completed).await;
            worker.quit().await;
            results
        });

        handles.push(handle);
    }

    // Await all workers and merge results
    let mut all_results: Vec<(usize, PositionEval)> = Vec::new();

    for handle in handles {
        let batch = handle
            .await
            .map_err(|e| format!("Worker task panicked: {}", e))?
            .map_err(|e: String| e)?;
        all_results.extend(batch);
    }

    // Restore original position ordering
    all_results.sort_by_key(|(idx, _)| *idx);
    Ok(all_results.into_iter().map(|(_, eval)| eval).collect())
}
