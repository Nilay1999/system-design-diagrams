import { useCallback, useEffect, useMemo, useState } from "react";
import { restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { editStore } from "./editStore";

const SAVE_DELAY_MS = 400;

/**
 * The user's local edits on top of a shipped diagram: loads saved edits, saves edits
 * (debounced) and resets. `generation` changes on reset; key the canvas on it to remount.
 */
export function useSceneEdits(key: string, signature: string) {
  // Bumped on reset, only to force a fresh read of the store.
  const [generation, setGeneration] = useState(0);
  const [edited, setEdited] = useState(false);

  const saved = useMemo(() => {
    const elements = editStore.load(key, signature);
    return elements && restoreElements(elements, null);
  }, [key, signature, generation]);

  const onEdit = useDebouncedCallback((elements: readonly ExcalidrawElement[]) => {
    editStore.save(key, signature, elements);
    setEdited(true);
  }, SAVE_DELAY_MS);

  useEffect(() => setEdited(saved !== null), [saved]);

  const reset = useCallback(() => {
    onEdit.cancel();
    editStore.clear(key);
    // Set directly: if nothing was saved when the tab loaded, `saved` stays null and the effect won't rerun.
    setEdited(false);
    setGeneration((g) => g + 1);
  }, [key, onEdit]);

  return { saved, edited, generation, onEdit, reset };
}
