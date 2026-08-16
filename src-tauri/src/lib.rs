mod engine;
mod lc0_config;
mod lc0_engine;
mod live_engine;

use rig::providers::{anthropic, openai, gemini};
use rig::completion::Prompt;
use rig::client::CompletionClient;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

/// System prompt for the report pipeline (critical-moment explanations and
/// thematic summaries).  Single source of truth — maintained in
/// `src-tauri/src/prompts/chess-coach.md`.
const COACH_SYSTEM_PROMPT: &str = include_str!("prompts/chess-coach.md");

// Model IDs verified against provider docs (Aug 2026) — rig-core's bundled
// constants lag behind, so these are literals. Recheck occasionally; a
// retired ID surfaces as a provider 404.
const GEMINI_FLASH_MODEL: &str = "gemini-3.7-flash";
const GEMINI_FLASH_LITE_MODEL: &str = "gemini-3.5-flash-lite";
const GEMINI_PRO_MODEL: &str = "gemini-3.1-pro-preview";

/// Default model for the coach and report pipeline: Gemini Flash — the only
/// provider of the three with a genuine free tier (Google AI Studio key).
const DEFAULT_ANALYSIS_MODEL: &str = GEMINI_FLASH_MODEL;

/// Model catalog: (model id, provider). The settings UI mirrors this list —
/// keep the two in sync.
fn provider_for_model(model: &str) -> Option<&'static str> {
    const CATALOG: &[(&str, &str)] = &[
        ("claude-haiku-4-5", "anthropic"),
        ("claude-sonnet-5", "anthropic"),
        ("claude-opus-5", "anthropic"),
        (GEMINI_FLASH_MODEL, "gemini"),
        (GEMINI_FLASH_LITE_MODEL, "gemini"),
        (GEMINI_PRO_MODEL, "gemini"),
        ("gpt-5.6-luna", "openai"),
        ("gpt-5.6-terra", "openai"),
        ("gpt-5.6-sol", "openai"),
    ];
    CATALOG
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, provider)| *provider)
}

// ── Context-Injection Pipeline types ──────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CriticalMomentData {
    fen: String,
    move_san: String,
    move_number: u32,
    side: String,
    eval_before: f64,
    eval_after: f64,
    eval_drop: f64,
    category: String,
    best_move_san: String,
    best_line: Vec<String>,
    lc0_wdl: Option<Vec<u32>>,
    lc0_top_move: Option<String>,
    lc0_line: Option<Vec<String>>,
    // Trap context (present when category == "trap")
    bait_move_san: Option<String>,
    refutation_line: Option<Vec<String>>,
    refutation_eval: Option<f64>,
    // What the move also qualifies as (e.g. a capitalized trap)
    secondary_category: Option<String>,
}

fn build_lc0_context(m: &CriticalMomentData) -> String {
    if let Some(ref wdl) = m.lc0_wdl {
        if wdl.len() == 3 {
            let w = wdl[0] as f64 / 10.0;
            let d = wdl[1] as f64 / 10.0;
            let l = wdl[2] as f64 / 10.0;
            let line_str = m.lc0_line.as_ref()
                .map(|l| l.join(" "))
                .unwrap_or_default();
            return format!(
                "\nLeela Chess Zero assessment: {:.1}% win, {:.1}% draw, {:.1}% loss.\n\
                 Lc0's preferred continuation: {}\n\
                 Use this strategic perspective to enrich your explanation.",
                w, d, l, line_str,
            );
        }
    }
    String::new()
}

