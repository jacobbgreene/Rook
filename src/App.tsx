import { useState, useEffect, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { ChessEngine } from "./chessEngine";
import { invoke } from "@tauri-apps/api/core";
import { runFullAnalysis, GameAnalysisReport, AnalysisPhase, SavedReport, SavedReportMeta, computeGameHash, determineGameResult } from "./gameAnalysis";
import ReactMarkdown from "react-markdown";
import "./App.css";

/** Strip LaTeX $...$ delimiters that LLMs wrap around chess notation. */
const stripLatex = (text: string) => text.replace(/\$([^$]+)\$/g, "$1");

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
const ReportIcon = () => (
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
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
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
  const [activeTab, setActiveTab] = useState<"strategize" | "analysis" | "report">("strategize");
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

  // Post-game report state
  const [postGameReport, setPostGameReport] = useState<GameAnalysisReport | null>(null);
  const [isPostGameLoading, setIsPostGameLoading] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisPhase | null>(null);
  const [showReportSetup, setShowReportSetup] = useState(false);
  const [reportPerspective, setReportPerspective] = useState<"white" | "black">("white");
  const [includeGreatMoves, setIncludeGreatMoves] = useState(false);
  const [analysisDepth, setAnalysisDepth] = useState<number>(12);
  const [mainLineHistory, setMainLineHistory] = useState<string[] | null>(null);

  // Save/load report state
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [savedReportMeta, setSavedReportMeta] = useState<SavedReportMeta | null>(null);
  const [showSavedReportsModal, setShowSavedReportsModal] = useState(false);
  const [savedReportsList, setSavedReportsList] = useState<SavedReportMeta[]>([]);

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
    if (activeTab === "report") {
      const el = document.querySelector('[data-report-active="true"]');
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [currentMoveIndex, activeTab]);

  // Auto-detect saved report for current game
  useEffect(() => {
    if (gameHistory.length <= 1) {
      setSavedReportMeta(null);
      return;
    }
    const hash = computeGameHash(gameHistory);
    invoke<SavedReportMeta | null>("check_report_exists", { gameHash: hash })
      .then((meta) => setSavedReportMeta(meta))
      .catch(() => setSavedReportMeta(null));
  }, [gameHistory]);

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
    setActiveTab("analysis");
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

  const requestPostGameReport = async () => {
    if (isPostGameLoading) return;
    setIsPostGameLoading(true);
    setActiveTab("report");
    setPostGameReport(null);
    setSavedReportId(null);
    setMainLineHistory([...gameHistory]);
    setAnalysisProgress({ phase: "engine", current: 0, total: gameHistory.length });

    try {
      const report = await runFullAnalysis(
        gameHistory,
        reportPerspective,
        (phase) => setAnalysisProgress(phase),
        analysisDepth,
        includeGreatMoves,
      );
      setPostGameReport(report);

      // Auto-save the report
      const gameHash = computeGameHash(gameHistory);
      const sanMoves = reconstructMoves(gameHistory.length - 1);
      const openingMoves = buildPgn(sanMoves.slice(0, Math.min(sanMoves.length, 6)));
      const result = determineGameResult(gameHistory, reportPerspective);
      const id = `rpt_${Date.now()}`;
      const savedReport: SavedReport = {
        id,
        gameHash,
        createdAt: new Date().toISOString(),
        perspective: reportPerspective,
        moveCount: sanMoves.length,
        openingMoves,
        result,
        report,
        gameHistory: [...gameHistory],
      };
      await invoke("save_report", { report: savedReport });
      setSavedReportId(id);
      setSavedReportMeta({
        id,
        gameHash,
        createdAt: savedReport.createdAt,
        perspective: reportPerspective,
        moveCount: sanMoves.length,
        openingMoves,
        criticalMomentCount: report.criticalMoments.length,
        result,
      });
    } catch (error) {
      setPostGameReport({
        criticalMoments: [],
        thematicSummary: `Analysis failed: ${error}`,
      });
    } finally {
      setIsPostGameLoading(false);
      setAnalysisProgress(null);
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
        // Check if this move matches the first move of a best line suggestion
        const currentFen = game.fen();
        if (postGameReport && activeTab === "report") {
          const matchingMoment = postGameReport.criticalMoments.find(
            (m) => m.fen === currentFen && m.bestLine.length > 0 && m.bestLine[0] === result.san
          );
          if (matchingMoment) {
            playBestLine(currentFen, matchingMoment.bestLine, 0);
            return true;
          }
        }

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
    setActiveTab("strategize");
    setDeepAnalysisAnnotations(null);
    setPostGameReport(null);
    setMainLineHistory(null);
    setShowReportSetup(false);
    setIncludeGreatMoves(false);
    setAnalysisDepth(12);
    setSavedReportId(null);
    setSavedReportMeta(null);
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
    setActiveTab("strategize");
    setDeepAnalysisAnnotations(null);
    setPostGameReport(null);
    setMainLineHistory(null);
    setShowReportSetup(false);
    setIncludeGreatMoves(false);
    setAnalysisDepth(12);
    setSavedReportId(null);
    setSavedReportMeta(null);
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

  const playBestLine = (fen: string, sanMoves: string[], targetIndex: number) => {
    const historyIndex = gameHistory.indexOf(fen);
    const baseHistory = historyIndex >= 0
      ? gameHistory.slice(0, historyIndex + 1)
      : [...gameHistory, fen];

    // Play ALL moves in the best line so Forward/Back can step through them
    const fullGame = new Chess(fen);
    const newHistory = [...baseHistory];
    for (let i = 0; i < sanMoves.length; i++) {
      try {
        const result = fullGame.move(sanMoves[i]);
        if (result) {
          newHistory.push(fullGame.fen());
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    if (newHistory.length > baseHistory.length) {
      // Navigate to the clicked move, not the end
      const navIndex = baseHistory.length + targetIndex;
      const clampedIndex = Math.min(navIndex, newHistory.length - 1);
      const navGame = new Chess(newHistory[clampedIndex]);
      startAnalysis(newHistory[clampedIndex]);
      setGame(navGame);
      setGameHistory(newHistory);
      setCurrentMoveIndex(clampedIndex);
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
    const sanMoves = gameSanMoves;
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

  // Memoize SAN reconstruction — this is expensive (creates Chess instances for every position)
  const gameSanMoves = useMemo(() => {
    const sans: string[] = [];
    for (let i = 0; i < gameHistory.length - 1; i++) {
      const fromFen = gameHistory[i];
      const toFen = gameHistory[i + 1];
      const tempGame = new Chess(fromFen);
      for (const san of tempGame.moves()) {
        const testGame = new Chess(fromFen);
        testGame.move(san);
        if (testGame.fen() === toFen) {
          sans.push(san);
          break;
        }
      }
    }
    return sans;
  }, [gameHistory]);

  const mainLineSanMoves = useMemo(() => {
    if (!mainLineHistory) return null;
    const sans: string[] = [];
    for (let i = 0; i < mainLineHistory.length - 1; i++) {
      const fromFen = mainLineHistory[i];
      const toFen = mainLineHistory[i + 1];
      const tempGame = new Chess(fromFen);
      for (const san of tempGame.moves()) {
        const testGame = new Chess(fromFen);
        testGame.move(san);
        if (testGame.fen() === toFen) {
          sans.push(san);
          break;
        }
      }
    }
    return sans;
  }, [mainLineHistory]);

  const isExploringVariation = activeTab === "report" && mainLineHistory !== null &&
    (gameHistory.length !== mainLineHistory.length ||
     gameHistory.some((fen, i) => mainLineHistory[i] !== fen));

  const navigateToMainLineMove = (historyIndex: number) => {
    if (!mainLineHistory || historyIndex < 0 || historyIndex >= mainLineHistory.length) return;
    setGameHistory(mainLineHistory);
    setCurrentMoveIndex(historyIndex);
    setGame(new Chess(mainLineHistory[historyIndex]));
    startAnalysis(mainLineHistory[historyIndex]);
  };

  const backToMainLine = () => {
    if (!mainLineHistory) return;
    const targetIndex = Math.min(currentMoveIndex, mainLineHistory.length - 1);
    setGameHistory(mainLineHistory);
    setCurrentMoveIndex(targetIndex);
    setGame(new Chess(mainLineHistory[targetIndex]));
    startAnalysis(mainLineHistory[targetIndex]);
  };

  const loadSavedReport = async (id: string) => {
    try {
      const saved = await invoke<SavedReport>("load_report", { id });
      setGameHistory(saved.gameHistory);
      setMainLineHistory(saved.gameHistory);
      setReportPerspective(saved.perspective);
      setPostGameReport(saved.report);
      setSavedReportId(saved.id);
      setCurrentMoveIndex(0);
      setGame(new Chess(saved.gameHistory[0]));
      startAnalysis(saved.gameHistory[0]);
      setActiveTab("report");
      setShowSavedReportsModal(false);
    } catch (e) {
      console.error("Failed to load report:", e);
    }
  };

  const handleDeleteReport = async (id: string) => {
    try {
      await invoke("delete_report", { id });
      setSavedReportsList((prev) => prev.filter((r) => r.id !== id));
      if (savedReportId === id) {
        setSavedReportId(null);
      }
      if (savedReportMeta?.id === id) {
        setSavedReportMeta(null);
      }
    } catch (e) {
      console.error("Failed to delete report:", e);
    }
  };

  const openSavedReportsModal = async () => {
    try {
      const reports = await invoke<SavedReportMeta[]>("list_reports");
      setSavedReportsList(reports);
      setShowSavedReportsModal(true);
    } catch (e) {
      console.error("Failed to list reports:", e);
    }
  };

  const renderReportMoves = () => {
    if (!postGameReport) return null;
    const sanMoves = mainLineSanMoves || gameSanMoves;

    if (sanMoves.length === 0) return null;

    const momentMap = new Map<string, (typeof postGameReport.criticalMoments)[number]>();
    for (const m of postGameReport.criticalMoments) {
      momentMap.set(`${m.moveNumber}-${m.side}`, m);
    }

    const elements: React.ReactNode[] = [];
    // We group moves into rows of 3 full moves (number + white + black).
    // A critical moment card breaks the row and starts a new one after.
    let currentRow: React.ReactNode[] = [];
    let movesInRow = 0; // counts full moves (white+black pairs) in current row
    let needsContinuation = false;

    const flushRow = (key: string) => {
      if (currentRow.length > 0) {
        elements.push(
          <div key={key} className="report-move-row">
            {currentRow}
          </div>
        );
        currentRow = [];
        movesInRow = 0;
      }
    };

    for (let i = 0; i < sanMoves.length; i++) {
      const moveNumber = Math.floor(i / 2) + 1;
      const isWhite = i % 2 === 0;
      const side: "white" | "black" = isWhite ? "white" : "black";
      const historyIndex = i + 1;
      const moment = momentMap.get(`${moveNumber}-${side}`);
      const isPlayerMoment = moment && moment.side === reportPerspective;
      const isOnMainLine = !isExploringVariation;
      const isCurrentMove = isOnMainLine && currentMoveIndex === historyIndex;

      // Start a new row every 3 full moves
      if (isWhite && movesInRow >= 3) {
        flushRow(`row-before-${i}`);
      }

      if (isWhite) {
        currentRow.push(
          <span key={`num-${i}`} style={{ color: "#888", fontSize: "0.85rem", marginRight: "2px" }}>
            {moveNumber}.
          </span>
        );
      } else if (needsContinuation) {
        // After a critical moment card broke the row, show continuation number
        currentRow.push(
          <span key={`cont-${i}`} style={{ color: "#888", fontSize: "0.85rem", marginRight: "2px" }}>
            {moveNumber}...
          </span>
        );
        needsContinuation = false;
      }

      let chipBg = "transparent";
      let chipColor = "#ddd";
      let chipBorder = "none";

      if (isCurrentMove) {
        chipBg = "#3a5a8a";
        chipColor = "#fff";
      } else if (isPlayerMoment) {
        switch (moment.category) {
          case "blunder":
            chipBg = "rgba(255, 80, 80, 0.15)";
            chipColor = "#ff6b6b";
            chipBorder = "1px solid rgba(255, 80, 80, 0.3)";
            break;
          case "mistake":
            chipBg = "rgba(255, 165, 0, 0.12)";
            chipColor = "#ffb067";
            chipBorder = "1px solid rgba(255, 165, 0, 0.3)";
            break;
          case "inaccuracy":
            chipBg = "rgba(255, 220, 80, 0.1)";
            chipColor = "#e8d44d";
            chipBorder = "1px solid rgba(255, 220, 80, 0.25)";
            break;
          case "turning_point":
            chipBg = "rgba(80, 180, 255, 0.12)";
            chipColor = "#6bc5ff";
            chipBorder = "1px solid rgba(80, 180, 255, 0.3)";
            break;
          case "great_move":
            chipBg = "rgba(74, 222, 128, 0.15)";
            chipColor = "#4ade80";
            chipBorder = "1px solid rgba(74, 222, 128, 0.3)";
            break;
          case "brilliant":
            chipBg = "rgba(34, 211, 238, 0.15)";
            chipColor = "#22d3ee";
            chipBorder = "1px solid rgba(34, 211, 238, 0.3)";
            break;
        }
      }

      currentRow.push(
        <span
          key={`move-${i}`}
          className="move-chip"
          onClick={() => navigateToMainLineMove(historyIndex)}
          data-report-active={isCurrentMove ? "true" : undefined}
          style={{
            cursor: "pointer",
            backgroundColor: chipBg,
            color: chipColor,
            padding: "2px 6px",
            borderRadius: "3px",
            border: chipBorder,
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

      // Count a full move after black's move
      if (!isWhite) {
        movesInRow++;
      }

      // Player's critical moments: flush current row, render card, start new row
      if (isPlayerMoment && moment) {
        flushRow(`row-before-card-${i}`);
        elements.push(
          <div
            key={`card-${i}`}
            className="critical-moment-card cm-inline"
            style={{ cursor: "pointer" }}
            onClick={() => navigateToMainLineMove(historyIndex)}
          >
            <div className="cm-header">
              <span className={`category-badge badge-${moment.category}`}>
                {moment.category === "turning_point" ? "Turning Point" : moment.category === "great_move" ? "Great Move" : moment.category === "brilliant" ? "Brilliant" : moment.category.charAt(0).toUpperCase() + moment.category.slice(1)}
              </span>
              <span className="cm-move-info">
                Move {moment.moveNumber}: <strong>{moment.moveSan}</strong>
              </span>
              <span className="cm-eval-drop" style={moment.category === "great_move" ? { color: "#4ade80" } : moment.category === "brilliant" ? { color: "#22d3ee" } : undefined}>
                {moment.category === "great_move" || moment.category === "brilliant" ? `+${Math.abs(moment.evalDrop).toFixed(1)}` : moment.evalDrop > 0 ? `−${moment.evalDrop.toFixed(1)}` : `+${Math.abs(moment.evalDrop).toFixed(1)}`}
              </span>
            </div>
            {moment.category !== "great_move" && moment.category !== "brilliant" && moment.bestLine.length > 0 && (() => {
              const fenIdx = gameHistory.indexOf(moment.fen);
              const activeBestLineIdx = fenIdx >= 0 && isExploringVariation
                ? currentMoveIndex - fenIdx - 1
                : -1;
              return (
              <div className="cm-best-line" onClick={(e) => e.stopPropagation()}>
                <span>Best:</span>
                {moment.bestLine.map((san, idx) => {
                  return (
                    <span key={idx} style={{ display: "contents" }}>
                      {idx > 0 && <span className="best-line-arrow">→</span>}
                      <span
                        className={`best-line-move${idx === activeBestLineIdx ? " best-line-active" : ""}`}
                        onClick={() => playBestLine(moment.fen, moment.bestLine, idx)}
                      >
                        {san}
                      </span>
                    </span>
                  );
                })}
              </div>
              );
            })()}
            <div className="cm-explanation"><ReactMarkdown>{stripLatex(moment.llmExplanation)}</ReactMarkdown></div>
          </div>
        );
        needsContinuation = isWhite;
      }
    }

    // Flush any remaining moves
    flushRow("row-final");

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {elements}
      </div>
    );
  };

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

          {isExploringVariation && (
            <button className="back-to-main-btn" onClick={backToMainLine}>
              ← Back to main line
            </button>
          )}

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
          {/* Best Lines Panel — hidden when viewing a full report */}
          {!(activeTab === "report" && (postGameReport || isPostGameLoading)) && (
          <div
            style={{
              height: "300px",
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
          )}

          {/* Tab-based Coach Panel */}
          <div className={`tab-panel${activeTab === "report" && (postGameReport || isPostGameLoading) ? " tab-panel-full" : ""}`}>
            {/* Tab Bar */}
            <div className="tab-bar">
              <button
                className={`tab-button${activeTab === "strategize" ? " tab-active" : ""}`}
                onClick={() => setActiveTab("strategize")}
              >
                Strategize
              </button>
              <button
                className={`tab-button${activeTab === "analysis" ? " tab-active" : ""}`}
                onClick={() => setActiveTab("analysis")}
              >
                Analysis
              </button>
              <button
                className={`tab-button${activeTab === "report" ? " tab-active" : ""}`}
                onClick={() => setActiveTab("report")}
              >
                Report
                {savedReportMeta && activeTab !== "report" && (
                  <span className="saved-indicator" />
                )}
              </button>
            </div>

            {/* Tab Content */}
            <div className="tab-content">
              {activeTab === "strategize" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", height: "100%" }}>
                  <button
                    className="action-button"
                    onClick={askCoach}
                    disabled={isCoachLoading || !evaluation}
                    style={{
                      flex: "none",
                      padding: "10px",
                      fontSize: "0.9rem",
                    }}
                  >
                    <CoachIcon /> {isCoachLoading ? "Thinking..." : "Strategize"}
                  </button>
                  <div
                    style={{
                      fontSize: "0.9rem",
                      lineHeight: "1.4",
                      color: "#ccc",
                      overflowY: "auto",
                      fontStyle: coachMessage ? "normal" : "italic",
                      flex: 1,
                    }}
                  >
                    {coachMessage
                      ? <ReactMarkdown>{stripLatex(coachMessage)}</ReactMarkdown>
                      : (isCoachLoading
                        ? "Coach is looking at the board..."
                        : "Click 'Strategize' to get quick insights about the current position from the AI coach.")}
                  </div>
                </div>
              )}

              {activeTab === "analysis" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", height: "100%" }}>
                  <button
                    className="action-button"
                    onClick={requestDeepAnalysis}
                    disabled={gameHistory.length <= 1 || isDeepAnalysisLoading}
                    style={{
                      flex: "none",
                      padding: "10px",
                      fontSize: "0.9rem",
                    }}
                  >
                    <DeepAnalysisIcon /> {isDeepAnalysisLoading ? "Analyzing..." : "Run Deep Analysis"}
                    {hasPremiumKey && <span className="premium-star"><StarIcon /></span>}
                  </button>
                  <div
                    style={{
                      fontSize: "0.9rem",
                      lineHeight: "1.4",
                      color: "#ccc",
                      overflowY: "auto",
                      flex: 1,
                    }}
                  >
                    {isDeepAnalysisLoading ? (
                      <div style={{ fontStyle: "italic", color: "#888", textAlign: "center", marginTop: "20px" }}>
                        Analyzing game with AI coach...
                      </div>
                    ) : deepAnalysisAnnotations ? (
                      renderAnnotatedMoves()
                    ) : (
                      <div style={{ fontStyle: "italic", color: "#888", textAlign: "center", marginTop: "20px" }}>
                        Click 'Run Deep Analysis' to get move-by-move annotations of the game so far.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "report" && (
                <div style={{ fontSize: "0.9rem", lineHeight: "1.4", color: "#ccc", overflowY: "auto", height: "100%" }}>
                  {isPostGameLoading && analysisProgress ? (
                    <div className="analysis-progress">
                      {analysisProgress.phase === "engine" && (
                        <>
                          <div className="progress-label">Evaluating positions with Stockfish...</div>
                          <div className="progress-bar-track">
                            <div className="progress-bar-fill" style={{ width: `${(analysisProgress.current / analysisProgress.total) * 100}%` }} />
                          </div>
                          <div className="progress-count">{analysisProgress.current} / {analysisProgress.total} positions</div>
                        </>
                      )}
                      {analysisProgress.phase === "llm" && (
                        <>
                          <div className="progress-label">AI analyzing critical moments...</div>
                          <div className="progress-bar-track">
                            <div className="progress-bar-fill" style={{ width: `${(analysisProgress.current / analysisProgress.total) * 100}%` }} />
                          </div>
                          <div className="progress-count">{analysisProgress.current} / {analysisProgress.total} moments</div>
                        </>
                      )}
                      {analysisProgress.phase === "summary" && (
                        <div className="progress-label">Generating thematic summary...</div>
                      )}
                    </div>
                  ) : postGameReport ? (
                    <div className="report-content">
                      <div className="report-summary"><ReactMarkdown>{stripLatex(postGameReport.thematicSummary)}</ReactMarkdown></div>
                      {renderReportMoves()}
                      {postGameReport.criticalMoments.filter(m => m.side === reportPerspective).length === 0 && (
                        <div style={{ fontStyle: "italic", color: "#888", textAlign: "center", marginTop: "12px" }}>
                          No critical moments detected for your play — solid game!
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", paddingTop: "20px" }}>
                      <button
                        className="action-button"
                        onClick={() => { setReportPerspective(boardOrientation); setShowReportSetup(true); }}
                        disabled={gameHistory.length <= 1 || isPostGameLoading}
                        style={{ width: "100%", justifyContent: "center", padding: "12px" }}
                      >
                        <ReportIcon /> Generate Report
                      </button>
                      {savedReportMeta && (
                        <div className="saved-report-notice">
                          <span>A saved report exists for this game</span>
                          <button
                            className="action-button"
                            onClick={() => loadSavedReport(savedReportMeta.id)}
                            style={{ flex: "none", padding: "6px 14px", fontSize: "0.8rem" }}
                          >
                            Load
                          </button>
                        </div>
                      )}
                      <button
                        className="action-button"
                        onClick={openSavedReportsModal}
                        style={{ width: "100%", justifyContent: "center", padding: "10px", fontSize: "0.85rem" }}
                      >
                        Browse Saved Reports
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Report Setup Modal */}
      {showReportSetup && (
        <div className="report-setup-overlay" onClick={() => setShowReportSetup(false)}>
          <div className="report-setup-modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "1.05rem", color: "#fff" }}>Full Game Report</h3>
            <p style={{ margin: "0 0 12px 0", fontSize: "0.85rem", color: "#aaa" }}>
              Who is this report for?
            </p>
            <div className="perspective-selector">
              <button
                className={`perspective-option ${reportPerspective === "white" ? "selected" : ""}`}
                onClick={() => setReportPerspective("white")}
              >
                <span style={{ fontSize: "1.2rem" }}>&#9812;</span> White
              </button>
              <button
                className={`perspective-option ${reportPerspective === "black" ? "selected" : ""}`}
                onClick={() => setReportPerspective("black")}
              >
                <span style={{ fontSize: "1.2rem" }}>&#9818;</span> Black
              </button>
            </div>
            <div className="model-toggle-row" style={{ marginTop: "16px", marginBottom: "0" }}>
              <div className="model-toggle-label">
                <span className="model-toggle-title">Show what I did well</span>
                <span className="model-toggle-desc">Highlight great moves that shifted the game in your favor</span>
              </div>
              <button
                className={`toggle-switch ${includeGreatMoves ? "toggle-on" : ""}`}
                onClick={() => setIncludeGreatMoves(!includeGreatMoves)}
                role="switch"
                aria-checked={includeGreatMoves}
              >
                <span className="toggle-knob" />
              </button>
            </div>
            <p style={{ margin: "16px 0 8px 0", fontSize: "0.85rem", color: "#aaa" }}>
              Analysis depth
            </p>
            <div className="perspective-selector">
              <button
                className={`perspective-option ${analysisDepth === 8 ? "selected" : ""}`}
                onClick={() => setAnalysisDepth(8)}
              >
                Quick
              </button>
              <button
                className={`perspective-option ${analysisDepth === 12 ? "selected" : ""}`}
                onClick={() => setAnalysisDepth(12)}
              >
                Standard
              </button>
              <button
                className={`perspective-option ${analysisDepth === 18 ? "selected" : ""}`}
                onClick={() => setAnalysisDepth(18)}
              >
                Deep
              </button>
            </div>
            <button
              className="action-button"
              onClick={() => { setShowReportSetup(false); requestPostGameReport(); }}
              style={{ width: "100%", marginTop: "16px", padding: "10px", justifyContent: "center" }}
            >
              <ReportIcon /> Analyze Game
            </button>
          </div>
        </div>
      )}

      {/* Saved Reports Modal */}
      {showSavedReportsModal && (
        <div className="saved-reports-overlay" onClick={() => setShowSavedReportsModal(false)}>
          <div className="saved-reports-modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              <span>Saved Reports</span>
              <button className="api-key-modal-close" onClick={() => setShowSavedReportsModal(false)}>
                ✕
              </button>
            </h2>
            {savedReportsList.length === 0 ? (
              <div style={{ fontStyle: "italic", color: "#888", textAlign: "center", padding: "20px 0" }}>
                No saved reports yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "400px", overflowY: "auto" }}>
                {savedReportsList.map((report) => (
                  <div key={report.id} className="saved-report-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.88rem", color: "#eee", marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {report.openingMoves || "No moves"}
                      </div>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "0.75rem", color: "#888" }}>
                        <span className={`perspective-badge perspective-${report.perspective}`}>
                          {report.perspective}
                        </span>
                        {report.result && report.result !== "unknown" && (
                          <span className={`result-badge result-${report.result}`}>
                            {report.result === "win" ? "W" : report.result === "loss" ? "L" : "D"}
                          </span>
                        )}
                        <span>{new Date(report.createdAt).toLocaleDateString()}</span>
                        <span>{report.moveCount} moves</span>
                        <span>{report.criticalMomentCount} critical moments</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                      <button
                        className="action-button"
                        onClick={() => loadSavedReport(report.id)}
                        style={{ flex: "none", padding: "6px 12px", fontSize: "0.78rem" }}
                      >
                        Load
                      </button>
                      <button
                        className="action-button"
                        onClick={() => handleDeleteReport(report.id)}
                        style={{ flex: "none", padding: "6px 12px", fontSize: "0.78rem", color: "#ff6b6b" }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
