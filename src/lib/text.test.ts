import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { slugify, textOf } from "./text";

describe("slugify", () => {
  it("matches the ids headings get in the docs", () => {
    expect(slugify("High-level architecture")).toBe("high-level-architecture");
    expect(slugify("Trade-offs & failure modes")).toBe("trade-offs-failure-modes");
    expect(slugify("  HTTP/2 vs. HTTP/3 ")).toBe("http2-vs-http3");
  });
});

describe("textOf", () => {
  it("flattens nested elements", () => {
    const node = ["The ", createElement("code", null, "LRU"), " cache ", 2];
    expect(textOf(node)).toBe("The LRU cache 2");
  });
});
