import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

/**
 * A stable function that runs `fn` once calls have stopped for `delay` ms. The latest `fn` is
 * always used, a pending call is dropped on unmount, and `cancel` drops it on demand.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay: number) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  const timer = useRef<number | undefined>(undefined);

  const cancel = useCallback(() => window.clearTimeout(timer.current), []);
  useEffect(() => cancel, [cancel]);

  return useMemo(() => {
    const debounced = (...args: A) => {
      cancel();
      timer.current = window.setTimeout(() => latest.current(...args), delay);
    };
    return Object.assign(debounced, { cancel });
  }, [cancel, delay]);
}
