import { useCallback, useLayoutEffect, useMemo, type ReactNode } from "react";

import { usePreference } from "../hooks/usePreference";
import { PALETTES, THEMES, ThemeContext, type Theme } from "./context";

const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/**
 * Remembers the chosen light/dark mode (defaulting to the OS setting) and colour palette, and applies
 * them to `<html data-theme data-palette>` before the page paints.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePreference("theme", THEMES, systemTheme);
  const [palette, setPalette] = usePreference("palette", PALETTES, () => PALETTES[0]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
  }, [theme, palette]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), [setTheme]);
  const value = useMemo(() => ({ theme, toggleTheme, palette, setPalette }), [theme, toggleTheme, palette, setPalette]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
