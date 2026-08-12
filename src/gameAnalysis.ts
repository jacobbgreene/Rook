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

export type MomentCategory =
  | "brilliant" // sound sacrifice with a hidden tactical point
  | "trap" // bait: the opponent's natural/tempting reply loses
  | "capitalized" // the player seized on an opponent's slip
  | "critical" // found the only strong move in a sharp position
  | "turning_point" // the game swung from losing to winning
  | "opportunity" // the opponent slipped — a chance to seize the advantage
  | "blunder" | "mistake" | "inaccuracy"
  // Legacy categories — only found in reports saved by older versions.
  | "great_move"
  | "golden_opportunity";

export interface CriticalMoment {
  fen: string;
  moveSan: string;
  moveNumber: number;
  side: "white" | "black";
  evalBefore: number; // pawns, from white's perspective
  evalAfter: number;
  evalDrop: number; // positive = player worsened their position
  category: MomentCategory;
  bestMoveSan: string;
  bestLine: string[];
  lc0Eval?: Lc0Eval;
  /** The tempting reply the opponent might grab (SAN). */
  baitMoveSan?: string;
  /** Refutation of the bait (SAN moves), starting after the bait. */
  refutationLine?: string[];
  /** Eval after the bait, from the mover's perspective (pawns). */
  refutationEval?: number;
  /** What this move would also qualify as (e.g. a capitalized trap). */
  secondaryCategory?: string;
  /** Ply index into the position/move history (internal, not sent to LLM). */
  moveIndex?: number;
}

/** Build the payload sent to Rust (flat fields + Lc0 + trap data). */
export function momentToPayload(m: CriticalMoment): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...m };
  if (m.lc0Eval) {
    payload.lc0Wdl = Array.from(m.lc0Eval.wdl);
    payload.lc0TopMove = m.lc0Eval.topMoveSan;
    payload.lc0Line = m.lc0Eval.pvSan;
  }
  delete payload.lc0Eval;
  return payload;
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
  name?: string | null;
  report: GameAnalysisReport;
  gameHistory: string[];
  evaluations?: PositionEval[];
  gameSanList?: string[];
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
  name?: string | null;
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

/** Move number and side to move for the position BEFORE ply `i`, read
 *  from the FEN itself so FEN-imported games are numbered correctly. */
export function moveInfoAt(
  fens: string[],
  i: number,
): { moveNumber: number; side: "white" | "black" } {
  const fen = fens[i];
  if (fen) {
    const parts = fen.split(" ");
    const num = parseInt(parts[5], 10);
    return {
      moveNumber: Number.isNaN(num) ? Math.floor(i / 2) + 1 : num,
      side: parts[1] === "b" ? "black" : "white",
    };
  }
  return {
    moveNumber: Math.floor(i / 2) + 1,
    side: i % 2 === 0 ? "white" : "black",
  };
}

