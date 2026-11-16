import { describe, expect, it } from "vitest";

import { BUILD_SEGMENT, SIM_SEGMENT } from "../topics/paths";
import { TRACKS } from "../tracks";
import { layoutProblems } from "./geometry";
import { edgeId, initialInputs, scenarioInputs } from "./types";

const topics = TRACKS.flatMap((t) => t.catalog.topics);
const runnable = topics.flatMap((t) => (t.simulation ? [[`${t.track}/${t.slug}`, t.simulation] as const] : []));

describe("live simulators", () => {
  it("exist for at least one topic", () => {
    expect(runnable.length).toBeGreaterThan(0);
  });

  it("never share a URL with a diagram tab or the step-by-step build", () => {
    expect(SIM_SEGMENT).not.toBe(BUILD_SEGMENT);
    expect(topics.filter((t) => t.diagrams.some((d) => d.id === SIM_SEGMENT)).map((t) => t.slug)).toEqual([]);
  });

  describe.each(runnable)("%s", (_, sim) => {
    const nodeIds = sim.nodes.map((n) => n.id);
    const controlIds = sim.controls.map((c) => c.id);

    it("has unique ids and a clean layout", () => {
      expect(new Set(nodeIds).size).toBe(nodeIds.length);
      expect(new Set(controlIds).size).toBe(controlIds.length);
      expect(new Set(sim.edges.map(edgeId)).size).toBe(sim.edges.length);
      expect(layoutProblems(sim)).toEqual([]);
    });

    it("has sliders that start inside their range, on a step", () => {
      for (const c of sim.controls) {
        expect(c.initial, c.id).toBeGreaterThanOrEqual(c.min);
        expect(c.initial, c.id).toBeLessThanOrEqual(c.max);
        expect((c.initial - c.min) % c.step, c.id).toBe(0);
      }
    });

    it("has experiments that only use real sliders and stoppable parts", () => {
      const stoppable = new Set(sim.nodes.filter((n) => n.stoppable).map((n) => n.id));
      expect(sim.scenarios.length).toBeGreaterThan(0);
      for (const s of sim.scenarios) {
        expect(Object.keys(s.values ?? {}).filter((id) => !controlIds.includes(id)), s.id).toEqual([]);
        expect((s.down ?? []).filter((id) => !stoppable.has(id)), s.id).toEqual([]);
      }
    });

    it("reports a state for every node and edge, in every experiment and with every part stopped", () => {
      const cases = [initialInputs(sim), ...sim.scenarios.map((s) => scenarioInputs(sim, s)), { ...initialInputs(sim), down: nodeIds }];
      for (const inputs of cases) {
        let snapshot = sim.step(undefined, inputs, 0);
        for (let i = 0; i < 40; i++) snapshot = sim.step(snapshot, inputs, 0.25);
        expect(Object.keys(snapshot.nodes).sort()).toEqual([...nodeIds].sort());
        expect(Object.keys(snapshot.edges).sort()).toEqual(sim.edges.map(edgeId).sort());
        expect(snapshot.remarks.length).toBeGreaterThan(0);
        const text = JSON.stringify(snapshot);
        expect(text).not.toMatch(/null|NaN|Infinity|undefined/); // JSON turns NaN and Infinity into null
        for (const e of Object.values(snapshot.edges)) expect(e.rate).toBeGreaterThanOrEqual(0);
      }
    });

    it("is pure: the same inputs give the same result", () => {
      const inputs = initialInputs(sim);
      const first = sim.step(undefined, inputs, 0);
      expect(sim.step(first, inputs, 0.25)).toEqual(sim.step(first, inputs, 0.25));
    });
  });
});
