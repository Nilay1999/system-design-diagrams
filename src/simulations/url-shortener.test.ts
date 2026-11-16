import { describe, expect, it } from "vitest";

import sim from "./url-shortener";
import { initialInputs, type SimInputs, type Snapshot } from "./types";

const normal = initialInputs(sim);
const withValues = (values: Record<string, number>, down: string[] = []): SimInputs => ({ values: { ...normal.values, ...values }, down });

/** Run for `seconds`, starting from `from` or from the settled state of `inputs`. */
function run(inputs: SimInputs, seconds: number, from?: Snapshot): Snapshot {
  let snapshot = from ?? sim.step(undefined, inputs, 0);
  for (let t = 0; t < seconds; t += 0.25) snapshot = sim.step(snapshot, inputs, 0.25);
  return snapshot;
}

const reading = (s: Snapshot, id: string) => s.readings.find((r) => r.id === id)!;
const rate = (s: Snapshot, edge: string) => s.edges[edge].rate;

describe("URL shortener simulation", () => {
  it("is healthy on a normal day, with each layer shielding the next", () => {
    const s = run(normal, 5);
    expect(reading(s, "success").value).toBe("100 %");
    expect(s.remarks.map((r) => r.level)).toEqual(["good"]);
    expect(rate(s, "visitor->cdn")).toBe(4000);
    expect(rate(s, "cdn->redirect")).toBeLessThan(2500);
    expect(rate(s, "redirect->urls")).toBeLessThan(250);
  });

  it("survives losing Redis at normal traffic but not at peak", () => {
    const calm = run(withValues({}, ["redis"]), 5);
    expect(reading(calm, "success").health).toBe("ok");
    expect(calm.nodes.urls.health).toBe("ok");

    const peak = run(withValues({ traffic: 20_000 }, ["redis"]), 5);
    expect(peak.nodes.urls.health).toBe("bad");
    expect(reading(peak, "success").health).toBe("bad");
    expect(reading(peak, "p99").value).toBe("time out");
  });

  it("brings Redis back empty, and the hit rate climbs over time", () => {
    const crashed = run(withValues({}, ["redis"]), 2);
    const hit = (s: Snapshot) => s.memory.warmth;
    const soon = run(normal, 1, crashed);
    const later = run(normal, 30, soon);
    expect(hit(crashed)).toBe(0);
    expect(hit(soon)).toBeGreaterThan(0);
    expect(hit(soon)).toBeLessThan(0.5);
    expect(hit(later)).toBeGreaterThan(0.95);
    expect(rate(soon, "redirect->urls")).toBeGreaterThan(rate(later, "redirect->urls"));
  });

  it("keeps redirecting cached links when the URL store is down, but creates nothing", () => {
    const s = run(withValues({}, ["urls"]), 5);
    expect(reading(s, "success").health).toBe("bad");
    expect(parseFloat(reading(s, "success").value)).toBeGreaterThan(90);
    expect(reading(s, "creates").value).toBe("0 %");
  });

  it("does not let a Kafka outage touch redirects", () => {
    const s = run(withValues({}, ["kafka"]), 5);
    expect(reading(s, "success").value).toBe("100 %");
    expect(reading(s, "p99").value).toBe(reading(run(normal, 5), "p99").value);
    expect(reading(s, "reports").value).toBe("losing clicks");
  });

  it("queues clicks while the stream processor is stopped, then drains them", () => {
    const stopped = run(withValues({}, ["processor"]), 20);
    expect(stopped.memory.backlog).toBeGreaterThan(20_000);
    expect(reading(stopped, "success").value).toBe("100 %");
    const draining = run(normal, 2, stopped);
    expect(draining.memory.backlog).toBeLessThan(stopped.memory.backlog);
    expect(run(normal, 60, stopped).memory.backlog).toBe(0);
  });

  it("falls behind on reports when clicks outrun the stream workers", () => {
    const s = run(withValues({ traffic: 40_000, servers: 16, workers: 1 }), 10);
    expect(s.nodes.processor.health).toBe("bad");
    expect(s.memory.backlog).toBeGreaterThan(0);
  });

  it("keeps creating links for hours without the key generation service", () => {
    const s = run(withValues({}, ["kgs"]), 60);
    expect(reading(s, "creates").value).toBe("100 %");
    expect(s.memory.idsLeft).toBeGreaterThan(990_000);
    expect(s.remarks.some((r) => r.text.includes("nothing has changed"))).toBe(true);
  });

  it("turns redirects away when the servers are too few, and recovers when more are added", () => {
    const few = run(withValues({ traffic: 20_000, servers: 2 }), 5);
    expect(few.nodes.redirect.health).toBe("bad");
    expect(reading(few, "success").health).toBe("bad");
    const more = run(withValues({ traffic: 20_000, servers: 8 }), 5);
    expect(more.nodes.redirect.health).toBe("ok");
    expect(reading(more, "success").value).toBe("100 %");
  });

  it("sends everything to the servers when the CDN is bypassed", () => {
    const s = run(withValues({}, ["cdn"]), 5);
    expect(rate(s, "cdn->redirect")).toBe(4000);
  });

  it("costs more as parts are added", () => {
    const cost = (s: Snapshot) => Number(reading(s, "cost").value.replace(/[$,]/g, ""));
    expect(cost(run(withValues({ servers: 8 }), 1))).toBeGreaterThan(cost(run(normal, 1)));
  });
});
