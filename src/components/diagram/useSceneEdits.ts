import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hashElementsVersion, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { editStore } from "./editStore";

const SAVE_DELAY_MS = 400;

/**
 * Tracks the user's edits to one diagram: loads saved edits, saves changes (debounced) and resets.
 * Feed every canvas change to `onChange`; call `ignoreNextChange` before replacing the scene from code.
 */
export function useSceneEdits(key: string, signature: string) {
  // Bumped on reset, only to force a fresh read of the store.
  const [generation, setGeneration] = useState(0);
  const [edited, setEdited] = useState(false);
  // Version of the scene last seen; null means the next change is a load, not a user edit.
  const baseline = useRef<number | null>(null);

  const saved = useMemo(() => {
    const elements = editStore.load(key, signature);
    return elements && restoreElements(elements, null);
  }, [key, signature, generation]);

  useEffect(() => {
    setEdited(saved !== null);
    baseline.current = null;
  }, [saved]);

  const save = useDebouncedCallback((elements: readonly ExcalidrawElement[]) => {
    editStore.save(key, signature, elements);
    setEdited(true);
  }, SAVE_DELAY_MS);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      const version = hashElementsVersion(elements);
      if (baseline.current === null) baseline.current = version;
      else if (version !== baseline.current) {
        baseline.current = version;
        save(elements);
      }
    },
    [save],
  );

  const ignoreNextChange = useCallback(() => {
    baseline.current = null;
  }, []);

  const reset = useCallback(() => {
    save.cancel();
    editStore.clear(key);
    setGeneration((g) => g + 1);
  }, [key, save]);

  return { saved, edited, generation, onChange, ignoreNextChange, reset };
}
