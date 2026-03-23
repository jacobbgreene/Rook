use rig::providers::{openai, gemini};
use rig::providers::gemini::completion::gemini_api_types::{
    AdditionalParameters, GenerationConfig, ThinkingConfig, ThinkingLevel,
};
use rig::completion::Prompt;
use rig::client::CompletionClient;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const CHESS_COACH_PROMPT: &str = include_str!("prompts/chess-coach.md");

#[derive(Debug, Deserialize, Serialize)]
struct MoveAnnotation {
    #[serde(rename = "moveNumber")]
    move_number: u32,
    side: String,
    comment: String,
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
}

fn build_critical_moment_prompt(m: &CriticalMomentData, perspective: &str) -> String {
    let category_desc = match m.category.as_str() {
        "blunder" => "a serious blunder",
        "mistake" => "a significant mistake",
        "inaccuracy" => "an inaccuracy",
        "turning_point" => "a critical turning point",
        "great_move" => "a great move",
        _ => "a notable moment",
    };

    let is_player_move = m.side == perspective;
    let opponent = if perspective == "white" { "black" } else { "white" };

    let is_great_move = m.category == "great_move";

    if is_player_move && is_great_move {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            You (playing {perspective}) played: {san} (Move {num})\n\
            Evaluation before: {eb:+.2} pawns (from white's perspective)\n\
            Evaluation after: {ea:+.2} pawns\n\
            Evaluation gain: {gain:.1} pawns — classified as {cat}\n\
            Stockfish's top line: {line}\n\n\
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
            Stockfish's top line: {line}\n\n\
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
        )
    } else {
        format!(
            "You are a chess coach giving targeted feedback to the {perspective} player.\n\n\
            Position (FEN): {fen}\n\
            Your opponent ({opponent}) played: {san} (Move {num})\n\
            This was {cat} by your opponent — evaluation before: {eb:+.2}, after: {ea:+.2} (drop: {drop:.1} pawns)\n\
            Stockfish's preferred move for the opponent was: {best}\n\
            Stockfish's top line: {line}\n\n\
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
        )
    }
}

fn build_thematic_summary_prompt(moments: &[CriticalMomentData], perspective: &str, include_great_moves: bool, game_result: &str) -> String {
    let opponent = if perspective == "white" { "black" } else { "white" };

    let result_context = match game_result {
        "win" => format!("The {} player won this game.", perspective),
        "loss" => format!("The {} player lost this game.", perspective),
        "draw" => "The game ended in a draw.".to_string(),
        _ => "The game outcome is not determined (may have been resigned or abandoned).".to_string(),
    };

    let mut prompt = format!(
        "You are a chess coach providing a targeted post-game summary for the {perspective} player.\n\n\
        Game result: {result}\n\n\
        The following critical moments were identified:\n\n",
        perspective = perspective,
        result = result_context,
    );

    for m in moments {
        let whose = if m.side == perspective {
            "Your move".to_string()
        } else {
            format!("Opponent's ({}) move", opponent)
        };
        if m.category == "great_move" {
            prompt += &format!(
                "- Move {} ({}): Played {}. Category: great_move, eval gain: {:.1} pawns.\n",
                m.move_number, whose, m.move_san, -m.eval_drop,
            );
        } else {
            prompt += &format!(
                "- Move {} ({}): Played {}, best was {}. Category: {}, eval drop: {:.1} pawns.\n",
                m.move_number, whose, m.move_san, m.best_move_san, m.category, m.eval_drop,
            );
        }
    }

    if include_great_moves {
        prompt += &format!(
            "\nProvide a brief (3-4 sentences) personalized summary for the {} player:\n\
            - Open with a brief, factual acknowledgment of the game result (congratulations on a win, or a frank but not discouraging note on a loss)\n\
            - Note any strong moves or sound tactical/positional decisions the player made\n\
            - If there were mistakes, identify the key patterns to work on\n\
            - Suggest one concrete area for improvement\n\
            Keep the tone direct and factual — recognize good play without excessive praise.\n\
            Address the player directly as \"you\".",
            perspective
        );
    } else {
        prompt += &format!(
            "\nProvide a brief (3-4 sentences) personalized summary for the {} player:\n\
            - Open with a brief, factual acknowledgment of the game result (congratulations on a win, or a frank but not discouraging note on a loss)\n\
            - Identify your most common types of errors and recurring patterns\n\
            - Note if you missed opportunities to capitalize on your opponent's mistakes\n\
            - Suggest one specific, actionable area to focus on for improvement\n\
            Address the player directly as \"you\".",
            perspective
        );
    }

    prompt
}

