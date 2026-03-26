import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Types ─────────────────────────────────────────────────────

export interface EngineThought {
  multipv: number;
  depth: number;
  score: string;
  moves: string[];       // SAN from backend
  rawMoves: string[];    // UCI for board interaction
  rawFirstMove: string;  // UCI for arrow drawing
}

interface EngineLineEvent {
  depth: number;
  multipv: number;
  scoreCp: number | null;
  scoreMate: number | null;
  pvUci: string[];
  pvSan: string[];
  fen: string;
}

interface EngineStatusEvent {
  status: string;
  fen: string;
}

// ── Hook ──────────────────────────────────────────────────────

export function useLiveEngine() {
  const [engineThoughts, setEngineThoughts] = useState<
    Record<number, EngineThought>
  >({});
  const [evaluation, setEvaluation] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const currentFenRef = useRef("");
  const evalDepthRef = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFireTime = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batching: accumulate engine-line updates and flush once per frame
  const pendingThoughts = useRef<Record<number, EngineThought>>({});
  const pendingEval = useRef<string | null>(null);
  const rafHandle = useRef<number | null>(null);

  const DEBOUNCE_MS = 200;
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  const scheduleFlush = useCallback(() => {
    if (rafHandle.current !== null) return;
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      const thoughts = pendingThoughts.current;
      const evalStr = pendingEval.current;
      if (Object.keys(thoughts).length > 0) {
        setEngineThoughts((prev) => {
          const merged = { ...prev };
          for (const key of Object.keys(thoughts)) {
            const k = Number(key);
            const incoming = thoughts[k];
            const existing = merged[k];
            if (!existing || incoming.depth >= existing.depth) {
              merged[k] = incoming;
            }
          }
          return merged;
        });
        pendingThoughts.current = {};
      }
      if (evalStr !== null) {
        setEvaluation(evalStr);
        pendingEval.current = null;
      }
    });
  }, []);

  // ── Reset idle timer ────────────────────────────────────────
  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      invoke("live_engine_stop").catch(() => {});
    }, IDLE_TIMEOUT_MS);
  }, []);

  // ── Start analysis (leading-edge debounce) ───────────────────
  const fireAnalysis = useCallback(
    (fen: string) => {
      lastFireTime.current = Date.now();
      currentFenRef.current = fen;
      evalDepthRef.current = 0;
      pendingThoughts.current = {};
      pendingEval.current = null;
      if (rafHandle.current !== null) {
        cancelAnimationFrame(rafHandle.current);
        rafHandle.current = null;
      }
      setEngineThoughts({});
      setEvaluation("");
      invoke("live_engine_set_fen", { fen }).catch(() => {});
      resetIdleTimer();
    },
    [resetIdleTimer],
  );

  const startAnalysis = useCallback(
    (fen: string) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      const elapsed = Date.now() - lastFireTime.current;
      if (elapsed >= DEBOUNCE_MS) {
        // Fire immediately — no recent call
        fireAnalysis(fen);
      } else {
        // Rapid succession — debounce to trailing edge
        debounceTimer.current = setTimeout(() => {
          fireAnalysis(fen);
        }, DEBOUNCE_MS - elapsed);
      }
    },
    [fireAnalysis],
  );

  // ── Stop analysis ───────────────────────────────────────────
  const stopAnalysis = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    invoke("live_engine_stop").catch(() => {});
  }, []);

  // ── New game (flushes hash tables) ──────────────────────────
  const newGame = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pendingThoughts.current = {};
    pendingEval.current = null;
    if (rafHandle.current !== null) {
      cancelAnimationFrame(rafHandle.current);
      rafHandle.current = null;
    }
    setEngineThoughts({});
    setEvaluation("");
    currentFenRef.current = "";
    evalDepthRef.current = 0;
    invoke("live_engine_new_game").catch(() => {});
  }, []);

  // ── Event listeners ─────────────────────────────────────────
  useEffect(() => {
    let lineUnlisten: UnlistenFn | undefined;
    let statusUnlisten: UnlistenFn | undefined;
    let mounted = true;

    const setup = async () => {
      lineUnlisten = await listen<EngineLineEvent>(
        "engine-line",
        (event) => {
          if (!mounted) return;
          const e = event.payload;

          // Stale detection: ignore lines for a different position
          if (e.fen !== currentFenRef.current) return;

          const score = formatScore(e.scoreCp, e.scoreMate);

          // Buffer into pending ref — only keep if depth is >= existing
          const existing = pendingThoughts.current[e.multipv];
          if (!existing || e.depth >= existing.depth) {
            pendingThoughts.current[e.multipv] = {
              multipv: e.multipv,
              depth: e.depth,
              score,
              moves: e.pvSan,
              rawMoves: e.pvUci,
              rawFirstMove: e.pvUci[0] || "",
            };
          }

          // Update top-level evaluation from line 1
          if (
            e.multipv === 1 &&
            score &&
            e.depth >= 5 &&
            e.depth >= evalDepthRef.current
          ) {
            evalDepthRef.current = e.depth;
            pendingEval.current = score;
          }

          scheduleFlush();
        },
      );

      statusUnlisten = await listen<EngineStatusEvent>(
        "engine-status",
        (event) => {
          if (!mounted) return;
          const { status } = event.payload;
          if (status === "searching") {
            setIsAnalyzing(true);
          } else if (status === "stopped" || status === "ready" || status === "error") {
            setIsAnalyzing(false);
          } else if (status === "phase2") {
            // Clear thoughts for fresh widen pass
            pendingThoughts.current = {};
            setEngineThoughts({});
          }
        },
      );
    };

    setup();

    // Visibility kill-switch
    const onVisibilityChange = () => {
      if (document.hidden) {
        invoke("live_engine_stop").catch(() => {});
      } else if (currentFenRef.current) {
        invoke("live_engine_set_fen", { fen: currentFenRef.current }).catch(
          () => {},
        );
        resetIdleTimer();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mounted = false;
      lineUnlisten?.();
      statusUnlisten?.();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    };
  }, [resetIdleTimer, scheduleFlush]);

  // Inject stored evaluation data (e.g. from a saved report) and stop
  // the live engine so it doesn't overwrite the injected values.
  const injectEval = useCallback(
    (eval_: string, thoughts: Record<number, EngineThought>) => {
      invoke("live_engine_stop").catch(() => {});
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      currentFenRef.current = "";
      evalDepthRef.current = 99;
      setEvaluation(eval_);
      setEngineThoughts(thoughts);
      setIsAnalyzing(false);
    },
    [],
  );

  return {
    engineThoughts,
    evaluation,
    isAnalyzing,
    startAnalysis,
    stopAnalysis,
    newGame,
    injectEval,
  };
}

// ── Helpers ───────────────────────────────────────────────────

function formatScore(
  scoreCp: number | null,
  scoreMate: number | null,
): string {
  if (scoreMate !== null) return `M${scoreMate}`;
  if (scoreCp !== null) return (scoreCp / 100).toFixed(2);
  return "";
}
