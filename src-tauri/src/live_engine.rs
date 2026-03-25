// ═══════════════════════════════════════════════════════════════
// Persistent Live Engine — Stop & Go Architecture
//
// Maintains a single long-lived Stockfish child process, accepts
// FEN positions via a channel, and streams parsed engine lines
// as Tauri events.  Two-phase analysis: MultiPV 3 → MultiPV 5
// once depth 8 is reached.
// ═══════════════════════════════════════════════════════════════

use crate::engine::{detect_system_resources, extract_i32, extract_pv, extract_u32};
use serde::Serialize;
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::uci::UciMove;
use shakmaty::{CastlingMode, Chess, Position};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

// ═══════════════════════════════════════════════════════════════
// Event Payloads
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLineEvent {
    pub depth: u32,
    pub multipv: u32,
    pub score_cp: Option<i32>,
    pub score_mate: Option<i32>,
    pub pv_uci: Vec<String>,
    pub pv_san: Vec<String>,
    pub fen: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusEvent {
    pub status: String,
    pub fen: String,
}

// ═══════════════════════════════════════════════════════════════
// Channel Commands
// ═══════════════════════════════════════════════════════════════

pub enum EngineCommand {
    SetFen(String),
    NewGame,
    Stop,
    Shutdown,
}

// ═══════════════════════════════════════════════════════════════
// Public Handle
// ═══════════════════════════════════════════════════════════════

pub struct LiveEngineHandle {
    tx: mpsc::Sender<EngineCommand>,
}

impl LiveEngineHandle {
    pub async fn set_fen(&self, fen: String) -> Result<(), String> {
        self.tx
            .send(EngineCommand::SetFen(fen))
            .await
            .map_err(|_| "Live engine task has stopped".to_string())
    }

    pub async fn new_game(&self) -> Result<(), String> {
        self.tx
            .send(EngineCommand::NewGame)
            .await
            .map_err(|_| "Live engine task has stopped".to_string())
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.tx
            .send(EngineCommand::Stop)
            .await
            .map_err(|_| "Live engine task has stopped".to_string())
    }

    pub fn shutdown(&self) {
        let _ = self.tx.try_send(EngineCommand::Shutdown);
    }
}

// ═══════════════════════════════════════════════════════════════
// FEN Validation
// ═══════════════════════════════════════════════════════════════

fn validate_fen(fen: &str) -> Result<(), String> {
    let parsed: Fen = fen
        .parse()
        .map_err(|e: shakmaty::fen::ParseFenError| format!("Invalid FEN: {}", e))?;
    let _pos: Chess = parsed
        .into_position(CastlingMode::Standard)
        .map_err(|e| format!("Illegal position: {:?}", e))?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// Resource Configuration
// ═══════════════════════════════════════════════════════════════

fn live_engine_config() -> (usize, usize) {
    let res = detect_system_resources();
    let threads = if res.logical_cores > 8 {
        res.logical_cores.saturating_sub(2).max(1)
    } else {
        res.logical_cores.saturating_sub(1).max(1)
    };
    let hash_mb = ((res.total_ram_mb as usize * 5) / 100).clamp(64, 1024);
    (hash_mb, threads)
}

// ═══════════════════════════════════════════════════════════════
// UCI → SAN Conversion
// ═══════════════════════════════════════════════════════════════

fn uci_pv_to_san(fen: &str, uci_moves: &[String]) -> (Vec<String>, Vec<String>) {
    let Ok(fen_parsed) = fen.parse::<Fen>() else {
        return (vec![], uci_moves.to_vec());
    };
    let Ok(mut pos) = fen_parsed.into_position::<Chess>(CastlingMode::Standard) else {
        return (vec![], uci_moves.to_vec());
    };

    let mut san_moves = Vec::new();
    let mut valid_uci = Vec::new();

    for uci_str in uci_moves {
        let Ok(uci) = uci_str.parse::<UciMove>() else {
            break;
        };
        let Ok(m) = uci.to_move(&pos) else {
            break;
        };
        let san = San::from_move(&pos, &m);
        pos.play_unchecked(&m);
        let suffix = if pos.is_checkmate() {
            "#"
        } else if pos.checkers().any() {
            "+"
        } else {
            ""
        };
        san_moves.push(format!("{}{}", san, suffix));
        valid_uci.push(uci_str.clone());
    }

    (san_moves, valid_uci)
}

// ═══════════════════════════════════════════════════════════════
// Spawn
// ═══════════════════════════════════════════════════════════════

pub fn spawn_live_engine(app: AppHandle, stockfish_path: String) -> LiveEngineHandle {
    let (tx, rx) = mpsc::channel(32);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = live_engine_task(app.clone(), rx, &stockfish_path).await {
            eprintln!("Live engine task failed: {}", e);
            let _ = app.emit(
                "engine-status",
                EngineStatusEvent {
                    status: "error".to_string(),
                    fen: String::new(),
                },
            );
        }
    });
    LiveEngineHandle { tx }
}

