import { describe, expect, it } from "vitest";

import { createStore } from "../lib/storage";
import { topic } from "../test/fixtures";
import { memoryStorage } from "../test/memoryStorage";
import { START, createProgressStore, diagramView, isSummary, pick, sanitize, score } from "./progress";
import type { Evolution } from "./types";

const choices = (best: string) => [
  { id: "a", label: "A", verdict: best === "a" ? ("best" as const) : ("poor" as const), feedback: "" },
  { id: "b", label: "B", verdict: best === "b" ? ("best" as const) : ("ok" as const), feedback: "" },
];

const evolution: Evolution = {
  intro: "",
  wrapUp: "",
  diagram: () => [],
  steps: [
    { id: "start", title: "Start", situation: "", result: "" },
    { id: "one", title: "One", situation: "", result: "", decision: { question: "?", choices: choices("a") } },
    { id: "two", title: "Two", situation: "", result: "", decision: { question: "?", choices: choices("b") } },
  ],
};
const [, one] = evolution.steps;

describe("diagramView", () => {
  it("shows the starting design on the first step", () => {
    expect(diagramView(evolution, START)).toEqual({ level: 0, markAdded: true });
  });

  it("shows the design before a step until its decision is made, then the design after it", () => {
    const open = { step: 1, picks: {} };
    expect(diagramView(evolution, open)).toEqual({ level: 0, markAdded: false });
    expect(diagramView(evolution, pick(one, open, "b"))).toEqual({ level: 1, markAdded: true });
  });

  it("shows the finished design, unmarked, on the summary", () => {
    const done = { step: 3, picks: { one: "a", two: "b" } };
    expect(isSummary(evolution, done)).toBe(true);
    expect(diagramView(evolution, done)).toEqual({ level: 2, markAdded: false });
  });
});

describe("pick and score", () => {
  it("keeps only the first pick at each step", () => {
    const first = pick(one, { step: 1, picks: {} }, "b");
    expect(pick(one, first, "a")).toBe(first);
  });

  it("counts decisions that matched the best choice first time", () => {
    expect(score(evolution, { step: 3, picks: { one: "a", two: "a" } })).toEqual({ right: 1, total: 2 });
  });
});

describe("sanitize", () => {
  it("starts over when nothing usable is saved", () => {
    expect(sanitize(evolution, null)).toEqual(START);
    expect(sanitize(evolution, "junk")).toEqual(START);
  });

  it("drops picks for steps and choices that no longer exist", () => {
    expect(sanitize(evolution, { step: 1, picks: { one: "gone", old: "a", two: "b" } })).toEqual({ step: 1, picks: { two: "b" } });
  });

  it("never lands past the first open decision", () => {
    expect(sanitize(evolution, { step: 3, picks: { one: "a" } })).toEqual({ step: 2, picks: { one: "a" } });
    expect(sanitize(evolution, { step: 3, picks: { one: "a", two: "b" } }).step).toBe(3);
  });
});

describe("progress store", () => {
  it("saves progress per track and topic", () => {
    const backend = memoryStorage();
    const store = createProgressStore(createStore("test", () => backend));
    const a = topic();
    const b = topic({ track: "kubernetes" });
    store.save(a, { step: 2, picks: { one: "a" } });
    expect(store.load(a, evolution)).toEqual({ step: 2, picks: { one: "a" } });
    expect(store.load(b, evolution)).toEqual(START);
    store.clear(a);
    expect(store.load(a, evolution)).toEqual(START);
  });
});
