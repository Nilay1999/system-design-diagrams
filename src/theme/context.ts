import { createContext, useContext } from "react";

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Colour palettes, each with a light and a dark mode. Applied as `<html data-palette>`, see styles.css. */
export const PALETTES = ["forest", "parchment", "nordic", "classic"] as const;
export type Palette = (typeof PALETTES)[number];

export const PALETTE_LABELS: Record<Palette, string> = {
  forest: "Forest",
  parchment: "Parchment",
  nordic: "Nordic",
  classic: "Classic",
};

export interface ThemeValue {
  theme: Theme;
  toggleTheme: () => void;
  palette: Palette;
  setPalette: (palette: Palette) => void;
}

export const ThemeContext = createContext<ThemeValue | null>(null);

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
