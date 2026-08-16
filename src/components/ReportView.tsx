// Dedicated report mode: board + eval bar + navigation on the left,
// the game-wide summary and the move list with inline moment cards
// on the right.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChessMarkdown } from "./ChessMarkdown";
import { animate, stagger } from "animejs";
import {
  moveInfoAt,
  type AnalysisPhase,
  type CriticalMomentWithExplanation,
  type GameAnalysisReport,
} from "../gameAnalysis";
import { stripLatex } from "../utils";
import { bouncy, PopIn } from "../animate";
import { BoardSection } from "./BoardSection";

type Moment = CriticalMomentWithExplanation;

interface Arrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  turning_point: "Turning Point",
  great_move: "Great Move",
  brilliant: "Brilliant!",
  trap: "Trap!",
  capitalized: "Capitalized!",
  critical: "Critical",
  golden_opportunity: "Golden Opportunity",
  opportunity: "Opportunity",
};

function categoryLabel(m: Moment): string {
  return (
    CATEGORY_LABEL[m.category] ??
    m.category.charAt(0).toUpperCase() + m.category.slice(1)
  );
}

function chipStyle(category: string): {
  chipBg: string;
  chipColor: string;
  chipBorder: string;
} {
  switch (category) {
    case "blunder":
      return {
        chipBg: "rgba(255, 80, 80, 0.15)",
        chipColor: "#ff6b6b",
        chipBorder: "1px solid rgba(255, 80, 80, 0.3)",
      };
    case "mistake":
      return {
        chipBg: "rgba(255, 165, 0, 0.12)",
        chipColor: "#ffb067",
        chipBorder: "1px solid rgba(255, 165, 0, 0.3)",
      };
    case "inaccuracy":
      return {
        chipBg: "rgba(255, 220, 80, 0.1)",
        chipColor: "#e8d44d",
        chipBorder: "1px solid rgba(255, 220, 80, 0.25)",
      };
    case "turning_point":
      return {
        chipBg: "rgba(80, 180, 255, 0.12)",
        chipColor: "#6bc5ff",
        chipBorder: "1px solid rgba(80, 180, 255, 0.3)",
      };
    case "great_move":
    case "capitalized":
      return {
        chipBg: "rgba(74, 222, 128, 0.15)",
        chipColor: "#4ade80",
        chipBorder: "1px solid rgba(74, 222, 128, 0.3)",
      };
    case "brilliant":
      return {
        chipBg: "rgba(251, 191, 36, 0.15)",
        chipColor: "#fbbf24",
        chipBorder: "1px solid rgba(251, 191, 36, 0.3)",
      };
    case "trap":
      return {
        chipBg: "rgba(244, 114, 182, 0.15)",
        chipColor: "#f472b6",
        chipBorder: "1px solid rgba(244, 114, 182, 0.3)",
      };
    case "critical":
      return {
        chipBg: "rgba(34, 211, 238, 0.15)",
        chipColor: "#22d3ee",
        chipBorder: "1px solid rgba(34, 211, 238, 0.3)",
      };
    case "opportunity":
      return {
        chipBg: "rgba(196, 181, 253, 0.15)",
        chipColor: "#c4b5fd",
        chipBorder: "1px solid rgba(196, 181, 253, 0.35)",
      };
    case "golden_opportunity":
      return {
        chipBg: "rgba(244, 114, 182, 0.15)",
        chipColor: "#f472b6",
        chipBorder: "1px solid rgba(244, 114, 182, 0.3)",
      };
    default:
      return { chipBg: "transparent", chipColor: "#ddd", chipBorder: "none" };
  }
}

function evalChipColor(m: Moment): string | undefined {
  switch (m.category) {
    case "great_move":
    case "capitalized":
      return "#4ade80";
    case "brilliant":
      return "#fbbf24";
    case "trap":
      return "#f472b6";
    case "critical":
      return "#22d3ee";
    case "opportunity":
    case "golden_opportunity":
      return "#c4b5fd";
    default:
      return undefined;
  }
}

