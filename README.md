# Rook

A desktop chess analysis application that combines real-time engine evaluation,
AI-powered coaching, and structured post-game reports to help players understand
their games and improve.

Built with [Tauri](https://tauri.app/) (Rust) and React (TypeScript).

## Features

### Live analysis

Stockfish runs continuously while you play or browse a game. The board displays
an evaluation bar, best-move arrows (color-coded by rank), and the top candidate
lines with scores. A two-phase MultiPV strategy starts narrow (3 lines) for fast
convergence, then widens (5 lines) once sufficient depth is reached.

### AI coaching

Click **Strategize** on any position to get a plain-language breakdown from an AI
coach. The coach identifies your likely plan, evaluates its soundness, suggests
concrete next moves, and warns about your opponent's counterplay. Powered by
Google Gemini or OpenAI, depending on which API key you provide.

### Post-game reports

Import a PGN, then generate a full-game report. The analysis pipeline runs in
four phases:

1. **Engine pass** &mdash; Stockfish evaluates every position at configurable
   depth (8, 12, or 18).
2. **Lc0 pass** *(optional, hybrid mode)* &mdash; Leela Chess Zero evaluates
   critical positions with 75,000 nodes, adding win/draw/loss probabilities and
   a neural-network perspective.
3. **LLM explanations** &mdash; Each critical moment gets a 2&ndash;3 sentence
   explanation tailored to its category.
4. **Thematic summary** &mdash; A game-wide narrative identifying patterns and
   suggesting one actionable area for improvement.

#### Critical moment categories

| Category | Trigger |
|---|---|
| Blunder | Eval drop > 2.0 pawns (detailed) or > 3.0 (standard) |
| Mistake | Eval drop > 1.0 / > 1.5 |
| Inaccuracy | Eval drop > 0.5 / > 0.75 |
| Turning point | Position swung from losing to winning |
| Critical | Only one strong move; gap to second-best > 1.5 pawns |
| Great move | Position improved > 1 pawn over the last two half-moves |
| Opportunity | Opponent's mistake or blunder you could have exploited |

Reports are saved automatically and can be browsed, loaded, or deleted from the
report library.

### Variation exploration

From any critical moment in a report, enter the engine's suggested best line and
step through it with arrow keys. Precomputed evaluations from the engine PV are
displayed without restarting Stockfish. Press **Up** to return to the exact
position you left on the main line.

### Engine modes

- **Standard** &mdash; Stockfish only. No additional downloads.
- **Advanced** &mdash; Stockfish + Leela Chess Zero. A setup wizard downloads
  the Lc0 binary and neural network weights automatically.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Left | Previous move |
| Right | Next move |
| `,` | Jump to start |
| `.` | Jump to end |
| Down | Enter suggested best line (report mode, main line) |
| Up | Return to main line (report mode, in variation) |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri CLI prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  platform
- [Stockfish](https://stockfishchess.org/download/) installed and available on
  your `PATH`, or set the `STOCKFISH_PATH` environment variable

### Optional

- **Lc0** &mdash; installed separately or downloaded through the in-app setup
  wizard for hybrid analysis mode.
- **API key** &mdash; A Google Gemini or OpenAI API key enables AI coaching and
  LLM-generated report explanations. Without a key, coaching and report
  explanations are unavailable, but engine analysis works fully. Add your key in
  the app via the key icon, or set `GEMINI_API_KEY` / `OPENAI_API_KEY` as
  environment variables.

## Get started

```bash
# Install frontend dependencies
npm install

# Run in development mode (starts Vite dev server + Tauri window)
npm run tauri dev

# Build a production binary
npm run tauri build
```

## Project structure

```
src/                        # React frontend
  App.tsx                   # Main UI: board, navigation, tabs, reports
  useLiveEngine.ts          # Real-time Stockfish analysis hook
  gameAnalysis.ts           # Post-game analysis pipeline
  SetupWizard.tsx           # First-launch engine setup flow
  prompts/chess-coach.md    # LLM system prompt

src-tauri/src/              # Rust backend
  lib.rs                    # Tauri commands, LLM integration, report persistence
  engine.rs                 # Stockfish worker pool (batch analysis)
  live_engine.rs            # Persistent Stockfish process (real-time)
  lc0_engine.rs             # Leela Chess Zero integration
  lc0_config.rs             # Lc0 discovery, download, configuration
```

## Tech stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite |
| Chess logic | chess.js, react-chessboard |
| Backend | Rust, Tokio, Serde |
| Engine protocol | UCI (Stockfish, Lc0) |
| AI providers | Google Gemini, OpenAI (via rig-core) |
| Move validation | shakmaty (Rust-side FEN/SAN) |

## Configuration

The app stores its configuration and saved reports in the platform-specific
application data directory (for example, `~/.local/share/chess-coach/` on Linux).

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