// ── Key resolution helper ────────────────────────────────────

fn resolve_api_keys(state: &Mutex<ApiKeys>) -> Result<(String, String), String> {
    let keys = state.lock().map_err(|e| e.to_string())?;
    let gemini = keys.gemini_api_key.clone().unwrap_or_default();
    let openai = keys.openai_api_key.clone().unwrap_or_default();
    let gemini = if gemini.is_empty() { env::var("GEMINI_API_KEY").unwrap_or_default() } else { gemini };
    let openai = if openai.is_empty() { env::var("OPENAI_API_KEY").unwrap_or_default() } else { openai };
    Ok((gemini, openai))
}

// ── Persistence ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ApiKeys {
    gemini_api_key: Option<String>,
    openai_api_key: Option<String>,
    #[serde(default)]
    use_gemini_pro: bool,
}

struct AppState {
    api_keys: Mutex<ApiKeys>,
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
    report: GameAnalysisReportData,
    game_history: Vec<String>,
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
}

fn get_reports_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("reports")
}

fn ensure_reports_dir(app: &tauri::AppHandle) {
    let dir = get_reports_dir(app);
    let _ = fs::create_dir_all(&dir);
}

#[derive(Debug, Serialize)]
struct ApiKeyStatus {
    gemini_set: bool,
    gemini_hint: String,
    openai_set: bool,
    openai_hint: String,
    gemini_pro_enabled: bool,
}

fn get_keys_file_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("api_keys.json")
}

fn load_keys_from_disk(path: &PathBuf) -> ApiKeys {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_keys_to_disk(path: &PathBuf, keys: &ApiKeys) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, serde_json::to_string_pretty(keys).unwrap_or_default());
}

fn make_hint(key: &Option<String>) -> String {
    match key {
        Some(k) if k.len() >= 4 => format!("\u{2022}\u{2022}\u{2022}\u{2022}{}", &k[k.len()-4..]),
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
        gemini_pro_enabled: keys.use_gemini_pro,
    })
}

#[tauri::command]
fn save_api_key(provider: String, key: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    match provider.as_str() {
        "gemini" => keys.gemini_api_key = Some(key),
        "openai" => keys.openai_api_key = Some(key),
        _ => return Err(format!("Unknown provider: {}", provider)),
    }
    save_keys_to_disk(&get_keys_file_path(&app), &keys);
    Ok(())
}

#[tauri::command]
fn remove_api_key(provider: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    match provider.as_str() {
        "gemini" => keys.gemini_api_key = None,
        "openai" => keys.openai_api_key = None,
        _ => return Err(format!("Unknown provider: {}", provider)),
    }
    save_keys_to_disk(&get_keys_file_path(&app), &keys);
    Ok(())
}

