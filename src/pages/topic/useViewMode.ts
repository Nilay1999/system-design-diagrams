import { useCallback } from "react";

import { usePreference } from "../../hooks/usePreference";
import { BREAKPOINTS, viewportWidth } from "../../lib/viewport";

export const VIEW_MODES = ["split", "doc", "diagram"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const VIEW_MODE_TABS: { id: ViewMode; label: string }[] = [
  { id: "split", label: "Split" },
  { id: "doc", label: "Document" },
  { id: "diagram", label: "Diagram" },
];

const isViewMode = (value: string | null): value is ViewMode => VIEW_MODES.includes(value as ViewMode);

/**
 * Document / diagram / split layout. A `?view=` query wins on load (for shared links); otherwise
 * the last choice is remembered, defaulting to the document alone on narrow screens.
 */
export function useViewMode() {
  const [mode, setMode] = usePreference<ViewMode>("view", VIEW_MODES, () => {
    const fromUrl = new URLSearchParams(window.location.search).get("view");
    if (isViewMode(fromUrl)) return fromUrl;
    return viewportWidth() < BREAKPOINTS.narrow ? "doc" : "split";
  });

  /** Make sure a diagram is on screen, keeping the document beside it when there's room. */
  const revealDiagram = useCallback(() => {
    setMode((m) => (m !== "doc" ? m : viewportWidth() > BREAKPOINTS.wide ? "split" : "diagram"));
  }, [setMode]);

  return { mode, setMode, revealDiagram };
}
