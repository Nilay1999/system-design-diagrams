import { PALETTES, PALETTE_LABELS, useTheme, type Palette } from "../theme/context";

/** Chooses the colour palette; light/dark is the separate ThemeToggle. */
export function PalettePicker() {
  const { palette, setPalette } = useTheme();
  return (
    <select
      className="palette-select"
      value={palette}
      onChange={(e) => setPalette(e.target.value as Palette)}
      aria-label="Colour theme"
      title="Colour theme"
    >
      {PALETTES.map((p) => (
        <option key={p} value={p}>
          {PALETTE_LABELS[p]}
        </option>
      ))}
    </select>
  );
}
