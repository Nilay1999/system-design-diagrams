import { describe, expect, it } from "vitest";

import { topic } from "../test/fixtures";
import { TopicCatalog, groupByCategory } from "./catalog";

const a = topic({ slug: "a", title: "Rate Limiter", category: "Infrastructure", tags: ["token bucket"] });
const b = topic({ slug: "b", title: "Chat", category: "Social", tags: ["websockets"] });
const c = topic({ slug: "c", title: "Cache", category: "Infrastructure", tags: [], source: "community" });

describe("TopicCatalog", () => {
  const catalog = new TopicCatalog([a, b, c]);

  it("finds by slug", () => {
    expect(catalog.find("b")).toBe(b);
    expect(catalog.find("zzz")).toBeUndefined();
    expect(catalog.find(undefined)).toBeUndefined();
    expect(catalog.first).toBe(a);
  });

  it("searches title, category and tags, case-insensitively", () => {
    expect(catalog.search("  ")).toEqual([a, b, c]);
    expect(catalog.search("WEBSOCK")).toEqual([b]);
    expect(catalog.search("infrastructure")).toEqual([a, c]);
  });

  it("rejects an empty catalog", () => {
    expect(() => new TopicCatalog([])).toThrow();
  });
});

describe("groupByCategory", () => {
  it("keeps categories in order of first use", () => {
    expect(groupByCategory([a, b, c])).toEqual([
      ["Infrastructure", [a, c]],
      ["Social", [b]],
    ]);
  });
});