fn build_critical_moment_prompt(
    m: &CriticalMomentData,
    perspective: &str,
    session_log: Option<&str>,
) -> String {
    let category_desc = match m.category.as_str() {
        "blunder" => "a serious blunder",
        "mistake" => "a significant mistake",
        "inaccuracy" => "an inaccuracy",
        "turning_point" => "a critical turning point",
        "great_move" => "a great move",
        "critical" => "a critical move",
        "brilliant" => "a brilliant move",
        "trap" => "a cunning trap",
        "capitalized" => "a well-timed punishment of the opponent's mistake",
        "opportunity" => "a mistake by the opponent (an opportunity for you)",
        "golden_opportunity" => "a serious blunder by the opponent (a golden opportunity for you)",
        _ => "a notable moment",
    };

    let is_player_move = m.side == perspective;
    let opponent = if perspective == "white" { "black" } else { "white" };

    let is_great_move = m.category == "great_move";
    let is_critical = m.category == "critical";
    let is_brilliant = m.category == "brilliant";
    let is_trap = m.category == "trap";
    let is_capitalized = m.category == "capitalized";

    let lc0_ctx = build_lc0_context(m);

    let prompt = if is_player_move && is_capitalized {
        let secondary_note = match m.secondary_category.as_deref() {
            Some("trap") => {
                let bait = m.bait_move_san.as_deref().unwrap_or("the tempting reply");
                let refutation = m
                    .refutation_line
                    .as_ref()
                    .map(|l| l.join(" "))
                    .unwrap_or_default();
                format!(
                    "\nThis move also works as a trap: the tempting {} loses to {}.",
                    bait, refutation
                )
            }
            Some("brilliant") => "\nThis move is also a brilliant sacrifice.".to_string(),
            Some("critical") => {
                "\nThis was also the only strong move in a sharp position.".to_string()
            }
            _ => String::new(),
        };
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            The opponent's previous move slipped by {drop:.1} pawns, and you seized on it with {san}.\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            {secondary}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Acknowledge that they recognized and seized the opportunity — be encouraging but factual.\n\
            2. Why {san} was the right way to punish the mistake — the tactical or strategic idea behind it.\n\
            Only reference moves that appear in this data — never invent move sequences.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            drop = m.eval_drop,
            eb = m.eval_before,
            ea = m.eval_after,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
            secondary = secondary_note,
        )
    } else if is_player_move && is_trap {
        let bait = m.bait_move_san.as_deref().unwrap_or("the tempting reply");
        let refutation = m
            .refutation_line
            .as_ref()
            .map(|l| l.join(" "))
            .unwrap_or_default();
        let ref_eval = m.refutation_eval.unwrap_or(0.0);
        // Never leave a dangling "loses to <blank>" — an empty refutation
        // invites the model to invent moves that were never calculated.
        let (refutation_clause, refutation_instruction) = if refutation.is_empty() {
            (
                format!(
                    "The tempting reply {bait} fails on positional grounds \
                     (evaluation after it: {ref_eval:+.2} pawns in your favor).",
                ),
                String::from(
                    "Why the bait fails and what the opponent should have played instead.",
                ),
            )
        } else {
            (
                format!(
                    "The hidden point: the tempting reply {bait} loses to {refutation} \
                     (evaluation after the bait: {ref_eval:+.2} pawns in your favor).",
                ),
                format!(
                    "The tactical idea behind the refutation ({refutation}) and what the opponent should have played instead.",
                ),
            )
        };
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position after the player's move (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            {refutation_clause}\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Why your move {san} sets a trap — what the opponent is tempted to grab with {bait} and why it is poisoned.\n\
            2. {refutation_instruction}\n\
            Only reference moves that appear in this data — never invent move sequences.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            refutation_clause = refutation_clause,
            refutation_instruction = refutation_instruction,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    } else if is_player_move && is_brilliant {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num}) — a sacrifice!\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Why your move {san} is brilliant — you gave up material, so explain what compensation (attack, initiative, king exposure, structure) it buys.\n\
            2. Why the position remains sound and what the follow-up plan is.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    } else if is_player_move && is_critical {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Evaluation gain: {gain:.1} pawns — classified as {cat}\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Why your move {san} was critical — this was the only strong continuation in a complex position, and you found it.\n\
            2. What made the alternatives so much worse and why this position demanded precise play.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            gain = -m.eval_drop,
            cat = category_desc,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    } else if is_player_move && is_great_move {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Evaluation gain: {gain:.1} pawns — classified as {cat}\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Why your move {san} was excellent — what tactical or strategic idea it exploited.\n\
            2. What positional or tactical principle made this the strongest choice.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            gain = -m.eval_drop,
            cat = category_desc,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    } else if is_player_move {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Evaluation drop: {drop:.1} pawns — classified as {cat}\n\
            Stockfish's preferred move: {best}\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the player:\n\
            1. Why your move {san} was {cat} — what tactical or strategic principle was violated.\n\
            2. What you should have played instead ({best}) and the key idea behind that continuation.\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            drop = m.eval_drop,
            cat = category_desc,
            best = m.best_move_san,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    } else {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            Your opponent ({opponent}) played: {san} (Move {num})\n\
            This was {cat} by your opponent — evaluation before: {eb:+.2}, after: {ea:+.2} (drop: {drop:.1} pawns)\n\
            Stockfish's preferred move for the opponent was: {best}\n\
            Stockfish's top line: {line}\n\
            {lc0}\n\
            In 2-3 concise sentences, explain to the {perspective} player:\n\
            1. Why the opponent's move {san} was {cat} and what opportunity it created for you.\n\
            2. How you should look to exploit this type of mistake — what continuation or idea should you be alert for?\n\
            Address the player directly as \"you\".",
            perspective = perspective,
            opponent = opponent,
            fen = m.fen,
            san = m.move_san,
            num = m.move_number,
            eb = m.eval_before,
            ea = m.eval_after,
            drop = m.eval_drop,
            cat = category_desc,
            best = m.best_move_san,
            line = m.best_line.join(" "),
            lc0 = lc0_ctx,
        )
    };

    // Narrative continuity: the coach sees a one-line digest of earlier
    // moments so explanations can reference the game's unfolding story.
    match session_log {
        Some(log) if !log.is_empty() => format!(
            "{}\n\nEarlier moments from this game (for narrative continuity — reference them when relevant):\n{}",
            prompt, log
        ),
        _ => prompt,
    }
}

