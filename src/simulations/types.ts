import type { NodeKind } from "../diagrams/dsl";

/**
 * A design that runs. The reader moves sliders and stops parts of the system, and a small model
 * recomputes, a few times a second, how much traffic each part carries and what breaks.
 *
 * The numbers come from simple formulas (capacity, hit rates, queues). They show the right shape
 * of behaviour; they are not benchmarks.
 */

/** What the reader has set: slider values by control id, and the ids of nodes they have stopped. */
export interface SimInputs {
  values: Record<string, number>;
  down: readonly string[];
}

export type Health = "ok" | "busy" | "bad" | "down" | "idle";

export interface NodeState {
  health: Health;
  /** Main line under the name, e.g. "1,920 / 10,000 per s". */
  value: string;
  /** Second line, e.g. "hit rate 91 %". */
  note?: string;
  /** Load as a share of capacity (1 = full), drawn as a bar. Omit for parts with no meaningful limit. */
  load?: number;
}

export interface EdgeState {
  /** Requests or events per second on this arrow. */
  rate: number;
  health: "ok" | "bad" | "idle";
  /** Text to show instead of the rate, e.g. "dropped". */
  text?: string;
}

/** A headline number above the diagram. */
export interface Reading {
  id: string;
  label: string;
  value: string;
  health: "ok" | "busy" | "bad";
}

/** One plain-language sentence about what is going on and why. */
export interface Remark {
  level: "bad" | "warn" | "good" | "info";
  text: string;
}

export interface Snapshot {
  nodes: Record<string, NodeState>;
  /** Keyed by `edgeId`. */
  edges: Record<string, EdgeState>;
  readings: Reading[];
  remarks: Remark[];
  /** Values that carry over between ticks: queue lengths, how warm a cache is. */
  memory: Record<string, number>;
}

export interface SimNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Grid position (fractions allowed), as in the diagram DSL. */
  col: number;
  row: number;
  /** Whether the reader can stop and restart this part. */
  stoppable?: boolean;
}

export interface SimEdge {
  from: string;
  to: string;
  label?: string;
  /** Fire-and-forget or queued traffic, drawn dashed. */
  async?: boolean;
}

export const edgeId = (edge: Pick<SimEdge, "from" | "to">) => `${edge.from}->${edge.to}`;

/** A slider. */
export interface Control {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  format: (value: number) => string;
  /** What this knob changes, in a few words. */
  help: string;
}

/** A ready-made experiment: it sets the sliders and stopped parts, and says what to look for. */
export interface Scenario {
  id: string;
  title: string;
  notice: string;
  /** Slider values that differ from the defaults. */
  values?: Record<string, number>;
  down?: string[];
}

export interface Simulation {
  intro: string;
  nodes: SimNode[];
  edges: SimEdge[];
  controls: Control[];
  scenarios: Scenario[];
  /**
   * Advance the system by `dt` seconds. Without `previous`, return the settled state for these
   * inputs (caches warm, queues empty). Must be pure: the same arguments give the same result.
   */
  step: (previous: Snapshot | undefined, inputs: SimInputs, dt: number) => Snapshot;
  /** A sentence on what the model leaves out, shown under the controls. */
  caveat: string;
}

export function initialInputs(sim: Simulation): SimInputs {
  return { values: Object.fromEntries(sim.controls.map((c) => [c.id, c.initial])), down: [] };
}

/** The inputs a scenario asks for: the defaults, with its own values and stopped parts on top. */
export function scenarioInputs(sim: Simulation, scenario: Scenario): SimInputs {
  return { values: { ...initialInputs(sim).values, ...scenario.values }, down: scenario.down ?? [] };
}
