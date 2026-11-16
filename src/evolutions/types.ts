import type { Skeleton } from "../diagrams/dsl";

/**
 * A design built up one decision at a time. The reader starts from the simplest version that
 * works; each later step brings a problem, asks them to choose a fix, then grows the diagram.
 *
 * Text fields are Markdown (bold, `code`, lists).
 */

/** How a choice compares with the one the reference design makes. */
export type Verdict = "best" | "ok" | "poor";

export interface Choice {
  id: string;
  label: string;
  verdict: Verdict;
  /** Shown once the reader has picked: why this choice fits, or what goes wrong with it. */
  feedback: string;
}

/** A number that makes the problem concrete, e.g. "Redirects: 4,000/s". */
export interface Metric {
  label: string;
  value: string;
}

export interface Step {
  /** Stable id; saved progress is keyed by it. */
  id: string;
  /** The problem in a few words, e.g. "The database is the bottleneck". */
  title: string;
  /** What is going wrong with the design so far (for the first step: where we begin). */
  situation: string;
  metrics?: Metric[];
  /** The decision to make. The first step has none: it only shows the starting design. */
  decision?: {
    question: string;
    /** Exactly one choice has the verdict "best"; the diagram follows it. */
    choices: Choice[];
  };
  /** What the diagram shows after this step, and why it works. */
  result: string;
  /** What the fix costs, or the new problem it creates. */
  tradeoff?: string;
}

export interface Evolution {
  /** One or two sentences shown on the first step. */
  intro: string;
  steps: Step[];
  /**
   * The design after `level + 1` steps (0 = the starting design). With `markAdded`, the parts
   * that step added are marked as new.
   */
  diagram: (level: number, markAdded: boolean) => Skeleton[];
  /** Shown on the summary screen once every step is done. */
  wrapUp: string;
}

/**
 * Helpers for writing `Evolution.diagram` as one function: `from(n)` says whether a part exists
 * yet, and `added(n)` returns the options that mark it as new on the step that adds it.
 */
export function stagedParts(level: number, markAdded: boolean) {
  return {
    /** True once step `n` has been applied. */
    from: (n: number) => level >= n,
    /** True from step `a` up to (not including) step `b`, for parts that a later step replaces. */
    between: (a: number, b: number) => level >= a && level < b,
    /** Options for a node or arrow that step `n` adds. */
    added: (n: number) => ({ added: markAdded && level === n && n > 0 }),
  };
}