/** Determine the game result from the perspective of the given side. */
export function determineGameResult(
  gameHistory: string[],
  perspective: string,
  pgnResult?: string,
): GameResult {
  if (gameHistory.length <= 1) return "unknown";
  const finalFen = gameHistory[gameHistory.length - 1];

  let game: Chess;
  try {
    game = new Chess(finalFen);
  } catch {
    return "unknown";
  }

  if (game.isCheckmate()) {
    // Side to move is mated, so the other side won
    const loserIsWhite = game.turn() === "w";
    const winnerIsWhite = !loserIsWhite;
    return (perspective === "white") === winnerIsWhite ? "win" : "loss";
  }
  if (game.isDraw() || game.isStalemate()) {
    return "draw";
  }
  // Game didn't end in a terminal position (e.g. resignation, timeout).
  // Fall back to PGN Result header if available.
  if (pgnResult === "1-0") {
    return perspective === "white" ? "win" : "loss";
  }
  if (pgnResult === "0-1") {
    return perspective === "white" ? "loss" : "win";
  }
  if (pgnResult === "1/2-1/2") {
    return "draw";
  }
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

export function uciToSan(fen: string, uciMoves: string[]): string[] {
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

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/** Raw material balance from white's perspective (centipawns). */
function materialBalanceCp(fen: string): number {
  let bal = 0;
  for (const ch of fen.split(" ")[0]) {
    const v = PIECE_VALUES[ch.toLowerCase()] ?? 0;
    if (ch >= "A" && ch <= "Z") bal += v;
    else if (ch >= "a" && ch <= "z") bal -= v;
  }
  return bal * 100;
}

function rawScoreLine(line: EngineLine): number {
  if (line.scoreMate !== null) return line.scoreMate > 0 ? MATE_CP : -MATE_CP;
  return line.scoreCp ?? 0;
}

/** A sound player move that may hide a tactical point — probed afterwards
 *  to discover traps (tempting replies that lose) and real sacrifices. */
export interface TrapCandidate {
  moveIndex: number; // index into moves[] / positions[] (position BEFORE the move)
  moveSan: string;
  moveNumber: number;
  side: "white" | "black";
  isWhiteTurn: boolean;
  fenBefore: string;
  fenAfter: string; // opponent to move
  moverBefore: number; // pawns, mover's perspective
  moverAfter: number;
  playedBest: boolean;
  materialDropped: boolean;
  criticalEligible: boolean; // huge gap between the engine's top two lines
  hasTemptingCapture: boolean;
}

export interface FilterResult {
  moments: CriticalMoment[];
  candidates: TrapCandidate[];
}

/**
 * Opponent captures that look profitable at a glance (naive material count) —
 * exactly the grabs a human is tempted by when facing a trap.
 */
export function findTemptingCaptures(
  fenAfter: string,
): { san: string; from: string; to: string; promotion?: string }[] {
  const game = new Chess(fenAfter);
  return game
    .moves({ verbose: true })
    .filter((m) => {
      if (!m.captured) return false;
      const capturedV = PIECE_VALUES[m.captured] ?? 0;
      const capturerV = PIECE_VALUES[m.piece] ?? 0;
      if (m.piece === "k") return capturedV >= 3; // KxR!? style baits
      return capturedV >= capturerV && capturedV >= 1;
    })
    .sort(
      (a, b) =>
        (PIECE_VALUES[b.captured!] ?? 0) - (PIECE_VALUES[a.captured!] ?? 0) ||
        (PIECE_VALUES[a.piece] ?? 0) - (PIECE_VALUES[b.piece] ?? 0),
    )
    .slice(0, 2)
    .map((m) => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion }));
}

