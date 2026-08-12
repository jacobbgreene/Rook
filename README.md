# Rook

Rook is a desktop chess analysis app for players who want to actually
understand their games, not just see a score. It combines an always-on
Stockfish evaluation, an on-demand AI coach that talks through plans in
plain language, and a full post-game report pipeline that turns a PGN
into a structured, explained list of the moments that decided the
result.

It exists to close the gap between "the engine says -2.3" and "here's
what went wrong and what to do differently." Everything in this README
is organized around the things you actually do in the app.

Built with [Tauri 2](https://tauri.app/) (Rust) + React 19 (TypeScript).

## Quick start

You'll need:

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable) and the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for
  your platform (Linux users can get the native deps via
  `nix develop`, using the `flake.nix` in this repo)
- [Stockfish](https://stockfishchess.org/download/) on your `PATH`, or
  set `STOCKFISH_PATH` to point at the binary

```bash
npm install
npm run tauri dev
```

The first time the app opens you'll land in the **setup wizard** — see
[Choose your engine mode](#1-choose-your-engine-mode-first-launch)
below. After that, drag a piece on the board and you're evaluating a
position. To build a production binary: `npm run tauri build`.

Everything beyond that is optional — Rook runs fully on local engines
with no network calls unless you add a Gemini or OpenAI key.

## Core user journeys

### 1. Choose your engine mode (first launch)

`src/SetupWizard.tsx` is the first thing you see. Pick one:

- **Standard** — Stockfish only, no download, calls `set_engine_mode("stockfish_only")`.
- **Advanced** — Stockfish + Leela Chess Zero (Lc0). Calls `setup_lc0`,
  which downloads the Lc0 binary and a neural-network weights file
  (~100MB) with a live progress bar (`lc0-download-progress` events),
  then verifies the install. If it fails, **Cancel — use Standard mode
  instead** falls back gracefully.

You can change this later at any time from **Settings → Engine Mode**
(`src/components/SettingsModal.tsx`), which just re-runs the same
`set_engine_mode` / `setup_lc0` commands.

### 2. Get a position on the board

Three ways in, all from the main board view (`src/App.tsx`):

- **Play it out** — drag pieces on the board (`onPieceDrop`); Rook
  validates the move with `chess.js` and appends it to the game
  history.
- **Import** — click the import icon in the board toolbar
  (`src/components/ImportModal.tsx`) and paste either a FEN (a single
  position) or a full PGN (headers optional, `Ctrl+Enter` to submit).
  PGNs with `SetUp`/`FEN` headers are replayed from that starting
  position, not move 1.
- **Browse history** — use the toolbar (`src/components/BoardToolbar.tsx`),
  arrow keys, or any move in the clickable **Moves** panel
  (`src/components/MovesPanel.tsx`); `,` / `.` jump to the start/end.

Every position change resets and re-primes the live engine
(`live_engine_set_fen`) so evaluation is never stale.

### 3. Read the live evaluation

As soon as a position is on the board, `useLiveEngine.ts` starts a
**persistent Stockfish process** (`src-tauri/src/live_engine.rs`) that
evaluates it continuously — no need to click anything:

- The **eval bar** (`src/components/EvalBar.tsx`) tracks the score and
  follows board orientation.
- **Best-move arrows** are drawn on the board, color-coded by rank.
- The **Explorer** tab (the default) lists the top candidate lines —
  SAN, score, and clickable move chips that play the line out via
  `playLineToMove`. A two-phase MultiPV strategy starts narrow (3
  lines) for a fast first read, then widens to 5 once depth is
  sufficient.
- If you leave a position alone for 3 minutes, or the window loses
  visibility, the engine idles down automatically to save CPU.

### 4. Ask the coach about a position

Switch to the **Coach** tab and click **Strategize**. This calls
`explain_move`, which sends the current position and engine evaluation
to your configured LLM (Google Gemini or OpenAI — see
[Enable AI features](#7-enable-ai-features-api-keys)) and returns a
plain-language read on:

- your most likely plan and whether it's sound,
- concrete next moves,
- your opponent's counterplay to watch for.

This works on *any* position — mid-game, an imported puzzle, or a
variation you've stepped into. Without an API key, the coach replies
with instructions for adding one; engine evaluation keeps working
regardless.

### 5. Generate a full-game report

Once a game has at least one move (played or imported), the side panel
shows **Generate Report**. Clicking it opens
`ReportSetupModal` where you choose:

| Option | What it does |
|---|---|
| Perspective (White/Black) | Whose blunders/mistakes get flagged |
| Show what I did well | Surfaces brilliant moves, traps, and critical finds |
| Show opportunities | Flags moments your opponent slipped and whether you capitalized |
| Use Lc0 analysis *(Advanced mode only)* | Adds a neural-network pass for critical positions |
| Analysis depth | Quick (8) / Standard (12) / Deep (18) |

Clicking **Analyze Game** runs the pipeline in `src/gameAnalysis.ts`
and `src-tauri/src/engine.rs`:

1. **Engine pass** — a Stockfish worker pool evaluates every position
   at the chosen depth.
2. **Trap probe** — for sound moves that leave bait hanging, Stockfish
   checks the opponent's tempting replies (greedy captures, plus
   Lc0 policy-head suggestions in hybrid mode). A reply that loses
   badly marks the move as a trap.
3. **Lc0 pass** *(optional)* — Leela evaluates critical positions at
   75,000 nodes, adding win/draw/loss odds and a second, more
   human-like perspective.
4. **LLM explanations** — each critical moment gets a 2–3 sentence
   explanation, with earlier moments fed back in so the coach can
   connect a plan across the whole game.
5. **Thematic summary** — a short, game-wide narrative plus one
   concrete area to work on.

Progress is streamed back as phase updates while it runs
(`analysisProgress` in `App.tsx`).

### 6. Read the report

The finished report opens in `src/components/ReportView.tsx`: a
dedicated board + move-list view where every flagged **critical
moment** is tagged with a category:

| Category | Trigger |
|---|---|
| Blunder | Eval drop > 2.0 pawns (detailed) / > 3.0 (standard) |
| Mistake | Eval drop > 1.0 / > 1.5 |
| Inaccuracy | Eval drop > 0.5 / > 0.75 |
| Turning point | Position swung from losing to winning |
| Opportunity | Opponent's mistake you could have exploited |
| Capitalized | You answered an opponent's slip and seized the advantage |
| Critical | Only one strong move; gap to second-best > 1.5 pawns, game still undecided |
| Brilliant | A sound material sacrifice — the engine's own best move |
| Trap | A sound move whose tempting reply loses 3+ pawns *and* leaves you clearly better (or mated) |

Click any moment to jump the board straight to it, with the LLM's
explanation alongside. Scroll up for the thematic summary of the whole
game.

### 7. Enable AI features (API keys)

Coaching (**Strategize**) and report explanations both need an LLM.
Open **Settings** (gear icon, top right) and paste a key:

- **Google Gemini** — free tier available from
  [Google AI Studio](https://aistudio.google.com/apikey). Toggle
  **Gemini 3.1 Pro Preview** for higher-quality (slower) report
  explanations.
- **OpenAI** — used as GPT-4o if you'd rather not use Gemini.

Keys are saved via `save_api_key` into the app's local config (see
[Where things are stored](#where-things-are-stored)) — or set
`GEMINI_API_KEY` / `OPENAI_API_KEY` as environment variables instead.
Without a key, live engine analysis, arrows, and the eval bar all keep
working; only the Coach tab and report explanations are unavailable.

### 8. Explore a variation from a report

From any critical moment, press **Down** to step into the engine's
suggested best line. Arrow keys walk through it move by move, and
evaluations are pulled from the already-computed engine PV — no engine
restart, no wait. Press **Up** to snap back to the exact position you
left on the main line. The full shortcut list is in
`src/components/ShortcutsModal.tsx` (also reachable via the **?**
button):

| Key | Action |
|---|---|
| `←` | Previous move |
| `→` | Next move |
| `,` | Jump to start |
| `.` | Jump to end |
| `↓` | Enter suggested best line (report, main line) |
| `↑` | Return to main line (report, in variation) |

### 9. Build a library of past games

Every generated report is saved automatically (`save_report`);
re-analyzing the same game replaces its previous report rather than
duplicating it. **Browse Saved Reports** opens
`src/components/SavedReportsModal.tsx`, where you can:

- **search** by name, opening moves, perspective, or result,
- **sort** by newest, oldest, most critical moments, or result,
- **load** a report straight back into the report view,
- **regenerate** it with current settings,
- **rename** or **delete** it.

If you reload a game that already has a saved report, Rook tells you
and offers a one-click **Load** instead of re-running the whole
pipeline.

## Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Chess logic (frontend) | chess.js, react-chessboard |
| UI animations | animejs (spring easings) |
| Backend | Rust, Tokio, Serde |
| Engine protocol | UCI (Stockfish, Lc0) |
| AI providers | Google Gemini, OpenAI (via rig-core) |
| Move validation (backend) | shakmaty |

## Project structure

```
src/                        # React frontend
  App.tsx                   # App state, analysis orchestration, layout
  icons.tsx                 # Shared SVG icon set
  utils.ts                  # Small text helpers
  animate.tsx               # Shared spring animations (animejs PopIn wrapper)
  useLiveEngine.ts          # Real-time Stockfish analysis hook
  gameAnalysis.ts           # Post-game analysis pipeline
  SetupWizard.tsx           # First-launch engine setup flow
  components/
    BoardSection.tsx        # Shared board + eval bar + toolbar (both views)
    EvalBar.tsx             # Vertical eval bar (follows board orientation)
    BoardToolbar.tsx        # Icon toolbar: navigation, flip, import, reset
    MovesPanel.tsx          # Live game score with clickable navigation
    ReportView.tsx          # Dedicated report mode (board + moments)
    ImportModal.tsx         # FEN/PGN import
    SettingsModal.tsx       # API keys, engine mode, report defaults
    ReportSetupModal.tsx    # Per-run report options
    SavedReportsModal.tsx   # Report library (search, sort, rename, load)
    ShortcutsModal.tsx      # Keyboard shortcut reference

src-tauri/src/              # Rust backend
  lib.rs                    # Tauri commands, LLM integration, report persistence
  engine.rs                 # Stockfish worker pool (batch report analysis)
  live_engine.rs            # Persistent Stockfish process (real-time)
  lc0_engine.rs             # Leela Chess Zero integration (WDL + policy probe)
  lc0_config.rs             # Lc0 discovery, download, configuration
  prompts/chess-coach.md    # LLM system prompt (compiled in via include_str!)
```

## Where things are stored

Config and saved reports live in the platform's application-data
directory, resolved from the Tauri bundle identifier — e.g.
`~/.local/share/com.jbgreene.chess-coach/` on Linux.

| File | Contents |
|---|---|
| `config.json` | Engine mode, Lc0 paths, report setting defaults |
| `api_keys.json` | Stored API keys, Gemini Pro toggle |
| `reports/` | Saved post-game reports (JSON, one per analysis) |

### Environment variables

| Variable | Purpose |
|---|---|
| `STOCKFISH_PATH` | Path to Stockfish binary (overrides auto-detection) |
| `LC0_PATH` | Path to Lc0 binary (overrides auto-detection) |
| `GEMINI_API_KEY` | Google Gemini API key (fallback if not set in-app) |
| `OPENAI_API_KEY` | OpenAI API key (fallback if not set in-app) |

## Development

```bash
npm run tauri dev      # Vite dev server + Tauri window, hot reload
npx tsc --noEmit        # Type-check the frontend
cd src-tauri && cargo check   # Type-check the backend
```

On NixOS or with Nix installed, `nix develop` (using the `flake.nix`
in this repo) provides the native GTK/WebKit dependencies Tauri needs
on Linux; Rust and Node still come from your own toolchain.
