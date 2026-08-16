// Unified settings: API keys, engine mode, and report defaults.
import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "../icons";
import { PopIn } from "../animate";
import { Dropdown } from "./Dropdown";

export interface ApiKeyStatus {
  gemini_set: boolean;
  gemini_hint: string;
  openai_set: boolean;
  openai_hint: string;
  anthropic_set: boolean;
  anthropic_hint: string;
  analysis_model: string;
}

/** Mirror of the model catalog in src-tauri/src/lib.rs (provider_for_model).
    Keep the two in sync. */
export const ANALYSIS_MODELS: {
  id: string;
  label: string;
  provider: "anthropic" | "gemini" | "openai";
}[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fast & affordable", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash — free tier", provider: "gemini" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite — budget", provider: "gemini" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "gemini" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna — budget", provider: "openai" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai" },
];

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  gemini: "Google (Gemini)",
  openai: "OpenAI",
};

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

function ApiKeySection({
  apiKeyStatus,
  onSave,
  onRemove,
}: {
  apiKeyStatus: ApiKeyStatus | null;
  onSave: (provider: string, key: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}) {
  const PROVIDERS = ["anthropic", "gemini", "openai"] as const;
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>(
    // Default the tab to the provider of the currently selected model.
    () =>
      PROVIDERS.find(
        (p) =>
          p ===
          ANALYSIS_MODELS.find((m) => m.id === apiKeyStatus?.analysis_model)
            ?.provider,
      ) ?? "gemini",
  );
  const [input, setInput] = useState("");
  const [show, setShow] = useState(false);

  const saved =
    provider === "anthropic"
      ? (apiKeyStatus?.anthropic_set ?? false)
      : provider === "gemini"
        ? (apiKeyStatus?.gemini_set ?? false)
        : (apiKeyStatus?.openai_set ?? false);
  const hint =
    provider === "anthropic"
      ? (apiKeyStatus?.anthropic_hint ?? "")
      : provider === "gemini"
        ? (apiKeyStatus?.gemini_hint ?? "")
        : (apiKeyStatus?.openai_hint ?? "");

  return (
    <div className="api-key-section">
      <h4>API Key</h4>
      <div className="provider-tabs">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            className={`provider-tab ${provider === p ? "provider-tab-active" : ""}`}
            onClick={() => {
              setProvider(p);
              setInput("");
              setShow(false);
            }}
          >
            {PROVIDER_LABELS[p]}
            {keySet(apiKeyStatus, p) && <span className="provider-tab-dot" />}
          </button>
        ))}
      </div>
      {saved ? (
        <div className="api-key-saved">
          <span className="key-hint">{hint}</span>
          <button onClick={() => onRemove(provider)}>Remove</button>
        </div>
      ) : (
        <div className="api-key-input-group">
          <input
            type={show ? "text" : "password"}
            placeholder={`Enter ${PROVIDER_LABELS[provider]} key...`}
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

function keySet(status: ApiKeyStatus | null, provider: string): boolean {
  if (!status) return false;
  return provider === "anthropic"
    ? status.anthropic_set
    : provider === "gemini"
      ? status.gemini_set
      : status.openai_set;
}

interface SettingsModalProps {
  apiKeyStatus: ApiKeyStatus | null;
  onSaveKey: (provider: string, key: string) => Promise<void>;
  onRemoveKey: (provider: string) => Promise<void>;
  onSelectModel: (model: string) => Promise<void>;
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
  onSelectModel,
  appConfig,
  onToggleEngineMode,
  reportSettings,
  onUpdateReportSettings,
  onClose,
}: SettingsModalProps) {
  const selectedModel = ANALYSIS_MODELS.find(
    (m) => m.id === apiKeyStatus?.analysis_model,
  );
  const selectedProviderHasKey = selectedModel
    ? keySet(apiKeyStatus, selectedModel.provider)
    : false;

  return (
    <div className="api-key-modal-overlay" onClick={onClose}>
      <PopIn className="api-key-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          <span>Settings</span>
          <button className="api-key-modal-close" onClick={onClose}>
            ✕
          </button>
        </h2>

        <div className="api-key-section">
          <h4>Analysis Model</h4>
          <Dropdown
            value={apiKeyStatus?.analysis_model ?? ""}
            onChange={(model) => onSelectModel(model)}
            options={(["anthropic", "gemini", "openai"] as const).map(
              (provider) => ({
                group: PROVIDER_LABELS[provider],
                options: ANALYSIS_MODELS.filter(
                  (m) => m.provider === provider,
                ).map((m) => ({
                  value: m.id,
                  label: m.label,
                  hint: keySet(apiKeyStatus, provider) ? undefined : "(no key)",
                })),
              }),
            )}
          />
          {selectedModel && !selectedProviderHasKey && (
            <div className="model-select-warning">
              No {PROVIDER_LABELS[selectedModel.provider]} key saved — add one
              below or pick a different model.
            </div>
          )}
        </div>

        <ApiKeySection
          apiKeyStatus={apiKeyStatus}
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
          The AI coach and report explanations use the analysis model selected
          above — Gemini 3.7 Flash by default (free via Google AI Studio). Add
          the API key for the provider whose model you want to use; without a
          key, engine analysis still works fully. Keys:{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: "#7ab3ff" }}>Anthropic</a>
          {", "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "#7ab3ff" }}>Google AI Studio</a>
          {" (free tier), "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: "#7ab3ff" }}>OpenAI</a>
          .
        </div>
      </PopIn>
    </div>
  );
}
