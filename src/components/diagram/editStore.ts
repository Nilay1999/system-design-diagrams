import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { createStore } from "../../lib/storage";
import type { DiagramTab, Topic } from "../../topics";

/** Persisted shape. Unchanged from before this module existed, so old edits keep loading. */
interface SavedEdit {
  /** Signature of the diagram source the edit was made on. */
  signature: string;
  elements: ExcalidrawElement[];
}

const store = createStore("sdd:diagram");

/** The user's local edits to diagrams, keyed by `editKey`. */
export const editStore = {
  /** Raw saved elements, or null if there are none or they were made on a different version of the diagram. */
  load(key: string, signature: string): ExcalidrawElement[] | null {
    const saved = store.getJSON<SavedEdit>(key);
    return saved?.signature === signature && Array.isArray(saved.elements) ? saved.elements : null;
  },
  save(key: string, signature: string, elements: readonly ExcalidrawElement[]) {
    store.setJSON(key, { signature, elements: elements.filter((e) => !e.isDeleted) } satisfies SavedEdit);
  },
  clear(key: string) {
    store.remove(key);
  },
};

/**
 * Storage key for edits to one tab. The first tab of a curated topic is keyed by slug alone, as it was
 * before topics had several tabs; other sources are prefixed so their slugs can't collide with curated ones.
 */
export function editKey(topic: Topic, tab: DiagramTab): string {
  const prefix = topic.source === "curated" ? topic.slug : `${topic.source}:${topic.slug}`;
  return tab === topic.diagrams[0] ? prefix : `${prefix}:${tab.id}`;
}

/** Base file name for exports of one tab. */
export const exportName = (topic: Topic, tab: DiagramTab) =>
  tab === topic.diagrams[0] ? topic.slug : `${topic.slug}-${tab.id}`;
