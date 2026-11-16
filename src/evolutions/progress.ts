import { createStore, type KeyValueStore } from "../lib/storage";
import type { Topic } from "../topics/types";
import type { Choice, Evolution, Step } from "./types";

/**
 * Where a reader is in a step-by-step design. `step` runs from 0 to `steps.length`; the last
 * value is the summary screen. `picks` holds the first choice made at each decision, by step id.
 */
export interface Progress {
  step: number;
  picks: Record<string, string>;
}

export const START: Progress = { step: 0, picks: {} };

export const isSummary = (evolution: Evolution, progress: Progress) => progress.step >= evolution.steps.length;

/** A step is finished once its decision is made; a step without a decision is finished on arrival. */
export const isAnswered = (step: Step, progress: Progress) => !step.decision || step.id in progress.picks;

export const bestChoice = (step: Step): Choice | undefined => step.decision?.choices.find((c) => c.verdict === "best");

export const pickedChoice = (step: Step, progress: Progress): Choice | undefined =>
  step.decision?.choices.find((c) => c.id === progress.picks[step.id]);

/**
 * What the diagram should show: the design before the current step while its decision is open,
 * the design after it (with the new parts marked) once it is made, and the finished design on the summary.
 */
export function diagramView(evolution: Evolution, progress: Progress): { level: number; markAdded: boolean } {
  const last = evolution.steps.length - 1;
  if (isSummary(evolution, progress)) return { level: last, markAdded: false };
  const step = evolution.steps[progress.step];
  return isAnswered(step, progress) ? { level: progress.step, markAdded: true } : { level: progress.step - 1, markAdded: false };
}

/** How many decisions there are, and how many the reader got right first time. */
export function score(evolution: Evolution, progress: Progress): { right: number; total: number } {
  const decisions = evolution.steps.filter((s) => s.decision);
  return { right: decisions.filter((s) => pickedChoice(s, progress)?.verdict === "best").length, total: decisions.length };
}

/** Record a choice. Only the first pick at each step counts; later clicks just read the other answers. */
export function pick(step: Step, progress: Progress, choiceId: string): Progress {
  if (step.id in progress.picks) return progress;
  return { ...progress, picks: { ...progress.picks, [step.id]: choiceId } };
}

/**
 * Make saved progress fit the evolution as it is now: drop picks for steps or choices that no
 * longer exist, and never land past the first unanswered step.
 */
export function sanitize(evolution: Evolution, saved: unknown): Progress {
  if (!saved || typeof saved !== "object") return START;
  const { step, picks } = saved as Partial<Progress>;
  const clean: Record<string, string> = {};
  for (const s of evolution.steps) {
    const id = picks && typeof picks === "object" ? picks[s.id] : undefined;
    if (s.decision?.choices.some((c) => c.id === id)) clean[s.id] = id as string;
  }
  const progress = { step: 0, picks: clean };
  const firstOpen = evolution.steps.findIndex((s) => !isAnswered(s, progress));
  const furthest = firstOpen === -1 ? evolution.steps.length : firstOpen;
  const wanted = typeof step === "number" && Number.isInteger(step) && step >= 0 ? step : 0;
  return { step: Math.min(wanted, furthest), picks: clean };
}

/** Saved progress, one entry per topic. */
export function createProgressStore(store: KeyValueStore = createStore("sdd:evolve")) {
  const key = (topic: Topic) => `${topic.track}:${topic.slug}`;
  return {
    load: (topic: Topic, evolution: Evolution) => sanitize(evolution, store.getJSON<Progress>(key(topic))),
    save: (topic: Topic, progress: Progress) => store.setJSON(key(topic), progress),
    clear: (topic: Topic) => store.remove(key(topic)),
  };
}

export const progressStore = createProgressStore();
