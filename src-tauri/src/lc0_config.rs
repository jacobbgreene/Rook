// ═══════════════════════════════════════════════════════════════
// Lc0 Configuration, Discovery & Auto-Download
// ═══════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

// ═══════════════════════════════════════════════════════════════
// Config Types
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EngineMode {
    StockfishOnly,
    Hybrid,
}

impl Default for EngineMode {
    fn default() -> Self {
        Self::StockfishOnly
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub engine_mode: EngineMode,
    pub lc0_path: Option<String>,
    pub weights_path: Option<String>,
    pub setup_complete: bool,
    // Persistent report settings
    #[serde(default = "default_depth")]
    pub analysis_depth: u32,
    #[serde(default)]
    pub include_great_moves: bool,
    #[serde(default = "default_true")]
    pub detailed_report: bool,
    #[serde(default)]
    pub use_lc0: bool,
    #[serde(default)]
    pub include_opportunities: bool,
}

fn default_depth() -> u32 { 12 }
fn default_true() -> bool { true }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            engine_mode: EngineMode::StockfishOnly,
            lc0_path: None,
            weights_path: None,
            setup_complete: false,
            analysis_depth: 12,
            include_great_moves: false,
            detailed_report: true,
            use_lc0: false,
            include_opportunities: false,
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════

fn get_config_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("config.json")
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    let path = get_config_path(app);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &AppConfig) {
    let path = get_config_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, serde_json::to_string_pretty(config).unwrap_or_default());
}

// ═══════════════════════════════════════════════════════════════
// Lc0 Binary Discovery
// ═══════════════════════════════════════════════════════════════

pub fn find_lc0_path(config: &AppConfig, app: &AppHandle) -> Option<String> {
    // 1. Environment variable (highest priority — explicit user override)
    if let Ok(p) = std::env::var("LC0_PATH") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }

    // 2. PATH lookup via `which` — reflects the user's current environment
    //    and picks up nix-profile / package manager updates automatically.
    let check = if cfg!(windows) {
        std::process::Command::new("where").arg("lc0").output()
    } else {
        std::process::Command::new("which").arg("lc0").output()
    };
    if let Ok(output) = check {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() && std::path::Path::new(&path_str).exists() {
                return Some(path_str);
            }
        }
    }

    // 3. Explicit config path (may be stale after package updates)
    if let Some(ref p) = config.lc0_path {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }

    // 4. Common OS paths
    let candidates: &[&str] = if cfg!(windows) {
        &["lc0.exe"]
    } else {
        &[
            "/usr/local/bin/lc0",
            "/usr/bin/lc0",
            "/opt/homebrew/bin/lc0",
        ]
    };

    for &path in candidates {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    // 5. App data dir
    let app_lc0 = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("lc0")
        .join(if cfg!(windows) { "lc0.exe" } else { "lc0" });
    if app_lc0.exists() {
        return app_lc0.to_str().map(String::from);
    }

    None
}

pub fn find_weights_path(config: &AppConfig, app: &AppHandle) -> Option<String> {
    // 1. Explicit config path
    if let Some(ref p) = config.weights_path {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }

    // 2. App data dir
    let app_weights = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("lc0")
        .join("weights.pb.gz");
    if app_weights.exists() {
        return app_weights.to_str().map(String::from);
    }

    None
}

// ═══════════════════════════════════════════════════════════════
// Download Progress Event
// ═══════════════════════════════════════════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub stage: String,
    pub downloaded: u64,
    pub total: u64,
}

// ═══════════════════════════════════════════════════════════════
// Download Helpers
// ═══════════════════════════════════════════════════════════════

