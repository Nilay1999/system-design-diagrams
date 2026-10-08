import { useCallback, useEffect, useMemo, type ReactNode } from "react";

import { usePreference } from "../hooks/usePreference";
import { THEMES, ThemeContext, type Theme } from "./context";

const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Remembers the chosen theme (defaulting to the OS setting) and applies it to `<html data-theme>`. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePreference("theme", THEMES, systemTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), [setTheme]);
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
