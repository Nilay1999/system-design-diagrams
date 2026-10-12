import type { Topic, TopicSource } from "./types";

/** Sidebar sections, in display order. */
export const SOURCES: readonly { source: TopicSource; label: string; emptyText?: string }[] = [
  { source: "local", label: "My Topics", emptyText: "Write up your own problem and sketch it on a blank canvas." },
  { source: "curated", label: "Curated" },
  { source: "community", label: "Community", emptyText: "Community problems will appear here." },
];

/** Sources still loading, or that failed to load (with a message). */
export type SourceStatus = Partial<Record<TopicSource, { state: "pending" } | { state: "error"; message: string }>>;

/** Read-only lookups over a set of topics, whatever their source. */
export class TopicCatalog {
  private readonly byKey: ReadonlyMap<string, Topic>;

  /** `topics` must include at least one curated topic, the fallback when nothing is chosen. */
  constructor(
    readonly topics: readonly Topic[],
    readonly status: SourceStatus = {},
  ) {
    if (!topics.some((t) => t.source === "curated")) throw new Error("A topic catalog needs a curated topic");
    this.byKey = new Map(topics.map((t) => [`${t.source}/${t.slug}`, t]));
  }

  /** The topic shown when none is chosen. */
  get first(): Topic {
    return this.topics.find((t) => t.source === "curated")!;
  }

  /** Slugs are unique within a source, not across sources. */
  find(slug: string | undefined, source: TopicSource = "curated"): Topic | undefined {
    return slug === undefined ? undefined : this.byKey.get(`${source}/${slug}`);
  }

  isPending(source: TopicSource): boolean {
    return this.status[source]?.state === "pending";
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
