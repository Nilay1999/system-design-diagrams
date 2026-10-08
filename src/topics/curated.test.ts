import { describe, expect, it } from "vitest";

import { CURATED_TOPICS } from "./curated";

describe("curated topics", () => {
  it("have unique slugs", () => {
    const slugs = CURATED_TOPICS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(CURATED_TOPICS.map((t) => [t.slug, t] as const))("%s has a doc and unique, non-empty tabs", (_, t) => {
    expect(t.doc.length).toBeGreaterThan(0);
    expect(t.diagrams.length).toBeGreaterThan(0);
    const ids = t.diagrams.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CURATED_TOPICS.map((t) => [t.slug, t] as const))("%s doc links only to its own tabs", (_, t) => {
    const ids = new Set(t.diagrams.map((d) => d.id));
    const linked = [...t.doc.matchAll(/\]\(#diagram\/([\w-]+)\)/g)].map((m) => m[1]);
    expect(linked.filter((id) => !ids.has(id))).toEqual([]);
  });
});