function evalChipText(m: Moment): string {
  if (m.category === "brilliant") return "!!";
  if (m.category === "trap") {
    return (m.refutationEval ?? 0) >= 50
      ? "mate"
      : `+${((m.refutationEval ?? 0) - (m.side === "white" ? m.evalAfter : -m.evalAfter)).toFixed(1)}`;
  }
  if (
    m.evalDrop > 0 &&
    (m.category === "blunder" ||
      m.category === "mistake" ||
      m.category === "inaccuracy")
  ) {
    return `−${m.evalDrop.toFixed(1)}`;
  }
  return `+${Math.abs(m.evalDrop).toFixed(1)}`;
}

function ProgressView({
  progress,
  onCancel,
}: {
  progress: AnalysisPhase;
  onCancel: () => void;
}) {
  return (
    <div className="analysis-progress">
      {progress.phase === "engine" && (
        <>
          <div className="progress-label">
            Evaluating positions with Stockfish...
          </div>
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{
                width: `${(progress.current / progress.total) * 100}%`,
              }}
            />
          </div>
          <div className="progress-count">
            {progress.current} / {progress.total} positions
          </div>
        </>
      )}
      {progress.phase === "lc0" && (
        <>
          <div className="progress-label">
            Lc0 strategic analysis...
            {progress.backend && (
              <span
                className="lc0-backend-badge"
                data-gpu={
                  !["eigen", "trivial", "random", "unknown"].includes(
                    progress.backend,
                  )
                }
              >
                {progress.backend}
              </span>
            )}
          </div>
          {progress.backend &&
            ["eigen", "trivial", "random"].includes(progress.backend) && (
              <div className="lc0-cpu-warning">
                CPU fallback — install Lc0 with OpenCL for GPU acceleration
              </div>
            )}
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill lc0-fill"
              style={{
                width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="progress-count">
            {progress.current} / {progress.total} positions
          </div>
        </>
      )}
      {progress.phase === "llm" && (
        <>
          <div className="progress-label">AI analyzing critical moments...</div>
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{
                width: `${(progress.current / progress.total) * 100}%`,
              }}
            />
          </div>
          <div className="progress-count">
            {progress.current} / {progress.total} moments
          </div>
        </>
      )}
      {progress.phase === "summary" && (
        <div className="progress-label">Generating thematic summary...</div>
      )}
      <button
        className="action-button progress-cancel-btn"
        onClick={onCancel}
      >
        Cancel analysis
      </button>
    </div>
  );
}

interface ReportViewProps {
  // Board
  fen: string;
  boardOrientation: "white" | "black";
  arrows: Arrow[];
  squareStyles: Record<string, { backgroundColor: string }>;
  onPieceDrop: (args: {
    sourceSquare: string;
    targetSquare: string | null;
  }) => boolean;
  // Eval bar
  evaluation: string;
  sideToMove: "w" | "b";
  isCheckmate: boolean;
  // Navigation
  currentMoveIndex: number;
  historyLength: number;
  onStart: () => void;
  onBack: () => void;
  onForward: () => void;
  onEnd: () => void;
  onFlip: () => void;
  // Header
  title: string;
  perspective: "white" | "black";
  result?: string;
  /** Player names (from PGN headers / saved report) for title highlighting. */
  whitePlayer?: string | null;
  blackPlayer?: string | null;
  onExitToGame: () => void;
  onCloseReport: () => void;
  onRegenerate: () => void;
  onOpenLibrary: () => void;
  onCancelAnalysis: () => void;
  // Report data
  isLoading: boolean;
  analysisProgress: AnalysisPhase | null;
  /** Moments classified so far — drives the toast popups by the eval bar. */
  classifiedMoments: {
    moveNumber: number;
    side: string;
    category: string;
    moveSan: string;
    fen: string;
  }[];
  report: GameAnalysisReport | null;
  reportPerspective: "white" | "black";
  // Move list interaction
  mainLineHistory: string[] | null;
  mainLineSanMoves: string[] | null;
  gameHistory: string[];
  gameSanList: string[];
  isExploringVariation: boolean;
  onNavigateToMainLineMove: (historyIndex: number) => void;
  onPlayBestLine: (fen: string, sanMoves: string[], targetIndex: number) => void;
  onBackToMainLine: () => void;
}

