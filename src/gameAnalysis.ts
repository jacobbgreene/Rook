import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ═══════════════════════════════════════════════════════════════
// Shared Data Models
// ═══════════════════════════════════════════════════════════════

export interface EngineLine {
  scoreCp: number | null;
  scoreMate: number | null;
  pv: string[]; // UCI moves
}

export interface PositionEval {
  scoreCp: number | null;
  scoreMate: number | null;
  topLines: EngineLine[];
}

export interface Lc0Eval {
  wdl: [number, number, number]; // win/draw/loss permille
  scoreCp: number | null;
  topMoveSan: string;
  pvSan: string[];
}

export interface CriticalMoment {
  fen: string;
  moveSan: string;
  moveNumber: number;
  side: "white" | "black";
  evalBefore: number; // pawns, from white's perspective
  evalAfter: number;
  evalDrop: number; // positive = player worsened their position
  category: "blunder" | "mistake" | "inaccuracy" | "turning_point" | "great_move" | "critical" | "brilliant";
  bestMoveSan: string;
  bestLine: string[];
  lc0Eval?: Lc0Eval;
}

export interface CriticalMomentWithExplanation extends CriticalMoment {
  llmExplanation: string;
}

export interface GameAnalysisReport {
  criticalMoments: CriticalMomentWithExplanation[];
  thematicSummary: string;
}

export type AnalysisPhase =
  | { phase: "engine"; current: number; total: number }
  | { phase: "lc0"; current: number; total: number; backend?: string }
  | { phase: "llm"; current: number; total: number }
  | { phase: "summary" }
  | { phase: "complete" };

// ═══════════════════════════════════════════════════════════════
// Saved Report Types
// ═══════════════════════════════════════════════════════════════

export type GameResult = "win" | "loss" | "draw" | "unknown";

export interface SavedReport {
  id: string;
  gameHash: string;
  createdAt: string;
  perspective: "white" | "black";
  moveCount: number;
  openingMoves: string;
  result: GameResult;
  report: GameAnalysisReport;
  gameHistory: string[];
}

export interface SavedReportMeta {
  id: string;
  gameHash: string;
  createdAt: string;
  perspective: "white" | "black";
  moveCount: number;
  openingMoves: string;
  criticalMomentCount: number;
  result: GameResult;
}

// ═══════════════════════════════════════════════════════════════
// Game Hash Utility
// ═══════════════════════════════════════════════════════════════

