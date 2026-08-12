// Unified settings: API keys, engine mode, and report defaults.
import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "../icons";
import { PopIn } from "../animate";

export interface ApiKeyStatus {
  gemini_set: boolean;
  gemini_hint: string;
  openai_set: boolean;
  openai_hint: string;
  gemini_pro_enabled: boolean;
}

export interface AppConfig {
  engineMode: "stockfish_only" | "hybrid";
  lc0Path: string | null;
  weightsPath: string | null;
  setupComplete: boolean;
  analysisDepth: number;
  includeGreatMoves: boolean;
  detailedReport: boolean;
  useLc0: boolean;
  includeOpportunities: boolean;
}

export interface ReportSettings {
  analysisDepth: number;
  includeGreatMoves: boolean;
  detailedReport: boolean;
  useLc0: boolean;
  includeOpportunities: boolean;
}

/** Label + toggle-switch row, shared by settings and report setup. */
export function ToggleRow({
  title,
  desc,
  checked,
  onToggle,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="model-toggle-row" style={{ marginTop: "16px", marginBottom: "0" }}>
      <div className="model-toggle-label">
        <span className="model-toggle-title">{title}</span>
        <span className="model-toggle-desc">{desc}</span>
      </div>
      <button
        className={`toggle-switch ${checked ? "toggle-on" : ""}`}
        onClick={onToggle}
        role="switch"
        aria-checked={checked}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

function KeySection({
  title,
  provider,
  saved,
  hint,
  onSave,
  onRemove,
}: {
  title: string;
  provider: string;
  saved: boolean;
  hint: string;
  onSave: (provider: string, key: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [show, setShow] = useState(false);

  return (
    <div className="api-key-section">
      <h4>{title}</h4>
      {saved ? (
        <div className="api-key-saved">
          <span className="key-hint">{hint}</span>
          <button onClick={() => onRemove(provider)}>Remove</button>
        </div>
      ) : (
        <div className="api-key-input-group">
          <input
            type={show ? "text" : "password"}
            placeholder={`Enter ${title}...`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && input.trim()) {
                await onSave(provider, input.trim());
                setInput("");
              }
            }}
          />
          <button className="eye-toggle" onClick={() => setShow(!show)}>
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button
            onClick={async () => {
              if (!input.trim()) return;
              await onSave(provider, input.trim());
              setInput("");
            }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

interface SettingsModalProps {
  apiKeyStatus: ApiKeyStatus | null;
  onSaveKey: (provider: string, key: string) => Promise<void>;
  onRemoveKey: (provider: string) => Promise<void>;
  onToggleGeminiPro: () => Promise<void>;
  appConfig: AppConfig | null;
  onToggleEngineMode: () => Promise<void>;
  reportSettings: ReportSettings;
  onUpdateReportSettings: (s: ReportSettings) => void;
  onClose: () => void;
}

export function SettingsModal({
  apiKeyStatus,
  onSaveKey,
  onRemoveKey,
  onToggleGeminiPro,
  appConfig,
  onToggleEngineMode,
  reportSettings,
  onUpdateReportSettings,
  onClose,
}: SettingsModalProps) {
  return (
    <div className="api-key-modal-overlay" onClick={onClose}>
      <PopIn className="api-key-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          <span>Settings</span>
          <button className="api-key-modal-close" onClick={onClose}>
            ✕
          </button>
        </h2>

        <KeySection
          title="Gemini API Key"
          provider="gemini"
          saved={apiKeyStatus?.gemini_set ?? false}
          hint={apiKeyStatus?.gemini_hint ?? ""}
          onSave={onSaveKey}
          onRemove={onRemoveKey}
        />

        {apiKeyStatus?.gemini_set && (
          <ToggleRow
            title="Gemini 3.1 Pro Preview"
            desc="Use Pro instead of Flash for report analysis. Slower but higher quality."
            checked={apiKeyStatus.gemini_pro_enabled}
            onToggle={onToggleGeminiPro}
          />
        )}

        <KeySection
          title="OpenAI API Key"
          provider="openai"
          saved={apiKeyStatus?.openai_set ?? false}
          hint={apiKeyStatus?.openai_hint ?? ""}
          onSave={onSaveKey}
          onRemove={onRemoveKey}
        />

        <div className="api-key-section">
          <h4>Engine Mode</h4>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <span style={{ fontSize: "0.85rem", color: "#ccc" }}>
              {appConfig?.engineMode === "hybrid"
                ? "Stockfish + Lc0 (Advanced)"
                : "Stockfish Only (Standard)"}
            </span>
            <button
              className="action-button"
              onClick={onToggleEngineMode}
              style={{ flex: "none", padding: "6px 12px", fontSize: "0.78rem" }}
            >
              {appConfig?.engineMode === "hybrid"
                ? "Switch to Standard"
                : "Switch to Advanced"}
            </button>
          </div>
        </div>

        <div className="api-key-section">
          <h4>Report Defaults</h4>
          <div className="perspective-selector" style={{ marginTop: "4px" }}>
            {([8, 12, 18] as const).map((d) => (
              <button
                key={d}
                className={`perspective-option ${reportSettings.analysisDepth === d ? "selected" : ""}`}
                onClick={() =>
                  onUpdateReportSettings({ ...reportSettings, analysisDepth: d })
                }
              >
                {d === 8 ? "Quick" : d === 12 ? "Standard" : "Deep"}
              </button>
            ))}
          </div>
          <ToggleRow
            title="Show what I did well"
            desc="Highlight brilliant moves, traps you set, and critical finds"
            checked={reportSettings.includeGreatMoves}
            onToggle={() =>
              onUpdateReportSettings({
                ...reportSettings,
                includeGreatMoves: !reportSettings.includeGreatMoves,
              })
            }
          />
          <ToggleRow
            title="Show opportunities"
            desc="Highlight moments where your opponent gave you a chance — and when you seized it"
            checked={reportSettings.includeOpportunities}
            onToggle={() =>
              onUpdateReportSettings({
                ...reportSettings,
                includeOpportunities: !reportSettings.includeOpportunities,
              })
            }
          />
          {appConfig?.engineMode === "hybrid" && (
            <ToggleRow
              title="Use Lc0 analysis"
              desc="Add Leela Chess Zero strategic insight and WDL probabilities"
              checked={reportSettings.useLc0}
              onToggle={() =>
                onUpdateReportSettings({
                  ...reportSettings,
                  useLc0: !reportSettings.useLc0,
                })
              }
            />
          )}
          <ToggleRow
            title="Detailed report"
            desc="Lower thresholds to flag more moments for broader game coverage"
            checked={reportSettings.detailedReport}
            onToggle={() =>
              onUpdateReportSettings({
                ...reportSettings,
                detailedReport: !reportSettings.detailedReport,
              })
            }
          />
        </div>

        <div className="api-key-info">
          An API key unlocks the AI coach and report explanations: Gemini 3
          Flash by default (or Gemini 3.1 Pro with the toggle above), or OpenAI
          GPT-4o. Without a key, engine analysis still works fully. Get a free
          Gemini key from{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#7ab3ff" }}
          >
            Google AI Studio
          </a>
          .
        </div>
      </PopIn>
    </div>
  );
}
