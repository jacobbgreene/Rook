// The board column shared by play view and report view:
// vertical eval bar pinned to the board's exact height, board, toolbar.
import type { ReactNode } from "react";
import { Chessboard } from "react-chessboard";
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
          <Chessboard
            options={{
              position: fen,
              onPieceDrop,
              arrows,
              boardOrientation,
              animationDurationInMs: 120,
              squareStyles,
            }}
          />
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
