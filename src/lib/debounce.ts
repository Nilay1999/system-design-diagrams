export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Run the pending call now, if there is one. */
  flush(): void;
  /** Drop the pending call. */
  cancel(): void;
}

/**
 * Runs `fn` once calls have stopped for `delay` ms. `resolve` is read at call time, so a pending
 * call always runs the function that was current when it was made (e.g. still saving to the tab
 * it was made on, even if the user has switched tabs since).
 */
export function debounce<A extends unknown[]>(resolve: () => (...args: A) => void, delay: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | undefined;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const flush = () => {
    const run = pending;
    cancel();
    run?.();
  };
  const debounced = (...args: A) => {
    const fn = resolve();
    cancel();
    pending = () => fn(...args);
    timer = setTimeout(flush, delay);
  };
  return Object.assign(debounced, { flush, cancel });
}