fn build_thematic_summary_prompt(moments: &[CriticalMomentData], san_moves: &[String], perspective: &str, include_great_moves: bool, game_result: &str, include_opportunities: bool, termination: Option<&str>) -> String {
    let opponent = if perspective == "white" { "black" } else { "white" };

    // The PGN Termination header (e.g. "rdinho73 won by resignation") is
    // ground truth when present — prefer it over the mapped result.
    let result_context = match (game_result, termination) {
        (_, Some(t)) if !t.is_empty() => format!("Game ended: {}.", t),
        ("win", _) => format!("The {} player won this game.", perspective),
        ("loss", _) => format!("The {} player lost this game.", perspective),
        ("draw", _) => "The game ended in a draw.".to_string(),
        _ => "The game result was not recorded. Do NOT mention the result or \
              its absence at all — focus the summary entirely on the play."
            .to_string(),
    };

    let mut prompt = format!(
        "You are a chess coach providing a targeted post-game summary for the {perspective} player.\n\n\
        Game result: {result}\n\n\
        The following critical moments were identified:\n\n",
        perspective = perspective,
        result = result_context,
    );

    let has_lc0 = moments.iter().any(|m| m.lc0_wdl.is_some());
    if has_lc0 {
        prompt += "Note: Leela Chess Zero (Lc0) strategic analysis was used alongside Stockfish for deeper positional insight.\n\n";
    }

    for m in moments {
        let whose = if m.side == perspective {
            "Your move".to_string()
        } else {
            format!("Opponent's ({}) move", opponent)
        };
        let wdl_str = m.lc0_wdl.as_ref()
            .filter(|w| w.len() == 3)
            .map(|w| format!(" [Lc0 WDL: {:.1}%/{:.1}%/{:.1}%]", w[0] as f64 / 10.0, w[1] as f64 / 10.0, w[2] as f64 / 10.0))
            .unwrap_or_default();
        if m.category == "trap" {
            let bait = m.bait_move_san.as_deref().unwrap_or("the tempting reply");
            let refutation = m
                .refutation_line
                .as_ref()
                .map(|l| l.join(" "))
                .unwrap_or_default();
            prompt += &format!(
                "- Move {} ({}): Played {} — a trap! The tempting {} loses to {}.{}\n",
                m.move_number, whose, m.move_san, bait, refutation, wdl_str,
            );
        } else if m.category == "capitalized" {
            let secondary = m
                .secondary_category
                .as_deref()
                .map(|s| format!(" (also a {})", s.replace('_', " ")))
                .unwrap_or_default();
            prompt += &format!(
                "- Move {} ({}): Played {} — capitalized on the opponent's mistake{} (gained {:.1} pawns).{}\n",
                m.move_number, whose, m.move_san, secondary, m.eval_drop, wdl_str,
            );
        } else if m.category == "brilliant" {
            prompt += &format!(
                "- Move {} ({}): Played {} — a brilliant sacrifice, eval gain: {:.1} pawns.{}\n",
                m.move_number, whose, m.move_san, -m.eval_drop, wdl_str,
            );
        } else if m.category == "critical" {
            prompt += &format!(
                "- Move {} ({}): Played {}. Category: critical, eval gain: {:.1} pawns. Found the only strong move in a complex position.{}\n",
                m.move_number, whose, m.move_san, -m.eval_drop, wdl_str,
            );
        } else if m.category == "great_move" {
            prompt += &format!(
                "- Move {} ({}): Played {}. Category: great_move, eval gain: {:.1} pawns.{}\n",
                m.move_number, whose, m.move_san, -m.eval_drop, wdl_str,
            );
        } else if m.category == "opportunity" || m.category == "golden_opportunity" {
            let label = if m.category == "golden_opportunity" { "golden opportunity" } else { "opportunity" };
            prompt += &format!(
                "- Move {} ({}): Opponent played {}. Category: {} — eval swing of {:.1} pawns in your favor. Best response: {}.{}\n",
                m.move_number, whose, m.move_san, label, m.eval_drop, m.best_move_san, wdl_str,
            );
        } else {
            prompt += &format!(
                "- Move {} ({}): Played {}, best was {}. Category: {}, eval before: {:.2}, eval after: {:.2} (drop: {:.1} pawns).{}\n",
                m.move_number, whose, m.move_san, m.best_move_san, m.category, m.eval_before, m.eval_after, m.eval_drop, wdl_str,
            );
        }
    }

    // Full game score, so move references are grounded in visible data
    // rather than reconstructed from the moments list.
    if !san_moves.is_empty() {
        prompt += &format!("\nFull game moves:\n{}\n", san_moves.join(" "));
    }

    prompt += "\nWhen writing the summary, follow this procedure exactly:\n\
        1. Select the 2-3 patterns that cover the largest total eval drop in the moment list.\n\
        2. For each pattern, cite only moves from the moment list, quoting move numbers, SANs, and eval figures verbatim.\n\
        3. State the engine's best move exactly as given in the data when discussing what should have been played.\n";

    let opp_instruction = if include_opportunities {
        "\n- Comment on whether you capitalized on the opportunities your opponent gave you, or if you missed chances to seize the advantage"
    } else {
        ""
    };

    if include_great_moves {
        prompt += &format!(
            "\nProvide a brief personalized summary for the {} player:\n\
            - Open with a brief, factual acknowledgment of the game result (congratulations on a win, or a frank but not discouraging note on a loss)\n\
            - Note any strong moves or sound tactical/positional decisions the player made\n\
            - If there were mistakes, identify the key patterns to work on{}\n\
            - Give 2-3 concrete principles or lessons to keep in mind for future games. \
            Each lesson MUST reference the specific move from this game it applies to \
            (in algebraic notation, e.g. \"after 12. Ng5\"), so the app can link it to the board\n\
            Keep the tone direct and factual — recognize good play without excessive praise.\n\
            Address the player directly as \"you\".",
            perspective, opp_instruction,
        );
    } else {
        prompt += &format!(
            "\nProvide a brief personalized summary for the {} player:\n\
            - Open with a brief, factual acknowledgment of the game result (congratulations on a win, or a frank but not discouraging note on a loss)\n\
            - Identify your most common types of errors and recurring patterns\n\
            - Note if you missed opportunities to capitalize on your opponent's mistakes{}\n\
            - Give 2-3 concrete principles or lessons to keep in mind for future games. \
            Each lesson MUST reference the specific move from this game it applies to \
            (in algebraic notation, e.g. \"after 12. Ng5\"), so the app can link it to the board\n\
            Address the player directly as \"you\".",
            perspective, opp_instruction,
        );
    }

    prompt
}

