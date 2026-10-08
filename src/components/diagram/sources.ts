import { convertToExcalidrawElements, hashString, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { DIAGRAM_FONT, MONO_FONT, type DiagramSpec } from "../../diagrams/dsl";
import { iconFilesFor } from "../../diagrams/icon-files";
import { isScene, type DiagramTab, type SceneSpec } from "../../topics";

/**
 * What the canvas needs from a diagram tab, whatever produced it. One implementation per
 * kind of tab, so the canvas never branches on where a diagram came from.
 */
export interface DiagramSource {
  /** Changes whenever the shipped diagram changes; edits saved against another signature are dropped. */
  readonly signature: string;
  /** Whether the node-kind legend describes this diagram. */
  readonly hasLegend: boolean;
  /** The diagram as shipped. Called again once fonts load, so text is measured with the real font. */
  elements(): readonly ExcalidrawElement[];
  /** Image data the elements refer to. */
  files(elements: readonly ExcalidrawElement[]): BinaryFiles;
}

const signatureOf = (value: unknown) => String(hashString(JSON.stringify(value)));

/** A tab built with the diagram DSL. Icons are image elements whose SVGs derive from their file ids. */
function dslSource(spec: DiagramSpec): DiagramSource {
  const skeleton = spec.build();
  return {
    signature: signatureOf(skeleton),
    hasLegend: true,
    elements: () => convertToExcalidrawElements(skeleton),
    files: iconFilesFor,
  };
}

/** A tab drawn directly in Excalidraw and stored as a raw scene. */
function sceneSource({ scene }: SceneSpec): DiagramSource {
  return {
    signature: signatureOf(scene.elements),
    hasLegend: false,
    elements: () => restoreElements(scene.elements, null),
    files: (elements) => ({ ...iconFilesFor(elements), ...scene.files }),
  };
}

export const createDiagramSource = (tab: DiagramTab): DiagramSource => (isScene(tab) ? sceneSource(tab) : dslSource(tab));

/** Resolves once the diagram fonts are usable (or failed to load; text then uses a fallback). */
export async function diagramFontsReady(): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`16px ${DIAGRAM_FONT.name}`), document.fonts.load(`13px ${MONO_FONT.name}`)]);
    await document.fonts.ready;
  } catch {
    // Measure with whatever font is available.
  }
}
