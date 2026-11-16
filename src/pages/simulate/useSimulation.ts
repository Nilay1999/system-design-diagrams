import { useCallback, useEffect, useRef, useState } from "react";

import { initialInputs, scenarioInputs, type Scenario, type SimInputs, type Simulation, type Snapshot } from "../../simulations/types";

/** Seconds of simulated time per tick; ticks run in real time. */
export const TICK_S = 0.25;

/**
 * Runs a simulation: holds what the reader has set, and steps the model a few times a second so
 * that queues grow, caches warm up and the numbers settle while they watch.
 */
export function useSimulation(sim: Simulation) {
  const [inputs, setInputs] = useState<SimInputs>(() => initialInputs(sim));
  const [snapshot, setSnapshot] = useState<Snapshot>(() => sim.step(undefined, initialInputs(sim), 0));
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario | undefined>(sim.scenarios[0]);
  // The ticking interval reads the latest inputs without restarting.
  const latest = useRef(inputs);
  latest.current = inputs;

  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => setSnapshot((prev) => sim.step(prev, latest.current, TICK_S)), TICK_S * 1000);
    return () => window.clearInterval(id);
  }, [sim, paused]);

  /** Apply a change straight away (even while paused), keeping queues and cache warmth as they are. */
  const change = useCallback(
    (next: SimInputs) => {
      setInputs(next);
      setSnapshot((prev) => sim.step(prev, next, 0));
    },
    [sim],
  );

  const setValue = useCallback((id: string, value: number) => change({ ...latest.current, values: { ...latest.current.values, [id]: value } }), [change]);

  const toggle = useCallback(
    (nodeId: string) => {
      const { down } = latest.current;
      change({ ...latest.current, down: down.includes(nodeId) ? down.filter((d) => d !== nodeId) : [...down, nodeId] });
    },
    [change],
  );

  /** Start a ready-made experiment from a settled system. */
  const run = useCallback(
    (next: Scenario) => {
      const start = scenarioInputs(sim, next);
      setScenario(next);
      setInputs(start);
      // Settle with everything running first, so a stopped part is seen to fail rather than starting broken.
      setSnapshot(sim.step(sim.step(undefined, { ...start, down: [] }, 0), start, 0));
    },
    [sim],
  );

  return { inputs, snapshot, paused, setPaused, scenario, setValue, toggle, run };
}