// ── Key resolution helper ────────────────────────────────────

/// Resolve (analysis_model, gemini_key, openai_key, anthropic_key).
/// User-configured keys take priority over environment-variable fallbacks.
fn resolve_api_keys(state: &Mutex<ApiKeys>) -> Result<(String, String, String, String), String> {
    let keys = state.lock().map_err(|e| e.to_string())?;
    let gemini = keys.gemini_api_key.clone().unwrap_or_default();
    let openai = keys.openai_api_key.clone().unwrap_or_default();
    let anthropic = keys.anthropic_api_key.clone().unwrap_or_default();
    let gemini = if gemini.is_empty() { env::var("GEMINI_API_KEY").unwrap_or_default() } else { gemini };
    let openai = if openai.is_empty() { env::var("OPENAI_API_KEY").unwrap_or_default() } else { openai };
    let anthropic = if anthropic.is_empty() { env::var("ANTHROPIC_API_KEY").unwrap_or_default() } else { anthropic };
    Ok((keys.effective_model(), gemini, openai, anthropic))
}

// ── Persistence ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ApiKeys {
    gemini_api_key: Option<String>,
    openai_api_key: Option<String>,
    #[serde(default)]
    anthropic_api_key: Option<String>,
    /// Selected analysis model. None on files written by older versions —
    /// migrated in `effective_model` from the legacy use_gemini_pro flag.
    #[serde(default)]
    analysis_model: Option<String>,
    /// Legacy: pre-model-picker "use Gemini Pro" toggle. Read-only, kept so
    /// old api_keys.json files still parse and migrate.
    #[serde(default)]
    use_gemini_pro: bool,
}

impl ApiKeys {
    fn effective_model(&self) -> String {
        if let Some(m) = &self.analysis_model {
            // A saved model may have been retired by the provider — fall
            // back to the default rather than erroring on every call.
            if provider_for_model(m).is_some() {
                return m.clone();
            }
        }
        // Migration for key files written before the model picker existed.
        if self.use_gemini_pro {
            GEMINI_PRO_MODEL.to_string()
        } else {
            DEFAULT_ANALYSIS_MODEL.to_string()
        }
    }
}

struct AppState {
    api_keys: Mutex<ApiKeys>,
    live_engine: live_engine::LiveEngineHandle,
    config: Mutex<lc0_config::AppConfig>,
    /// Set by `cancel_analysis`; engine passes check it between positions.
    analysis_cancel: Arc<AtomicBool>,
}

