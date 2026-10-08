import type { Topic } from "../topics/types";

/** A minimal topic; DSL tabs build nothing, which is all routing and lookups need. */
export function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    source: "curated",
    slug: "url-shortener",
    title: "URL Shortener",
    category: "Infrastructure",
    summary: "Short links",
    tags: ["base62", "caching"],
    doc: "# URL Shortener",
    diagrams: [
      { id: "architecture", name: "Architecture", build: () => [] },
      { id: "redirect-flow", name: "Redirect flow", build: () => [] },
    ],
    ...overrides,
  };
}
