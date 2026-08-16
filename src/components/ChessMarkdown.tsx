// ReactMarkdown wrapper that turns SAN move tokens (Nf3, exd5, O-O,
// Qxh7+ …) into clickable chips that navigate to the referenced move.
import { isValidElement, cloneElement, type ReactNode, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";

// Castles, piece moves, pawn moves/captures, promotion, check/mate suffix.
// Annotation suffixes (!, ?, !? …) are captured separately so the chip can
// display them while lookup uses the bare SAN.
const SAN_RE =
  /\b(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h][1-8](?:=[QRBN])?)([+#]?)([!?]{1,2})?\b/g;

interface ChessMarkdownProps {
  children: string;
  /** Called with the bare SAN (annotations stripped) when a chip is clicked. */
  onMoveClick?: (san: string) => void;
}

function chipify(
  node: ReactNode,
  onMoveClick: ((san: string) => void) | undefined,
  keyPrefix: string,
): ReactNode {
  if (typeof node === "string") {
    const out: ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    SAN_RE.lastIndex = 0;
    let i = 0;
    while ((m = SAN_RE.exec(node)) !== null) {
      if (m.index > last) out.push(node.slice(last, m.index));
      const san = m[1] + (m[2] ?? "");
      const display = san + (m[3] ?? "");
      out.push(
        onMoveClick ? (
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
    if (out.length === 0) return node;
    if (last < node.length) out.push(node.slice(last));
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((child, i) => chipify(child, onMoveClick, `${keyPrefix}-${i}`));
  }
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode; className?: string }>;
    // Already a chip — don't chipify inside it (loose lists run text
    // through both the li and p wrappers, which would nest chips).
    if (el.props.className?.includes("md-move-chip")) return node;
    if (el.props.children) {
      return cloneElement(
        el,
        undefined,
        chipify(el.props.children, onMoveClick, `${keyPrefix}-c`),
      );
    }
  }
  return node;
}

export function ChessMarkdown({ children, onMoveClick }: ChessMarkdownProps) {
  const wrap = (Tag: "p" | "li") =>
    function MdNode(props: { children?: ReactNode }) {
      return <Tag>{chipify(props.children, onMoveClick, Tag)}</Tag>;
    };

  return (
    <ReactMarkdown components={{ p: wrap("p"), li: wrap("li") }}>
      {children}
    </ReactMarkdown>
  );
}
