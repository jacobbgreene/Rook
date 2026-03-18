# Task: Upgrade Stockfish Engine from stockfish.js 10 to Stockfish 18 (NNUE)

## Context

This is "Rook" — a Tauri 2 desktop chess coach app (React 19 + TypeScript + Vite 7). It currently uses `stockfish.js` v10.0.2, a 2018-era JavaScript port with **classical evaluation only** (no NNUE). The starting position evaluates at ~+0.90 instead of the expected ~+0.30, because NNUE (introduced in Stockfish 12, 2020) is dramatically more accurate at positional assessment. Chess.com and Lichess both use NNUE-based Stockfish.

The goal is to replace `stockfish.js` v10.0.2 with the modern `stockfish` npm package (v18, maintained by Chess.com/nmrugg), which embeds the NNUE neural network directly in the WASM binary.

## Current Architecture

### Files involved:
- `src/chessEngine.ts` — Wrapper around the Stockfish Web Worker (UCI postMessage interface)
- `src/App.tsx` — Main React component; parses UCI `info` messages, manages eval/arrows/engine thoughts
- `public/stockfish.js`, `public/stockfish.wasm`, `public/stockfish.wasm.js` — Current engine files (to be replaced)
- `package.json` — Currently depends on `"stockfish.js": "^10.0.2"`
- `vite.config.ts` — Vite dev server config (may need COOP/COEP headers for multi-threaded variant)
- `src-tauri/tauri.conf.json` — Tauri config (may need COOP/COEP headers for production builds)

### How the engine is currently used:

`src/chessEngine.ts` creates a Web Worker and communicates via UCI protocol over `postMessage`:
```typescript
// Constructor:
this.worker = new Worker("/stockfish.js");
this.worker.postMessage("uci");
this.worker.postMessage("isready");

// Analysis:
this.worker.postMessage("stop");
this.worker.postMessage("setoption name MultiPV value 3");
this.worker.postMessage(`position fen ${fen}`);
this.worker.postMessage(`go depth ${depth}`);

// Response handling:
this.worker.onmessage = (event) => { callback(event.data); };
```

`src/App.tsx` parses the UCI `info depth ...` messages from the worker, extracting:
- `depth`, `multipv`, `score cp` / `score mate`, and `pv` (move list)

The UCI protocol interface is **identical** between old and new Stockfish — only the Worker file path changes.

## Upgrade Steps

### 1. Replace the npm package

```bash
npm uninstall stockfish.js
npm install stockfish
```

### 2. Choose a build variant and copy files to `public/`

The `stockfish` v18 package provides multiple variants in `node_modules/stockfish/`:

| Variant | Files | Size | NNUE | Threads | Needs COOP/COEP headers |
|---|---|---|---|---|---|
| **Lite single-threaded (RECOMMENDED)** | `stockfish-18-lite-single.js` + `.wasm` | ~7 MB | Smaller net | No | **No** |
| Full single-threaded | `stockfish-18-single.js` + `.wasm` | >100 MB | Full net | No | **No** |
| Lite multi-threaded | `stockfish-18-lite.js` + `.wasm` | ~7 MB | Smaller net | Yes | Yes |
| Full multi-threaded | `stockfish-18.js` + `.wasm` | >100 MB | Full net | Yes | Yes |
| ASM.js fallback | `stockfish-18-asm.js` | ~10 MB | None | No | No |

**Recommendation: Use `stockfish-18-lite-single`** — it gives NNUE evaluation at ~7 MB with zero header configuration. The lite NNUE net is still vastly more accurate than the old classical eval. For a desktop app, single-threaded is fine; threads only affect search speed, not evaluation quality.

```bash
# Delete old engine files
rm public/stockfish.js public/stockfish.wasm public/stockfish.wasm.js

# Copy new engine files from the npm package
cp node_modules/stockfish/stockfish-18-lite-single.js public/
cp node_modules/stockfish/stockfish-18-lite-single.wasm public/
```

### 3. Update `src/chessEngine.ts`

The only required change is the Worker path:

```typescript
// OLD:
this.worker = new Worker("/stockfish.js");

// NEW:
this.worker = new Worker("/stockfish-18-lite-single.js");
```

Everything else (UCI commands, `onMessage`, `postMessage`) stays exactly the same.

### 4. Update `src/App.tsx`

Update the label that currently says "Stockfish 16" (line ~781) to say "Stockfish 18":

```typescript
// Find and update this string:
"Stockfish 16"
// Change to:
"Stockfish 18"
```

No other changes needed in App.tsx — the UCI message format is identical.

### 5. (Only if using multi-threaded variant) Add COOP/COEP headers

**Skip this step if using the single-threaded variant (recommended).**

If you choose a multi-threaded variant, `SharedArrayBuffer` requires cross-origin isolation headers.

In `vite.config.ts`, add to the server config:
```typescript
server: {
  headers: {
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin'
  },
  // ... existing config
}
```

In `src-tauri/tauri.conf.json`, add under `app.security`:
```json
"headers": {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}
```

Note: Tauri only injects headers from `tauri.conf.json` in **production** builds. The Vite config covers development.

### 6. Verify

After the upgrade, the starting position evaluation should be ~+0.25 to +0.35 (matching chess.com/lichess), rather than the current ~+0.90 from the old classical engine.

## What NOT to change

- The UCI protocol commands (`uci`, `isready`, `stop`, `setoption`, `position fen`, `go depth`) — these are identical across all Stockfish versions
- The `onMessage` parsing logic in `App.tsx` — the `info depth ... score cp ... pv ...` format is unchanged
- The two-phase analysis approach (MultiPV 3 → MultiPV 5 widening) — this works the same with the new engine
- The stale result detection / generation counter logic — engine-agnostic

## Current engine analysis architecture (for reference)

The app uses a two-phase analysis approach:
1. **Phase 1**: Starts with `MultiPV 3` for fast eval convergence
2. **Phase 2**: Once depth 8 is reached on the best line, restarts with `MultiPV 5` for broader candidate moves

Anti-stale-result protections:
- `analysisGenRef` (generation counter) — incremented on every position change, checked in state updaters to discard queued stale results
- `currentFenRef` — updated synchronously in move handlers (not in useEffect) to close the race window
- `evalDepthRef` — prevents eval from regressing to a shallower depth when the widened search restarts
- Legality check — validates the first move of each engine line against the current position

The `startAnalysis(fen)` function is called synchronously from all position-changing handlers (makeAMove, moveBack, moveForward, moveToStart, moveToEnd, resetBoard, handleImport, playLineToMove) before `setGame()`, ensuring refs are updated before any async worker messages can arrive.
