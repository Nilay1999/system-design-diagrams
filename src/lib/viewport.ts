/** Layout breakpoints used from script. Keep in step with the media queries in styles.css. */
export const BREAKPOINTS = {
  /** Below this, a split view is too cramped to be the default. */
  narrow: 900,
  /** Above this, opening a diagram from the document can keep both panes. */
  wide: 1100,
} as const;

export const viewportWidth = () => window.innerWidth;
