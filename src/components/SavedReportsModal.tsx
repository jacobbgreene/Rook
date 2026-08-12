// Saved reports library: search, sort, load, and per-item actions menu.
import { useMemo, useState } from "react";
import type { SavedReportMeta } from "../gameAnalysis";
import { DotsIcon } from "../icons";
import { PopIn } from "../animate";

type SortKey = "newest" | "oldest" | "critical" | "result";

interface SavedReportsModalProps {
  reports: SavedReportMeta[];
  busy: boolean; // a report is currently being generated
  onLoad: (id: string) => void;
  onRegenerate: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onClose: () => void;
}

export function SavedReportsModal({
  reports,
  busy,
  onLoad,
  onRegenerate,
  onDelete,
  onRename,
  onClose,
}: SavedReportsModalProps) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [menuForId, setMenuForId] = useState<string | null>(null);

  const visibleReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? reports.filter((r) =>
          [r.name, r.openingMoves, r.perspective, r.result]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : reports;
    const resultOrder: Record<string, number> = {
      win: 0,
      draw: 1,
      loss: 2,
      unknown: 3,
    };
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return a.createdAt.localeCompare(b.createdAt);
        case "critical":
          return (
            b.criticalMomentCount - a.criticalMomentCount ||
            b.createdAt.localeCompare(a.createdAt)
          );
        case "result":
          return (
            (resultOrder[a.result] ?? 3) - (resultOrder[b.result] ?? 3) ||
            b.createdAt.localeCompare(a.createdAt)
          );
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });
  }, [reports, search, sort]);

  const startRename = (r: SavedReportMeta) => {
    setRenamingId(r.id);
    setRenameText(r.name ?? "");
    setMenuForId(null);
  };

  const submitRename = async (id: string) => {
    await onRename(id, renameText);
    setRenamingId(null);
  };

  return (
    <div className="saved-reports-overlay" onClick={onClose}>
      <PopIn
        className="saved-reports-modal"
        onClick={(e) => {
          e.stopPropagation();
          setMenuForId(null);
        }}
      >
        <h2>
          <span>Saved Reports</span>
          <button className="api-key-modal-close" onClick={onClose}>
            ✕
          </button>
        </h2>

        {reports.length > 0 && (
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              type="text"
              placeholder="Search by name, opening, result..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="saved-reports-search"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="saved-reports-sort"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="critical">Most critical moments</option>
              <option value="result">Result (W-D-L)</option>
            </select>
          </div>
        )}

        {reports.length === 0 ? (
          <div className="saved-reports-empty">No saved reports yet.</div>
        ) : visibleReports.length === 0 ? (
          <div className="saved-reports-empty">
            No reports match "{search}".
          </div>
        ) : (
          <div className="saved-reports-list">
            {visibleReports.map((report) => (
              <div key={report.id} className="saved-report-item">
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renamingId === report.id ? (
                    <input
                      type="text"
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRename(report.id);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      placeholder="Report name (empty = opening line)"
                      className="saved-reports-rename"
                    />
                  ) : (
                    <div
                      className="saved-report-title"
                      title={report.name || report.openingMoves}
                    >
                      {report.name || report.openingMoves || "No moves"}
                      {report.name && report.openingMoves && (
                        <span className="saved-report-subtitle">
                          {report.openingMoves}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="saved-report-meta">
                    <span
                      className={`perspective-badge perspective-${report.perspective}`}
                    >
                      {report.perspective}
                    </span>
                    {report.result && report.result !== "unknown" && (
                      <span className={`result-badge result-${report.result}`}>
                        {report.result === "win"
                          ? "W"
                          : report.result === "loss"
                            ? "L"
                            : "D"}
                      </span>
                    )}
                    <span>{new Date(report.createdAt).toLocaleDateString()}</span>
                    <span>{report.moveCount} moves</span>
                    <span>{report.criticalMomentCount} critical moments</span>
                  </div>
                </div>

                <div className="sri-actions">
                  {renamingId === report.id ? (
                    <button
                      className="action-button sri-btn"
                      style={{ color: "#4ade80" }}
                      onClick={() => submitRename(report.id)}
                    >
                      Save
                    </button>
                  ) : (
                    <button
                      className="action-button sri-btn"
                      onClick={() => onLoad(report.id)}
                    >
                      Load
                    </button>
                  )}
                  <div className="menu-wrap">
                    <button
                      className="action-button sri-btn"
                      title="More actions"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuForId(menuForId === report.id ? null : report.id);
                      }}
                    >
                      <DotsIcon />
                    </button>
                    {menuForId === report.id && (
                      <div className="menu-popup">
                        <button onClick={() => startRename(report)}>
                          Rename
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setMenuForId(null);
                            onRegenerate(report.id);
                          }}
                        >
                          Regenerate
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            setMenuForId(null);
                            onDelete(report.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </PopIn>
    </div>
  );
}
