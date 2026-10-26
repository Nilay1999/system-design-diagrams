import { useCallback, useLayoutEffect, useMemo, type ReactNode } from "react";

import { usePreference } from "../hooks/usePreference";
import { THEMES, ThemeContext, type Theme } from "./context";

const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/**
 * Remembers the chosen light/dark mode (defaulting to the OS setting) and applies it to
 * `<html data-theme>` before the page paints.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePreference("theme", THEMES, systemTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), [setTheme]);
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
