// Import modal: paste a FEN or a full PGN (multi-line friendly).
import { useState } from "react";
import { PopIn } from "../animate";

interface ImportModalProps {
  /** Parses and applies the input; returns feedback shown inside the modal. */
  onImport: (input: string) => Promise<{ ok: boolean; text: string } | null>;
  onClose: () => void;
}

export function ImportModal({ onImport, onClose }: ImportModalProps) {
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await onImport(input);
      if (result) setFeedback(result);
      if (result?.ok) {
        // Brief confirmation, then close — the board shows the new game.
        setTimeout(onClose, 900);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="report-setup-overlay" onClick={onClose}>
      <PopIn className="report-setup-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Import game or position</h3>
        <p className="modal-subtitle">
          Paste a FEN for a single position, or a full PGN (headers optional).
        </p>
        <textarea
          className="import-textarea"
          autoFocus
          placeholder={'e.g. 1. e4 e5 2. Nf3 Nc6 ... or rnbqkbnr/pppppppp/8/... w KQkq - 0 1'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
            if (e.key === "Escape") onClose();
          }}
        />
        {feedback && (
          <div className={`import-feedback ${feedback.ok ? "ok" : "err"}`}>
            {feedback.text}
          </div>
        )}
        <button
          className="action-button modal-primary-btn"
          onClick={submit}
          disabled={!input.trim() || busy}
        >
          Import
        </button>
        <div className="modal-hint">Ctrl+Enter to import</div>
      </PopIn>
    </div>
  );
}
