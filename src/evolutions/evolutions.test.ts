import { describe, expect, it } from "vitest";

import { layoutProblems } from "../diagrams/layout-lint";
import { BUILD_SEGMENT } from "../topics/paths";
import { TRACKS } from "../tracks";

const topics = TRACKS.flatMap((t) => t.catalog.topics);
const buildable = topics.flatMap((t) => (t.evolution ? [[`${t.track}/${t.slug}`, t.evolution] as const] : []));

/** Arrows and node borders drawn with the "added in this step" weight. */
const addedParts = (elements: readonly { strokeWidth?: number }[]) => elements.filter((e) => e.strokeWidth === 4);

describe("step-by-step builds", () => {
  it("exist for at least one topic", () => {
    expect(buildable.length).toBeGreaterThan(0);
  });

  it("never share a URL with a diagram tab", () => {
    expect(topics.filter((t) => t.diagrams.some((d) => d.id === BUILD_SEGMENT)).map((t) => t.slug)).toEqual([]);
  });

  describe.each(buildable)("%s", (_, evolution) => {
    const { steps } = evolution;

    it("has unique step ids and starts without a decision", () => {
      const ids = steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(steps.length).toBeGreaterThan(1);
      expect(steps[0].decision).toBeUndefined();
    });

    it("asks one decision per later step, with exactly one best choice", () => {
      for (const step of steps.slice(1)) {
        const choices = step.decision?.choices ?? [];
        expect(choices.length, step.id).toBeGreaterThanOrEqual(2);
        expect(new Set(choices.map((c) => c.id)).size, step.id).toBe(choices.length);
        expect(choices.filter((c) => c.verdict === "best").length, step.id).toBe(1);
      }
    });

    it("does not always put the best choice in the same position", () => {
      const positions = steps.slice(1).map((s) => s.decision!.choices.findIndex((c) => c.verdict === "best"));
      expect(new Set(positions).size).toBeGreaterThan(1);
    });

    it.each(steps.map((s, level) => [s.id, level] as const))("draws step %s with a clean layout", (_, level) => {
      expect(layoutProblems(evolution.diagram(level, true))).toEqual([]);
      expect(layoutProblems(evolution.diagram(level, false))).toEqual([]);
    });

    it("marks what each step adds, and only when asked", () => {
      expect(addedParts(evolution.diagram(0, true))).toEqual([]);
      steps.slice(1).forEach((step, i) => {
        expect(addedParts(evolution.diagram(i + 1, true)).length, step.id).toBeGreaterThan(0);
        expect(addedParts(evolution.diagram(i + 1, false)), step.id).toEqual([]);
      });
    });
  });
});