export function filterCriticalMoments(
  positions: string[],
  moves: string[],
  evaluations: PositionEval[],
  includeGreatMoves: boolean = false,
  detailed: boolean = true,
  includeOpportunities: boolean = false,
  perspective?: string,
): FilterResult {
  const moments: CriticalMoment[] = [];
  const candidates: TrapCandidate[] = [];

  // Detailed mode uses lower thresholds to flag more moments,
  // giving broader coverage of the game.  Standard mode uses
  // higher thresholds so only the most impactful moments appear.
  const thresholds = detailed
    ? { blunder: 2.0, mistake: 1.0, inaccuracy: 0.5 }
    : { blunder: 3.0, mistake: 1.5, inaccuracy: 0.75 };

  for (let i = 0; i < moves.length; i++) {
    const fenBefore = positions[i];
    const fenAfter = positions[i + 1];
    if (!fenAfter) continue;
    const isWhiteTurn = new Chess(fenBefore).turn() === "w";
    const side: "white" | "black" = isWhiteTurn ? "white" : "black";
    // Read the fullmove number from the FEN itself so games imported from a
    // custom position (Black to move first, or a mid-game FEN) are numbered
    // correctly instead of assuming the game starts at 1. e4 territory.
    const fenParts = fenBefore.split(" ");
    const moveNumber = parseInt(fenParts[5], 10) || Math.floor(i / 2) + 1;

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

    // Eval from the mover's perspective (pawns)
    const moverBefore = (isWhiteTurn ? normBefore : -normBefore) / 100;
    const moverAfter = (isWhiteTurn ? normAfter : -normAfter) / 100;

    // Turning point: mover was losing but is now winning
    const isTurningPoint = moverBefore < -0.5 && moverAfter > 0.5;

    // Categorize by eval swing first
    let category: MomentCategory | null = null;
    if (isTurningPoint) category = "turning_point";
    else if (evalDrop > thresholds.blunder) category = "blunder";
    else if (evalDrop > thresholds.mistake) category = "mistake";
    else if (evalDrop > thresholds.inaccuracy) category = "inaccuracy";

    // The opponent's blunders/mistakes are the player's opportunities —
    // but only when the player can actually use the chance: not still
    // dead lost after the slip, and not already cruising to a blowout.
    if (
      category &&
      includeOpportunities &&
      perspective &&
      side !== perspective &&
      (category === "blunder" || category === "mistake")
    ) {
      const playerPovAfter =
        (perspective === "white" ? normAfter : -normAfter) / 100;
      if (playerPovAfter > -3 && playerPovAfter < 6) {
        category = "opportunity";
      }
    }

    // Sound player moves become candidates for trap / brilliant / critical
    // classification — assigned AFTER the trap probe runs in runFullAnalysis.
    // "Sound" = not already flagged as an eval swing above.
    if (
      !category &&
      includeGreatMoves &&
      perspective &&
      side === perspective &&
      evalDrop <= thresholds.inaccuracy
    ) {
      const topLines = evalBefore.topLines;
      const bestSan = topLines.length
        ? uciToSan(fenBefore, topLines[0].pv)[0]
        : undefined;
      const playedBest = !!bestSan && bestSan === moves[i];

      let criticalEligible = false;
      if (topLines.length >= 2) {
        const gap = rawScoreLine(topLines[0]) - rawScoreLine(topLines[1]);
        // Only when the game is still undecided — "the only move" is
        // meaningless in a position that is already won or dead lost.
        if (gap >= 150 && Math.abs(moverBefore) < 5) criticalEligible = true;
      }

      const matBefore = materialBalanceCp(fenBefore);
      const matAfter = materialBalanceCp(fenAfter);
      const materialDropped = isWhiteTurn
        ? matAfter < matBefore
        : matAfter > matBefore;

      const hasTemptingCapture = findTemptingCaptures(fenAfter).length > 0;

      candidates.push({
        moveIndex: i,
        moveSan: moves[i],
        moveNumber,
        side,
        isWhiteTurn,
        fenBefore,
        fenAfter,
        moverBefore,
        moverAfter,
        playedBest,
        materialDropped,
        criticalEligible,
        hasTemptingCapture,
      });
      continue;
    }

    if (!category) continue;

    // For opportunities, show the position AFTER the opponent's mistake
    // and the player's best response from that position
    let momentFen: string;
    let bestMoveSan = "";
    let bestLineSan: string[] = [];

    if (category === "opportunity") {
      momentFen = fenAfter;
      const responseTopLine = evalAfter.topLines[0];
      if (responseTopLine?.pv.length) {
        bestLineSan = uciToSan(fenAfter, responseTopLine.pv);
        bestMoveSan = bestLineSan[0] || "";
      }
    } else {
      momentFen = fenBefore;
      const topLine = evalBefore.topLines[0];
      if (topLine?.pv.length) {
        bestLineSan = uciToSan(fenBefore, topLine.pv);
        bestMoveSan = bestLineSan[0] || "";
      }
    }

    moments.push({
      fen: momentFen,
      moveSan: moves[i],
      moveNumber,
      side,
      evalBefore: normBefore / 100,
      evalAfter: normAfter / 100,
      evalDrop,
      category,
      bestMoveSan,
      bestLine: bestLineSan,
      moveIndex: i,
    });
  }

  return { moments, candidates };
}

// ═══════════════════════════════════════════════════════════════
// Trap Probe — evaluate the opponent's tempting replies
// ═══════════════════════════════════════════════════════════════

/** A tempting opponent reply (bait) for a trap candidate. */
interface BaitMove {
  san: string;
  from?: string;
  to?: string;
  promotion?: string;
  /** Lc0 policy probability (0-100) when discovered via the policy head. */
  policy?: number;
}

export interface TrapResult {
  baitSan: string;
  refutationLine: string[]; // SAN moves from the position after the bait
  refutationEval: number; // pawns, player's perspective
  swing: number; // how much worse the bait is vs the opponent's best play
}

/** Lc0 policy-head output: how likely a human is to play each move. */
export interface Lc0PolicyMove {
  uci: string;
  san: string;
  policy: number; // percent
}

/** Minimum eval swing (pawns) for a tempting reply to count as a trap. */
const TRAP_SWING_THRESHOLD = 3.0;
/** The bait must genuinely flip the game toward the player: clearly better
 *  after the bait (or mate, which normalizes to ±100).  A "trap" that
 *  leaves the player just as lost is no trap at all. */
