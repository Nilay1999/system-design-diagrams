import { useEffect } from "react";

/** Ask the browser to confirm leaving the page (reload, close, external link) while `when` is true. */
export function useBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);
}
