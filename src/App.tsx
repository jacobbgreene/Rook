import { useState, useEffect, useMemo, useRef } from "react";
import { Chess } from "chess.js";
import { invoke } from "@tauri-apps/api/core";
import {
  runFullAnalysis,
  GameAnalysisReport,
  AnalysisPhase,
  SavedReport,
  SavedReportMeta,
  computeGameHash,
  determineGameResult,
  moveInfoAt,
  uciToSan,
  PositionEval,
} from "./gameAnalysis";
import { useLiveEngine } from "./useLiveEngine";
import { SetupWizard } from "./SetupWizard";
import ReactMarkdown from "react-markdown";
import { stripLatex } from "./utils";
import {
  CoachIcon,
  ReportIcon,
  SettingsIcon,
  HelpIcon,
} from "./icons";
import { BoardSection } from "./components/BoardSection";
import { MovesPanel } from "./components/MovesPanel";
import { ImportModal } from "./components/ImportModal";
import {
  SettingsModal,
  type ApiKeyStatus,
  type AppConfig,
  type ReportSettings,
} from "./components/SettingsModal";
import { ReportSetupModal } from "./components/ReportSetupModal";
import { SavedReportsModal } from "./components/SavedReportsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { ReportView } from "./components/ReportView";
import "./App.css";

interface Arrow {
  startSquare: string;
  endSquare: string;
  color: string;
}

