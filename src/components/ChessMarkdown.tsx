// ReactMarkdown wrapper that turns SAN move tokens (Nf3, exd5, O-O,
// Qxh7+ …) into clickable chips that navigate to the referenced move.
import { isValidElement, cloneElement, type ReactNode, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";

// Castles, piece moves, pawn moves/captures, promotion, check/mate suffix.
// Annotation suffixes (!, ?, !? …) are captured separately so the chip can
// display them while lookup uses the bare SAN.
const SAN_RE =
  /\b(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h][1-8](?:=[QRBN])?)([+#]?)([!?]{1,2})?\b/g;

// Eval figures like "1.41" / "-2.98" (a decimal point is what
// distinguishes them from move numbers like "12.").
const EVAL_RE = /(?<![\w.])-?\d+\.\d+/g;

interface ChessMarkdownProps {
  children: string;
  /** Called with the bare SAN (annotations stripped) when a chip is clicked. */
  onMoveClick?: (san: string) => void;
  /** Whether a SAN chip can be navigated to — non-navigable moves (e.g.
      engine suggestions never played) render as static chips. */
  canNavigate?: (san: string) => boolean;
}

/** Style bare eval figures in a plain-text segment. */
function evalify(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  EVAL_RE.lastIndex = 0;
  let i = 0;
  while ((m = EVAL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <code key={`${keyPrefix}-e${i++}`} className="md-eval">
        {m[0]}
      </code>,
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function chipify(
  node: ReactNode,
  onMoveClick: ((san: string) => void) | undefined,
  canNavigate: ((san: string) => boolean) | undefined,
  keyPrefix: string,
): ReactNode {
  if (typeof node === "string") {
    const out: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    SAN_RE.lastIndex = 0;
    let i = 0;
    while ((m = SAN_RE.exec(node)) !== null) {
      if (m.index > last)
        out.push(...evalify(node.slice(last, m.index), `${keyPrefix}-t${i}`));
      const san = m[1] + (m[2] ?? "");
      const display = san + (m[3] ?? "");
      const navigable = onMoveClick && (!canNavigate || canNavigate(san));
      out.push(
        navigable ? (
          <button
            key={`${keyPrefix}-${i++}`}
            className="md-move-chip"
            onClick={() => onMoveClick(san)}
          >
            {display}
          </button>
        ) : (
          <code key={`${keyPrefix}-${i++}`} className="md-move-chip md-move-static">
            {display}
          </code>
        ),
      );
      last = m.index + m[0].length;
    }
    if (out.length === 0) {
      const evaled = evalify(node, keyPrefix);
      return evaled.length === 1 ? node : evaled;
    }
    if (last < node.length)
      out.push(...evalify(node.slice(last), `${keyPrefix}-t${i}-end`));
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => chipify(child, onMoveClick, canNavigate, `${keyPrefix}-${i}`));
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode; className?: string }>;
    // Already a chip or styled eval — don't chipify inside it (loose lists
    // run text through both the li and p wrappers, which would nest chips).
    const cls = el.props.className ?? "";
    if (cls.includes("md-move-chip") || cls.includes("md-eval")) return node;
    if (el.props.children) {
      return cloneElement(
        el,
        undefined,
        chipify(el.props.children, onMoveClick, canNavigate, `${keyPrefix}-c`),
      );
    }
  }
  return node;
}

export function ChessMarkdown({ children, onMoveClick, canNavigate }: ChessMarkdownProps) {
  const wrap = (Tag: "p" | "li") =>
    function MdNode(props: { children?: ReactNode }) {
      return <Tag>{chipify(props.children, onMoveClick, canNavigate, Tag)}</Tag>;
    };

  return (
    <ReactMarkdown components={{ p: wrap("p"), li: wrap("li") }}>
      {children}
    </ReactMarkdown>
  );
}

