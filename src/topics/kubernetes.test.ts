import { describe, expect, it } from "vitest";

import { layoutProblems } from "../diagrams/layout-lint";
import { isScene } from "./types";
import { CURATED_TOPICS } from "./curated";
import { KUBERNETES_TOPICS } from "./kubernetes";

describe("kubernetes topics", () => {
  it("have unique slugs", () => {
    const slugs = KUBERNETES_TOPICS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("all belong to the kubernetes track", () => {
    expect(KUBERNETES_TOPICS.every((t) => t.track === "kubernetes")).toBe(true);
    expect(CURATED_TOPICS.every((t) => t.track === "system-design")).toBe(true);
  });

  it.each(KUBERNETES_TOPICS.map((t) => [t.slug, t] as const))("%s has a doc and unique, non-empty tabs", (_, t) => {
    expect(t.doc.length).toBeGreaterThan(0);
    expect(t.diagrams.length).toBeGreaterThan(0);
    const ids = t.diagrams.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(KUBERNETES_TOPICS.map((t) => [t.slug, t] as const))("%s doc links only to its own tabs", (_, t) => {
    const ids = new Set(t.diagrams.map((d) => d.id));
    const linked = [...t.doc.matchAll(/\]\(#diagram\/([\w-]+)\)/g)].map((m) => m[1]);
    expect(linked.filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(KUBERNETES_TOPICS.map((t) => [t.slug, t] as const))("%s doc links to every one of its tabs", (_, t) => {
    const linked = new Set([...t.doc.matchAll(/\]\(#diagram\/([\w-]+)\)/g)].map((m) => m[1]));
    expect(t.diagrams.map((d) => d.id).filter((id) => !linked.has(id))).toEqual([]);
  });

  const tabs = KUBERNETES_TOPICS.flatMap((t) => t.diagrams.filter((d) => !isScene(d)).map((d) => [`${t.slug}/${d.id}`, d] as const));
  it.each(tabs)("%s has no overlapping boxes", (_, d) => {
    if (isScene(d)) return;
    expect(layoutProblems(d.build())).toEqual([]);
  });
});