// ── Report Persistence ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedReport {
    id: String,
    game_hash: String,
    created_at: String,
    perspective: String,
    move_count: u32,
    opening_moves: String,
    #[serde(default = "default_result")]
    result: String,
    /// Optional user-assigned display name (e.g. "Club game vs. Alex").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    white_player: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    black_player: Option<String>,
    /// PGN Result header ("1-0" etc.) — the only record of a resignation or
    /// timeout win, so it must persist with the report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pgn_result: Option<String>,
    /// PGN Termination header (e.g. "rdinho73 won by resignation").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    termination: Option<String>,
    report: GameAnalysisReportData,
    game_history: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evaluations: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    game_san_list: Option<Vec<String>>,
}

fn default_result() -> String {
    "unknown".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameAnalysisReportData {
    critical_moments: Vec<CriticalMomentFull>,
    thematic_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CriticalMomentFull {
    fen: String,
    move_san: String,
    move_number: u32,
    side: String,
    eval_before: f64,
    eval_after: f64,
    eval_drop: f64,
    category: String,
    best_move_san: String,
    best_line: Vec<String>,
    llm_explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedReportMeta {
    id: String,
    game_hash: String,
    created_at: String,
    perspective: String,
    move_count: u32,
    opening_moves: String,
    critical_moment_count: u32,
    #[serde(default = "default_result")]
    result: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    white_player: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    black_player: Option<String>,
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data directory: {}", e))
}

fn get_reports_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("reports"))
}

fn ensure_reports_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = get_reports_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create reports directory: {}", e))
}

/// Report IDs become filenames — reject anything that could escape the
/// reports directory (path traversal).
fn validate_report_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("Invalid report ID".to_string())
    }
}

#[derive(Debug, Serialize)]
struct ApiKeyStatus {
    gemini_set: bool,
    gemini_hint: String,
    openai_set: bool,
    openai_hint: String,
    anthropic_set: bool,
    anthropic_hint: String,
    analysis_model: String,
}

fn get_keys_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("api_keys.json"))
}

fn load_keys_from_disk(path: &PathBuf) -> ApiKeys {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_keys_to_disk(path: &PathBuf, keys: &ApiKeys) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    // The file contains secrets — restrict to owner read/write.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn make_hint(key: &Option<String>) -> String {
    match key {
        Some(k) if k.chars().count() >= 4 => {
            // Char-based slice — a byte slice could panic on multi-byte UTF-8.
            let tail: String = k
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            format!("\u{2022}\u{2022}\u{2022}\u{2022}{}", tail)
        }
        Some(_) => "\u{2022}\u{2022}\u{2022}\u{2022}".to_string(),
        None => String::new(),
    }
}

#[tauri::command]
fn get_api_keys(state: tauri::State<'_, AppState>) -> Result<ApiKeyStatus, String> {
    let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    Ok(ApiKeyStatus {
        gemini_set: keys.gemini_api_key.is_some(),
        gemini_hint: make_hint(&keys.gemini_api_key),
        openai_set: keys.openai_api_key.is_some(),
        openai_hint: make_hint(&keys.openai_api_key),
        anthropic_set: keys.anthropic_api_key.is_some(),
        anthropic_hint: make_hint(&keys.anthropic_api_key),
        analysis_model: keys.effective_model(),
    })
}

#[tauri::command]
fn save_api_key(provider: String, key: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    match provider.as_str() {
        "gemini" => keys.gemini_api_key = Some(key),
        "openai" => keys.openai_api_key = Some(key),
        "anthropic" => keys.anthropic_api_key = Some(key),
        _ => return Err(format!("Unknown provider: {}", provider)),
    }
    save_keys_to_disk(&get_keys_file_path(&app)?, &keys)?;
    Ok(())
}

#[tauri::command]
fn remove_api_key(provider: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    match provider.as_str() {
        "gemini" => keys.gemini_api_key = None,
        "openai" => keys.openai_api_key = None,
        "anthropic" => keys.anthropic_api_key = None,
        _ => return Err(format!("Unknown provider: {}", provider)),
    }
    save_keys_to_disk(&get_keys_file_path(&app)?, &keys)?;
    Ok(())
}

#[tauri::command]
fn set_analysis_model(model: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    if provider_for_model(&model).is_none() {
        return Err(format!("Unknown analysis model: {}", model));
    }
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    keys.analysis_model = Some(model);
    save_keys_to_disk(&get_keys_file_path(&app)?, &keys)?;
    Ok(())
}

