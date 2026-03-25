import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface SetupWizardProps {
  onComplete: () => void;
}

interface DownloadProgress {
  stage: string;
  downloaded: number;
  total: number;
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const [selectedMode, setSelectedMode] = useState<"stockfish" | "hybrid">("stockfish");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress>({ stage: "", downloaded: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen<DownloadProgress>("lc0-download-progress", (event) => {
      if (!cancelled) {
        setProgress(event.payload);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleContinue = async () => {
    if (selectedMode === "stockfish") {
      try {
        await invoke("set_engine_mode", { mode: "stockfish_only" });
        onComplete();
      } catch (e) {
        setError(`Failed to save config: ${e}`);
      }
      return;
    }

    // Hybrid mode: download Lc0
    setDownloading(true);
    setError(null);

    try {
      await invoke("setup_lc0");
      onComplete();
    } catch (e) {
      setError(`${e}`);
    } finally {
      setDownloading(false);
    }
  };

  const handleFallbackToStandard = async () => {
    try {
      await invoke("set_engine_mode", { mode: "stockfish_only" });
      onComplete();
    } catch {
      onComplete();
    }
  };

  const stageLabel = (stage: string): string => {
    switch (stage) {
      case "binary": return "Downloading Lc0 engine...";
      case "weights": return "Downloading neural network...";
      case "verifying": return "Verifying installation...";
      default: return "Preparing...";
    }
  };

  const progressPercent = progress.total > 0
    ? Math.round((progress.downloaded / progress.total) * 100)
    : 0;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  if (downloading) {
    return (
      <div className="setup-wizard-overlay">
        <div className="setup-wizard">
          <h2 className="setup-wizard-title">Setting up Lc0...</h2>

          <div className="download-stage-label">{stageLabel(progress.stage)}</div>

          {progress.total > 0 && (
            <>
              <div className="download-progress-bar">
                <div
                  className="download-progress-fill"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <div className="download-progress-text">
                {progressPercent}% ({formatBytes(progress.downloaded)} / {formatBytes(progress.total)})
              </div>
            </>
          )}

          {progress.stage === "verifying" && (
            <div className="download-progress-text">Almost done...</div>
          )}

          {error && (
            <div className="setup-error">
              <p>{error}</p>
              <button className="action-button" onClick={handleContinue} style={{ marginTop: "8px" }}>
                Retry
              </button>
            </div>
          )}

          <button
            className="setup-fallback-btn"
            onClick={handleFallbackToStandard}
          >
            Cancel — use Standard mode instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="setup-wizard-overlay">
      <div className="setup-wizard">
        <h2 className="setup-wizard-title">Welcome to Rook</h2>
        <p className="setup-wizard-subtitle">Choose your analysis experience:</p>

        <div className="engine-choice-cards">
          <button
            className={`engine-choice-card${selectedMode === "stockfish" ? " selected" : ""}`}
            onClick={() => setSelectedMode("stockfish")}
          >
            <div className="engine-choice-icon">&#9823;</div>
            <div className="engine-choice-name">Standard</div>
            <div className="engine-choice-desc">
              Stockfish tactical analysis
            </div>
            <div className="engine-choice-note">No download needed</div>
          </button>

          <button
            className={`engine-choice-card${selectedMode === "hybrid" ? " selected" : ""}`}
            onClick={() => setSelectedMode("hybrid")}
          >
            <div className="engine-choice-icon">&#9823;&#9823;</div>
            <div className="engine-choice-name">Advanced</div>
            <div className="engine-choice-desc">
              Stockfish + Leela (Lc0) human-like strategic insight
            </div>
            <div className="engine-choice-note">~100MB download</div>
          </button>
        </div>

        {error && (
          <div className="setup-error">
            <p>{error}</p>
          </div>
        )}

        <button
          className="action-button"
          onClick={handleContinue}
          style={{ width: "100%", marginTop: "20px", padding: "12px", justifyContent: "center" }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
