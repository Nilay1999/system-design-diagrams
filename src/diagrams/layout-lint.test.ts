import { describe, expect, it } from "vitest";

import { Diagram } from "./dsl";
import { layoutProblems } from "./layout-lint";

describe("layoutProblems", () => {
  it("accepts a clean layout", () => {
    const d = new Diagram().node("a", "A", 0, 0).node("b", "B", 1, 0).zone("Z", ["a", "b"]).panel("P", ["x"], 0, 1.5);
    expect(layoutProblems(d.build())).toEqual([]);
  });

  it("reports overlapping boxes", () => {
    const d = new Diagram().node("a", "A", 0, 0).node("b", "B", 0.3, 0.2);
    expect(layoutProblems(d.build())).toEqual(["a overlaps b"]);
  });

  it("reports an arrow passing through a box it doesn't connect", () => {
    const d = new Diagram().node("a", "A", 0, 0).node("b", "B", 2, 0).node("c", "C", 1, 0).edge("a", "b");
    expect(layoutProblems(d.build())).toEqual(["arrow a → b passes through c"]);
    const around = new Diagram().node("a", "A", 0, 0).node("b", "B", 2, 0).node("c", "C", 1, 0).edge("a", "b", undefined, { via: [[1, 1]] });
    expect(layoutProblems(around.build())).toEqual([]);
  });

  it("reports a box crossing a zone border", () => {
    const d = new Diagram().node("a", "A", 0, 0).node("b", "B", 1, 0).zone("Z", ["a"]).panel("P", ["x"], 0.5, 0.2, { width: 200 });
    expect(layoutProblems(d.build()).some((p) => p.includes("crosses the border"))).toBe(true);
  });
});