/// Send a single prompt to the user's selected analysis model. Dispatches
/// on the model's provider; errors clearly when that provider has no key
/// (instead of silently falling back to another provider).
async fn llm_prompt(
    preamble: &str,
    prompt_text: &str,
    state: &AppState,
) -> Result<String, String> {
    let (model, gemini_key, openai_key, anthropic_key) = resolve_api_keys(&state.api_keys)?;
    let provider = provider_for_model(&model)
        .ok_or_else(|| format!("Unknown analysis model: {}", model))?;

    match provider {
        "anthropic" => {
            if anthropic_key.is_empty() {
                return Err("No Anthropic API key configured. Add one in Settings or pick a model from a provider you have a key for.".to_string());
            }
            let client = anthropic::Client::new(&anthropic_key)
                .map_err(|e| format!("Failed to initialise Anthropic client: {}", e))?;
            // Anthropic's API rejects requests without max_tokens.
            let agent = client.agent(&model)
                .preamble(preamble)
                .max_tokens(4096)
                .build();
            agent.prompt(prompt_text).await.map_err(|e| format!("Claude Error: {}", e))
        }
        "gemini" => {
            if gemini_key.is_empty() {
                return Err("No Gemini API key configured. Add one in Settings or pick a model from a provider you have a key for.".to_string());
            }
            let client = gemini::Client::new(&gemini_key)
                .map_err(|e| format!("Failed to initialise Gemini client: {}", e))?;
            let agent = client.agent(&model).preamble(preamble).build();
            agent.prompt(prompt_text).await.map_err(|e| format!("Gemini Error: {}", e))
        }
        "openai" => {
            if openai_key.is_empty() {
                return Err("No OpenAI API key configured. Add one in Settings or pick a model from a provider you have a key for.".to_string());
            }
            let client = openai::Client::new(&openai_key)
                .map_err(|e| format!("Failed to initialise OpenAI client: {}", e))?;
            let agent = client.agent(&model).preamble(preamble).build();
            agent.prompt(prompt_text).await.map_err(|e| format!("OpenAI Error: {}", e))
        }
        _ => Err(format!("Unknown provider for model: {}", model)),
    }
}

#[tauri::command]
async fn explain_move(
    fen: String,
    evaluation: String,
    top_lines: String,
    perspective: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (_, gemini_key, openai_key, anthropic_key) = resolve_api_keys(&state.api_keys)?;

    if gemini_key.is_empty() && openai_key.is_empty() && anthropic_key.is_empty() {
        return Ok("No API key found. Open Settings to add an API key for the model you've selected — engine analysis works fully without one.".to_string());
    }

    let preamble = format!("You are a grandmaster AI chess coach. The user is a beginner to intermediate player. They are currently playing from the perspective of {}. Using the provided current board state (FEN), Stockfish evaluation, and top projected lines, explain the position and tell the user *why* the top suggested move is a good idea. Keep it highly concise (2-3 sentences max), friendly, and instructional. Frame your advice specifically for the {} player.", perspective, perspective);
    let prompt_text = format!(
        "Here is the current board state FEN: {}\nStockfish Evaluation: {}\nTop Engine Lines:\n{}",
        fen, evaluation, top_lines
    );

    llm_prompt(&preamble, &prompt_text, &state).await
}

// ── Context-Injection Pipeline commands ───────────────────────

#[tauri::command]
async fn explain_critical_moment(
    moment: CriticalMomentData,
    perspective: String,
    session_log: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (_, gemini_key, openai_key, anthropic_key) = resolve_api_keys(&state.api_keys)?;

    if gemini_key.is_empty() && openai_key.is_empty() && anthropic_key.is_empty() {
        return Err("No API key configured.".to_string());
    }

    let prompt =
        build_critical_moment_prompt(&moment, &perspective, session_log.as_deref());

    llm_prompt(COACH_SYSTEM_PROMPT, &prompt, &state).await
}

#[tauri::command]
async fn generate_thematic_summary(
    moments: Vec<CriticalMomentData>,
    san_moves: Option<Vec<String>>,
    perspective: String,
    include_great_moves: Option<bool>,
    include_opportunities: Option<bool>,
    game_result: Option<String>,
    termination: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (_, gemini_key, openai_key, anthropic_key) = resolve_api_keys(&state.api_keys)?;

    if gemini_key.is_empty() && openai_key.is_empty() && anthropic_key.is_empty() {
        return Err("No API key configured.".to_string());
    }

    // Bound the move list — it goes straight into the prompt.
    let san_moves: Vec<String> = san_moves.unwrap_or_default().into_iter().take(500).collect();

    let result_str = game_result.as_deref().unwrap_or("unknown");
    let prompt = build_thematic_summary_prompt(&moments, &san_moves, &perspective, include_great_moves.unwrap_or(false), result_str, include_opportunities.unwrap_or(false), termination.as_deref());

    llm_prompt(COACH_SYSTEM_PROMPT, &prompt, &state).await
}

// ── Report Persistence Commands ───────────────────────────────

