// The board column shared by play view and report view:
// vertical eval bar pinned to the board's exact height, board, toolbar.
import { memo, useMemo, type ReactNode } from "react";
import { Chessboard } from "react-chessboard";

// Memoized so engine-eval updates (which only affect EvalBar) don't
// re-render the board — react-chessboard v5 re-renders all 64 squares on
// every render, which causes jank mid-drag.
const MemoChessboard = memo(Chessboard);
import { EvalBar } from "./EvalBar";
import { BoardToolbar } from "./BoardToolbar";

interface Arrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

interface BoardSectionProps {
  fen: string;
  boardOrientation: "white" | "black";
  arrows: Arrow[];
  squareStyles: Record<string, { backgroundColor: string }>;
  onPieceDrop: (args: {
    sourceSquare: string;
    targetSquare: string | null;
  }) => boolean;
  evaluation: string;
  sideToMove: "w" | "b";
  isCheckmate: boolean;
  hasGame: boolean;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onStart: () => void;
  onBack: () => void;
  onForward: () => void;
  onEnd: () => void;
  onFlip: () => void;
  onImport?: () => void;
  onReset?: () => void;
  /** Rendered under the toolbar (e.g. the back-to-main-line button). */
  children?: ReactNode;
}

export function BoardSection({
  fen,
  boardOrientation,
  arrows,
  squareStyles,
  onPieceDrop,
  evaluation,
  sideToMove,
  isCheckmate,
  hasGame,
  canNavigateBack,
  canNavigateForward,
  onStart,
  onBack,
  onForward,
  onEnd,
  onFlip,
  onImport,
  onReset,
  children,
}: BoardSectionProps) {
  // Stable identity across renders: MemoChessboard only re-renders when one
  // of these inputs actually changes (not on every engine eval flush).
  const options = useMemo(
    () => ({
      position: fen,
      onPieceDrop,
      arrows,
      boardOrientation,
      animationDurationInMs: 120,
      squareStyles,
    }),
    [fen, onPieceDrop, arrows, boardOrientation, squareStyles],
  );
  return (
    <div className="board-col">
      <div className="board-row">
        <EvalBar
          evaluation={evaluation}
          sideToMove={sideToMove}
          isCheckmate={isCheckmate}
          boardOrientation={boardOrientation}
          hasGame={hasGame}
        />
        <div className="board-wrap">
          <MemoChessboard options={options} />
        </div>
      </div>
      <BoardToolbar
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onStart={onStart}
        onBack={onBack}
        onForward={onForward}
        onEnd={onEnd}
        onFlip={onFlip}
        onImport={onImport}
        onReset={onReset}
      />
      {children}
    </div>
  );
}