const TRAP_MIN_RESULT = 1.0;
/** Cap on probe positions so the extra pass stays fast. */
const MAX_TRAP_CANDIDATES = 12;

/**
 * Probe trap candidates: evaluate the position after each tempting reply
 * and check whether it loses badly compared to the opponent's best play.
 *
 * Bait moves come from two sources:
 *  - naive material-winning captures (always available)
 *  - Lc0 policy priors (hybrid mode) — what a human would actually be
 *    tempted to play, even when it isn't a capture
 */
export async function probeTrapCandidates(
  candidates: TrapCandidate[],
  positions: string[],
  moves: string[],
  evaluations: PositionEval[],
  depth: number,
  policyByCandidate?: Map<number, Lc0PolicyMove[]>,
  onProbeProgress?: (current: number, total: number) => void,
): Promise<Map<number, TrapResult>> {
  const results = new Map<number, TrapResult>();
  if (candidates.length === 0) return results;

  // ── Collect baits per candidate ─────────────────────────────
  interface ProbeWork {
    candIdx: number;
    bait: BaitMove;
    baitFen: string | null; // null when the opponent actually played the bait
    takenIndex: number | null; // evaluation index of the played bait position
  }
  const work: ProbeWork[] = [];

  for (let c = 0; c < candidates.length; c++) {
    const cand = candidates[c];
    const baits: BaitMove[] = findTemptingCaptures(cand.fenAfter);

    // Hybrid mode: add high-policy human-like replies that aren't captures
    const policyMoves = policyByCandidate?.get(c) ?? [];
    // The opponent's best response (what the position "should" continue with)
    const bestResponse = evaluations[cand.moveIndex + 1]?.topLines[0];
    const bestResponseSan = bestResponse
      ? uciToSan(cand.fenAfter, bestResponse.pv)[0]
      : undefined;
    for (const pm of policyMoves) {
      if (pm.policy < 12) continue; // not actually tempting
      if (pm.san === bestResponseSan) continue; // the bait is fine — no trap
      if (baits.some((b) => b.san === pm.san)) continue;
      baits.push({ san: pm.san, policy: pm.policy });
    }

    for (const bait of baits.slice(0, 3)) {
      // Did the opponent actually take the bait in the game?
      const playedNext = moves[cand.moveIndex + 1];
      if (playedNext && playedNext === bait.san) {
        const takenIndex = cand.moveIndex + 2;
        if (evaluations[takenIndex]) {
          work.push({
            candIdx: c,
            bait,
            baitFen: null,
            takenIndex,
          });
          continue;
        }
      }
      // Otherwise compute the bait position and queue it for evaluation
      try {
        const g = new Chess(cand.fenAfter);
        g.move(bait.san);
        work.push({
          candIdx: c,
          bait,
          baitFen: g.fen(),
          takenIndex: null,
        });
      } catch {
        // illegal move (shouldn't happen) — skip
      }
    }
  }

  // ── Evaluate bait positions that weren't played ─────────────
  const toProbe = work.filter((w) => w.baitFen !== null);
  const probeEvals: PositionEval[] =
    toProbe.length > 0
      ? await runEnginePass(
          toProbe.map((w) => w.baitFen!),
          depth,
          onProbeProgress,
        )
      : [];

  const probeEvalByFen = new Map<string, PositionEval>();
  toProbe.forEach((w, i) => {
    if (probeEvals[i]) probeEvalByFen.set(w.baitFen!, probeEvals[i]);
  });

  // ── Confirm traps ───────────────────────────────────────────
  for (const w of work) {
    // Evaluation of the position after the bait — the player is to move,
    // so the engine score is already from the player's perspective.
    const baitEval = w.takenIndex !== null
      ? evaluations[w.takenIndex]
      : probeEvalByFen.get(w.baitFen!);
    if (!baitEval) continue;
    const baitFen = w.takenIndex !== null
      ? positions[w.takenIndex]
      : w.baitFen!;

    const baitEvalPlayer = rawScore(baitEval) / 100; // player to move
    const cand = candidates[w.candIdx];
    const swing = baitEvalPlayer - cand.moverAfter;
    // The swing alone isn't enough — the bait must actually flip the game
    // in the player's favor.  In a dead-lost position a "trap" whose bait
    // merely loses less badly is noise (and the LLM will hallucinate a
    // refutation that doesn't exist).
    if (swing < TRAP_SWING_THRESHOLD || baitEvalPlayer < TRAP_MIN_RESULT)
      continue;

    const refPv = baitEval.topLines[0]?.pv ?? [];
    const refutationLine = uciToSan(baitFen, refPv).slice(0, 6);

    // Keep the strongest bait per candidate
    const existing = results.get(w.candIdx);
    if (existing && existing.swing >= swing) continue;
    results.set(w.candIdx, {
      baitSan: w.bait.san,
      refutationLine,
      refutationEval: baitEvalPlayer,
      swing,
    });
  }

  return results;
}