export function ReportView(props: ReportViewProps) {
  const {
    fen,
    boardOrientation,
    arrows,
    squareStyles,
    onPieceDrop,
    evaluation,
    sideToMove,
    isCheckmate,
    currentMoveIndex,
    historyLength,
    onStart,
    onBack,
    onForward,
    onEnd,
    onFlip,
    title,
    perspective,
    result,
    whitePlayer,
    blackPlayer,
    onExitToGame,
    onCloseReport,
    onRegenerate,
    onOpenLibrary,
    onCancelAnalysis,
    isLoading,
    analysisProgress,
    classifiedMoments,
    report,
    reportPerspective,
    mainLineHistory,
    mainLineSanMoves,
    gameHistory,
    gameSanList,
    isExploringVariation,
    onNavigateToMainLineMove,
    onPlayBestLine,
    onBackToMainLine,
  } = props;

  // Keep the active move scrolled into view while navigating.
  useEffect(() => {
    const el = document.querySelector('[data-current-move="true"]');
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [currentMoveIndex]);

  // Bouncy entrance: summary card first, then moment cards stagger in.
  // Runs once per newly loaded report (the effect's nodes re-render during
  // navigation, but the animation only replays when `report` changes).
  useLayoutEffect(() => {
    if (!report) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animate(".report-summary", {
      opacity: [0, 1],
      y: [10, 0],
      ease: bouncy(),
    });
    animate(".cm-inline", {
      opacity: [0, 1],
      y: [10, 0],
      scale: [0.985, 1],
      ease: bouncy(0.25, 450),
      delay: stagger(60),
    });
  }, [report]);

  // Stabilize the callbacks so the move list memo below isn't defeated by
  // fresh function identities from App on every render.
  const navigateRef = useRef(onNavigateToMainLineMove);
  navigateRef.current = onNavigateToMainLineMove;

  // Clicking a move chip in the summary/explanations jumps to that move on
  // the board. Repeated SANs resolve to the first occurrence. Ref-based so
  // the memoized move list below never captures a stale move list.
  const sanMovesRef = useRef<string[]>([]);
  sanMovesRef.current = mainLineSanMoves || gameSanList;
  const navigateToSan = (san: string) => {
    const idx = sanMovesRef.current.findIndex((s) => s === san);
    if (idx >= 0) navigateRef.current(idx + 1);
  };

  // Moment toasts: during the LLM phase the progress event carries the FEN
  // of the moment currently being explained — the toast for that moment
  // pops while the coach works on it, in sync with the board. Nothing
  // shows during the engine/Lc0 phases.
  const llmFen =
    isLoading && analysisProgress?.phase === "llm"
      ? analysisProgress.fen
      : undefined;
  const activeToast = llmFen
    ? classifiedMoments.find((m) => m.fen === llmFen)
    : null;
  const playBestLineRef = useRef(onPlayBestLine);
  playBestLineRef.current = onPlayBestLine;

  // Memoized: while freely exploring a variation the live engine flushes
  // at 10 Hz, and this rebuilds every move chip plus a ReactMarkdown parse
  // per moment card — only redo it when the inputs actually change.
  const movesContent = useMemo(() => {
    if (!report) return null;
    const sanMoves = mainLineSanMoves || gameSanList;
    if (sanMoves.length === 0) return null;

    const momentMap = new Map<string, Moment>();
    for (const m of report.criticalMoments) {
      momentMap.set(`${m.moveNumber}-${m.side}`, m);
    }
    const fens = mainLineHistory || gameHistory;
    // fen → history index, built once (was indexOf per moment card)
    const fenIndex = new Map<string, number>();
    gameHistory.forEach((f, idx) => fenIndex.set(f, idx));

    const elements: React.ReactNode[] = [];
    // Group moves into rows of 3 full moves; a moment card breaks the row.
    let currentRow: React.ReactNode[] = [];
    let movesInRow = 0;
    let needsContinuation = false;

    const flushRow = (key: string) => {
      if (currentRow.length > 0) {
        elements.push(
          <div key={key} className="report-move-row">
            {currentRow}
          </div>,
        );
        currentRow = [];
        movesInRow = 0;
      }
    };

    for (let i = 0; i < sanMoves.length; i++) {
      const { moveNumber, side } = moveInfoAt(fens, i);
      const isWhite = side === "white";
      const historyIndex = i + 1;
      const moment = momentMap.get(`${moveNumber}-${side}`);
      const isPlayerMoment = moment && moment.side === reportPerspective;
      const isOpportunity =
        moment &&
        moment.side !== reportPerspective &&
        (moment.category === "opportunity" ||
          moment.category === "golden_opportunity");
      const isCurrentMove =
        !isExploringVariation && currentMoveIndex === historyIndex;

      if (isWhite && movesInRow >= 3) {
        flushRow(`row-before-${i}`);
      }

      if (isWhite) {
        currentRow.push(
          <span key={`num-${i}`} className="moves-panel-num">
            {moveNumber}.
          </span>,
        );
      } else if (i === 0) {
        // Game starts with Black to move (imported FEN) — label it
        currentRow.push(
          <span key={`num-${i}`} className="moves-panel-num">
            {moveNumber}...
          </span>,
        );
      } else if (needsContinuation) {
        currentRow.push(
          <span key={`cont-${i}`} className="moves-panel-num">
            {moveNumber}...
          </span>,
        );
        needsContinuation = false;
      }

      let chipBg = "transparent";
      let chipColor = "#ddd";
      let chipBorder = "none";
      if (!isCurrentMove && (isPlayerMoment || isOpportunity) && moment) {
        ({ chipBg, chipColor, chipBorder } = chipStyle(moment.category));
      }

      currentRow.push(
        <span
          key={`move-${i}`}
          className="move-chip"
          onClick={() => navigateRef.current(historyIndex)}
          data-current-move={isCurrentMove ? "true" : undefined}
          style={{
            cursor: "pointer",
            backgroundColor: isCurrentMove ? "#3a5a8a" : chipBg,
            color: isCurrentMove ? "#fff" : chipColor,
            padding: "2px 6px",
            borderRadius: "3px",
            border: isCurrentMove ? "none" : chipBorder,
            marginRight: "4px",
            fontFamily: "monospace",
            fontSize: "0.9rem",
            display: "inline",
            boxShadow: "none",
          }}
        >
          {sanMoves[i]}
        </span>,
      );

      if (!isWhite) movesInRow++;

      // Player moments + opportunities: flush row, render card, start new row
      if ((isPlayerMoment || isOpportunity) && moment) {
        flushRow(`row-before-card-${i}`);
        const fenIdx = fenIndex.get(moment.fen) ?? -1;
        const activeBestLineIdx =
          fenIdx >= 0 && isExploringVariation
            ? currentMoveIndex - fenIdx - 1
            : -1;
        elements.push(
          <div
            key={`card-${i}`}
            className="critical-moment-card cm-inline"
            style={{ cursor: "pointer" }}
            onClick={() => navigateRef.current(historyIndex)}
          >
            <div className="cm-header">
              <span className={`category-badge badge-${moment.category}`}>
                {categoryLabel(moment)}
              </span>
              <span className="cm-move-info">
                Move {moment.moveNumber}: <strong>{moment.moveSan}</strong>
              </span>
              <span
                className="cm-eval-drop"
                style={
                  evalChipColor(moment)
                    ? { color: evalChipColor(moment) }
                    : undefined
                }
              >
                {evalChipText(moment)}
              </span>
            </div>
            {moment.category !== "great_move" &&
              moment.category !== "critical" &&
              moment.category !== "brilliant" &&
              moment.bestLine.length > 0 &&
              (moment.category === "opportunity" ||
                moment.category === "golden_opportunity" ||
                moment.category === "trap" ||
                moment.category === "capitalized" ||
                moment.side === reportPerspective) && (
                <div
                  className="cm-best-line"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>
                    {moment.baitMoveSan ? (
                      <>
                        If <strong>{moment.baitMoveSan}</strong>??
                      </>
                    ) : moment.category === "opportunity" ||
                      moment.category === "golden_opportunity" ? (
                      "Best response:"
                    ) : moment.category === "capitalized" ? (
                      "Punishment:"
                    ) : (
                      "Best:"
                    )}
                  </span>
                  {moment.bestLine.map((san, idx) => (
                    <span key={idx} style={{ display: "contents" }}>
                      {idx > 0 && <span className="best-line-arrow">→</span>}
                      <span
                        className={`best-line-move${idx === activeBestLineIdx ? " best-line-active" : ""}`}
                        onClick={() =>
                          playBestLineRef.current(moment.fen, moment.bestLine, idx)
                        }
                      >
                        {san}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            <div className="cm-explanation">
              <ChessMarkdown onMoveClick={navigateToSan}>
                {stripLatex(moment.llmExplanation)}
              </ChessMarkdown>
            </div>
          </div>,
        );
        needsContinuation = isWhite;
      }
    }

    flushRow("row-final");

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {elements}
      </div>
    );
  }, [
    report,
    mainLineSanMoves,
    gameSanList,
    mainLineHistory,
    gameHistory,
    currentMoveIndex,
    isExploringVariation,
    reportPerspective,
  ]);

  return (
    <div className="report-view">
      <PopIn className="report-header">
        <button className="action-button" onClick={onExitToGame}>
          ← Back to game
        </button>
        <div className="report-header-title" title={title}>
          {whitePlayer || blackPlayer ? (
            <>
              <span
                className={
                  perspective === "white" ? "report-player-you" : undefined
                }
              >
                {whitePlayer ?? "White"}
              </span>
              <span className="report-player-dash"> – </span>
              <span
                className={
                  perspective === "black" ? "report-player-you" : undefined
                }
              >
                {blackPlayer ?? "Black"}
              </span>
            </>
          ) : (
            title
          )}
        </div>
        <span className={`perspective-badge perspective-${perspective}`}>
          {perspective}
        </span>
        {result && result !== "unknown" && (
          <span className={`result-badge result-${result}`}>
            {result === "win" ? "W" : result === "loss" ? "L" : "D"}
          </span>
        )}
        <button
          className="action-button"
          onClick={onRegenerate}
          disabled={isLoading}
          title="Re-run analysis with current settings"
        >
          ↻ Regenerate
        </button>
        <button className="action-button" onClick={onOpenLibrary}>
          Saved Reports
        </button>
        <button
          className="settings-button"
          onClick={onCloseReport}
          title="Close report"
          style={{ marginLeft: "4px" }}
        >
          ✕
        </button>
      </PopIn>

      <div className="report-body">
        <div className="board-toast-wrap">
          {activeToast && (
            <div
              key={activeToast.fen}
              className="moment-toast"
            >
              <span className={`category-badge badge-${activeToast.category}`}>
                {CATEGORY_LABEL[activeToast.category] ??
                  activeToast.category.charAt(0).toUpperCase() +
                    activeToast.category.slice(1)}
              </span>
              <span className="moment-toast-move">
                {activeToast.moveNumber}. {activeToast.moveSan}
              </span>
            </div>
          )}
          <BoardSection
            fen={fen}
            boardOrientation={boardOrientation}
            arrows={currentMoveIndex === 0 ? [] : arrows}
            squareStyles={squareStyles}
            onPieceDrop={onPieceDrop}
            evaluation={evaluation}
            sideToMove={sideToMove}
            isCheckmate={isCheckmate}
            hasGame={currentMoveIndex > 0}
            canNavigateBack={currentMoveIndex > 0}
            canNavigateForward={currentMoveIndex < historyLength - 1}
            onStart={onStart}
            onBack={onBack}
            onForward={onForward}
            onEnd={onEnd}
            onFlip={onFlip}
          >
            {isExploringVariation && (
              <PopIn className="back-to-main-btn" onClick={onBackToMainLine}>
                ← Back to main line
              </PopIn>
            )}
            {/* The thematic summary gets its own pane under the board instead
                of competing with the move browser for side-column height. */}
            {!isLoading && report && (
              <div className="report-summary report-summary-board">
                <ChessMarkdown onMoveClick={navigateToSan}>
                  {stripLatex(report.thematicSummary)}
                </ChessMarkdown>
              </div>
            )}
          </BoardSection>
        </div>

        <div className="report-side">
          {isLoading && analysisProgress ? (
            <ProgressView
              progress={analysisProgress}
              onCancel={onCancelAnalysis}
            />
          ) : report ? (
            <>
              <div className="report-moves-scroll">{movesContent}</div>
              {report.criticalMoments.filter(
                (m) =>
                  m.side === reportPerspective ||
                  m.category === "opportunity" ||
                  m.category === "golden_opportunity",
              ).length === 0 && (
                <div className="report-empty-note">
                  No critical moments detected for your play — solid game!
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