#[tauri::command]
fn save_report(report: SavedReport, app: tauri::AppHandle) -> Result<(), String> {
    validate_report_id(&report.id)?;
    ensure_reports_dir(&app)?;
    let path = get_reports_dir(&app)?.join(format!("{}.json", report.id));
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_reports(app: tauri::AppHandle) -> Result<Vec<SavedReportMeta>, String> {
    ensure_reports_dir(&app)?;
    let dir = get_reports_dir(&app)?;
    let mut reports: Vec<SavedReportMeta> = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let contents = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let report: SavedReport = match serde_json::from_str(&contents) {
            Ok(r) => r,
            Err(_) => continue,
        };
        reports.push(SavedReportMeta {
            id: report.id,
            game_hash: report.game_hash,
            created_at: report.created_at,
            perspective: report.perspective,
            move_count: report.move_count,
            opening_moves: report.opening_moves,
            critical_moment_count: report.report.critical_moments.len() as u32,
            result: report.result.clone(),
            name: report.name.clone(),
            white_player: report.white_player.clone(),
            black_player: report.black_player.clone(),
        });
    }

    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(reports)
}

#[tauri::command]
fn load_report(id: String, app: tauri::AppHandle) -> Result<SavedReport, String> {
    validate_report_id(&id)?;
    let path = get_reports_dir(&app)?.join(format!("{}.json", id));
    let contents = fs::read_to_string(&path).map_err(|e| format!("Report not found: {}", e))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse report: {}", e))
}

#[tauri::command]
fn delete_report(id: String, app: tauri::AppHandle) -> Result<(), String> {
    validate_report_id(&id)?;
    let path = get_reports_dir(&app)?.join(format!("{}.json", id));
    fs::remove_file(&path).map_err(|e| format!("Failed to delete report: {}", e))
}

#[tauri::command]
fn rename_report(id: String, name: String, app: tauri::AppHandle) -> Result<(), String> {
    validate_report_id(&id)?;
    let name = name.trim().to_string();
    if name.chars().count() > 100 {
        return Err("Name too long (max 100 characters)".to_string());
    }
    let path = get_reports_dir(&app)?.join(format!("{}.json", id));
    let contents = fs::read_to_string(&path).map_err(|e| format!("Report not found: {}", e))?;
    let mut report: SavedReport =
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse report: {}", e))?;
    // An empty name clears the custom name and falls back to the opening line.
    report.name = if name.is_empty() { None } else { Some(name) };
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn check_report_exists(game_hash: String, app: tauri::AppHandle) -> Result<Option<SavedReportMeta>, String> {
    ensure_reports_dir(&app)?;
    let dir = get_reports_dir(&app)?;
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let contents = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let report: SavedReport = match serde_json::from_str(&contents) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if report.game_hash == game_hash {
            return Ok(Some(SavedReportMeta {
                id: report.id,
                game_hash: report.game_hash,
                created_at: report.created_at,
                perspective: report.perspective,
                move_count: report.move_count,
                opening_moves: report.opening_moves,
                critical_moment_count: report.report.critical_moments.len() as u32,
                result: report.result.clone(),
                name: report.name.clone(),
                white_player: report.white_player.clone(),
                black_player: report.black_player.clone(),
            }));
        }
    }

    Ok(None)
}

// ── Live Engine Commands ──────────────────────────────────────

#[tauri::command]
async fn live_engine_set_fen(fen: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.live_engine.set_fen(fen).await
}

#[tauri::command]
async fn live_engine_new_game(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.live_engine.new_game().await
}

#[tauri::command]
async fn live_engine_stop(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.live_engine.stop().await
}

// ── Stockfish Worker Pool Command ─────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineProgress {
    current: usize,
    total: usize,
}

#[tauri::command]
async fn run_engine_pass(
    positions: Vec<String>,
    depth: u32,
    multipv: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<engine::PositionEval>, String> {
    // Bounds-check parameters — these commands are reachable from any JS in
    // the webview, so don't trust them blindly.
    if !(1..=30).contains(&depth) {
        return Err(format!("Invalid depth {} (expected 1-30)", depth));
    }
    if !(1..=10).contains(&multipv) {
        return Err(format!("Invalid MultiPV {} (expected 1-10)", multipv));
    }
    let stockfish_path = engine::find_stockfish_path()?;
    let total = positions.len();
    let completed = Arc::new(AtomicUsize::new(0));
    let done = Arc::new(AtomicBool::new(false));

    // Background task: poll the shared counter and emit progress events.
    // Stops when `done` is set (on success *or* failure).
    let completed_for_progress = completed.clone();
    let done_for_progress = done.clone();
    let app_for_progress = app.clone();
    let progress_task = tokio::spawn(async move {
        let mut last_reported = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if done_for_progress.load(Ordering::Relaxed) {
                break;
            }
            let current = completed_for_progress.load(Ordering::Relaxed);
            if current != last_reported {
                last_reported = current;
                let _ = app_for_progress.emit(
                    "engine-progress",
                    EngineProgress { current, total },
                );
            }
        }
    });

    // Fresh pass → clear any previous cancellation, then hand the flag to
    // the worker pool so `cancel_analysis` stops it between positions.
    state.analysis_cancel.store(false, Ordering::Relaxed);
    let cancel = state.analysis_cancel.clone();

    let result = engine::run_engine_pass(
        positions,
        depth,
        multipv,
        &stockfish_path,
        completed,
        cancel,
    )
    .await;

    // Signal the progress poller to stop, then wait for it
    done.store(true, Ordering::Relaxed);
    let _ = progress_task.await;
    result
}

