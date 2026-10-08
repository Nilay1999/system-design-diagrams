import type { Topic, TopicSource } from "./types";

/** Sidebar sections, in display order. */
export const SOURCES: readonly { source: TopicSource; label: string; emptyText?: string }[] = [
  { source: "curated", label: "Curated" },
  { source: "community", label: "Community", emptyText: "Community problems will appear here." },
];

/** Read-only lookups over a set of topics, whatever their source. */
export class TopicCatalog {
  private readonly bySlug: ReadonlyMap<string, Topic>;

  constructor(readonly topics: readonly Topic[]) {
    if (topics.length === 0) throw new Error("A topic catalog needs at least one topic");
    this.bySlug = new Map(topics.map((t) => [t.slug, t]));
  }

  /** The topic shown when none is chosen. */
  get first(): Topic {
    return this.topics[0];
  }

  find(slug: string | undefined): Topic | undefined {
    return slug === undefined ? undefined : this.bySlug.get(slug);
  }

  /** Case-insensitive match on title, summary, category and tags. An empty query matches everything. */
  search(query: string): Topic[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...this.topics];
    return this.topics.filter((t) =>
      [t.title, t.summary, t.category, ...t.tags].some((field) => field.toLowerCase().includes(q)),
    );
  }
}

/** `[category, topics]` pairs, categories in order of first use. */
export function groupByCategory(topics: readonly Topic[]): [string, Topic[]][] {
  const groups = new Map<string, Topic[]>();
  for (const t of topics) {
    const group = groups.get(t.category);
    if (group) group.push(t);
    else groups.set(t.category, [t]);
  }
  return [...groups];
}