#[tauri::command]
fn set_gemini_pro(enabled: bool, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let mut keys = state.api_keys.lock().map_err(|e| e.to_string())?;
    keys.use_gemini_pro = enabled;
    save_keys_to_disk(&get_keys_file_path(&app), &keys);
    Ok(())
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn explain_move(
    fen: String,
    evaluation: String,
    top_lines: String,
    perspective: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (gemini_key, openai_key) = {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        (
            keys.gemini_api_key.clone().unwrap_or_default(),
            keys.openai_api_key.clone().unwrap_or_default(),
        )
    };

    // User keys take priority, fall back to environment variables
    let gemini_key = if gemini_key.is_empty() { env::var("GEMINI_API_KEY").unwrap_or_default() } else { gemini_key };
    let openai_key = if openai_key.is_empty() { env::var("OPENAI_API_KEY").unwrap_or_default() } else { openai_key };

    if gemini_key.is_empty() && openai_key.is_empty() {
        return Ok("No API key found. Click the key icon above to add your API key, or set the GEMINI_API_KEY environment variable for a free AI coach.".to_string());
    }

    let preamble = format!("You are a grandmaster AI chess coach. The user is a beginner to intermediate player. They are currently playing from the perspective of {}. Using the provided current board state (FEN), Stockfish evaluation, and top projected lines, explain the position and tell the user *why* the top suggested move is a good idea. Keep it highly concise (2-3 sentences max), friendly, and instructional. Frame your advice specifically for the {} player.", perspective, perspective);
    let prompt_text = format!(
        "Here is the current board state FEN: {}\nStockfish Evaluation: {}\nTop Engine Lines:\n{}",
        fen, evaluation, top_lines
    );

    if !gemini_key.is_empty() {
        let client = gemini::Client::new(&gemini_key).unwrap();
        let agent = client.agent("gemini-3-flash-preview")
            .preamble(&preamble)
            .build();

        match agent.prompt(&prompt_text).await {
            Ok(response) => Ok(response),
            Err(e) => Err(format!("Gemini Coaching Error: {}", e))
        }
    } else {
        let client = openai::Client::new(&openai_key).unwrap();
        let agent = client.agent(openai::GPT_4O)
            .preamble(&preamble)
            .build();

        match agent.prompt(&prompt_text).await {
            Ok(response) => Ok(response),
            Err(e) => Err(format!("OpenAI Coaching Error: {}", e))
        }
    }
}

#[tauri::command]
async fn deep_analysis(
    pgn: String,
    current_fen: String,
    evaluation: String,
    top_lines: String,
    perspective: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Resolve keys: user key preferred, env var fallback
    // Track whether key is user-provided for model upgrade
    let (gemini_key, gemini_is_user, use_pro, openai_key, openai_is_user) = {
        let keys = state.api_keys.lock().map_err(|e| e.to_string())?;
        let gemini_user = keys.gemini_api_key.clone().unwrap_or_default();
        let openai_user = keys.openai_api_key.clone().unwrap_or_default();
        let g_is_user = !gemini_user.is_empty();
        let o_is_user = !openai_user.is_empty();
        let g_key = if g_is_user { gemini_user } else { env::var("GEMINI_API_KEY").unwrap_or_default() };
        let o_key = if o_is_user { openai_user } else { env::var("OPENAI_API_KEY").unwrap_or_default() };
        (g_key, g_is_user, keys.use_gemini_pro, o_key, o_is_user)
    };

    if gemini_key.is_empty() && openai_key.is_empty() {
        return Ok("No API key found. Click the key icon above to add your API key, or set the GEMINI_API_KEY environment variable for a free AI coach.".to_string());
    }

    let preamble = format!(
        "{}\n\nYou are providing a deep game analysis. The user is playing as {}. \
        Return ONLY a JSON array of annotation objects, with no other text. \
        Each object has: {{\"moveNumber\": <number>, \"side\": \"white\" or \"black\", \"comment\": \"<your insight>\"}}. \
        Annotate 4-8 strategically significant moves. Focus on turning points, mistakes, brilliant moves, \
        and key strategic decisions. Use standard algebraic notation when referencing moves.",
        CHESS_COACH_PROMPT, perspective
    );

    let prompt_text = format!(
        "Analyze this game and annotate the most important moves:\n\nPGN: {}\n\nCurrent FEN: {}\nStockfish Evaluation: {}\nTop Engine Lines:\n{}",
        pgn, current_fen, evaluation, top_lines
    );

    let raw_response = if !gemini_key.is_empty() {
        let client = gemini::Client::new(&gemini_key).unwrap();
        if gemini_is_user {
            // User key → thinking enabled; Pro model if toggled on
            let model = if use_pro { "gemini-3.1-pro-preview" } else { "gemini-3-flash-preview" };
            let thinking_cfg = GenerationConfig {
                thinking_config: Some(ThinkingConfig {
                    thinking_budget: None,
                    thinking_level: Some(ThinkingLevel::High),
                    include_thoughts: None,
                }),
                ..Default::default()
            };
            let params = AdditionalParameters::default().with_config(thinking_cfg);
            let agent = client.agent(model)
                .preamble(&preamble)
                .additional_params(serde_json::to_value(params).unwrap())
                .build();
            agent.prompt(&prompt_text).await.map_err(|e| format!("Gemini Error: {}", e))?
        } else {
            // Env var fallback → Gemini 3 Flash without thinking
            let agent = client.agent("gemini-3-flash-preview")
                .preamble(&preamble)
                .build();
            agent.prompt(&prompt_text).await.map_err(|e| format!("Gemini Error: {}", e))?
        }
    } else {
        // User key → premium reasoning model; env var → standard model
        let model = if openai_is_user { "o4-mini" } else { openai::GPT_4O };
        let client = openai::Client::new(&openai_key).unwrap();
        let agent = client.agent(model)
            .preamble(&preamble)
            .build();
        agent.prompt(&prompt_text).await.map_err(|e| format!("OpenAI Error: {}", e))?
    };

    // Strip markdown code fences if present
    let cleaned = raw_response.trim();
    let cleaned = if cleaned.starts_with("```json") {
        cleaned.trim_start_matches("```json").trim_end_matches("```").trim()
    } else if cleaned.starts_with("```") {
        cleaned.trim_start_matches("```").trim_end_matches("```").trim()
    } else {
        cleaned
    };

    // Validate and re-serialize clean JSON
    let annotations: Vec<MoveAnnotation> = serde_json::from_str(cleaned)
        .map_err(|e| format!("Failed to parse AI response as JSON: {}. Raw response: {}", e, &raw_response[..raw_response.len().min(500)]))?;

    serde_json::to_string(&annotations)
        .map_err(|e| format!("Failed to serialize annotations: {}", e))
}

// ── Context-Injection Pipeline commands ───────────────────────

#[tauri::command]
async fn explain_critical_moment(
    moment: CriticalMomentData,
    perspective: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (gemini_key, openai_key) = resolve_api_keys(&state.api_keys)?;

    if gemini_key.is_empty() && openai_key.is_empty() {
        return Err("No API key configured.".to_string());
    }

    let prompt = build_critical_moment_prompt(&moment, &perspective);
    let preamble = "You are a grandmaster-level chess coach. Explain critical moments concisely, focusing on the tactical and strategic reasons behind evaluation swings.";

    if !gemini_key.is_empty() {
        let client = gemini::Client::new(&gemini_key).unwrap();
        let agent = client.agent("gemini-3-flash-preview")
            .preamble(preamble)
            .build();
        agent.prompt(&prompt).await.map_err(|e| format!("Gemini Error: {}", e))
    } else {
        let client = openai::Client::new(&openai_key).unwrap();
        let agent = client.agent(openai::GPT_4O)
            .preamble(preamble)
            .build();
        agent.prompt(&prompt).await.map_err(|e| format!("OpenAI Error: {}", e))
    }
}

#[tauri::command]
async fn generate_thematic_summary(
    moments: Vec<CriticalMomentData>,
    perspective: String,
    include_great_moves: Option<bool>,
    game_result: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let (gemini_key, openai_key) = resolve_api_keys(&state.api_keys)?;

    if gemini_key.is_empty() && openai_key.is_empty() {
        return Err("No API key configured.".to_string());
    }

    let result_str = game_result.as_deref().unwrap_or("unknown");
    let prompt = build_thematic_summary_prompt(&moments, &perspective, include_great_moves.unwrap_or(false), result_str);
    let preamble = "You are a chess coach writing a concise post-game summary. Focus on actionable patterns the player can improve.";

    if !gemini_key.is_empty() {
        let client = gemini::Client::new(&gemini_key).unwrap();
        let agent = client.agent("gemini-3-flash-preview")
            .preamble(preamble)
            .build();
        agent.prompt(&prompt).await.map_err(|e| format!("Gemini Error: {}", e))
    } else {
        let client = openai::Client::new(&openai_key).unwrap();
        let agent = client.agent(openai::GPT_4O)
            .preamble(preamble)
            .build();
        agent.prompt(&prompt).await.map_err(|e| format!("OpenAI Error: {}", e))
    }
}

// ── Report Persistence Commands ───────────────────────────────

#[tauri::command]
fn save_report(report: SavedReport, app: tauri::AppHandle) -> Result<(), String> {
    ensure_reports_dir(&app);
    let path = get_reports_dir(&app).join(format!("{}.json", report.id));
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_reports(app: tauri::AppHandle) -> Result<Vec<SavedReportMeta>, String> {
    ensure_reports_dir(&app);
    let dir = get_reports_dir(&app);
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
        });
    }

    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(reports)
}