function App() {
  const [game, setGame] = useState(new Chess());
  const [gameHistory, setGameHistory] = useState<string[]>([new Chess().fen()]);
  const [gameSanList, setGameSanList] = useState<string[]>([]);
  const [currentMoveIndex, setCurrentMoveIndex] = useState(0);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">(
    "white",
  );

  const {
    engineThoughts,
    evaluation,
    startAnalysis,
    stopAnalysis,
    newGame: resetEngine,
    injectEval,
  } = useLiveEngine();
  const [coachMessage, setCoachMessage] = useState("");
  const [isCoachLoading, setIsCoachLoading] = useState(false);
  // The Explorer tab (engine lines) is the default view.
  const [activeTab, setActiveTab] = useState<
    "strategize" | "analysis" | "report"
  >("analysis");

  // Modal visibility
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);

  // Post-game report state
  const [postGameReport, setPostGameReport] =
    useState<GameAnalysisReport | null>(null);
  const [isPostGameLoading, setIsPostGameLoading] = useState(false);
  const [analysisProgress, setAnalysisProgress] =
    useState<AnalysisPhase | null>(null);
  const [showReportSetup, setShowReportSetup] = useState(false);
  const [reportPerspective, setReportPerspective] = useState<"white" | "black">(
    "white",
  );
  const [includeGreatMoves, setIncludeGreatMoves] = useState(false);
  const [analysisDepth, setAnalysisDepth] = useState<number>(12);
  const [mainLineHistory, setMainLineHistory] = useState<string[] | null>(null);
  const [useLc0, setUseLc0] = useState(false);
  const [detailedReport, setDetailedReport] = useState(true);
  const [includeOpportunities, setIncludeOpportunities] = useState(false);
  const [pgnResult, setPgnResult] = useState<string | undefined>(undefined);

  // Refs that always reflect the latest values — prevents stale closures
  // in handlePositionChange from starting the live engine after async gaps.
  // Updated eagerly (before React re-renders) via wrapper setters below.
  const reportEvalsRef = useRef<PositionEval[] | null>(null);
  const mainLineRef = useRef<string[] | null>(null);
  const mainLineSansRef = useRef<string[] | null>(null);
  const mainLineIndexRef = useRef<Map<string, number> | null>(null);
  const activeTabRef = useRef<string>("analysis");
  const variationEvalsRef = useRef(
    new Map<
      string,
      {
        score: string;
        thoughts: Record<number, import("./useLiveEngine").EngineThought>;
      }
    >(),
  );
  const variationReturnIdxRef = useRef<number | null>(null);

  // Bumped whenever a report run starts or is dismissed, so a stale async
  // analysis can't write its results into a newer/closed report session.
  const reportGenRef = useRef(0);

  const setReportEvaluations = (v: PositionEval[] | null) => {
    reportEvalsRef.current = v;
  };
  const setMainLineHistoryTracked = (v: string[] | null, sans?: string[] | null) => {
    mainLineRef.current = v;
    mainLineSansRef.current = sans ?? null;
    if (v) {
      const map = new Map<string, number>();
      for (let i = 0; i < v.length; i++) map.set(v[i], i);
      mainLineIndexRef.current = map;
    } else {
      mainLineIndexRef.current = null;
    }
    setMainLineHistory(v);
  };
  const setActiveTabTracked = (v: "strategize" | "analysis" | "report") => {
    activeTabRef.current = v;
    setActiveTab(v);
  };

  // App config for engine mode
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Save/load report state
  const [savedReportId, setSavedReportId] = useState<string | null>(null);
  const [savedReportMeta, setSavedReportMeta] =
    useState<SavedReportMeta | null>(null);
  const [showSavedReportsModal, setShowSavedReportsModal] = useState(false);
  const [savedReportsList, setSavedReportsList] = useState<SavedReportMeta[]>(
    [],
  );

  const loadApiKeys = async () => {
    try {
      const status = await invoke<ApiKeyStatus>("get_api_keys");
      setApiKeyStatus(status);
    } catch (e) {
      console.error("Failed to load API keys:", e);
    }
  };

  const handleSaveKey = async (provider: string, key: string) => {
    try {
      await invoke("save_api_key", { provider, key });
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

  const handleToggleEngineMode = async () => {
    try {
      if (appConfig?.engineMode === "hybrid") {
        await invoke("set_engine_mode", { mode: "stockfish_only" });
      } else {
        await invoke("set_engine_mode", { mode: "hybrid" });
      }
      const config = await invoke<AppConfig>("get_app_config");
      setAppConfig(config);
    } catch (e) {
      console.error("Failed to switch engine mode:", e);
    }
  };

  const reportSettings: ReportSettings = {
    analysisDepth,
    includeGreatMoves,
    detailedReport,
    useLc0,
    includeOpportunities,
  };

  // Apply + persist report settings (shared by Settings and Report Setup).
  const updateReportSettings = (s: ReportSettings) => {
    setAnalysisDepth(s.analysisDepth);
    setIncludeGreatMoves(s.includeGreatMoves);
    setDetailedReport(s.detailedReport);
    setUseLc0(s.useLc0);
    setIncludeOpportunities(s.includeOpportunities);
    invoke("save_report_settings", {
      analysisDepth: s.analysisDepth,
      includeGreatMoves: s.includeGreatMoves,
      detailedReport: s.detailedReport,
      useLc0: s.useLc0,
      includeOpportunities: s.includeOpportunities,
    }).catch(() => {});
  };

  useEffect(() => {
    loadApiKeys();
    invoke<AppConfig>("get_app_config")
      .then((config) => {
        setAppConfig(config);
        setConfigLoaded(true);
        // Restore persistent report settings
        if (config.analysisDepth) setAnalysisDepth(config.analysisDepth);
        setIncludeGreatMoves(config.includeGreatMoves ?? false);
        setDetailedReport(config.detailedReport ?? true);
        setUseLc0(config.useLc0 ?? false);
        setIncludeOpportunities(config.includeOpportunities ?? false);
      })
      .catch(() => setConfigLoaded(true));
  }, []);

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

  // Convert a stored PositionEval + FEN into display-ready EngineThought records.
  const positionEvalToThoughts = (
    ev: PositionEval,
    fen: string,
  ): Record<number, import("./useLiveEngine").EngineThought> => {
    const thoughts: Record<number, import("./useLiveEngine").EngineThought> =
      {};
    const formatSc = (line: {
      scoreCp: number | null;
      scoreMate: number | null;
    }) =>
      line.scoreMate !== null
        ? `M${line.scoreMate}`
        : line.scoreCp !== null
          ? (line.scoreCp / 100).toFixed(2)
          : "";

    for (let i = 0; i < ev.topLines.length; i++) {
      const line = ev.topLines[i];
      thoughts[i + 1] = {
        multipv: i + 1,
        depth: analysisDepth, // nominal — reflects the configured report depth
        score: formatSc(line),
        moves: uciToSan(fen, line.pv),
        rawMoves: line.pv,
        rawFirstMove: line.pv[0] || "",
      };
    }
    return thoughts;
  };

  // Wrap startAnalysis to also clear coach message and handle game-over.
  // Callers that already have a Chess instance should pass gameOver directly
  // to avoid constructing a throwaway Chess object in the hot path.
  const handlePositionChange = (fen: string, gameOver?: boolean) => {
    setCoachMessage("");
    const isOver = gameOver ?? new Chess(fen).isGameOver();

    if (isOver) {
      stopAnalysis();
      return;
    }

    // When browsing a report on the main line, use stored evaluations
    // instead of running the live engine redundantly.
    // Uses refs to avoid stale closure reads after async gaps.
    const evals = reportEvalsRef.current;
    const mainLineIndex = mainLineIndexRef.current;
    if (activeTabRef.current === "report" && evals && mainLineIndex) {
      const idx = mainLineIndex.get(fen) ?? -1;
      if (idx >= 0 && evals[idx]) {
        const ev = evals[idx];
        const score =
          ev.scoreMate !== null
            ? `M${ev.scoreMate}`
            : ev.scoreCp !== null
              ? (ev.scoreCp / 100).toFixed(2)
              : "";
        injectEval(score, positionEvalToThoughts(ev, fen));
        return;
      }
    }

    // When browsing a best-line variation, use precomputed evals from the PV
    // instead of running the live engine.
    const varEval = variationEvalsRef.current.get(fen);
    if (varEval) {
      injectEval(varEval.score, varEval.thoughts);
      return;
    }

    startAnalysis(fen);
  };

  // Start analyzing the initial position on mount
  useEffect(() => {
    startAnalysis(new Chess().fen());
  }, []);

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

  // Reconstruct SAN moves from a FEN history. Only used for on-demand
  // operations (deep analysis, report save) — NOT on every move.
  const reconstructSansFromHistory = (
    fens: string[],
    endIndex?: number,
  ): string[] => {
    const limit = endIndex ?? fens.length - 1;
    const sanMoves: string[] = [];
    for (let i = 0; i < limit; i++) {
      const tempGame = new Chess(fens[i]);
      const toFen = fens[i + 1];
      for (const san of tempGame.moves()) {
        tempGame.move(san);
        if (tempGame.fen() === toFen) {
          sanMoves.push(san);
          break;
        }
        tempGame.undo();
      }
    }
    return sanMoves;
  };

  const buildPgn = (sanMoves: string[], startFen?: string): string => {
    // Derive the starting side/fullmove from the initial position so games
    // imported from a custom FEN are numbered correctly.
    let startMove = 1;
    let blackFirst = false;
    if (startFen) {
      const parts = startFen.split(" ");
      startMove = parseInt(parts[5], 10) || 1;
      blackFirst = parts[1] === "b";
    }
    let pgn = "";
    for (let i = 0; i < sanMoves.length; i++) {
      const plyOffset = blackFirst ? i + 1 : i;
      if (plyOffset % 2 === 0) {
        pgn += `${startMove + Math.floor(plyOffset / 2)}. `;
      } else if (i === 0) {
        pgn += `${startMove}... `;
      }
      pgn += sanMoves[i] + " ";
    }
    return pgn.trim();
  };

  // Runs the full analysis pipeline.  By default it analyses the current
  // game; pass `override` to regenerate a previously saved report.
  const requestPostGameReport = async (override?: {
    history: string[];
    sanList: string[];
    perspective: "white" | "black";
    pgnResult?: string;
  }) => {
    if (isPostGameLoading) return;
    // If a report is active, the board may be showing a variation — always
    // analyse the recorded main line, not whatever line is on screen.
    const history =
      override?.history ?? mainLineRef.current ?? gameHistory;
    const sanList =
      override?.sanList ?? mainLineSansRef.current ?? gameSanList;
    const perspective = override?.perspective ?? reportPerspective;
    const pgnRes = override?.pgnResult ?? pgnResult;

    const gen = ++reportGenRef.current;
    setIsPostGameLoading(true);
    setActiveTabTracked("report");
    setPostGameReport(null);
    setReportEvaluations(null);
    setSavedReportId(null);
    setMainLineHistoryTracked([...history], [...sanList]);
    if (override) {
      // Regenerating a saved report — load its game onto the board.
      setGameHistory(history);
      setGameSanList(sanList);
      setReportPerspective(perspective);
      setPgnResult(pgnRes);
    }
    setBoardOrientation(perspective);
    setAnalysisProgress({
      phase: "engine",
      current: 0,
      total: history.length,
    });

    try {
      const { report, evaluations } = await runFullAnalysis(
        history,
        perspective,
        (phase) => {
          // Ignore progress from a superseded/closed report run
          if (gen === reportGenRef.current) setAnalysisProgress(phase);
        },
        analysisDepth,
        includeGreatMoves,
        useLc0,
        detailedReport,
        includeOpportunities,
        pgnRes,
      );
      // The report was closed or re-started while analysing — discard.
      if (gen !== reportGenRef.current) return;
      setPostGameReport(report);
      setReportEvaluations(evaluations);
      if (history.length > 1) {
        setCurrentMoveIndex(1);
        setGame(new Chess(history[1]));
        handlePositionChange(history[1]);
      }

      // Auto-save the report. Replace any previously saved report for this
      // same game instead of accumulating duplicates in the library.
      const gameHash = computeGameHash(history);
      const existing = await invoke<SavedReportMeta | null>(
        "check_report_exists",
        { gameHash },
      ).catch(() => null);
      if (existing) {
        await invoke("delete_report", { id: existing.id }).catch(() => {});
      }
      const openingMoves = buildPgn(
        sanList.slice(0, Math.min(sanList.length, 6)),
        history[0],
      );
      const result = determineGameResult(history, perspective, pgnRes);
      const id = `rpt_${Date.now()}`;
      const savedReport: SavedReport = {
        id,
        gameHash,
        createdAt: new Date().toISOString(),
        perspective,
        moveCount: sanList.length,
        openingMoves,
        result,
        report,
        gameHistory: [...history],
        evaluations,
        gameSanList: [...sanList],
      };
      await invoke("save_report", { report: savedReport });
      setSavedReportId(id);
      setSavedReportMeta({
        id,
        gameHash,
        createdAt: savedReport.createdAt,
        perspective,
        moveCount: sanList.length,
        openingMoves,
        criticalMomentCount: report.criticalMoments.length,
        result,
      });
    } catch (error) {
      if (gen === reportGenRef.current) {
        setPostGameReport({
          criticalMoments: [],
          thematicSummary: `Analysis failed: ${error}`,
        });
      }
    } finally {
      if (gen === reportGenRef.current) {
        setIsPostGameLoading(false);
        setAnalysisProgress(null);
      }
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
            (m) =>
              m.fen === currentFen &&
              m.bestLine.length > 0 &&
              m.bestLine[0] === result.san,
          );
          if (matchingMoment) {
            playBestLine(currentFen, matchingMoment.bestLine, 0);
            return true;
          }
        }

        const newFen = gameCopy.fen();
        const isOver = gameCopy.isGameOver();
        setGame(gameCopy);
        const newHistory = [
          ...gameHistory.slice(0, currentMoveIndex + 1),
          newFen,
        ];
        setGameHistory(newHistory);
        setGameSanList([...gameSanList.slice(0, currentMoveIndex), result.san]);
        setCurrentMoveIndex(newHistory.length - 1);
        // Defer engine IPC so the board renders the drop immediately
        setTimeout(() => handlePositionChange(newFen, isOver), 0);
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

  const navigateToMove = (historyIndex: number) => {
    if (historyIndex < 0 || historyIndex >= gameHistory.length) return;
    handlePositionChange(gameHistory[historyIndex]);
    setCurrentMoveIndex(historyIndex);
    setGame(new Chess(gameHistory[historyIndex]));
  };

  const moveBack = () => {
    if (currentMoveIndex > 0) navigateToMove(currentMoveIndex - 1);
  };

  const moveForward = () => {
    if (currentMoveIndex < gameHistory.length - 1)
      navigateToMove(currentMoveIndex + 1);
  };

  const moveToStart = () => {
    if (currentMoveIndex > 0) navigateToMove(0);
  };

  const moveToEnd = () => {
    if (currentMoveIndex < gameHistory.length - 1)
      navigateToMove(gameHistory.length - 1);
  };

  const flipBoard = () => {
    setBoardOrientation((prev) => (prev === "white" ? "black" : "white"));
  };

  const resetBoard = async () => {
    const newGame = new Chess();
    // Clear report state first — the tracked setters update their refs
    // synchronously, so handlePositionChange below can't pick up stale
    // report evals for the fresh position.
    setActiveTabTracked("analysis");
    setPostGameReport(null);
    setMainLineHistoryTracked(null);
    setReportEvaluations(null);
    setShowReportSetup(false);
    setSavedReportId(null);
    setSavedReportMeta(null);
    variationEvalsRef.current.clear();
    variationReturnIdxRef.current = null;
    setGame(newGame);
    setGameHistory([newGame.fen()]);
    setGameSanList([]);
    setCurrentMoveIndex(0);
    setBoardOrientation("white");
    // Await the engine reset so ucinewgame lands before the next set_fen.
    await resetEngine();
    handlePositionChange(newGame.fen());
  };

  // Import handler for the ImportModal — parses FEN or PGN, applies it,
  // and returns feedback text to display inside the modal.
  const handleImportInput = async (
    input: string,
  ): Promise<{ ok: boolean; text: string } | null> => {
    const newGame = new Chess();
    const trimmed = input.trim();
    if (!trimmed) return null;

    let loaded = false;
    let isPgn = false;

    try {
      newGame.load(trimmed);
      loaded = true;
    } catch (e) {
      // Not a valid FEN, ignore and try PGN
    }

    if (!loaded) {
      try {
        newGame.loadPgn(trimmed);
        loaded = true;
        isPgn = true;
      } catch (e) {
        // Not a valid PGN either
      }
    }

    if (!loaded) {
      return { ok: false, text: "Invalid FEN or PGN format" };
    }

    let feedbackText: string;
    if (isPgn) {
      // Extract PGN Result header (e.g. "1-0", "0-1", "1/2-1/2")
      const headers = newGame.header();
      setPgnResult(headers.Result || undefined);

      // Reconstruct the full timeline history if a PGN was imported.
      // Respect SetUp/FEN headers: games starting from a custom position
      // must be replayed from that position, not the standard startpos.
      const startFen =
        headers.SetUp === "1" && headers.FEN ? headers.FEN : undefined;
      const moves = newGame.history();
      const tempGame = startFen ? new Chess(startFen) : new Chess();
      const fens = [tempGame.fen()];

      for (const move of moves) {
        tempGame.move(move);
        fens.push(tempGame.fen());
      }

      setGameHistory(fens);
      setGameSanList(moves);
      setCurrentMoveIndex(fens.length - 1);
      feedbackText = `Game imported — ${moves.length} move${moves.length === 1 ? "" : "s"}`;
    } else {
      // It was a single FEN position
      setPgnResult(undefined);
      setGameHistory([newGame.fen()]);
      setGameSanList([]);
      setCurrentMoveIndex(0);
      feedbackText = `Position imported — ${newGame.turn() === "w" ? "White" : "Black"} to move`;
    }

    // Clear report state FIRST (the tracked setters update their refs
    // synchronously), so handlePositionChange can't inject stale report
    // evals for the imported position.
    setActiveTabTracked("analysis");
    setPostGameReport(null);
    setMainLineHistoryTracked(null);
    setReportEvaluations(null);
    setShowReportSetup(false);
    setSavedReportId(null);
    setSavedReportMeta(null);
    // Await the engine reset so ucinewgame lands before the next set_fen.
    await resetEngine();
    handlePositionChange(newGame.fen());
    setGame(newGame);
    return { ok: true, text: feedbackText };
  };

  const playLineToMove = (uciMoves: string[], targetIndex: number) => {
    const gameCopy = new Chess();
    const currentFen = gameHistory[currentMoveIndex];
    const baseHistory = gameHistory.slice(0, currentMoveIndex + 1);
    const baseSans = gameSanList.slice(0, currentMoveIndex);
    try {
      gameCopy.load(currentFen);
    } catch (e) {
      return;
    }

    const newHistory = [...baseHistory];
    const newSans = [...baseSans];

    for (let i = 0; i <= targetIndex; i++) {
      const rawMove = uciMoves[i];
      if (!rawMove || rawMove.length < 4) break;
      const from = rawMove.slice(0, 2);
      const to = rawMove.slice(2, 4);
      const promotion = rawMove.length >= 5 ? rawMove[4] : undefined;
      try {
        const result = gameCopy.move({ from, to, promotion });
        if (result) {
          newHistory.push(gameCopy.fen());
          newSans.push(result.san);
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }

    if (newHistory.length > baseHistory.length) {
      handlePositionChange(gameCopy.fen(), gameCopy.isGameOver());
      setGame(gameCopy);
      setGameHistory(newHistory);
      setGameSanList(newSans);
      setCurrentMoveIndex(newHistory.length - 1);
    }
  };

  const playBestLine = (
    fen: string,
    sanMoves: string[],
    targetIndex: number,
  ) => {
    // Only record the return point when entering from the main line — a
    // second hop while already inside a variation must not overwrite it.
    if (!isExploringVariation) {
      variationReturnIdxRef.current = currentMoveIndex;
    }

    const historyIndex = gameHistory.indexOf(fen);
    const baseHistory =
      historyIndex >= 0
        ? gameHistory.slice(0, historyIndex + 1)
        : [...gameHistory, fen];
    const baseSans = gameSanList.slice(
      0,
      historyIndex >= 0 ? historyIndex : gameSanList.length,
    );

    // Play ALL moves in the best line so Forward/Back can step through them
    const fullGame = new Chess(fen);
    const newHistory = [...baseHistory];
    const newSans = [...baseSans];
    for (let i = 0; i < sanMoves.length; i++) {
      try {
        const result = fullGame.move(sanMoves[i]);
        if (result) {
          newHistory.push(fullGame.fen());
          newSans.push(result.san);
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    // Precompute evals for variation positions from the source PV.
    // Only valid when the variation actually FOLLOWS the engine's PV — for
    // trap lines (bait → refutation) it diverges, so we skip precomputation
    // and let the live engine analyse those positions instead.
    variationEvalsRef.current = new Map();
    const srcEvals = reportEvalsRef.current;
    const srcIndex = mainLineIndexRef.current;
    if (srcEvals && srcIndex) {
      const srcIdx = srcIndex.get(fen) ?? -1;
      if (srcIdx >= 0 && srcEvals[srcIdx]) {
        const topLine = srcEvals[srcIdx].topLines[0];
        const lineFollowsPv =
          !!topLine?.pv.length &&
          uciToSan(fen, [topLine.pv[0]])[0] === sanMoves[0];
        if (topLine && lineFollowsPv) {
          const walker = new Chess(fen);
          for (let d = 0; d < sanMoves.length; d++) {
            try {
              walker.move(sanMoves[d]);
            } catch {
              break;
            }
            const posFen = walker.fen();
            const p = d + 1; // plies played from the root position
            const signedCp =
              topLine.scoreCp !== null
                ? (p % 2 === 1 ? -topLine.scoreCp : topLine.scoreCp)
                : null;
            // Mate distance shrinks as the forced line plays out: UCI
            // "mate N" means mate in 2N-1 plies, so after p plies the
            // remaining distance is floor((2N - p) / 2).
            const signedMate =
              topLine.scoreMate !== null
                ? (() => {
                    const n = topLine.scoreMate!;
                    const mag = Math.max(
                      1,
                      Math.floor((2 * Math.abs(n) - p) / 2),
                    );
                    const signed = Math.sign(n) * mag;
                    return p % 2 === 1 ? -signed : signed;
                  })()
                : null;
            const score =
              signedMate !== null
                ? `M${signedMate}`
                : signedCp !== null
                  ? (signedCp / 100).toFixed(2)
                  : "";
            const remainingPv = topLine.pv.slice(d + 1);
            const pvWalker = new Chess(posFen);
            const pvSan: string[] = [];
            const pvUci: string[] = [];
            for (const uci of remainingPv) {
              if (uci.length < 4) break;
              try {
                const r = pvWalker.move({
                  from: uci.slice(0, 2),
                  to: uci.slice(2, 4),
                  promotion: uci.length >= 5 ? uci[4] : undefined,
                });
                if (r) {
                  pvSan.push(r.san);
                  pvUci.push(uci);
                } else break;
              } catch {
                break;
              }
            }
            variationEvalsRef.current.set(posFen, {
              score,
              thoughts: {
                1: {
                  multipv: 1,
                  depth: analysisDepth,
                  score,
                  moves: pvSan,
                  rawMoves: pvUci,
                  rawFirstMove: pvUci[0] || "",
                },
              },
            });
          }
        }
      }
    }

    if (newHistory.length > baseHistory.length) {
      // Navigate to the clicked move, not the end
      const navIndex = baseHistory.length + targetIndex;
      const clampedIndex = Math.min(navIndex, newHistory.length - 1);
      const navGame = new Chess(newHistory[clampedIndex]);
      handlePositionChange(newHistory[clampedIndex], navGame.isGameOver());
      setGame(navGame);
      setGameHistory(newHistory);
      setGameSanList(newSans);
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
      if (
        arrows.some(
          (a) => a.startSquare === startSquare && a.endSquare === endSquare,
        )
      )
        return arrows;
      const bestLine = Object.values(engineThoughts).find(
        (t) => t.multipv === 1,
      );
      const bestScore = bestLine ? parseScore(bestLine.score) : 0;
      const lineScore = parseScore(thought.score);
      const isBlunder =
        thought.multipv !== 1 && bestScore > 1.0 && lineScore < 0;
      let color = "rgba(128, 128, 128, 0.4)";
      if (isBlunder) color = "rgba(255, 80, 80, 0.7)";
      else if (thought.multipv === 1) color = "rgba(50, 205, 50, 0.8)";
      else if (thought.multipv === 2) color = "rgba(30, 144, 255, 0.6)";
      else if (thought.multipv === 3) color = "rgba(255, 165, 0, 0.6)";
      arrows.push({ startSquare, endSquare, color });
      return arrows;
    }, [])
    .reverse();

  const displayThoughts = Object.values(engineThoughts)
    .sort((a, b) => a.multipv - b.multipv)
    .slice(0, 3);

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

  const mainLineSanMoves = useMemo(() => {
    if (!mainLineHistory) return null;
    // Use pre-cached SANs if available (avoids O(n²) reconstruction)
    if (mainLineSansRef.current && mainLineSansRef.current.length === mainLineHistory.length - 1) {
      return mainLineSansRef.current;
    }
    return reconstructSansFromHistory(mainLineHistory);
  }, [mainLineHistory]);

  const moveHighlightSquares = useMemo(() => {
    if (currentMoveIndex === 0) return {};

    const prevFen = gameHistory[currentMoveIndex - 1];
    const san = gameSanList[currentMoveIndex - 1];
    if (!prevFen || !san) return {};

    try {
      const g = new Chess(prevFen);
      const move = g.move(san);
      if (!move) return {};

      let color = "rgba(255, 255, 100, 0.4)"; // default yellow
      if (postGameReport && activeTab === "report") {
        const { moveNumber: moveNum, side } = moveInfoAt(
          gameHistory,
          currentMoveIndex - 1,
        );
        const moment = postGameReport.criticalMoments.find(
          (m) => m.moveNumber === moveNum && m.side === side,
        );
        if (moment) {
          switch (moment.category) {
            case "blunder":
              color = "rgba(255, 80, 80, 0.45)";
              break;
            case "mistake":
              color = "rgba(255, 165, 0, 0.4)";
              break;
            case "inaccuracy":
              color = "rgba(240, 180, 50, 0.4)";
              break;
            case "turning_point":
              color = "rgba(80, 180, 255, 0.4)";
              break;
            case "great_move":
            case "capitalized":
              color = "rgba(74, 222, 128, 0.45)";
              break;
            case "brilliant":
              color = "rgba(251, 191, 36, 0.45)";
              break;
            case "trap":
              color = "rgba(244, 114, 182, 0.4)";
              break;
            case "critical":
              color = "rgba(34, 211, 238, 0.45)";
              break;
            case "opportunity":
              color = "rgba(196, 181, 253, 0.4)";
              break;
            case "golden_opportunity":
              color = "rgba(244, 114, 182, 0.4)";
              break;
          }
        }
      }

      return {
        [move.from]: { backgroundColor: color },
        [move.to]: { backgroundColor: color },
      };
    } catch {
      return {};
    }
  }, [currentMoveIndex, gameHistory, gameSanList, postGameReport, activeTab]);

  const isExploringVariation = useMemo(() => {
    if (activeTab !== "report" || mainLineHistory === null) return false;
    // Fast path: same reference means identical content
    if (gameHistory === mainLineHistory) return false;
    // Length mismatch is a quick divergence check
    if (gameHistory.length !== mainLineHistory.length) return true;
    for (let i = 0; i < gameHistory.length; i++) {
      if (gameHistory[i] !== mainLineHistory[i]) return true;
    }
    return false;
  }, [activeTab, mainLineHistory, gameHistory]);

  const navigateToMainLineMove = (historyIndex: number) => {
    if (
      !mainLineHistory ||
      historyIndex < 0 ||
      historyIndex >= mainLineHistory.length
    )
      return;
    variationReturnIdxRef.current = null;
    variationEvalsRef.current.clear();
    setGameHistory(mainLineHistory);
    setGameSanList(mainLineSanMoves || []);
    setCurrentMoveIndex(historyIndex);
    setGame(new Chess(mainLineHistory[historyIndex]));
    handlePositionChange(mainLineHistory[historyIndex]);
  };

  const backToMainLine = () => {
    if (!mainLineHistory) return;
    const targetIndex =
      variationReturnIdxRef.current !== null
        ? Math.min(variationReturnIdxRef.current, mainLineHistory.length - 1)
        : Math.min(currentMoveIndex, mainLineHistory.length - 1);
    variationReturnIdxRef.current = null;
    variationEvalsRef.current.clear();
    setGameHistory(mainLineHistory);
    setGameSanList(mainLineSanMoves || []);
    setCurrentMoveIndex(targetIndex);
    setGame(new Chess(mainLineHistory[targetIndex]));
    handlePositionChange(mainLineHistory[targetIndex]);
  };

  // ── Keyboard navigation ──────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        moveBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        moveForward();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        // In report mode on main line: enter the best line variation
        if (
          postGameReport &&
          activeTab === "report" &&
          !isExploringVariation &&
          currentMoveIndex > 0
        ) {
          const i = currentMoveIndex - 1;
          const { moveNumber: moveNum, side } = moveInfoAt(gameHistory, i);
          const moment = postGameReport.criticalMoments.find(
            (m) =>
              m.moveNumber === moveNum &&
              m.side === side &&
              m.bestLine.length > 0,
          );
          if (moment) {
            playBestLine(moment.fen, moment.bestLine, 0);
            return;
          }
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        // In report mode exploring a variation: return to main line
        if (isExploringVariation) {
          backToMainLine();
          return;
        }
      } else if (e.key === ",") {
        e.preventDefault();
        moveToStart();
      } else if (e.key === ".") {
        e.preventDefault();
        moveToEnd();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    currentMoveIndex,
    gameHistory,
    postGameReport,
    activeTab,
    isExploringVariation,
  ]);

  const loadSavedReport = async (id: string) => {
    try {
      const saved = await invoke<SavedReport>("load_report", { id });
      const sans = saved.gameSanList || reconstructSansFromHistory(saved.gameHistory);
      setGameHistory(saved.gameHistory);
      setGameSanList(sans);
      setMainLineHistoryTracked(saved.gameHistory, sans);
      setReportPerspective(saved.perspective);
      setBoardOrientation(saved.perspective);
      setPostGameReport(saved.report);
      setReportEvaluations(saved.evaluations || null);
      setSavedReportId(saved.id);
      setActiveTabTracked("report");
      setCurrentMoveIndex(0);
      setGame(new Chess(saved.gameHistory[0]));
      handlePositionChange(saved.gameHistory[0]);
      setShowSavedReportsModal(false);
    } catch (e) {
      console.error("Failed to load report:", e);
    }
  };

  // Regenerate a saved report with the current analysis settings.
  const regenerateReport = async (id: string) => {
    try {
      const saved = await invoke<SavedReport>("load_report", { id });
      const sans =
        saved.gameSanList &&
        saved.gameSanList.length === saved.gameHistory.length - 1
          ? saved.gameSanList
          : reconstructSansFromHistory(saved.gameHistory);
      setShowSavedReportsModal(false);
      // Map the stored result back to a PGN-style result for the summary
      const pgnResult =
        saved.result === "win"
          ? saved.perspective === "white"
            ? "1-0"
            : "0-1"
          : saved.result === "loss"
            ? saved.perspective === "white"
              ? "0-1"
              : "1-0"
            : saved.result === "draw"
              ? "1/2-1/2"
              : undefined;
      await requestPostGameReport({
        history: saved.gameHistory,
        sanList: sans,
        perspective: saved.perspective,
        pgnResult,
      });
    } catch (e) {
      console.error("Failed to regenerate report:", e);
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

  const handleRenameReport = async (id: string, name: string) => {
    try {
      await invoke("rename_report", { id, name });
      const newName = name.trim() || null;
      setSavedReportsList((prev) =>
        prev.map((r) => (r.id === id ? { ...r, name: newName } : r)),
      );
      if (savedReportMeta?.id === id) {
        setSavedReportMeta({ ...savedReportMeta, name: newName });
      }
    } catch (e) {
      console.error("Failed to rename report:", e);
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

  // Exit report mode but keep the report session in memory.
  const exitReportToGame = () => {
    setActiveTabTracked("analysis");
    if (gameHistory.length > 0) {
      handlePositionChange(gameHistory[currentMoveIndex]);
    }
  };

  // Discard the report session entirely and return to the game.
  const closeReport = () => {
    // Invalidate any in-flight analysis so its late results can't
    // resurrect a closed report.
    reportGenRef.current++;
    setPostGameReport(null);
    setIsPostGameLoading(false);
    setMainLineHistoryTracked(null);
    setReportEvaluations(null);
    setActiveTabTracked("analysis");
  };

  // Show setup wizard on first launch
  if (configLoaded && appConfig && !appConfig.setupComplete) {
    return (
      <SetupWizard
        onComplete={() => {
          invoke<AppConfig>("get_app_config").then(setAppConfig);
        }}
      />
    );
  }

  const reportMode = activeTab === "report";
  const reportTitle =
    savedReportMeta?.openingMoves ||
    (gameSanList.length > 0
      ? buildPgn(gameSanList.slice(0, 6), gameHistory[0])
      : "Game report");

  return (
    <main className="container">
      <header className="app-header">
        <h1 className="app-title">Rook</h1>
        <div className="header-actions">
          <button
            className="settings-button"
            onClick={() => setShowHelpModal(true)}
            title="Keyboard shortcuts"
          >
            <HelpIcon />
          </button>
          <button
            className="settings-button"
            onClick={() => setShowSettingsModal(true)}
            title="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      {reportMode ? (
        <ReportView
          fen={game.fen()}
          boardOrientation={boardOrientation}
          arrows={bestMoveArrows}
          squareStyles={moveHighlightSquares}
          onPieceDrop={onDrop}
          evaluation={evaluation}
          sideToMove={game.turn()}
          isCheckmate={game.isCheckmate()}
          currentMoveIndex={currentMoveIndex}
          historyLength={gameHistory.length}
          onStart={moveToStart}
          onBack={moveBack}
          onForward={moveForward}
          onEnd={moveToEnd}
          onFlip={flipBoard}
          title={reportTitle}
          perspective={reportPerspective}
          result={savedReportMeta?.result}
          onExitToGame={exitReportToGame}
          onCloseReport={closeReport}
          onRegenerate={() => requestPostGameReport()}
          onOpenLibrary={openSavedReportsModal}
          isLoading={isPostGameLoading}
          analysisProgress={analysisProgress}
          report={postGameReport}
          reportPerspective={reportPerspective}
          mainLineHistory={mainLineHistory}
          mainLineSanMoves={mainLineSanMoves}
          gameHistory={gameHistory}
          gameSanList={gameSanList}
          isExploringVariation={isExploringVariation}
          onNavigateToMainLineMove={navigateToMainLineMove}
          onPlayBestLine={playBestLine}
          onBackToMainLine={backToMainLine}
        />
      ) : (
        <div className="play-layout">
          <BoardSection
            fen={game.fen()}
            boardOrientation={boardOrientation}
            arrows={currentMoveIndex === 0 ? [] : bestMoveArrows}
            squareStyles={moveHighlightSquares}
            onPieceDrop={onDrop}
            evaluation={evaluation}
            sideToMove={game.turn()}
            isCheckmate={game.isCheckmate()}
            hasGame={currentMoveIndex > 0}
            canNavigateBack={currentMoveIndex > 0}
            canNavigateForward={currentMoveIndex < gameHistory.length - 1}
            onStart={moveToStart}
            onBack={moveBack}
            onForward={moveForward}
            onEnd={moveToEnd}
            onFlip={flipBoard}
            onImport={() => setShowImportModal(true)}
            onReset={resetBoard}
          />

          <div className="side-col">
            {/* Reports are the app's main value — they lead the column. */}
            <div className="report-entry">
              {postGameReport ? (
                <button
                  className="action-button report-entry-btn"
                  onClick={() => {
                    setActiveTabTracked("report");
                    handlePositionChange(gameHistory[currentMoveIndex]);
                  }}
                >
                  <ReportIcon /> View Report
                </button>
              ) : (
                <button
                  className="action-button report-entry-btn"
                  onClick={() => {
                    setReportPerspective(boardOrientation);
                    setShowReportSetup(true);
                  }}
                  disabled={gameHistory.length <= 1 || isPostGameLoading}
                >
                  <ReportIcon /> Generate Report
                </button>
              )}
              {savedReportMeta && (
                <div className="saved-report-notice">
                  <span>A saved report exists for this game</span>
                  <button
                    className="action-button"
                    onClick={() => loadSavedReport(savedReportMeta.id)}
                    style={{
                      flex: "none",
                      padding: "6px 14px",
                      fontSize: "0.8rem",
                    }}
                  >
                    Load
                  </button>
                </div>
              )}
              <button
                className="action-button report-entry-btn"
                onClick={openSavedReportsModal}
              >
                Browse Saved Reports
              </button>
            </div>

            {/* Tab panel: Explorer (engine lines) is the default view */}
            <div className="tab-panel">
              <div className="tab-bar">
                <button
                  className={`tab-button${activeTab === "analysis" ? " tab-active" : ""}`}
                  onClick={() => setActiveTabTracked("analysis")}
                >
                  Explorer
                </button>
                <button
                  className={`tab-button${activeTab === "strategize" ? " tab-active" : ""}`}
                  onClick={() => setActiveTabTracked("strategize")}
                >
                  Coach
                </button>
              </div>

              <div className="tab-content">
                {activeTab === "strategize" && (
                  <div className="tab-pane">
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
                      <CoachIcon />{" "}
                      {isCoachLoading ? "Thinking..." : "Strategize"}
                    </button>
                    <div
                      className={`coach-message${coachMessage ? "" : " coach-message-empty"}`}
                    >
                      {coachMessage ? (
                        <ReactMarkdown>{stripLatex(coachMessage)}</ReactMarkdown>
                      ) : isCoachLoading ? (
                        "Coach is looking at the board..."
                      ) : (
                        "Click 'Strategize' to get quick insights about the current position from the AI coach."
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "analysis" && (
                  <div className="tab-pane">
                    <h3
                      style={{
                        marginTop: 0,
                        marginBottom: 0,
                        borderBottom: "1px solid #444",
                        paddingBottom: "12px",
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
                        Stockfish
                      </span>
                    </h3>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                        flex: 1,
                        overflowY: "auto",
                      }}
                    >
                      {displayThoughts.length === 0 && (
                        <div className="lines-empty">
                          Analyzing current position...
                        </div>
                      )}

                      {displayThoughts.map((thought) => {
                        const lineScore = parseScore(thought.score);
                        const bestLine = displayThoughts.find(
                          (t) => t.multipv === 1,
                        );
                        const bestScore = bestLine
                          ? parseScore(bestLine.score)
                          : 0;
                        const isBlunder =
                          thought.multipv !== 1 &&
                          bestScore > 1.0 &&
                          lineScore < 0;
                        const style = getLineStyle(
                          isBlunder ? "red" : thought.multipv,
                        );
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
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: "6px",
                              }}
                            >
                              {thought.moves.map((san, i) => {
                                if (!san) return null;
                                return (
                                  <button
                                    key={i}
                                    className="move-chip"
                                    onClick={() =>
                                      playLineToMove(thought.rawMoves, i)
                                    }
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
              </div>
            </div>

            <MovesPanel
              fens={gameHistory}
              sans={gameSanList}
              currentIndex={currentMoveIndex}
              onNavigate={navigateToMove}
            />

          </div>
        </div>
      )}

      {/* Modals */}
      {showReportSetup && (
        <ReportSetupModal
          appConfig={appConfig}
          reportPerspective={reportPerspective}
          onPerspectiveChange={setReportPerspective}
          settings={reportSettings}
          onUpdateSettings={updateReportSettings}
          onAnalyze={() => {
            setShowReportSetup(false);
            requestPostGameReport();
          }}
          onClose={() => setShowReportSetup(false)}
        />
      )}

      {showSavedReportsModal && (
        <SavedReportsModal
          reports={savedReportsList}
          busy={isPostGameLoading}
          onLoad={loadSavedReport}
          onRegenerate={regenerateReport}
          onDelete={handleDeleteReport}
          onRename={handleRenameReport}
          onClose={() => setShowSavedReportsModal(false)}
        />
      )}

      {showImportModal && (
        <ImportModal
          onImport={handleImportInput}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          apiKeyStatus={apiKeyStatus}
          onSaveKey={handleSaveKey}
          onRemoveKey={handleRemoveKey}
          onToggleGeminiPro={handleToggleGeminiPro}
          appConfig={appConfig}
          onToggleEngineMode={handleToggleEngineMode}
          reportSettings={reportSettings}
          onUpdateReportSettings={updateReportSettings}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {showHelpModal && <ShortcutsModal onClose={() => setShowHelpModal(false)} />}
    </main>
  );
}

export default App;