/** Compute a djb2 hash of the FEN history, stripping halfmove/fullmove counters for stability. */
export function computeGameHash(positions: string[]): string {
  const normalized = positions.map((fen) => {
    const parts = fen.split(" ");
    return parts.slice(0, 4).join(" ");
  }).join("|");

  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** Determine the game result from the perspective of the given side. */
export function determineGameResult(gameHistory: string[], perspective: string): GameResult {
  if (gameHistory.length <= 1) return "unknown";
  const finalFen = gameHistory[gameHistory.length - 1];
  const game = new Chess(finalFen);

  if (game.isCheckmate()) {
    // Side to move is mated, so the other side won
    const loserIsWhite = game.turn() === "w";
    const winnerIsWhite = !loserIsWhite;
    return (perspective === "white") === winnerIsWhite ? "win" : "loss";
  }
  if (game.isDraw() || game.isStalemate()) {
    return "draw";
  }
  // Game didn't end in a terminal position (e.g. resignation, or game still in progress).
  // Use the final evaluation heuristic: check the last eval if available, otherwise unknown.
  return "unknown";
}

// ═══════════════════════════════════════════════════════════════
// Score Normalization
// ═══════════════════════════════════════════════════════════════

const MATE_CP = 10000;

/** Convert a PositionEval to a single centipawn number from side-to-move's perspective. */
function rawScore(ev: PositionEval): number {
  if (ev.scoreMate !== null) {
    return ev.scoreMate > 0 ? MATE_CP : -MATE_CP;
  }
  return ev.scoreCp ?? 0;
}

/** Flip score to white's perspective. */
function toWhitePerspective(cpFromSideToMove: number, isWhiteTurn: boolean): number {
  return isWhiteTurn ? cpFromSideToMove : -cpFromSideToMove;
}

// ═══════════════════════════════════════════════════════════════
// Engine Pass — evaluate every position via native Stockfish pool
// ═══════════════════════════════════════════════════════════════

export async function runEnginePass(
  positions: string[],
  depth: number = 15,
  onProgress?: (current: number, total: number) => void,
): Promise<PositionEval[]> {
  // Subscribe to progress events from the Rust worker pool
  let unlisten: UnlistenFn | undefined;
  if (onProgress) {
    unlisten = await listen<{ current: number; total: number }>(
      "engine-progress",
      (event) => {
        onProgress(event.payload.current, event.payload.total);
      },
    );
  }

  try {
    return await invoke<PositionEval[]>("run_engine_pass", {
      positions,
      depth,
      multipv: 3,
    });
  } finally {
    unlisten?.();
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers — UCI to SAN conversion
// ═══════════════════════════════════════════════════════════════

function uciToSan(fen: string, uciMoves: string[]): string[] {
  const game = new Chess(fen);
  const sanMoves: string[] = [];
  for (const uci of uciMoves) {
    if (uci.length < 4) break;
    try {
      const result = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length >= 5 ? uci[4] : undefined,
      });
      if (result) sanMoves.push(result.san);
      else break;
    } catch {
      break;
    }
  }
  return sanMoves;
}

// ═══════════════════════════════════════════════════════════════
// Threshold Filter — flag critical moments
// ═══════════════════════════════════════════════════════════════

export function filterCriticalMoments(
  positions: string[],
  moves: string[],
  evaluations: PositionEval[],
  includeGreatMoves: boolean = false,
  detailed: boolean = true,
): CriticalMoment[] {
  const moments: CriticalMoment[] = [];

  // Detailed mode uses lower thresholds to flag more moments,
  // giving broader coverage of the game.  Standard mode uses
  // higher thresholds so only the most impactful moments appear.
  const thresholds = detailed
    ? { blunder: 2.0, mistake: 1.0, inaccuracy: 0.5 }
    : { blunder: 3.0, mistake: 1.5, inaccuracy: 0.75 };

  for (let i = 0; i < moves.length; i++) {
    const fenBefore = positions[i];
    const isWhiteTurn = new Chess(fenBefore).turn() === "w";
    const side: "white" | "black" = isWhiteTurn ? "white" : "black";
    const moveNumber = Math.floor(i / 2) + 1;

    const evalBefore = evaluations[i];
    const evalAfter = evaluations[i + 1];
    if (!evalBefore || !evalAfter) continue;

    // Normalize every score to white's perspective (centipawns)
    const normBefore = toWhitePerspective(rawScore(evalBefore), isWhiteTurn);
    const normAfter = toWhitePerspective(rawScore(evalAfter), !isWhiteTurn);

    // Eval drop from the mover's perspective (pawns, positive = worse for mover)
    const evalDrop = isWhiteTurn
      ? (normBefore - normAfter) / 100
      : (normAfter - normBefore) / 100;

    // Turning point: mover was losing but is now winning
    const moverBefore = isWhiteTurn ? normBefore : -normBefore;
    const moverAfter = isWhiteTurn ? normAfter : -normAfter;
    const isTurningPoint = moverBefore < -50 && moverAfter > 50;

    // Categorize
    let category: CriticalMoment["category"] | null = null;
    if (isTurningPoint) category = "turning_point";
    else if (evalDrop > thresholds.blunder) category = "blunder";
    else if (evalDrop > thresholds.mistake) category = "mistake";
    else if (evalDrop > thresholds.inaccuracy) category = "inaccuracy";

    // Critical move: player found the *only* strong move in a complex position.
    // The gap between the engine's top two lines is huge, meaning there was one
    // narrow path and the player found it.
    if (!category && includeGreatMoves && evalDrop <= 0.15) {
      const topLines = evalBefore.topLines;
      if (topLines.length >= 2) {
        const rawScoreLine = (line: EngineLine): number => {
          if (line.scoreMate !== null) return line.scoreMate > 0 ? MATE_CP : -MATE_CP;
          return line.scoreCp ?? 0;
        };
        const score1 = rawScoreLine(topLines[0]);
        const score2 = rawScoreLine(topLines[1]);
        const gap = score1 - score2; // both from side-to-move perspective
        const moverEval = isWhiteTurn ? normBefore : -normBefore;
        if (gap >= 150 && moverEval < 500) {
          category = "critical";
        }
      }
    }

    // Great move: the player's position improved significantly over the last
    // two half-moves (opponent's move + player's response) and the player
    // didn't squander the opportunity (their own evalDrop is small).
    // This catches moves where the player correctly punished an opponent error.
    if (!category && includeGreatMoves && i >= 1 && evalDrop <= 0.3) {
      const evalTwoPliesAgo = evaluations[i - 1];
      if (evalTwoPliesAgo) {
        const prevTurn = !isWhiteTurn; // who moved two plies ago (the opponent)
        const normTwoPliesAgo = toWhitePerspective(rawScore(evalTwoPliesAgo), prevTurn);
        // Eval gain from the player's perspective over the two half-moves
        const pairGain = isWhiteTurn
          ? (normAfter - normTwoPliesAgo) / 100
          : (normTwoPliesAgo - normAfter) / 100;
        if (pairGain >= 1.0) {
          category = "great_move";
        }
      }
    }

    if (!category) continue;

    // Best move from Stockfish's top line
    const topLine = evalBefore.topLines[0];
    let bestMoveSan = "";
    let bestLineSan: string[] = [];
    if (topLine?.pv.length) {
      bestLineSan = uciToSan(fenBefore, topLine.pv);
      bestMoveSan = bestLineSan[0] || "";
    }

    moments.push({
      fen: fenBefore,
      moveSan: moves[i],
      moveNumber,
      side,
      evalBefore: normBefore / 100,
      evalAfter: normAfter / 100,
      evalDrop,
      category,
      bestMoveSan,
      bestLine: bestLineSan,
    });
  }

  return moments;
}

// ═══════════════════════════════════════════════════════════════
// Full Pipeline Orchestrator
// ═══════════════════════════════════════════════════════════════

export async function runFullAnalysis(
  gameHistory: string[],
  perspective: string,
  onProgress?: (phase: AnalysisPhase) => void,
  depth: number = 15,
  includeGreatMoves: boolean = false,
  hybridMode: boolean = false,
  detailedReport: boolean = true,
): Promise<GameAnalysisReport> {
  // Step 1 — Reconstruct SAN moves from the FEN history
  const sanMoves: string[] = [];
  for (let i = 0; i < gameHistory.length - 1; i++) {
    const game = new Chess(gameHistory[i]);
    for (const san of game.moves()) {
      const test = new Chess(gameHistory[i]);
      test.move(san);
      if (test.fen() === gameHistory[i + 1]) {
        sanMoves.push(san);
        break;
      }
    }
  }

  // Step 2 — Engine pass: evaluate every position at fixed depth.
  // In hybrid mode Lc0 handles the strategic deep dive, so we can
  // reduce Stockfish depth to speed up the tactial scan.  Cap at 15
  // to keep the pool fast while still catching tactical motifs.
  const sfDepth = hybridMode ? Math.min(depth, 15) : depth;
  const evaluations = await runEnginePass(
    gameHistory,
    sfDepth,
    (current, total) => onProgress?.({ phase: "engine", current, total }),
  );

  // Step 3 — Threshold filter: find critical moments
  const criticalMoments = filterCriticalMoments(gameHistory, sanMoves, evaluations, includeGreatMoves, detailedReport);

  // Step 3.5 — Lc0 strategic pass (hybrid mode only)
  if (hybridMode) {
    const criticalFens = criticalMoments.map(m => m.fen);
    if (criticalFens.length > 0) {
      onProgress?.({ phase: "lc0", current: 0, total: criticalFens.length });
      const lc0Unlisten = await listen<{ current: number; total: number }>(
        "lc0-eval-progress", (event) => {
          const p = event.payload as { current: number; total: number; backend?: string };
          onProgress?.({ phase: "lc0", current: p.current, total: p.total, backend: p.backend });
        }
      );
      try {
        const lc0Results = await invoke<Lc0Eval[]>("run_lc0_pass", {
          positions: criticalFens, nodes: 75000,
        });
        for (let i = 0; i < criticalMoments.length; i++) {
          if (lc0Results[i]) {
            criticalMoments[i].lc0Eval = lc0Results[i];
          }
        }
      } catch (e) {
        console.warn("Lc0 pass failed, continuing without:", e);
      } finally {
        lc0Unlisten();
      }
    }
  }

  // Step 4 — LLM explanation only for the player's critical moments
  const playerMoments = criticalMoments.filter(m => m.side === perspective);
  const explained: CriticalMomentWithExplanation[] = [];
  for (let i = 0; i < playerMoments.length; i++) {
    onProgress?.({ phase: "llm", current: i + 1, total: playerMoments.length });
    try {
      // Build the moment payload — include Lc0 data if available
      const momentPayload: Record<string, unknown> = { ...playerMoments[i] };
      if (playerMoments[i].lc0Eval) {
        momentPayload.lc0Wdl = Array.from(playerMoments[i].lc0Eval!.wdl);
        momentPayload.lc0TopMove = playerMoments[i].lc0Eval!.topMoveSan;
        momentPayload.lc0Line = playerMoments[i].lc0Eval!.pvSan;
      }
      // Remove the nested lc0Eval before sending (Rust expects flat fields)
      delete momentPayload.lc0Eval;

      const explanation = await invoke<string>("explain_critical_moment", {
        moment: momentPayload,
        perspective,
      });
      explained.push({ ...playerMoments[i], llmExplanation: explanation });
    } catch (e) {
      explained.push({
        ...playerMoments[i],
        llmExplanation: `Analysis unavailable: ${e}`,
      });
    }
  }

  // Step 5 — Thematic summary across all moments
  const gameResult = determineGameResult(gameHistory, perspective);
  onProgress?.({ phase: "summary" });
  let thematicSummary = "";

  // Build moments payload with Lc0 data for the summary too
  const momentsForSummary = criticalMoments.map(m => {
    const payload: Record<string, unknown> = { ...m };
    if (m.lc0Eval) {
      payload.lc0Wdl = Array.from(m.lc0Eval.wdl);
      payload.lc0TopMove = m.lc0Eval.topMoveSan;
      payload.lc0Line = m.lc0Eval.pvSan;
    }
    delete payload.lc0Eval;
    return payload;
  });

  if (criticalMoments.length > 0) {
    try {
      thematicSummary = await invoke<string>("generate_thematic_summary", {
        moments: momentsForSummary,
        perspective,
        includeGreatMoves,
        gameResult,
      });
    } catch (e) {
      thematicSummary = `Summary unavailable: ${e}`;
    }
  } else if (playerMoments.length === 0) {
    thematicSummary = "No critical moments were detected in your play — solid game!";
  } else {
    thematicSummary = "No critical moments were detected — solid play throughout!";
  }

  onProgress?.({ phase: "complete" });
  return { criticalMoments: explained, thematicSummary };
}
