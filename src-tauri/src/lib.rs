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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
