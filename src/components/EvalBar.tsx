// Vertical evaluation bar, rendered beside the board.
// The side you're viewing as fills from the bottom (standard chess-app
// convention); the label shows the eval from that side's perspective.

interface EvalBarProps {
  /** Live/stored eval string: "0.42" (pawns, side-to-move pov) or "M3". */
  evaluation: string;
  sideToMove: "w" | "b";
  isCheckmate: boolean;
  boardOrientation: "white" | "black";
  /** False on a fresh/empty board — renders the neutral 50% state. */
  hasGame: boolean;
}

export function EvalBar({
  evaluation,
  sideToMove,
  isCheckmate,
  boardOrientation,
  hasGame,
}: EvalBarProps) {
  let percent = 50;
  let label = "";
  let labelColor = "#fff";

  if (evaluation && hasGame) {
    const isBlackTurn = sideToMove === "b";
    let evalFromWhite: number;
    let isMate = false;
    let mateNum = 0;

    // Checkmate: read the board directly — the eval string may be stale.
    if (isCheckmate) {
      isMate = true;
      const whiteWon = isBlackTurn; // side to move is mated
      evalFromWhite = whiteWon ? Infinity : -Infinity;
    } else if (evaluation.startsWith("M")) {
      isMate = true;
      mateNum = parseInt(evaluation.slice(1), 10);
      const whiteMating = isBlackTurn ? mateNum < 0 : mateNum > 0;
      evalFromWhite = whiteMating ? Infinity : -Infinity;
    } else {
      const raw = parseFloat(evaluation);
      evalFromWhite = isBlackTurn ? -raw : raw;
    }

    // Sigmoid: 50% at 0, saturating towards the winning side.
    percent = 50 + 50 * (2 / (1 + Math.exp(-evalFromWhite * 0.3)) - 1);

    const perspectiveEval =
      boardOrientation === "white" ? evalFromWhite : -evalFromWhite;
    if (isCheckmate) {
      // A delivered mate — show "#" rather than "M0".
      label = perspectiveEval > 0 ? "#" : "-#";
    } else if (isMate) {
      label =
        perspectiveEval > 0
          ? `M${Math.abs(mateNum)}`
          : `-M${Math.abs(mateNum)}`;
    } else {
      const sign = perspectiveEval > 0 ? "+" : "";
      label = `${sign}${perspectiveEval.toFixed(2)}`;
    }
    labelColor = percent > 55 ? "#333" : percent < 45 ? "#eee" : "#fff";
  }

  return (
    <div className="eval-bar-v" role="img" aria-label={`Evaluation ${label || "even"}`}>
      <div
        className="eval-bar-v-fill"
        style={{
          // scaleY instead of height: composited on the GPU, no layout
          // reflow of .board-row on every streamed eval update.
          transform: `scaleY(${percent / 100})`,
          // The side you view as fills from the bottom.
          transformOrigin: boardOrientation === "white" ? "bottom" : "top",
        }}
      />
      <div className="eval-bar-v-label" style={{ color: labelColor }}>
        {label}
      </div>
    </div>
  );
}
