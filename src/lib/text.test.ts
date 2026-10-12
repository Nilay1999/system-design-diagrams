import { describe, expect, it } from "vitest";

import { createSlugger, outline, slugify } from "./text";

describe("slugify", () => {
  it("matches the ids headings get in the docs", () => {
    expect(slugify("High-level architecture")).toBe("high-level-architecture");
    expect(slugify("Trade-offs & failure modes")).toBe("trade-offs-failure-modes");
    expect(slugify("  HTTP/2 vs. HTTP/3 ")).toBe("http2-vs-http3");
  });
});

describe("createSlugger", () => {
  it("suffixes repeats", () => {
    const slug = createSlugger();
    expect(["API", "Data model", "API", "API"].map(slug)).toEqual(["api", "data-model", "api-1", "api-2"]);
  });
});

describe("outline", () => {
  it("lists ## and ### headings with unique ids, ignoring code fences", () => {
    const doc = [
      "# Title",
      "## Requirements",
      "### The `LRU` *cache*",
      "```md",
      "## not a heading",
      "```",
      "## [Linked](https://x) heading ##",
      "## Requirements",
      "#### too deep",
    ].join("\n");
    expect(outline(doc)).toEqual([
      { depth: 2, title: "Requirements", id: "requirements" },
      { depth: 3, title: "The LRU cache", id: "the-lru-cache" },
      { depth: 2, title: "Linked heading", id: "linked-heading" },
      { depth: 2, title: "Requirements", id: "requirements-1" },
    ]);
  });
});