/// Abort an in-progress report analysis. Engine workers check the flag
/// between positions; the frontend pipeline checks its own flag between
/// steps and stops issuing further commands.
#[tauri::command]
fn cancel_analysis(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.analysis_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

// ── Lc0 Config Commands ───────────────────────────────────────

#[tauri::command]
fn get_app_config(state: tauri::State<'_, AppState>) -> Result<lc0_config::AppConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
fn set_engine_mode(mode: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.engine_mode = match mode.as_str() {
        "hybrid" => lc0_config::EngineMode::Hybrid,
        _ => lc0_config::EngineMode::StockfishOnly,
    };
    config.setup_complete = true;
    lc0_config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
fn save_report_settings(
    analysis_depth: u32,
    include_great_moves: bool,
    detailed_report: bool,
    use_lc0: bool,
    include_opportunities: bool,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.analysis_depth = analysis_depth;
    config.include_great_moves = include_great_moves;
    config.detailed_report = detailed_report;
    config.use_lc0 = use_lc0;
    config.include_opportunities = include_opportunities;
    lc0_config::save_config(&app, &config)?;
    Ok(())
}

#[tauri::command]
async fn setup_lc0(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    lc0_config::setup_lc0(app.clone()).await?;
    // Reload config into state
    let new_config = lc0_config::load_config(&app);
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    *config = new_config;
    Ok(())
}

#[tauri::command]
fn check_lc0_ready(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<bool, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(lc0_config::check_lc0_ready(&config, &app))
}

#[tauri::command]
async fn run_lc0_pass(
    positions: Vec<String>,
    nodes: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<lc0_engine::Lc0Eval>, String> {
    if !(1..=1_000_000).contains(&nodes) {
        return Err(format!("Invalid node count {} (expected 1-1000000)", nodes));
    }
    let (lc0_path, weights_path) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let lp = lc0_config::find_lc0_path(&config, &app)
            .ok_or("Lc0 binary not found. Run setup first.")?;
        let wp = lc0_config::find_weights_path(&config, &app)
            .ok_or("Lc0 weights not found. Run setup first.")?;
        (lp, wp)
    };

    lc0_engine::run_lc0_pass(positions, nodes, &lc0_path, &weights_path, app).await
}

#[tauri::command]
async fn run_lc0_policy_probe(
    positions: Vec<String>,
    nodes: u32,
    top_n: Option<usize>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<Vec<lc0_engine::Lc0PolicyMove>>, String> {
    if !(1..=100_000).contains(&nodes) {
        return Err(format!("Invalid node count {} (expected 1-100000)", nodes));
    }
    let (lc0_path, weights_path) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let lp = lc0_config::find_lc0_path(&config, &app)
            .ok_or("Lc0 binary not found. Run setup first.")?;
        let wp = lc0_config::find_weights_path(&config, &app)
            .ok_or("Lc0 weights not found. Run setup first.")?;
        (lp, wp)
    };

    lc0_engine::run_lc0_policy_probe(
        positions,
        nodes,
        &lc0_path,
        &weights_path,
        app,
        top_n.unwrap_or(3),
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Load persisted API keys (fall back to defaults if the data
            // directory is somehow unavailable)
            let keys = get_keys_file_path(&handle)
                .map(|p| load_keys_from_disk(&p))
                .unwrap_or_default();

            // Load persisted app config
            let config = lc0_config::load_config(&handle);

            // Spawn persistent live Stockfish process
            let sf_path = engine::find_stockfish_path().unwrap_or_else(|_| "stockfish".to_string());
            let live_engine = live_engine::spawn_live_engine(handle, sf_path);

            app.manage(AppState {
                api_keys: Mutex::new(keys),
                live_engine,
                config: Mutex::new(config),
                analysis_cancel: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            explain_move,
            get_api_keys,
            save_api_key,
            remove_api_key,
            set_analysis_model,
            explain_critical_moment,
            generate_thematic_summary,
            save_report,
            list_reports,
            load_report,
            delete_report,
            rename_report,
            check_report_exists,
            run_engine_pass,
            cancel_analysis,
            live_engine_set_fen,
            live_engine_new_game,
            live_engine_stop,
            get_app_config,
            set_engine_mode,
            save_report_settings,
            setup_lc0,
            check_lc0_ready,
            run_lc0_pass,
            run_lc0_policy_probe,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Gracefully stop the persistent Stockfish process so it doesn't
            // outlive the app (the child also has kill_on_drop as a backstop).
            if let Some(state) = handle.try_state::<AppState>() {
                state.live_engine.shutdown();
            }
        }
    });
}

