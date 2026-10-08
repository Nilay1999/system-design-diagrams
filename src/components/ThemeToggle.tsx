import { useTheme } from "../theme/context";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle dark mode" title="Toggle dark mode">
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
