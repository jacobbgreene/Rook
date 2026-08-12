// Per-run report options: perspective, depth, and content toggles.
import { ReportIcon } from "../icons";
import { PopIn } from "../animate";
import { ToggleRow, type AppConfig, type ReportSettings } from "./SettingsModal";

interface ReportSetupModalProps {
  appConfig: AppConfig | null;
  reportPerspective: "white" | "black";
  onPerspectiveChange: (p: "white" | "black") => void;
  settings: ReportSettings;
  onUpdateSettings: (s: ReportSettings) => void;
  onAnalyze: () => void;
  onClose: () => void;
}

export function ReportSetupModal({
  appConfig,
  reportPerspective,
  onPerspectiveChange,
  settings,
  onUpdateSettings,
  onAnalyze,
  onClose,
}: ReportSetupModalProps) {
  return (
    <div className="report-setup-overlay" onClick={onClose}>
      <PopIn className="report-setup-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Full Game Report</h3>
        <p className="modal-subtitle">Who is this report for?</p>
        <div className="perspective-selector">
          <button
            className={`perspective-option ${reportPerspective === "white" ? "selected" : ""}`}
            onClick={() => onPerspectiveChange("white")}
          >
            <span style={{ fontSize: "1.2rem" }}>&#9812;</span> White
          </button>
          <button
            className={`perspective-option ${reportPerspective === "black" ? "selected" : ""}`}
            onClick={() => onPerspectiveChange("black")}
          >
            <span style={{ fontSize: "1.2rem" }}>&#9818;</span> Black
          </button>
        </div>

        <ToggleRow
          title="Show what I did well"
          desc="Highlight brilliant moves, traps you set, and critical finds"
          checked={settings.includeGreatMoves}
          onToggle={() =>
            onUpdateSettings({
              ...settings,
              includeGreatMoves: !settings.includeGreatMoves,
            })
          }
        />
        <ToggleRow
          title="Show opportunities"
          desc="Highlight moments where your opponent gave you a chance — and when you seized it"
          checked={settings.includeOpportunities}
          onToggle={() =>
            onUpdateSettings({
              ...settings,
              includeOpportunities: !settings.includeOpportunities,
            })
          }
        />
        {appConfig?.engineMode === "hybrid" && (
          <ToggleRow
            title="Use Lc0 analysis"
            desc="Add Leela Chess Zero strategic insight and WDL probabilities"
            checked={settings.useLc0}
            onToggle={() =>
              onUpdateSettings({ ...settings, useLc0: !settings.useLc0 })
            }
          />
        )}
        <ToggleRow
          title="Detailed report"
          desc="Lower thresholds to flag more moments for broader game coverage"
          checked={settings.detailedReport}
          onToggle={() =>
            onUpdateSettings({
              ...settings,
              detailedReport: !settings.detailedReport,
            })
          }
        />

        <p className="modal-subtitle" style={{ marginTop: "16px" }}>
          Analysis depth
        </p>
        <div className="perspective-selector">
          {([8, 12, 18] as const).map((d) => (
            <button
              key={d}
              className={`perspective-option ${settings.analysisDepth === d ? "selected" : ""}`}
              onClick={() =>
                onUpdateSettings({ ...settings, analysisDepth: d })
              }
            >
              {d === 8 ? "Quick" : d === 12 ? "Standard" : "Deep"}
            </button>
          ))}
        </div>

        <button className="action-button modal-primary-btn" onClick={onAnalyze}>
          <ReportIcon /> Analyze Game
        </button>
      </PopIn>
    </div>
  );
}
