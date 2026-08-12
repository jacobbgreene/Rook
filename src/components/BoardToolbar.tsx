// Compact icon toolbar under the board: navigation cluster on the left,
// board actions on the right.  Tooltips double as shortcut documentation.
import {
  SkipBackIcon,
  BackIcon,
  ForwardIcon,
  SkipForwardIcon,
  FlipIcon,
  ResetIcon,
  ImportIcon,
} from "../icons";

interface BoardToolbarProps {
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onStart: () => void;
  onBack: () => void;
  onForward: () => void;
  onEnd: () => void;
  onFlip: () => void;
  /** Optional — omit in contexts where they don't apply (e.g. report mode). */
  onReset?: () => void;
  onImport?: () => void;
}

export function BoardToolbar({
  canNavigateBack,
  canNavigateForward,
  onStart,
  onBack,
  onForward,
  onEnd,
  onFlip,
  onReset,
  onImport,
}: BoardToolbarProps) {
  return (
    <div className="board-toolbar">
      <div className="toolbar-cluster">
        <button
          className="action-button icon-btn"
          onClick={onStart}
          disabled={!canNavigateBack}
          title="First position (,)"
        >
          <SkipBackIcon />
        </button>
        <button
          className="action-button icon-btn"
          onClick={onBack}
          disabled={!canNavigateBack}
          title="Previous move (←)"
        >
          <BackIcon />
        </button>
        <button
          className="action-button icon-btn"
          onClick={onForward}
          disabled={!canNavigateForward}
          title="Next move (→)"
        >
          <ForwardIcon />
        </button>
        <button
          className="action-button icon-btn"
          onClick={onEnd}
          disabled={!canNavigateForward}
          title="Last position (.)"
        >
          <SkipForwardIcon />
        </button>
      </div>
      <div className="toolbar-divider" />
      <div className="toolbar-cluster">
        <button
          className="action-button icon-btn"
          onClick={onFlip}
          title="Flip board"
        >
          <FlipIcon />
        </button>
        {onImport && (
          <button
            className="action-button icon-btn"
            onClick={onImport}
            title="Import FEN or PGN"
          >
            <ImportIcon />
          </button>
        )}
        {onReset && (
          <button
            className="action-button icon-btn"
            onClick={onReset}
            title="Reset board"
          >
            <ResetIcon />
          </button>
        )}
      </div>
    </div>
  );
}