async fn download_file(
    url: &str,
    dest: &std::path::Path,
    app: &AppHandle,
    stage_name: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("File write error: {}", e))?;

        downloaded += chunk.len() as u64;

        // Throttle progress events to ~10/sec
        if last_emit.elapsed().as_millis() > 100 {
            let _ = app.emit(
                "lc0-download-progress",
                DownloadProgress {
                    stage: stage_name.to_string(),
                    downloaded,
                    total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }

    // Final progress event
    let _ = app.emit(
        "lc0-download-progress",
        DownloadProgress {
            stage: stage_name.to_string(),
            downloaded,
            total,
        },
    );

    Ok(())
}

/// Resolve the Lc0 binary, either by finding it on the system or
/// downloading it (Windows only — Linux/macOS must install via package manager).
///
/// Returns the path to the binary, or an error with install instructions.
fn resolve_lc0_binary(lc0_dir: &std::path::Path) -> Result<Option<PathBuf>, String> {
    // Already downloaded into our app dir?
    let binary_name = if cfg!(windows) { "lc0.exe" } else { "lc0" };
    let local = lc0_dir.join(binary_name);
    if local.exists() {
        return Ok(Some(local));
    }

    // Check common system paths
    if let Ok(p) = std::env::var("LC0_PATH") {
        if std::path::Path::new(&p).exists() {
            return Ok(Some(PathBuf::from(p)));
        }
    }

    let candidates: &[&str] = if cfg!(windows) {
        &[]
    } else {
        &[
            "/usr/local/bin/lc0",
            "/usr/bin/lc0",
            "/opt/homebrew/bin/lc0",
        ]
    };

    for &path in candidates {
        if std::path::Path::new(path).exists() {
            return Ok(Some(PathBuf::from(path)));
        }
    }

    // Check if it's on PATH by trying `which`/`where`
    let check = if cfg!(windows) {
        std::process::Command::new("where").arg("lc0").output()
    } else {
        std::process::Command::new("which").arg("lc0").output()
    };
    if let Ok(output) = check {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() && std::path::Path::new(&path_str).exists() {
                return Ok(Some(PathBuf::from(path_str)));
            }
        }
    }

    Ok(None)
}

/// Download and configure Lc0 binary + neural network weights.
pub async fn setup_lc0(app: AppHandle) -> Result<(), String> {
    let lc0_dir = app.path().app_data_dir().unwrap().join("lc0");
    let _ = fs::create_dir_all(&lc0_dir);

    // ── Resolve Lc0 binary ──────────────────────────────────────
    let _ = app.emit(
        "lc0-download-progress",
        DownloadProgress {
            stage: "binary".to_string(),
            downloaded: 0,
            total: 0,
        },
    );

    let binary_dest = match resolve_lc0_binary(&lc0_dir)? {
        Some(path) => path,
        None => {
            if cfg!(windows) {
                // Auto-download on Windows (official binaries available)
                let binary_url = "https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-cpu-dnnl.zip";
                let binary_name = "lc0.exe";
                let archive_path = lc0_dir.join("lc0_download.zip");
                download_file(binary_url, &archive_path, &app, "binary").await?;

                let dest = lc0_dir.join(binary_name);
                extract_binary(&archive_path, &dest, binary_name, "zip")?;
                let _ = fs::remove_file(&archive_path);
                dest
            } else {
                // Linux/macOS: no official pre-built binaries
                let install_hint = if cfg!(target_os = "macos") {
                    "Install Lc0 with: brew install lc0"
                } else {
                    "Install Lc0 from your package manager (e.g. 'sudo apt install lc0', \
                     'nix profile install nixpkgs#lc0', or build from source: \
                     https://github.com/LeelaChessZero/lc0)"
                };
                return Err(format!(
                    "Lc0 not found on your system. {}. \
                     Then retry setup, or set the LC0_PATH environment variable.",
                    install_hint
                ));
            }
        }
    };

    // ── Download neural network weights ─────────────────────────
    let weights_path = lc0_dir.join("weights.pb.gz");
    if !weights_path.exists() {
        let _ = app.emit(
            "lc0-download-progress",
            DownloadProgress {
                stage: "weights".to_string(),
                downloaded: 0,
                total: 0,
            },
        );

        // Network 42850 (T40): 256x20 SE architecture, ~55MB.
        // SE (Squeeze-and-Excitation) format is required for OpenCL
        // compatibility — the newer attention/transformer networks
        // (T1, T60+, BT3, BT4) are NOT supported by OpenCL.
        let weights_url = "https://storage.lczero.org/files/networks/00af53b081e80147172e6f281c01daf5ca19ada173321438914c730370aa4267";
        download_file(weights_url, &weights_path, &app, "weights").await?;
    }

    // ── Verify ──────────────────────────────────────────────────
    let _ = app.emit(
        "lc0-download-progress",
        DownloadProgress {
            stage: "verifying".to_string(),
            downloaded: 0,
            total: 0,
        },
    );

    let verify = tokio::process::Command::new(&binary_dest)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;

    match verify {
        Ok(status) if status.success() || status.code().unwrap_or(1) <= 1 => {}
        Ok(status) => {
            return Err(format!(
                "Lc0 verification failed with exit code: {:?}",
                status.code()
            ))
        }
        Err(e) => return Err(format!("Failed to run Lc0: {}", e)),
    }

    // ── Update config ───────────────────────────────────────────
    let mut config = load_config(&app);
    config.lc0_path = binary_dest.to_str().map(String::from);
    config.weights_path = weights_path.to_str().map(String::from);
    config.engine_mode = EngineMode::Hybrid;
    config.setup_complete = true;
    save_config(&app, &config);

    Ok(())
}

