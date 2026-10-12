/** URL fragment for a heading: lower-case, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Returns `slugify(text)`, suffixed `-1`, `-2`, … when that slug was already handed out (as GitHub does). */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** Depths whose headings get ids (and so can appear in a page index). */
export const LINKED_HEADING_DEPTHS = [2, 3] as const;

export interface OutlineEntry {
  depth: (typeof LINKED_HEADING_DEPTHS)[number];
  title: string;
  id: string;
}

/**
 * `##` and `###` headings of a Markdown document, skipping fenced code, with the same ids
 * `remarkHeadingIds` gives them when rendered.
 */
export function outline(markdown: string): OutlineEntry[] {
  const slug = createSlugger();
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (fence === null || marker.startsWith(fence))) {
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence !== null) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const title = m[2]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .trim();
    entries.push({ depth: m[1].length as 2 | 3, title, id: slug(title) });
  }
  return entries;
}