// ═══════════════════════════════════════════════════════════════
// State Machine
// ═══════════════════════════════════════════════════════════════

enum State {
    Idle,
    Searching,
    Draining,
}

enum PendingAction {
    SetFen(String),
    Widen,
    NewGame,
    GoIdle,
}

// ═══════════════════════════════════════════════════════════════
// Background Task
// ═══════════════════════════════════════════════════════════════

async fn live_engine_task(
    app: AppHandle,
    mut rx: mpsc::Receiver<EngineCommand>,
    stockfish_path: &str,
) -> Result<(), String> {
    let (hash_mb, threads) = live_engine_config();

    // ── Spawn Stockfish ───────────────────────────────────────
    let mut cmd = Command::new(stockfish_path);

    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
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

    let stdin_handle = child
        .stdin
        .take()
        .ok_or("Failed to capture Stockfish stdin")?;
    let stdout_handle = child
        .stdout
        .take()
        .ok_or("Failed to capture Stockfish stdout")?;

    let mut writer = tokio::io::BufWriter::new(stdin_handle);
    let mut reader = BufReader::new(stdout_handle);

    // ── UCI Handshake ─────────────────────────────────────────
    send(&mut writer, "uci").await?;
    wait_for(&mut reader, "uciok").await?;

    send(
        &mut writer,
        &format!("setoption name Threads value {}", threads),
    )
    .await?;
    send(
        &mut writer,
        &format!("setoption name Hash value {}", hash_mb),
    )
    .await?;
    send(&mut writer, "setoption name Use NNUE value true").await?;

    send(&mut writer, "isready").await?;
    wait_for(&mut reader, "readyok").await?;

    let _ = app.emit(
        "engine-status",
        EngineStatusEvent {
            status: "ready".to_string(),
            fen: String::new(),
        },
    );

    // ── Main Loop ─────────────────────────────────────────────
    let mut state = State::Idle;
    let mut pending: Option<PendingAction> = None;
    let mut current_fen = String::new();
    let mut widened = false;
    let mut buf = String::new();

    loop {
        match state {
            // ── Idle: only wait for commands ───────────────────
            State::Idle => match rx.recv().await {
                Some(EngineCommand::SetFen(fen)) => {
                    if validate_fen(&fen).is_err() {
                        continue;
                    }
                    send(
                        &mut writer,
                        "setoption name MultiPV value 3",
                    )
                    .await?;
                    send(&mut writer, &format!("position fen {}", fen)).await?;
                    send(&mut writer, "go infinite").await?;
                    current_fen = fen.clone();
                    widened = false;
                    state = State::Searching;
                    let _ = app.emit(
                        "engine-status",
                        EngineStatusEvent {
                            status: "searching".to_string(),
                            fen,
                        },
                    );
                }
                Some(EngineCommand::NewGame) => {
                    send(&mut writer, "ucinewgame").await?;
                    send(&mut writer, "isready").await?;
                    wait_for(&mut reader, "readyok").await?;
                }
                Some(EngineCommand::Stop) => {}
                Some(EngineCommand::Shutdown) | None => break,
            },

            // ── Searching: read stdout + receive commands ─────
            State::Searching => {
                buf.clear();
                tokio::select! {
                    result = reader.read_line(&mut buf) => {
                        let n = result.map_err(|e| format!("Stockfish read error: {}", e))?;
                        if n == 0 {
                            return Err("Stockfish process terminated unexpectedly".to_string());
                        }
                        let line = buf.trim();

                        if line.starts_with("bestmove") {
                            state = State::Idle;
                            let _ = app.emit("engine-status", EngineStatusEvent {
                                status: "stopped".to_string(),
                                fen: current_fen.clone(),
                            });
                        } else if line.starts_with("info depth") && !line.contains("currmove") {
                            if let Some(depth) = extract_u32(line, " depth ") {
                                let multipv = extract_u32(line, " multipv ").unwrap_or(1);
                                let score_cp = extract_i32(line, " score cp ");
                                let score_mate = extract_i32(line, " score mate ");
                                let pv_uci_all = extract_pv(line);

                                if score_cp.is_some() || score_mate.is_some() {
                                    let pv_uci: Vec<String> =
                                        pv_uci_all.into_iter().take(8).collect();
                                    let (pv_san, pv_uci_valid) =
                                        uci_pv_to_san(&current_fen, &pv_uci);

                                    let _ = app.emit("engine-line", EngineLineEvent {
                                        depth,
                                        multipv,
                                        score_cp,
                                        score_mate,
                                        pv_uci: pv_uci_valid,
                                        pv_san,
                                        fen: current_fen.clone(),
                                    });

                                    // Phase 2: widen to 5 lines once depth 8 reached
                                    if !widened && multipv == 1 && depth >= 8 {
                                        send(&mut writer, "stop").await?;
                                        pending = Some(PendingAction::Widen);
                                        state = State::Draining;
                                    }
                                }
                            }
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(EngineCommand::SetFen(fen)) => {
                                send(&mut writer, "stop").await?;
                                pending = Some(PendingAction::SetFen(fen));
                                state = State::Draining;
                            }
                            Some(EngineCommand::NewGame) => {
                                send(&mut writer, "stop").await?;
                                pending = Some(PendingAction::NewGame);
                                state = State::Draining;
                            }
                            Some(EngineCommand::Stop) => {
                                send(&mut writer, "stop").await?;
                                pending = Some(PendingAction::GoIdle);
                                state = State::Draining;
                            }
                            Some(EngineCommand::Shutdown) | None => {
                                let _ = send(&mut writer, "quit").await;
                                let _ = child.wait().await;
                                return Ok(());
                            }
                        }
                    }
                }
            }

            // ── Draining: wait for bestmove, then act ─────────
            State::Draining => {
                buf.clear();
                tokio::select! {
                    result = reader.read_line(&mut buf) => {
                        let n = result.map_err(|e| format!("Stockfish read error: {}", e))?;
                        if n == 0 {
                            return Err("Stockfish process terminated unexpectedly".to_string());
                        }
                        let line = buf.trim();

                        if line.starts_with("bestmove") {
                            match pending.take() {
                                Some(PendingAction::SetFen(fen)) => {
                                    if validate_fen(&fen).is_ok() {
                                        send(&mut writer, "setoption name MultiPV value 3").await?;
                                        send(&mut writer, &format!("position fen {}", fen)).await?;
                                        send(&mut writer, "go infinite").await?;
                                        current_fen = fen.clone();
                                        widened = false;
                                        state = State::Searching;
                                        let _ = app.emit("engine-status", EngineStatusEvent {
                                            status: "searching".to_string(),
                                            fen,
                                        });
                                    } else {
                                        state = State::Idle;
                                    }
                                }
                                Some(PendingAction::Widen) => {
                                    let _ = app.emit("engine-status", EngineStatusEvent {
                                        status: "phase2".to_string(),
                                        fen: current_fen.clone(),
                                    });
                                    send(&mut writer, "setoption name MultiPV value 5").await?;
                                    send(&mut writer, &format!("position fen {}", current_fen)).await?;
                                    send(&mut writer, "go infinite").await?;
                                    widened = true;
                                    state = State::Searching;
                                }
                                Some(PendingAction::NewGame) => {
                                    send(&mut writer, "ucinewgame").await?;
                                    send(&mut writer, "isready").await?;
                                    wait_for(&mut reader, "readyok").await?;
                                    current_fen.clear();
                                    widened = false;
                                    state = State::Idle;
                                    let _ = app.emit("engine-status", EngineStatusEvent {
                                        status: "ready".to_string(),
                                        fen: String::new(),
                                    });
                                }
                                Some(PendingAction::GoIdle) | None => {
                                    state = State::Idle;
                                    let _ = app.emit("engine-status", EngineStatusEvent {
                                        status: "stopped".to_string(),
                                        fen: current_fen.clone(),
                                    });
                                }
                            }
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(EngineCommand::SetFen(fen)) => {
                                pending = Some(PendingAction::SetFen(fen));
                            }
                            Some(EngineCommand::NewGame) => {
                                pending = Some(PendingAction::NewGame);
                            }
                            Some(EngineCommand::Stop) => {
                                pending = Some(PendingAction::GoIdle);
                            }
                            Some(EngineCommand::Shutdown) | None => {
                                let _ = send(&mut writer, "quit").await;
                                let _ = child.wait().await;
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Cleanup ───────────────────────────────────────────────
    let _ = send(&mut writer, "quit").await;
    let _ = child.wait().await;
    Ok(())
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
        .map_err(|e| format!("Stockfish stdin write error: {}", e))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("Stockfish stdin flush error: {}", e))?;
    Ok(())
}

async fn wait_for(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    target: &str,
) -> Result<(), String> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
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
