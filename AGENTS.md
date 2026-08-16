# AGENTS.md — Rook (chess-coach)

Desktop chess analysis app: Tauri 2 (Rust backend) + React 19 (TypeScript,
Vite). Live Stockfish analysis, AI coaching (Gemini/OpenAI), and a post-game
report pipeline (Stockfish batch pass → trap probe → optional Lc0 pass → LLM
explanations → thematic summary).

## Commands

```bash
nix develop                # Linux: REQUIRED for native GTK/WebKit deps (cargo fails without it)
npm run tauri dev          # dev server + app window
npm run build              # tsc + vite build (frontend gate)
npx tsc --noEmit           # frontend type check
cd src-tauri && cargo clippy   # backend lint — keep at ZERO warnings
```

There is no test suite yet. Gates: `npx tsc --noEmit`, `npm run build`,
`cargo clippy` clean.

## Layout

- `src/App.tsx` — app state + orchestration + layout. UI lives in
  `src/components/` (BoardSection is the shared board/eval-bar/toolbar block
  used by both the play view and `ReportView`; modals are separate files).
  Icons in `src/icons.tsx`, spring animations in `src/animate.tsx`.
- `src/gameAnalysis.ts` — the report pipeline and critical-moment taxonomy
  (pure logic, no Tauri types leak in except `invoke`/`listen` calls).
- `src/useLiveEngine.ts` — live engine hook (debounce, 10 Hz throttled
  flush, idle-stop, stale-while-revalidate for line panes). Talks to
  `src-tauri/src/live_engine.rs` (persistent Stockfish).
- `src-tauri/src/lib.rs` — all Tauri commands, LLM integration, report
  persistence. `engine.rs` (batch worker pool), `lc0_engine.rs` (Lc0 session:
  WDL pass + policy probe), `lc0_config.rs` (discovery/download).
- `src-tauri/src/prompts/chess-coach.md` — the coach system prompt, compiled
  in via `include_str!`. Edit the markdown, not a string literal.

## Conventions (follow these)

- **Tauri commands**: snake_case Rust params arrive camelCase in JS. Validate
  everything the webview sends (report IDs are `[A-Za-z0-9_-]{1,64}` — they
  become filenames; engine depth/nodes are bounded; FENs are validated with
  shakmaty before reaching an engine).
- **No panics in command handlers** — no `unwrap`/`expect` on fallible paths;
  return `Err(String)`. `app_data_dir()` goes through the `Result` helper.
- **Engine processes**: every stdout read has a timeout; children get
  `kill_on_drop(true)` or an explicit quit path. Never let a search hang the
  app or leak a process.
- **API keys / models**: written via `save_keys_to_disk` (0600 on Unix);
  never log them; `resolve_api_keys` handles in-app key → env var fallback.
  All LLM calls go through `llm_prompt` in lib.rs, which dispatches on the
  user-selected `analysis_model` via `provider_for_model` (the model
  catalog). Providers: anthropic / gemini / openai. The catalog is mirrored
  in `ANALYSIS_MODELS` in `src/components/SettingsModal.tsx` — add new
  models in BOTH places. Default model: `DEFAULT_ANALYSIS_MODEL` (Gemini
  Flash — only provider with a free tier). `use_gemini_pro` in api_keys.json
  is legacy, migrated by `ApiKeys::effective_model`.
- **Animations**: animejs `spring({ bounce: 0.4, duration: 500 })` via
  `PopIn`/`bouncy` from `src/animate.tsx` — only for discrete mount events
  (modals, cards, view entrances). Never on continuously-updating surfaces
  (eval bar, progress bars, engine lines): those keep plain CSS transitions.
  Respect `prefers-reduced-motion` (helpers already do).
- **Eval bar** is pinned to the board height via `.board-row`; its fill
  follows board orientation. `--board-size` in `App.css` is the single source
  of truth for layout dimensions.

## Critical-moment taxonomy (gameAnalysis.ts)

`blunder / mistake / inaccuracy` (eval-drop tiers), `turning_point`,
`opportunity` (opponent slipped; suppressed if the player can't use it),
`capitalized` (sound reply seizing an opportunity; overrides and records
`secondaryCategory`), `critical` (only-move; suppressed unless the game is
undecided), `brilliant` (sound sacrifice = engine's best move), `trap`
(tempting reply loses ≥3 pawns AND leaves the player ≥+1 or mated — the floor
exists because a "trap" in a lost position is noise; see the Kf1 lesson).
`great_move` / `golden_opportunity` are legacy categories kept only for
rendering reports saved by older versions.

Colors: blunder red, mistake orange, inaccuracy yellow, turning_point blue,
opportunity violet, capitalized green, critical cyan, brilliant gold, trap
pink. Add categories by extending the union, the badge CSS, `chipStyle`/
`evalChip*` in ReportView, the highlight switch in App.tsx, and the prompt
builder in lib.rs.

## Validating detector changes

Reproduce with a real game, not vibes. Pattern used so far: bundle
`src/gameAnalysis.ts` with esbuild (`--platform=node --format=esm`), alias
`@tauri-apps/api/core` to a stub whose `invoke("run_engine_pass")` runs a
local Stockfish child process, then run a known PGN through
`filterCriticalMoments` → `probeTrapCandidates` → `finalizeCandidateMoments` →
`applyCapitalization` and inspect the moments. The reference game is
tbkgreene–Batista1234567 (30.Rh8 must be a trap with bait Kxh8 → mate;
32.Kf1 must produce nothing).

## Storage

App data dir follows the Tauri bundle identifier
(`~/.local/share/com.jbgreene.chess-coach/` on Linux): `config.json`,
`api_keys.json` (0600), `reports/*.json`, `lc0/` (binary + weights).
