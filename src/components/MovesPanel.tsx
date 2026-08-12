// Live game score: the current game's moves as clickable chips.
// Persistent panel in play view — the report mode has its own richer list.
import { useEffect, useRef } from "react";
import { moveInfoAt } from "../gameAnalysis";

interface MovesPanelProps {
  fens: string[]; // gameHistory — position i is before move i
  sans: string[]; // gameSanList
  currentIndex: number; // currentMoveIndex (0 = initial position)
  onNavigate: (historyIndex: number) => void;
}

export function MovesPanel({
  fens,
  sans,
  currentIndex,
  onNavigate,
}: MovesPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current move visible while navigating.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-current-move="true"]');
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [currentIndex]);

  if (sans.length === 0) {
    return (
      <div className="moves-panel">
        <div className="moves-panel-empty">
          No moves yet — play on the board or import a game.
        </div>
      </div>
    );
  }

  return (
    <div className="moves-panel" ref={listRef}>
      <div className="moves-panel-list">
        {sans.map((san, i) => {
          const { moveNumber, side } = moveInfoAt(fens, i);
          const isCurrent = currentIndex === i + 1;
          return (
            <span key={i} style={{ display: "contents" }}>
              {side === "white" && (
                <span className="moves-panel-num">{moveNumber}.</span>
              )}
              {side === "black" && i === 0 && (
                <span className="moves-panel-num">{moveNumber}...</span>
              )}
              <button
                className={`move-chip moves-panel-chip${isCurrent ? " moves-chip-current" : ""}`}
                data-current-move={isCurrent ? "true" : undefined}
                onClick={() => onNavigate(i + 1)}
              >
                {san}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
