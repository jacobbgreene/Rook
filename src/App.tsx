import { useState, useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { ChessEngine } from "./chessEngine";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface Arrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

interface EngineThought {
  multipv: number;
  depth: string;
  score: string;
  moves: any[];
  rawFirstMove: string;
}

const SkipBackIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 20L9 12l10-8V20z" />
    <line x1="5" y1="4" x2="5" y2="20" />
  </svg>
);
const BackIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
const ForwardIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);
const SkipForwardIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 4l10 8-10 8V4z" />
    <line x1="19" y1="4" x2="19" y2="20" />
  </svg>
);
const FlipIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="17 1 21 5 17 9"></polyline>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <polyline points="7 23 3 19 7 15"></polyline>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
  </svg>
);
const ResetIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);
const CoachIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
    <path d="M12 12L2.1 10.05" />
    <path d="M12 12l1.21-9.81" />
    <path d="M12 12l8.76-4.81" />
    <path d="M12 12l5.88 8.09" />
    <path d="M12 12l-9.46 3.25" />
  </svg>
);

function App() {
  const [game, setGame] = useState(new Chess());
  const [gameHistory, setGameHistory] = useState<string[]>([new Chess().fen()]);
  const [currentMoveIndex, setCurrentMoveIndex] = useState(0);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">(
    "white",
  );

  const [evaluation, setEvaluation] = useState("");
  const [engineThoughts, setEngineThoughts] = useState<
    Record<number, EngineThought>
  >({});
  const [coachMessage, setCoachMessage] = useState("");
  const [isCoachLoading, setIsCoachLoading] = useState(false);
  const engineRef = useRef<ChessEngine | null>(null);
  const currentFenRef = useRef(new Chess().fen());
  const analysisGenRef = useRef(0);
  const widenedRef = useRef(false);
  const evalDepthRef = useRef(0);

  useEffect(() => {
    engineRef.current = new ChessEngine();
    engineRef.current.onMessage((msg) => {
      if (msg.startsWith("info depth") && !msg.includes("currmovenumber")) {
        const depthMatch = msg.match(/depth (\d+)/);
        const multipvMatch = msg.match(/multipv (\d+)/);
        const pvMatch = msg.match(/ pv (.+)/);

        let score = "";
        if (msg.includes("score cp")) {
          const match = msg.match(/score cp (-?\d+)/);
          if (match) {
            score = (parseInt(match[1]) / 100).toFixed(2);
          }
        } else if (msg.includes("score mate")) {
          const match = msg.match(/score mate (-?\d+)/);
          if (match) {
            score = `M${match[1]}`;
          }
        }

        if (depthMatch && pvMatch) {
          const depth = depthMatch[1];
          const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
          const rawMoves = pvMatch[1].split(" ").slice(0, 5);

          // Capture current analysis generation for stale detection
          const msgGen = analysisGenRef.current;

          // Discard stale results from a previous position
          const firstMove = rawMoves[0];
          if (firstMove && firstMove.length >= 4) {
            try {
              const testGame = new Chess(currentFenRef.current);
              testGame.move({
                from: firstMove.slice(0, 2),
                to: firstMove.slice(2, 4),
                promotion: firstMove.length >= 5 ? firstMove[4] : undefined,
              });
            } catch {
              return; // move is illegal in current position — stale result
            }
          }

          setEngineThoughts((prev) => {
            // Discard if a new analysis started since this message arrived
            if (msgGen !== analysisGenRef.current) return prev;

            const currentLine = prev[multipv];
            if (
              !currentLine ||
              parseInt(depth) >= parseInt(currentLine.depth)
            ) {
              return {
                ...prev,
                [multipv]: {
                  multipv,
                  depth,
                  score,
                  moves: rawMoves,
                  rawFirstMove: rawMoves[0],
                },
              };
            }
            return prev;
          });

          const depthNum = parseInt(depth);

          if (
            multipv === 1 &&
            score &&
            msgGen === analysisGenRef.current &&
            depthNum >= 5 &&
            depthNum >= evalDepthRef.current
          ) {
            evalDepthRef.current = depthNum;
            setEvaluation(score);
          }

          // Phase 2: once depth 8 is reached, widen to 5 lines
          if (
            multipv === 1 &&
            depthNum >= 8 &&
            !widenedRef.current &&
            msgGen === analysisGenRef.current
          ) {
            widenedRef.current = true;
            engineRef.current?.widenSearch(currentFenRef.current);
          }
        }
      }
    });

    // Start analyzing the initial position
    engineRef.current.evaluatePosition(currentFenRef.current);

    return () => {
      engineRef.current?.terminate();
    };
  }, []);

  const startAnalysis = (fen: string) => {
    analysisGenRef.current += 1;
    widenedRef.current = false;
    evalDepthRef.current = 0;
    currentFenRef.current = fen;
    setEngineThoughts({});
    setEvaluation("");
    setCoachMessage("");
    if (engineRef.current) {
      const check = new Chess(fen);
      if (!check.isGameOver()) {
        engineRef.current.evaluatePosition(fen);
      } else {
        engineRef.current.stop();
      }
    }
  };

  const askCoach = async () => {
    if (isCoachLoading) return;
    setIsCoachLoading(true);
    setCoachMessage("");

    try {
      const top3Lines = Object.values(engineThoughts)
        .sort((a, b) => a.multipv - b.multipv)
        .slice(0, 3)
        .map(
          (t) => `Line #${t.multipv} (Eval ${t.score}): ${t.moves.join(" ")}`,
        )
        .join("\n");

      const response = await invoke<string>("explain_move", {
        fen: game.fen(),
        evaluation: evaluation,
        topLines: top3Lines || "Engine still analyzing...",
        perspective: boardOrientation,
      });
      setCoachMessage(response);
    } catch (error) {
      setCoachMessage(`Error calling AI Coach: ${error}`);
    } finally {
      setIsCoachLoading(false);
    }
  };

  function makeAMove(move: { from: string; to: string; promotion?: string }) {
    const gameCopy = new Chess(game.fen());
    try {
      const result = gameCopy.move(move);
      if (result) {
        const newFen = gameCopy.fen();
        startAnalysis(newFen);
        setGame(gameCopy);
        const newHistory = [
          ...gameHistory.slice(0, currentMoveIndex + 1),
          newFen,
        ];
        setGameHistory(newHistory);
        setCurrentMoveIndex(newHistory.length - 1);
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function onDrop({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }) {
    if (!targetSquare) return false;
    const move = makeAMove({
      from: sourceSquare,
      to: targetSquare,
      promotion: "q",
    });
    return move;
  }

  const moveBack = () => {
    if (currentMoveIndex > 0) {
      const newIndex = currentMoveIndex - 1;
      startAnalysis(gameHistory[newIndex]);
      setCurrentMoveIndex(newIndex);
      setGame(new Chess(gameHistory[newIndex]));
    }
  };

  const moveForward = () => {
    if (currentMoveIndex < gameHistory.length - 1) {
      const newIndex = currentMoveIndex + 1;
      startAnalysis(gameHistory[newIndex]);
      setCurrentMoveIndex(newIndex);
      setGame(new Chess(gameHistory[newIndex]));
    }
  };

  const moveToStart = () => {
    if (currentMoveIndex > 0) {
      startAnalysis(gameHistory[0]);
      setCurrentMoveIndex(0);
      setGame(new Chess(gameHistory[0]));
    }
  };

  const moveToEnd = () => {
    const lastIndex = gameHistory.length - 1;
    if (currentMoveIndex < lastIndex) {
      startAnalysis(gameHistory[lastIndex]);
      setCurrentMoveIndex(lastIndex);
      setGame(new Chess(gameHistory[lastIndex]));
    }
  };

  const flipBoard = () => {
    setBoardOrientation((prev) => (prev === "white" ? "black" : "white"));
  };

  const resetBoard = () => {
    const newGame = new Chess();
    startAnalysis(newGame.fen());
    setGame(newGame);
    setGameHistory([newGame.fen()]);
    setCurrentMoveIndex(0);
    setBoardOrientation("white");
  };

  const [importInput, setImportInput] = useState("");
  const [importError, setImportError] = useState("");

  const handleImport = () => {
    setImportError("");
    const newGame = new Chess();
    const input = importInput.trim();

    if (!input) return;

    let loaded = false;
    let isPgn = false;

    try {
      newGame.load(input);
      loaded = true;
    } catch (e) {
      // Not a valid FEN, ignore and try PGN
    }

    if (!loaded) {
      try {
        newGame.loadPgn(input);
        loaded = true;
        isPgn = true;
      } catch (e) {
        // Not a valid PGN either
      }
    }

    if (!loaded) {
      setImportError("Invalid FEN or PGN format");
      return;
    }

    if (isPgn) {
      // Reconstruct the full timeline history if a PGN was imported
      const moves = newGame.history();
      const tempGame = new Chess();
      const fens = [tempGame.fen()];

      for (const move of moves) {
        tempGame.move(move);
        fens.push(tempGame.fen());
      }

      setGameHistory(fens);
      setCurrentMoveIndex(fens.length - 1);
    } else {
      // It was a single FEN position
      setGameHistory([newGame.fen()]);
      setCurrentMoveIndex(0);
    }

    startAnalysis(newGame.fen());
    setGame(newGame);
    setImportInput("");
  };

  const playLineToMove = (moves: any[], targetIndex: number) => {
    const gameCopy = new Chess();
    const currentFen = gameHistory[currentMoveIndex];
    const baseHistory = gameHistory.slice(0, currentMoveIndex + 1);
    try {
      gameCopy.load(currentFen);
    } catch (e) {
      return;
    }

    const newHistory = [...baseHistory];

    for (let i = 0; i <= targetIndex; i++) {
      const moveVal = moves[i];
      const rawMove = typeof moveVal === "string" ? moveVal : moveVal?.raw;
      if (!rawMove) break;
      const from = rawMove.slice(0, 2);
      const to = rawMove.slice(2, 4);
      const promotion = rawMove.length >= 5 ? rawMove[4] : undefined;
      try {
        const result = gameCopy.move({ from, to, promotion });
        if (result) {
          newHistory.push(gameCopy.fen());
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (newHistory.length > baseHistory.length) {
      startAnalysis(gameCopy.fen());
      setGame(gameCopy);
      setGameHistory(newHistory);
      setCurrentMoveIndex(newHistory.length - 1);
    }
  };

  const bestMoveArrows = Object.values(engineThoughts)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 5)
    .map((thought) => {
      const move = thought.rawFirstMove;
      if (!move || move.length < 4) return null;
      let color = "rgba(128, 128, 128, 0.4)";
      if (thought.multipv === 1) color = "rgba(50, 205, 50, 0.8)";
      else if (thought.multipv === 2) color = "rgba(30, 144, 255, 0.6)";
      else if (thought.multipv === 3) color = "rgba(255, 165, 0, 0.6)";
      return {
        startSquare: move.slice(0, 2),
        endSquare: move.slice(2, 4),
        color,
      };
    })
    .filter(Boolean) as Arrow[];

  const displayThoughts = Object.values(engineThoughts)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 3);

  const uciMovesToSan = (uciMoves: any[]): string[] => {
    const tempGame = new Chess(game.fen());
    const sanMoves: string[] = [];
    for (const moveVal of uciMoves) {
      const rawMove = typeof moveVal === "string" ? moveVal : moveVal?.raw;
      if (!rawMove || rawMove.length < 4) break;
      try {
        const result = tempGame.move({
          from: rawMove.slice(0, 2),
          to: rawMove.slice(2, 4),
          promotion: rawMove.length >= 5 ? rawMove[4] : undefined,
        });
        if (result) {
          sanMoves.push(result.san);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    return sanMoves;
  };

  const getEvalInfo = () => {
    if (!evaluation)
      return { percent: 50, label: "Calculating...", labelColor: "#fff" };
    const isBlackTurn = game.turn() === "b";
    let evalFromWhite: number;
    let isMate = false;
    let mateNum = 0;

    if (evaluation.startsWith("M")) {
      isMate = true;
      mateNum = parseInt(evaluation.slice(1));
      const whiteMating = isBlackTurn ? mateNum < 0 : mateNum > 0;
      evalFromWhite = whiteMating ? 10 : -10;
    } else {
      const raw = parseFloat(evaluation);
      evalFromWhite = isBlackTurn ? -raw : raw;
    }

    const whitePercent =
      50 + 50 * (2 / (1 + Math.exp(-evalFromWhite * 0.3)) - 1);
    const percent =
      boardOrientation === "white" ? whitePercent : 100 - whitePercent;
    const perspectiveEval =
      boardOrientation === "white" ? evalFromWhite : -evalFromWhite;

    let label: string;
    if (isMate) {
      const perspectiveMatePositive = perspectiveEval > 0;
      label = perspectiveMatePositive
        ? `M${Math.abs(mateNum)}`
        : `-M${Math.abs(mateNum)}`;
    } else {
      const sign = perspectiveEval > 0 ? "+" : "";
      label = `${sign}${perspectiveEval.toFixed(2)}`;
    }

    const labelColor = percent > 55 ? "#333" : percent < 45 ? "#eee" : "#fff";
    return { percent, label, labelColor };
  };

  const evalInfo = getEvalInfo();

  const getLineStyle = (multipv: number) => {
    switch (multipv) {
      case 1:
        return {
          bg: "#2a3b2a",
          border: "#3c5c3c",
          text: "#8fbc8f",
          chipBg: "#1e2e1e",
        };
      case 2:
        return {
          bg: "#1a2b3c",
          border: "#2c4c6c",
          text: "#87cefa",
          chipBg: "#111d2b",
        };
      case 3:
        return {
          bg: "#3c2a1a",
          border: "#5c3c1a",
          text: "#ffb067",
          chipBg: "#2b1d11",
        };
      default:
        return { bg: "#222", border: "#333", text: "#aaa", chipBg: "#111" };
    }
  };

  return (
    <main className="container">
      <h1>Rook</h1>
      <div className="eval-bar-container">
        <div className="eval-bar-black-side" />
        <div
          className="eval-bar-white-side"
          style={{ width: `${evalInfo.percent}%` }}
        />
        <div className="eval-bar-label" style={{ color: evalInfo.labelColor }}>
          {evalInfo.label}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "row",
          gap: "30px",
          width: "100%",
          maxWidth: "1000px",
          justifyContent: "center",
          alignItems: "flex-start",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "15px",
            width: "550px",
            maxWidth: "100%",
          }}
        >
          <div style={{ boxShadow: "0 4px 12px rgba(0,0,0,0.3)" }}>
            <Chessboard
              options={{
                position: game.fen(),
                onPieceDrop: onDrop,
                arrows: bestMoveArrows,
                boardOrientation: boardOrientation,
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "10px",
            }}
          >
            <button
              className="action-button"
              onClick={moveToStart}
              disabled={currentMoveIndex === 0}
            >
              <SkipBackIcon /> Start
            </button>
            <button
              className="action-button"
              onClick={moveBack}
              disabled={currentMoveIndex === 0}
            >
              <BackIcon /> Back
            </button>
            <button
              className="action-button"
              onClick={moveForward}
              disabled={currentMoveIndex === gameHistory.length - 1}
            >
              Forward <ForwardIcon />
            </button>
            <button
              className="action-button"
              onClick={moveToEnd}
              disabled={currentMoveIndex === gameHistory.length - 1}
            >
              End <SkipForwardIcon />
            </button>
            <button className="action-button" onClick={flipBoard}>
              <FlipIcon /> Flip
            </button>
            <button className="action-button" onClick={resetBoard}>
              <ResetIcon /> Reset
            </button>
          </div>

          {/* Import Game Field */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "5px",
              width: "100%",
              marginTop: "10px",
            }}
          >
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="Paste FEN or PGN string here to import a position..."
                value={importInput}
                onChange={(e) => setImportInput(e.target.value)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "8px",
                  border: "1px solid #ccc",
                  fontSize: "0.9rem",
                }}
                onKeyDown={(e) => e.key === "Enter" && handleImport()}
              />
              <button
                className="action-button"
                onClick={handleImport}
                style={{ flex: "none", width: "80px" }}
              >
                Import
              </button>
            </div>
            {importError && (
              <div
                style={{
                  color: "red",
                  fontSize: "0.8rem",
                  textAlign: "left",
                  paddingLeft: "5px",
                }}
              >
                {importError}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            width: "400px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          {/* Suggested Lines Panel */}
          <div
            style={{
              height: "400px",
              border: "1px solid #444",
              borderRadius: "12px",
              padding: "20px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#1a1a1a",
              color: "#eee",
              textAlign: "left",
              boxShadow: "inset 0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <h3
              style={{
                marginTop: 0,
                borderBottom: "1px solid #444",
                paddingBottom: "15px",
                marginBottom: "15px",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>
                Best Lines for {game.turn() === "w" ? "White" : "Black"}
              </span>
              <span
                style={{
                  fontSize: "0.8rem",
                  fontWeight: "normal",
                  color: "#888",
                  backgroundColor: "#333",
                  padding: "4px 8px",
                  borderRadius: "4px",
                }}
              >
                Stockfish 16
              </span>
            </h3>

            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              {displayThoughts.length === 0 && (
                <div
                  style={{
                    fontStyle: "italic",
                    color: "#888",
                    textAlign: "center",
                    marginTop: "20px",
                  }}
                >
                  Analyzing current position...
                </div>
              )}

              {displayThoughts.map((thought) => {
                const style = getLineStyle(thought.multipv);
                const sanMoves = uciMovesToSan(thought.moves);
                return (
                  <div
                    key={thought.multipv}
                    style={{
                      backgroundColor: style.bg,
                      border: `1px solid ${style.border}`,
                      borderRadius: "6px",
                      padding: "10px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: "0.8rem",
                        color: style.text,
                      }}
                    >
                      <span>
                        <strong>Line #{thought.multipv}</strong>
                      </span>
                      <span style={{ fontWeight: "bold" }}>
                        Eval:{" "}
                        {thought.score.startsWith("-") ||
                        thought.score.startsWith("M")
                          ? thought.score
                          : `+${thought.score}`}
                      </span>
                    </div>
                    <div
                      style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}
                    >
                      {thought.moves.map((_moveVal, i) => {
                        const san = sanMoves[i];
                        if (!san) return null;
                        return (
                          <button
                            key={i}
                            className="move-chip"
                            onClick={() => playLineToMove(thought.moves, i)}
                            style={{
                              backgroundColor: style.chipBg,
                              color: style.text,
                            }}
                          >
                            {san}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* AI Coach Panel */}
          <div
            style={{
              height: "190px",
              border: "1px solid #444",
              borderRadius: "12px",
              padding: "20px",
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#1a1a1a",
              color: "#eee",
              textAlign: "left",
              boxShadow: "inset 0 2px 8px rgba(0,0,0,0.2)",
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "10px",
              }}
            >
              <h3 style={{ margin: 0, color: "#fff", fontSize: "1rem" }}>
                Coach Analysis
              </h3>
              <button
                className="action-button"
                onClick={askCoach}
                disabled={isCoachLoading || !evaluation}
                style={{
                  flex: "none",
                  padding: "6px 12px",
                  fontSize: "0.8rem",
                  height: "auto",
                }}
              >
                <CoachIcon /> {isCoachLoading ? "Thinking..." : "Strategize"}
              </button>
            </div>

            <div
              style={{
                fontSize: "0.9rem",
                lineHeight: "1.4",
                color: "#ccc",
                overflowY: "auto",
                fontStyle: coachMessage ? "normal" : "italic",
                height: "100%",
              }}
            >
              {coachMessage ||
                (isCoachLoading
                  ? "Coach is looking at the board..."
                  : "Click 'Explain Move' to get grandmaster insights on the current position.")}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