/**
 * Assign final categories to trap candidates once the probe has run.
 * Precedence: trap > brilliant > critical.
 */
export function finalizeCandidateMoments(
  candidates: TrapCandidate[],
  trapResults: Map<number, TrapResult>,
  evaluations: PositionEval[],
): CriticalMoment[] {
  const out: CriticalMoment[] = [];
  for (let c = 0; c < candidates.length; c++) {
    const cand = candidates[c];
    const trap = trapResults.get(c);

    let category: MomentCategory | null = null;
    if (trap) category = "trap";
    else if (cand.materialDropped && cand.playedBest && cand.moverBefore < 5)
      category = "brilliant";
    else if (cand.criticalEligible) category = "critical";
    if (!category) continue;

    const evalBeforeEv = evaluations[cand.moveIndex];
    const topLine = evalBeforeEv?.topLines[0];
    const engineLine = topLine?.pv.length
      ? uciToSan(cand.fenBefore, topLine.pv)
      : [];

    if (category === "trap" && trap) {
      // The variation starts from the position after the player's move
      // (which is in the main history) and begins with the bait itself,
      // so exploring the line replays: bait → refutation.
      out.push({
        fen: cand.fenAfter,
        moveSan: cand.moveSan,
        moveNumber: cand.moveNumber,
        side: cand.side,
        evalBefore: cand.isWhiteTurn ? cand.moverBefore : -cand.moverBefore,
        evalAfter: cand.isWhiteTurn ? cand.moverAfter : -cand.moverAfter,
        evalDrop: cand.moverBefore - cand.moverAfter,
        category,
        bestMoveSan: engineLine[0] || "",
        bestLine: [trap.baitSan, ...trap.refutationLine],
        baitMoveSan: trap.baitSan,
        refutationLine: trap.refutationLine,
        refutationEval: trap.refutationEval,
        moveIndex: cand.moveIndex,
      });
    } else {
      out.push({
        fen: cand.fenBefore,
        moveSan: cand.moveSan,
        moveNumber: cand.moveNumber,
        side: cand.side,
        evalBefore: cand.isWhiteTurn ? cand.moverBefore : -cand.moverBefore,
        evalAfter: cand.isWhiteTurn ? cand.moverAfter : -cand.moverAfter,
        evalDrop: cand.moverBefore - cand.moverAfter,
        category,
        bestMoveSan: engineLine[0] || "",
        bestLine: engineLine,
        moveIndex: cand.moveIndex,
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Capitalization — connecting opportunities to their punishment
// ═══════════════════════════════════════════════════════════════

/**
 * When the opponent slips (opportunity) and the player's reply keeps the
 * advantage (a sound reply), the reply becomes a "capitalized" moment —
 * the connector that shows the player recognized and punished the mistake.
 * Takes precedence over trap/brilliant/critical, which are demoted to a
 * secondary note ("also a trap").
 */
export function applyCapitalization(
  moments: CriticalMoment[],
  positions: string[],
  moves: string[],
  evaluations: PositionEval[],
  perspective: string,
  includeOpportunities: boolean,
): CriticalMoment[] {
  if (!includeOpportunities) return moments;

  const byIndex = new Map<number, CriticalMoment>();
  for (const m of moments) {
    if (m.moveIndex !== undefined) byIndex.set(m.moveIndex, m);
  }

  for (const opp of moments) {
    if (opp.category !== "opportunity" || opp.moveIndex === undefined) continue;
    const replyIdx = opp.moveIndex + 1;
    const fenReplyBefore = positions[replyIdx];
    const evBefore = evaluations[replyIdx];
    const evAfter = evaluations[replyIdx + 1];
    if (!fenReplyBefore || !evBefore || !evAfter || !moves[replyIdx]) continue;

    const isWhiteTurn = new Chess(fenReplyBefore).turn() === "w";
    const replySide: "white" | "black" = isWhiteTurn ? "white" : "black";
    // Only the perspective player can capitalize on the opponent's slip
    if (replySide !== perspective) continue;

    const normBefore = toWhitePerspective(rawScore(evBefore), isWhiteTurn);
    const normAfter = toWhitePerspective(rawScore(evAfter), !isWhiteTurn);
    const replyDrop = isWhiteTurn
      ? (normBefore - normAfter) / 100
      : (normAfter - normBefore) / 100;

    // The reply must be sound — it converts the gift rather than handing
    // it back.  (A weak reply leaves the moment as a plain opportunity.)
    if (replyDrop > 0.3) continue;

    // The chip shows the size of the opponent's slip, not the reply's drop.
    const slipSize = opp.evalDrop;

    const existing = byIndex.get(replyIdx);
    if (existing) {
      if (existing.category !== "capitalized") {
        existing.secondaryCategory = existing.category;
        existing.category = "capitalized";
        existing.evalDrop = slipSize;
      }
      continue;
    }

    const topLine = evBefore.topLines[0];
    const bestLineSan = topLine?.pv.length
      ? uciToSan(fenReplyBefore, topLine.pv)
      : [];
    const fenParts = fenReplyBefore.split(" ");
    const moveNumber =
      parseInt(fenParts[5], 10) || Math.floor(replyIdx / 2) + 1;
    const moment: CriticalMoment = {
      fen: fenReplyBefore,
      moveSan: moves[replyIdx],
      moveNumber,
      side: replySide,
      evalBefore: normBefore / 100,
      evalAfter: normAfter / 100,
      evalDrop: slipSize,
      category: "capitalized",
      bestMoveSan: bestLineSan[0] || "",
      bestLine: bestLineSan,
      moveIndex: replyIdx,
    };
    moments.push(moment);
    byIndex.set(replyIdx, moment);
  }

  // Keep chronological order
  return moments.sort((a, b) => (a.moveIndex ?? 0) - (b.moveIndex ?? 0));
}

// ═══════════════════════════════════════════════════════════════
// Full Pipeline Orchestrator
// ═══════════════════════════════════════════════════════════════

export interface FullAnalysisResult {
  report: GameAnalysisReport;
  evaluations: PositionEval[];
}

export async function runFullAnalysis(
  gameHistory: string[],
  perspective: string,
  onProgress?: (phase: AnalysisPhase) => void,
  depth: number = 15,
  includeGreatMoves: boolean = false,
  hybridMode: boolean = false,
  detailedReport: boolean = true,
  includeOpportunities: boolean = false,
  pgnResult?: string,
): Promise<FullAnalysisResult> {
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
  // A mismatch here means a position in the history isn't reachable by any
  // legal move — continuing would silently corrupt every report entry.
  if (sanMoves.length !== gameHistory.length - 1) {
    throw new Error(
      `Failed to reconstruct the game: only ${sanMoves.length} of ` +
        `${gameHistory.length - 1} moves could be matched. The game history ` +
        `may contain an illegal or corrupted position.`,
    );
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

  // Step 3 — Threshold filter: flag eval-swing moments and collect
  // candidates for trap / brilliant / critical classification.
  const { moments, candidates } = filterCriticalMoments(
    gameHistory,
    sanMoves,
    evaluations,
    includeGreatMoves,
    detailedReport,
    includeOpportunities,
    perspective,
  );

  // Keep the candidate count bounded so the extra probing stays cheap.
  const rankedCandidates = candidates
    .map((c, idx) => ({ c, idx }))
    .sort(
      (a, b) =>
        Number(b.c.materialDropped) - Number(a.c.materialDropped) ||
        Number(b.c.hasTemptingCapture) - Number(a.c.hasTemptingCapture) ||
        a.idx - b.idx,
    )
    .slice(0, MAX_TRAP_CANDIDATES)
    .map(({ c }) => c);


  // Step 3.5a — Lc0 policy probe (hybrid mode): what would a human opponent
  // be TEMPTED to play against the player's sound moves?  High-policy
  // replies that lose are traps just as surely as greedy captures.
  let policyByCandidate: Map<number, Lc0PolicyMove[]> | undefined;
  if (hybridMode && rankedCandidates.length > 0) {
    onProgress?.({
      phase: "lc0",
      current: 0,
      total: rankedCandidates.length,
      backend: "policy",
    });
    try {
      const probeResults = await invoke<Lc0PolicyMove[][]>(
        "run_lc0_policy_probe",
        {
          positions: rankedCandidates.map((c) => c.fenAfter),
          nodes: 1000,
          topN: 3,
        },
      );
      policyByCandidate = new Map();
      for (let i = 0; i < rankedCandidates.length; i++) {
        if (probeResults[i]?.length) policyByCandidate.set(i, probeResults[i]);
      }
    } catch (e) {
      console.warn("Lc0 policy probe failed, continuing without:", e);
    }
  }

  // Step 3.5b — Trap probe: evaluate the opponent's tempting replies and
  // check whether they lose badly compared to best play.
  let trapResults = new Map<number, TrapResult>();
  if (rankedCandidates.length > 0) {
    try {
      trapResults = await probeTrapCandidates(
        rankedCandidates,
        gameHistory,
        sanMoves,
        evaluations,
        sfDepth,
        policyByCandidate,
        (current, total) => onProgress?.({ phase: "engine", current, total }),
      );
    } catch (e) {
      console.warn("Trap probe failed, continuing without:", e);
    }
  }

  // Merge and connect opportunities to the moves that punished them.
  const criticalMoments = applyCapitalization(
    [...moments, ...finalizeCandidateMoments(rankedCandidates, trapResults, evaluations)],
    gameHistory,
    sanMoves,
    evaluations,
    perspective,
    includeOpportunities,
  );

  // Step 3.6 — Lc0 strategic pass (hybrid mode only)
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

  // Step 4 — LLM explanation for player's critical moments + opportunities.
  // A running log of earlier moments is passed along so the coach can
  // connect plans across the game (narrative continuity).
  const playerMoments = criticalMoments.filter(m =>
    m.side === perspective ||
    m.category === "opportunity" ||
    m.category === "golden_opportunity" // legacy reports
  );
  const explained: CriticalMomentWithExplanation[] = [];
  const sessionLog: string[] = [];
  for (let i = 0; i < playerMoments.length; i++) {
    onProgress?.({ phase: "llm", current: i + 1, total: playerMoments.length });
    const m = playerMoments[i];
    try {
      const explanation = await invoke<string>("explain_critical_moment", {
        moment: momentToPayload(m),
        perspective,
        sessionLog: sessionLog.length > 0 ? sessionLog.join("\n") : null,
      });
      explained.push({ ...m, llmExplanation: explanation });
      // One-line digest for the narrative context of later moments
      const firstSentence = explanation.split(/(?<=[.!?])\s/)[0] ?? explanation;
      sessionLog.push(
        `- ${m.moveNumber}. ${m.moveSan} (${m.category}): ${firstSentence.slice(0, 160)}`,
      );
    } catch (e) {
      explained.push({
        ...m,
        llmExplanation: `Analysis unavailable: ${e}`,
      });
    }
  }

  // Step 5 — Thematic summary across all moments
  const gameResult = determineGameResult(gameHistory, perspective, pgnResult);
  onProgress?.({ phase: "summary" });
  let thematicSummary = "";

  // Build moments payload with Lc0 + trap data for the summary too
  const momentsForSummary = criticalMoments.map(momentToPayload);

  if (criticalMoments.length > 0) {
    try {
      thematicSummary = await invoke<string>("generate_thematic_summary", {
        moments: momentsForSummary,
        perspective,
        includeGreatMoves,
        includeOpportunities,
        gameResult,
      });
    } catch (e) {
      thematicSummary = `Summary unavailable: ${e}`;
    }
  } else {
    // playerMoments is a subset of criticalMoments, so both are empty here.
    thematicSummary = "No critical moments were detected in your play — solid game!";
  }

  onProgress?.({ phase: "complete" });
  return {
    report: { criticalMoments: explained, thematicSummary },
    evaluations,
  };
}
