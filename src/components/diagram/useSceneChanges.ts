import { useCallback, useLayoutEffect, useRef } from "react";
import { hashElementsVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * Excalidraw calls `onChange` for scrolls, selection and loads, not only edits. This passes on
 * only real edits: the first change after mount (or after `ignoreNextChange`) is the scene being
 * loaded, and later ones count only if the elements' version actually moved.
 */
export function useSceneChanges<A extends unknown[]>(onEdit: (elements: readonly ExcalidrawElement[], ...rest: A) => void) {
  const baseline = useRef<number | null>(null);
  const latest = useRef(onEdit);
  useLayoutEffect(() => {
    latest.current = onEdit;
  });

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], ...rest: A) => {
      const version = hashElementsVersion(elements);
      if (baseline.current === null) baseline.current = version;
      else if (version !== baseline.current) {
        baseline.current = version;
        latest.current(elements, ...rest);
      }
    },
    [],
  );

  const ignoreNextChange = useCallback(() => {
    baseline.current = null;
  }, []);

  return { onChange, ignoreNextChange };
}
