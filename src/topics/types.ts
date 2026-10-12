import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import type { DiagramSpec } from "../diagrams/dsl";

/** A diagram tab shipped as a raw Excalidraw scene (community content), rather than built from the DSL. */
export interface SceneSpec {
  id: string;
  name: string;
  scene: { elements: readonly ExcalidrawElement[]; files?: BinaryFiles };
}

/** A diagram tab whose drawing lives in browser storage and belongs to the user (My Topics). */
export interface StoredSceneSpec {
  id: string;
  name: string;
  stored: true;
}

/** A tab whose drawing ships with the topic (as opposed to being stored by the user). */
export type ShippedTab = DiagramSpec | SceneSpec;

export type DiagramTab = ShippedTab | StoredSceneSpec;

export const isScene = (tab: DiagramTab): tab is SceneSpec => "scene" in tab;
export const isStored = (tab: DiagramTab): tab is StoredSceneSpec => "stored" in tab;

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

/** Where a topic comes from: this repo, the user's own browser, or other users (via the API). */
export type TopicSource = "curated" | "local" | "community";

export interface Topic {
  source: TopicSource;
  slug: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  difficulty?: Difficulty;
  /** Diagram views shown as tabs: architecture first, then request flows and deep dives. Never empty. */
  diagrams: DiagramTab[];
  /** Markdown source. */
  doc: string;
  /** ISO timestamp, for topics that change. */
  updatedAt?: string;
}
