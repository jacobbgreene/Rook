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

interface MoveAnnotation {
  moveNumber: number;
  side: "white" | "black";
  comment: string;
}

interface ApiKeyStatus {
  gemini_set: boolean;
  gemini_hint: string;
  openai_set: boolean;
  openai_hint: string;
  gemini_pro_enabled: boolean;
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
const DeepAnalysisIcon = () => (
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
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);
const KeyIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);
const EyeIcon = () => (
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
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = () => (
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
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
const StarIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="1"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
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
  const [deepAnalysisAnnotations, setDeepAnalysisAnnotations] = useState<MoveAnnotation[] | null>(null);
  const [isDeepAnalysisLoading, setIsDeepAnalysisLoading] = useState(false);
  const [showDeepAnalysis, setShowDeepAnalysis] = useState(false);
  const engineRef = useRef<ChessEngine | null>(null);
  const currentFenRef = useRef(new Chess().fen());
  const analysisGenRef = useRef(0);
  const widenedRef = useRef(false);
  const evalDepthRef = useRef(0);

  // API Key management state
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [openaiKeyInput, setOpenaiKeyInput] = useState("");
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showOpenaiKey, setShowOpenaiKey] = useState(false);

  const loadApiKeys = async () => {
    try {
      const status = await invoke<ApiKeyStatus>("get_api_keys");
      setApiKeyStatus(status);
    } catch (e) {
      console.error("Failed to load API keys:", e);
    }
  };

  const handleSaveKey = async (provider: string) => {
    const key = provider === "gemini" ? geminiKeyInput : openaiKeyInput;
    if (!key.trim()) return;
    try {
      await invoke("save_api_key", { provider, key: key.trim() });
      if (provider === "gemini") setGeminiKeyInput("");
      else setOpenaiKeyInput("");
      await loadApiKeys();
    } catch (e) {
      console.error("Failed to save key:", e);
    }
  };

  const handleRemoveKey = async (provider: string) => {
    try {
      await invoke("remove_api_key", { provider });
      await loadApiKeys();
    } catch (e) {
      console.error("Failed to remove key:", e);
    }
  };

  const handleToggleGeminiPro = async () => {
    const newValue = !apiKeyStatus?.gemini_pro_enabled;
    try {
      await invoke("set_gemini_pro", { enabled: newValue });
      await loadApiKeys();
    } catch (e) {
      console.error("Failed to toggle Gemini Pro:", e);
    }
  };

  useEffect(() => {
    loadApiKeys();
  }, []);

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
            setEngineThoughts({});
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

  const reconstructMoves = (endIndex?: number): string[] => {
    const limit = endIndex ?? currentMoveIndex;
    const sanMoves: string[] = [];
    for (let i = 0; i < limit; i++) {
      const fromFen = gameHistory[i];
      const toFen = gameHistory[i + 1];
      const tempGame = new Chess(fromFen);
      const legalMoves = tempGame.moves();
      for (const san of legalMoves) {
        const testGame = new Chess(fromFen);
        testGame.move(san);
        if (testGame.fen() === toFen) {
          sanMoves.push(san);
          break;
        }
      }
    }
    return sanMoves;
  };

  const buildPgn = (sanMoves: string[]): string => {
    let pgn = "";
    for (let i = 0; i < sanMoves.length; i++) {
      if (i % 2 === 0) {
        pgn += `${Math.floor(i / 2) + 1}. `;
      }
      pgn += sanMoves[i] + " ";
    }
    return pgn.trim();
  };

  const requestDeepAnalysis = async () => {
    if (isDeepAnalysisLoading) return;
    setIsDeepAnalysisLoading(true);
    setShowDeepAnalysis(true);
    setDeepAnalysisAnnotations(null);

    try {
      const sanMoves = reconstructMoves();
      const pgn = buildPgn(sanMoves);

      const top3Lines = Object.values(engineThoughts)
        .sort((a, b) => a.multipv - b.multipv)
        .slice(0, 3)
        .map(
          (t) => `Line #${t.multipv} (Eval ${t.score}): ${t.moves.join(" ")}`,
        )
        .join("\n");

      const response = await invoke<string>("deep_analysis", {
        pgn: pgn || "No moves yet",
        currentFen: game.fen(),
        evaluation: evaluation || "N/A",
        topLines: top3Lines || "Engine still analyzing...",
        perspective: boardOrientation,
      });

      const annotations: MoveAnnotation[] = JSON.parse(response);
      setDeepAnalysisAnnotations(annotations);
    } catch (error) {
      setDeepAnalysisAnnotations([
        { moveNumber: 1, side: "white", comment: `Error: ${error}` },
      ]);
    } finally {
      setIsDeepAnalysisLoading(false);
    }
  };

  const navigateToMove = (historyIndex: number) => {
    if (historyIndex >= 0 && historyIndex < gameHistory.length) {
      startAnalysis(gameHistory[historyIndex]);
      setCurrentMoveIndex(historyIndex);
      setGame(new Chess(gameHistory[historyIndex]));
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
    setShowDeepAnalysis(false);
    setDeepAnalysisAnnotations(null);
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
    setShowDeepAnalysis(false);
    setDeepAnalysisAnnotations(null);
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

  const parseScore = (s: string): number => {
    if (s.startsWith("M")) {
      const n = parseInt(s.slice(1), 10);
      return n < 0 ? -100 : 100;
    }
    return parseFloat(s) || 0;
  };

  const bestMoveArrows = Object.values(engineThoughts)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 5)
    .reduce<Arrow[]>((arrows, thought) => {
      const move = thought.rawFirstMove;
      if (!move || move.length < 4) return arrows;
      const startSquare = move.slice(0, 2);
      const endSquare = move.slice(2, 4);
      // Skip if an arrow for this square pair already exists (higher-ranked line wins)
      if (arrows.some((a) => a.startSquare === startSquare && a.endSquare === endSquare))
        return arrows;
      const bestLine = Object.values(engineThoughts).find((t) => t.multipv === 1);
      const bestScore = bestLine ? parseScore(bestLine.score) : 0;
      const lineScore = parseScore(thought.score);
      const isBlunder = thought.multipv !== 1 && bestScore > 1.0 && lineScore < 0;
      let color = "rgba(128, 128, 128, 0.4)";
      if (isBlunder) color = "rgba(255, 80, 80, 0.7)";
      else if (thought.multipv === 1) color = "rgba(50, 205, 50, 0.8)";
      else if (thought.multipv === 2) color = "rgba(30, 144, 255, 0.6)";
      else if (thought.multipv === 3) color = "rgba(255, 165, 0, 0.6)";
      arrows.push({ startSquare, endSquare, color });
      return arrows;
    }, []).reverse();

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
    if (!evaluation || currentMoveIndex === 0)
      return { percent: 50, label: "", labelColor: "#fff" };
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

  const getLineStyle = (multipv: number | "red") => {
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
      case "red":
        return {
          bg: "#3c1a1a",
          border: "#5c2a2a",
          text: "#ff6b6b",
          chipBg: "#2b1111",
        };
      default:
        return { bg: "#222", border: "#333", text: "#aaa", chipBg: "#111" };
    }
  };

  const renderAnnotatedMoves = () => {
    const sanMoves = reconstructMoves(gameHistory.length - 1);
    if (sanMoves.length === 0) {
      return <div style={{ fontStyle: "italic", color: "#888", textAlign: "center", marginTop: "20px" }}>No moves to annotate.</div>;
    }

    const annotationMap = new Map<string, string>();
    if (deepAnalysisAnnotations) {
      for (const a of deepAnalysisAnnotations) {
        annotationMap.set(`${a.moveNumber}-${a.side}`, a.comment);
      }
    }

    const elements: React.ReactNode[] = [];
    let needsContinuation = false;

    for (let i = 0; i < sanMoves.length; i++) {
      const moveNumber = Math.floor(i / 2) + 1;
      const isWhite = i % 2 === 0;
      const side = isWhite ? "white" : "black";
      const historyIndex = i + 1; // gameHistory[0] is start position

      // Prepend move number before white's move, or continuation after annotation
      if (isWhite) {
        elements.push(
          <span key={`num-${i}`} style={{ color: "#888", fontSize: "0.85rem", marginRight: "2px" }}>
            {moveNumber}.
          </span>
        );
      } else if (needsContinuation) {
        elements.push(
          <span key={`cont-${i}`} style={{ color: "#888", fontSize: "0.85rem", marginRight: "2px" }}>
            {moveNumber}...
          </span>
        );
        needsContinuation = false;
      }

      // Render clickable move
      elements.push(
        <span
          key={`move-${i}`}
          className="move-chip"
          onClick={() => navigateToMove(historyIndex)}
          style={{
            cursor: "pointer",
            backgroundColor: currentMoveIndex === historyIndex ? "#3a5a8a" : "transparent",
            color: currentMoveIndex === historyIndex ? "#fff" : "#ddd",
            padding: "2px 4px",
            borderRadius: "3px",
            border: "none",
            marginRight: "4px",
            fontFamily: "monospace",
            fontSize: "0.9rem",
            display: "inline",
            boxShadow: "none",
          }}
        >
          {sanMoves[i]}
        </span>
      );

      // Check for annotation after this move
      const annotationKey = `${moveNumber}-${side}`;
      const comment = annotationMap.get(annotationKey);
      if (comment) {
        elements.push(
          <span key={`ann-${i}`} className="deep-analysis-comment">
            {comment}
          </span>
        );
        // If white's move was annotated, black's next move needs continuation number
        if (isWhite) {
          needsContinuation = true;
        }
      }
    }

    return (
      <div style={{ lineHeight: "1.8", padding: "4px 0" }}>
        {elements}
      </div>
    );
  };

  const hasPremiumKey = apiKeyStatus?.gemini_set || apiKeyStatus?.openai_set;

  return (
    <main className="container">
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <h1 style={{ margin: "0.67em 0" }}>Rook</h1>
        <button
          className="settings-button"
          onClick={() => setShowApiKeyModal(true)}
          title="API Key Settings"
        >
          <KeyIcon />
        </button>
      </div>
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
                arrows: currentMoveIndex === 0 ? [] : bestMoveArrows,
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
                const lineScore = parseScore(thought.score);
                const bestLine = displayThoughts.find(
                  (t) => t.multipv === 1
                );
                const bestScore = bestLine
                  ? parseScore(bestLine.score)
                  : 0;
                const isBlunder =
                  thought.multipv !== 1 &&
                  bestScore > 1.0 &&
                  lineScore < 0;
                const style = getLineStyle(
                  isBlunder ? "red" : thought.multipv
                );
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
              height: showDeepAnalysis ? "400px" : "190px",
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
              transition: "height 0.3s ease",
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
                {showDeepAnalysis ? "Game Analysis" : "Coach Analysis"}
              </h3>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                {showDeepAnalysis ? (
                  <button
                    className="action-button"
                    onClick={() => setShowDeepAnalysis(false)}
                    style={{
                      flex: "none",
                      padding: "6px 12px",
                      fontSize: "0.8rem",
                      height: "auto",
                    }}
                  >
                    ← Back
                  </button>
                ) : (
                  <>
                    <button
                      className="action-button"
                      onClick={requestDeepAnalysis}
                      disabled={gameHistory.length <= 1 || isDeepAnalysisLoading}
                      style={{
                        flex: "none",
                        padding: "6px 12px",
                        fontSize: "0.8rem",
                        height: "auto",
                      }}
                    >
                      <DeepAnalysisIcon /> {isDeepAnalysisLoading ? "Analyzing..." : "Deep Analysis"}
                      {hasPremiumKey && <span className="premium-star"><StarIcon /></span>}
                    </button>
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
                  </>
                )}
              </div>
            </div>

            {showDeepAnalysis ? (
              <div
                style={{
                  fontSize: "0.9rem",
                  lineHeight: "1.4",
                  color: "#ccc",
                  overflowY: "auto",
                  height: "100%",
                }}
              >
                {isDeepAnalysisLoading ? (
                  <div
                    style={{
                      fontStyle: "italic",
                      color: "#888",
                      textAlign: "center",
                      marginTop: "20px",
                    }}
                  >
                    Analyzing game with AI coach...
                  </div>
                ) : (
                  renderAnnotatedMoves()
                )}
              </div>
            ) : (
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
                    : "Click 'Strategize' for quick insights or 'Deep Analysis' for full game annotations.")}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* API Key Modal */}
      {showApiKeyModal && (
        <div className="api-key-modal-overlay" onClick={() => setShowApiKeyModal(false)}>
          <div className="api-key-modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              <span>API Key Settings</span>
              <button className="api-key-modal-close" onClick={() => setShowApiKeyModal(false)}>
                ✕
              </button>
            </h2>

            {/* Gemini Section */}
            <div className="api-key-section">
              <h4>Gemini API Key</h4>
              {apiKeyStatus?.gemini_set ? (
                <div className="api-key-saved">
                  <span className="key-hint">{apiKeyStatus.gemini_hint}</span>
                  <button onClick={() => handleRemoveKey("gemini")}>Remove</button>
                </div>
              ) : (
                <div className="api-key-input-group">
                  <input
                    type={showGeminiKey ? "text" : "password"}
                    placeholder="Enter Gemini API key..."
                    value={geminiKeyInput}
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveKey("gemini")}
                  />
                  <button className="eye-toggle" onClick={() => setShowGeminiKey(!showGeminiKey)}>
                    {showGeminiKey ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                  <button onClick={() => handleSaveKey("gemini")}>Save</button>
                </div>
              )}
            </div>

            {/* Gemini Pro Toggle */}
            {apiKeyStatus?.gemini_set && (
              <div className="model-toggle-row">
                <div className="model-toggle-label">
                  <span className="model-toggle-title">Gemini 3.1 Pro Preview</span>
                  <span className="model-toggle-desc">Use Pro instead of Flash for Deep Analysis. Slower but higher quality.</span>
                </div>
                <button
                  className={`toggle-switch ${apiKeyStatus.gemini_pro_enabled ? "toggle-on" : ""}`}
                  onClick={handleToggleGeminiPro}
                  role="switch"
                  aria-checked={apiKeyStatus.gemini_pro_enabled}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
            )}

            {/* OpenAI Section */}
            <div className="api-key-section">
              <h4>OpenAI API Key</h4>
              {apiKeyStatus?.openai_set ? (
                <div className="api-key-saved">
                  <span className="key-hint">{apiKeyStatus.openai_hint}</span>
                  <button onClick={() => handleRemoveKey("openai")}>Remove</button>
                </div>
              ) : (
                <div className="api-key-input-group">
                  <input
                    type={showOpenaiKey ? "text" : "password"}
                    placeholder="Enter OpenAI API key..."
                    value={openaiKeyInput}
                    onChange={(e) => setOpenaiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveKey("openai")}
                  />
                  <button className="eye-toggle" onClick={() => setShowOpenaiKey(!showOpenaiKey)}>
                    {showOpenaiKey ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                  <button onClick={() => handleSaveKey("openai")}>Save</button>
                </div>
              )}
            </div>

            {/* Info Box */}
            <div className="api-key-info">
              Adding your own API key unlocks deep thinking for Deep Analysis:
              Gemini 3 Flash with thinking (high), or OpenAI o4-mini (reasoning model).
              Without a key, Gemini 3 Flash is used without thinking.
              Get a free Gemini key from{" "}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "#7ab3ff" }}>
                Google AI Studio
              </a>.
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
