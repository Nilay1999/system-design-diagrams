/**
 * GitHub-style alerts: a blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
 * `[!WARNING]` or `[!CAUTION]` becomes `<blockquote class="callout callout-<kind>">`. The marker is
 * removed and the label goes in `data-callout`, so the docs also render as alerts on GitHub.
 */

/** The few mdast fields this plugin touches. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

export const CALLOUT_LABELS = {
  note: "Note",
  tip: "Tip",
  important: "Key idea",
  warning: "Watch out",
  caution: "Danger",
} as const;

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i;

function transform(node: MdNode) {
  if (node.type === "blockquote") {
    const paragraph = node.children?.[0];
    const text = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
    const match = text?.type === "text" && text.value ? MARKER.exec(text.value) : null;
    if (paragraph && text && match) {
      const kind = match[1].toLowerCase() as keyof typeof CALLOUT_LABELS;
      text.value = text.value!.slice(match[0].length);
      if (!text.value) paragraph.children!.shift();
      if (!paragraph.children!.length) node.children!.shift();
      node.data = {
        ...node.data,
        hProperties: { className: ["callout", `callout-${kind}`], dataCallout: CALLOUT_LABELS[kind] },
      };
    }
  }
  node.children?.forEach(transform);
}

export function remarkCallouts() {
  return (tree: MdNode) => transform(tree);
}
