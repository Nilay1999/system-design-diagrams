import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import type { DiagramSpec } from "../diagrams/dsl";

/** A diagram tab drawn directly in Excalidraw (community content), rather than built from the DSL. */
export interface SceneSpec {
  id: string;
  name: string;
  scene: { elements: readonly ExcalidrawElement[]; files?: BinaryFiles };
}

export type DiagramTab = DiagramSpec | SceneSpec;

export const isScene = (tab: DiagramTab): tab is SceneSpec => "scene" in tab;

/** Curated topics live in this repo; community topics are user-generated. */
export type TopicSource = "curated" | "community";

export interface Topic {
  source: TopicSource;
  slug: string;
  title: string;
  category: string;
  summary: string;
  tags: string[];
  /** Diagram views shown as tabs: architecture first, then request flows and deep dives. */
  diagrams: DiagramTab[];
  /** Markdown source. */
  doc: string;
}
