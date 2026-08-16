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

  const currentFenRef = useRef("");
  const evalDepthRef = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFireTime = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batching: accumulate engine-line updates and flush on a throttle
  const pendingThoughts = useRef<Record<number, EngineThought>>({});
  const pendingEval = useRef<string | null>(null);
  const rafHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When analysis restarts (new position / widen pass), the displayed lines
  // stay on screen until the first flush of new lines REPLACES them
  // wholesale. This avoids the panes blanking out between moves.
  const replaceOnFlush = useRef(false);

  const DEBOUNCE_MS = 200;
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  // Throttle UI updates to ~10 Hz. Per-frame flushing re-rendered the whole
  // App tree (including the board) at up to 60 fps, which caused visible
  // jank while dragging pieces. The eval bar's CSS transition smooths the
  // 10 Hz updates, so nothing looks less fluid.
  const FLUSH_MS = 100;

  const scheduleFlush = useCallback(() => {
    if (rafHandle.current !== null) return;
    rafHandle.current = setTimeout(() => {
      rafHandle.current = null;
      const thoughts = pendingThoughts.current;
      const evalStr = pendingEval.current;
      if (Object.keys(thoughts).length > 0) {
        if (replaceOnFlush.current) {
          // First lines for a fresh analysis: swap in whole, don't merge
          // (stale lines may have higher depth and would win the merge).
          setEngineThoughts(thoughts);
          replaceOnFlush.current = false;
        } else {
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
        }
        pendingThoughts.current = {};
      }
      if (evalStr !== null) {
        setEvaluation(evalStr);
        pendingEval.current = null;
      }
    }, FLUSH_MS);
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
        clearTimeout(rafHandle.current);
        rafHandle.current = null;
      }
      // Keep the previous position's lines/eval displayed until the new
      // ones stream in — clearing here made the panes vanish on every move.
      replaceOnFlush.current = true;
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
  // Returns the invoke promise so callers can await it — awaiting guarantees
  // the ucinewgame command lands in the engine's channel BEFORE any
  // subsequent set_fen (otherwise the two commands race and the freshly
  // started search can be torn down by a late NewGame).
  const newGame = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pendingThoughts.current = {};
    pendingEval.current = null;
    if (rafHandle.current !== null) {
      clearTimeout(rafHandle.current);
      rafHandle.current = null;
    }
    setEngineThoughts({});
    setEvaluation("");
    currentFenRef.current = "";
    evalDepthRef.current = 0;
    return invoke("live_engine_new_game").catch(() => {});
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
          if (event.payload.status === "phase2") {
            // Fresh widen pass: new lines replace the old ones wholesale
            // (they restart at lower depth), but keep the old lines on
            // screen until the replacements arrive.
            pendingThoughts.current = {};
            replaceOnFlush.current = true;
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
      if (rafHandle.current !== null) clearTimeout(rafHandle.current);
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
    },
    [],
  );

  return {
    engineThoughts,
    evaluation,
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
