import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";

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

export interface CriticalMoment {
  fen: string;
  moveSan: string;
  moveNumber: number;
  side: "white" | "black";
  evalBefore: number; // pawns, from white's perspective
  evalAfter: number;
  evalDrop: number; // positive = player worsened their position
  category: "blunder" | "mistake" | "inaccuracy" | "turning_point" | "great_move";
  bestMoveSan: string;
  bestLine: string[];
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
// Promise-based Stockfish Evaluation (dedicated worker)
// ═══════════════════════════════════════════════════════════════

/** Wait for a specific message from the worker. */
function waitForMessage(worker: Worker, predicate: (msg: string) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      if (predicate(event.data as string)) {
        worker.removeEventListener("message", handler);
        resolve();
      }
    };
    worker.addEventListener("message", handler);
  });
}

/** Evaluate a single position to a fixed depth. Returns when 'bestmove' arrives. */
async function evaluatePosition(
  worker: Worker,
  fen: string,
  depth: number,
  multipv: number = 3,
): Promise<PositionEval> {
  // Flush any stale output
  worker.postMessage("stop");
  const readyPromise = waitForMessage(worker, (m) => m === "readyok");
  worker.postMessage("isready");
  await readyPromise;

  // Collect lines as the search runs, resolve on bestmove
  return new Promise((resolve) => {
    const lines = new Map<
      number,
      { depth: number; scoreCp: number | null; scoreMate: number | null; pv: string[] }
    >();

    const handler = (event: MessageEvent) => {
      const msg = event.data as string;

      if (msg.startsWith("info depth") && !msg.includes("currmovenumber")) {
        const depthMatch = msg.match(/depth (\d+)/);
        const mpvMatch = msg.match(/multipv (\d+)/);
        const pvMatch = msg.match(/ pv (.+)/);

        if (depthMatch && pvMatch) {
          const d = parseInt(depthMatch[1]);
          const mpv = mpvMatch ? parseInt(mpvMatch[1]) : 1;
          let scoreCp: number | null = null;
          let scoreMate: number | null = null;

          const cpMatch = msg.match(/score cp (-?\d+)/);
          const mateMatch = msg.match(/score mate (-?\d+)/);
          if (cpMatch) scoreCp = parseInt(cpMatch[1]);
          else if (mateMatch) scoreMate = parseInt(mateMatch[1]);

          const existing = lines.get(mpv);
          if (!existing || d > existing.depth) {
            lines.set(mpv, { depth: d, scoreCp, scoreMate, pv: pvMatch[1].split(" ") });
          }
        }
      }

      if (msg.startsWith("bestmove")) {
        worker.removeEventListener("message", handler);

        const topLines: EngineLine[] = Array.from(lines.entries())
          .sort(([a], [b]) => a - b)
          .map(([, line]) => ({
            scoreCp: line.scoreCp,
            scoreMate: line.scoreMate,
            pv: line.pv,
          }));

        const best = topLines[0];
        resolve({
          scoreCp: best?.scoreCp ?? 0,
          scoreMate: best?.scoreMate ?? null,
          topLines,
        });
      }
    };

    worker.addEventListener("message", handler);
    worker.postMessage(`setoption name MultiPV value ${multipv}`);
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// Engine Pass — evaluate every position in the game
// ═══════════════════════════════════════════════════════════════

export async function runEnginePass(
  positions: string[],
  depth: number = 15,
  onProgress?: (current: number, total: number) => void,
): Promise<PositionEval[]> {
  const worker = new Worker("/stockfish.js");
  worker.postMessage("uci");
  await waitForMessage(worker, (m) => m.includes("uciok"));

  const evaluations: PositionEval[] = [];

  for (let i = 0; i < positions.length; i++) {
    onProgress?.(i + 1, positions.length);

    const game = new Chess(positions[i]);
    if (game.isCheckmate()) {
      // Side to move is mated
      evaluations.push({ scoreCp: -MATE_CP, scoreMate: null, topLines: [] });
    } else if (game.isDraw() || game.isStalemate()) {
      evaluations.push({ scoreCp: 0, scoreMate: null, topLines: [] });
    } else {
      evaluations.push(await evaluatePosition(worker, positions[i], depth));
    }
  }

  worker.terminate();
  return evaluations;
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
): CriticalMoment[] {
  const moments: CriticalMoment[] = [];

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
    else if (evalDrop > 3.0) category = "blunder";
    else if (evalDrop > 1.5) category = "mistake";
    else if (evalDrop > 0.75) category = "inaccuracy";

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

  // Step 2 — Engine pass: evaluate every position at fixed depth
  const evaluations = await runEnginePass(
    gameHistory,
    depth,
    (current, total) => onProgress?.({ phase: "engine", current, total }),
  );

  // Step 3 — Threshold filter: find critical moments
  const criticalMoments = filterCriticalMoments(gameHistory, sanMoves, evaluations, includeGreatMoves);

  // Step 4 — LLM explanation only for the player's critical moments
  const playerMoments = criticalMoments.filter(m => m.side === perspective);
  const explained: CriticalMomentWithExplanation[] = [];
  for (let i = 0; i < playerMoments.length; i++) {
    onProgress?.({ phase: "llm", current: i + 1, total: playerMoments.length });
    try {
      const explanation = await invoke<string>("explain_critical_moment", {
        moment: playerMoments[i],
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
  if (criticalMoments.length > 0) {
    try {
      thematicSummary = await invoke<string>("generate_thematic_summary", {
        moments: criticalMoments,
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