#[tauri::command]
fn load_report(id: String, app: tauri::AppHandle) -> Result<SavedReport, String> {
    let path = get_reports_dir(&app).join(format!("{}.json", id));
    let contents = fs::read_to_string(&path).map_err(|e| format!("Report not found: {}", e))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse report: {}", e))
}

#[tauri::command]
fn delete_report(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = get_reports_dir(&app).join(format!("{}.json", id));
    fs::remove_file(&path).map_err(|e| format!("Failed to delete report: {}", e))
}

#[tauri::command]
fn check_report_exists(game_hash: String, app: tauri::AppHandle) -> Result<Option<SavedReportMeta>, String> {
    ensure_reports_dir(&app);
    let dir = get_reports_dir(&app);
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
            }));
        }
    }

    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { api_keys: Mutex::new(ApiKeys::default()) })
        .setup(|app| {
            let path = get_keys_file_path(app.handle());
            let keys = load_keys_from_disk(&path);
            *app.state::<AppState>().api_keys.lock().unwrap() = keys;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            explain_move,
            deep_analysis,
            get_api_keys,
            save_api_key,
            remove_api_key,
            set_gemini_pro,
            explain_critical_moment,
            generate_thematic_summary,
            save_report,
            list_reports,
            load_report,
            delete_report,
            check_report_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
