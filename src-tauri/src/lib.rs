use rig::providers::{openai, gemini};
use rig::completion::Prompt;
use rig::client::CompletionClient;
use std::env;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn explain_move(fen: String, evaluation: String, top_lines: String, perspective: String) -> Result<String, String> {
    let gemini_key = env::var("GEMINI_API_KEY").unwrap_or_default();
    let openai_key = env::var("OPENAI_API_KEY").unwrap_or_default();

    if gemini_key.is_empty() && openai_key.is_empty() {
        return Ok("No API Key found! For a free AI coach, get a key from Google AI Studio and set the GEMINI_API_KEY environment variable. Alternatively, set OPENAI_API_KEY to use GPT-4o.".to_string());
    }

    let preamble = format!("You are a grandmaster AI chess coach. The user is a beginner to intermediate player. They are currently playing from the perspective of {}. Using the provided current board state (FEN), Stockfish evaluation, and top projected lines, explain the position and tell the user *why* the top suggested move is a good idea. Keep it highly concise (2-3 sentences max), friendly, and instructional. Frame your advice specifically for the {} player.", perspective, perspective);
    let prompt_text = format!(
        "Here is the current board state FEN: {}\nStockfish Evaluation: {}\nTop Engine Lines:\n{}",
        fen, evaluation, top_lines
    );

    if !gemini_key.is_empty() {
        // Use Gemini 1.5 Flash (Free Tier)
        let client = gemini::Client::new(&gemini_key).unwrap();
        let agent = client.agent("gemini-1.5-flash")
            .preamble(&preamble)
            .build();
            
        match agent.prompt(&prompt_text).await {
            Ok(response) => Ok(response),
            Err(e) => Err(format!("Gemini Coaching Error: {}", e))
        }
    } else {
        // Fallback to OpenAI GPT-4o
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, explain_move])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
