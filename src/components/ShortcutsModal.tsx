// Keyboard shortcut reference.
import { PopIn } from "../animate";

const SHORTCUTS: [string, string][] = [
  ["←", "Previous move"],
  ["→", "Next move"],
  [",", "Jump to start"],
  [".", "Jump to end"],
  ["↓", "Enter suggested best line (report, main line)"],
  ["↑", "Return to main line (report, in variation)"],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="api-key-modal-overlay" onClick={onClose}>
      <PopIn
        className="api-key-modal"
        style={{ maxWidth: "420px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>
          <span>Keyboard Shortcuts</span>
          <button className="api-key-modal-close" onClick={onClose}>
            ✕
          </button>
        </h2>
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUTS.map(([key, desc]) => (
              <tr key={key}>
                <td>
                  <kbd>{key}</kbd>
                </td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopIn>
    </div>
  );
}
