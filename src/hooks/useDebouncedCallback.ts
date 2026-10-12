import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { debounce, type Debounced } from "../lib/debounce";

/**
 * A stable debounced `fn`. Each call uses the `fn` from the render it was made in, and a call
 * still pending on unmount is flushed rather than lost.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay: number): Debounced<A> {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  const debounced = useMemo(() => debounce<A>(() => latest.current, delay), [delay]);
  useEffect(() => debounced.flush, [debounced]);
  return debounced;
}