/// Extract the lc0 binary from a downloaded archive.
fn extract_binary(
    archive_path: &std::path::Path,
    dest: &std::path::Path,
    binary_name: &str,
    archive_ext: &str,
) -> Result<(), String> {
    let parent = dest.parent().ok_or("No parent directory")?;

    if archive_ext == "tar.gz" {
        let file =
            fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut tar = tar::Archive::new(gz);

        for entry in tar
            .entries()
            .map_err(|e| format!("Failed to read tar: {}", e))?
        {
            let mut entry = entry.map_err(|e| format!("Tar entry error: {}", e))?;
            let path = entry
                .path()
                .map_err(|e| format!("Tar path error: {}", e))?;
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| n == binary_name)
            {
                entry
                    .unpack(dest)
                    .map_err(|e| format!("Failed to extract binary: {}", e))?;
                return Ok(());
            }
        }
        Err(format!("Binary '{}' not found in tar archive", binary_name))
    } else {
        // zip
        let file =
            fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| format!("Zip entry error: {}", e))?;
            let name = entry.name().to_string();
            if name.ends_with(binary_name)
                || std::path::Path::new(&name)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map_or(false, |n| n == binary_name)
            {
                let mut out = fs::File::create(dest)
                    .map_err(|e| format!("Failed to create binary file: {}", e))?;
                std::io::copy(&mut entry, &mut out)
                    .map_err(|e| format!("Failed to write binary: {}", e))?;
                return Ok(());
            }
        }

        // If not found by name, try extracting all and look for it
        zip.extract(parent)
            .map_err(|e| format!("Failed to extract zip: {}", e))?;

        // Search extracted files
        if dest.exists() {
            return Ok(());
        }

        // Look in subdirectories
        for entry in fs::read_dir(parent).map_err(|e| format!("Read dir error: {}", e))? {
            if let Ok(entry) = entry {
                let p = entry.path();
                if p.is_dir() {
                    let candidate = p.join(binary_name);
                    if candidate.exists() {
                        fs::rename(&candidate, dest)
                            .map_err(|e| format!("Failed to move binary: {}", e))?;
                        return Ok(());
                    }
                }
            }
        }

        Err(format!(
            "Binary '{}' not found in zip archive",
            binary_name
        ))
    }
}

/// Check whether both Lc0 binary and weights are present and accessible.
pub fn check_lc0_ready(config: &AppConfig, app: &AppHandle) -> bool {
    find_lc0_path(config, app).is_some() && find_weights_path(config, app).is_some()
}
