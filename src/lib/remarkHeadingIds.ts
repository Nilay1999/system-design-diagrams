import { LINKED_HEADING_DEPTHS, createSlugger } from "./text";

// The few mdast fields this plugin touches.
interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const plainText = (node: MdNode): string => node.value ?? (node.children ?? []).map(plainText).join("");

/**
 * Remark plugin: give `##` and `###` headings unique ids (matching `outline()`), so a page index
 * can link to them even when two headings share a title.
 */
export function remarkHeadingIds() {
  return (tree: MdNode) => {
    const slug = createSlugger();
    const visit = (node: MdNode) => {
      if (node.type === "heading" && LINKED_HEADING_DEPTHS.includes(node.depth as 2 | 3)) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slug(plainText(node).trim()) } };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
