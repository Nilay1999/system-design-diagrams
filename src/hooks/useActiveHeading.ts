import { useEffect, useState, type RefObject } from "react";

/** How far below the top of the scrolling pane a heading counts as "reached". */
const OFFSET = 80;

/**
 * The id of the heading the reader has most recently scrolled past, inside the scrolling element
 * that contains `ref`. At the very bottom it is the last heading, even when that section is short.
 */
export function useActiveHeading(ids: readonly string[], ref: RefObject<HTMLElement | null>): string | undefined {
  const [active, setActive] = useState<string>();

  useEffect(() => {
    const pane = ref.current?.closest<HTMLElement>(".doc-pane");
    if (!pane) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
      if (atBottom && pane.scrollTop > 0) return setActive(ids[ids.length - 1]);
      const line = pane.getBoundingClientRect().top + OFFSET;
      let current: string | undefined;
      for (const id of ids) {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [ids, ref]);

  return active;
}
