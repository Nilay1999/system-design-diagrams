import { useCallback, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { SITE } from "../site";
import { PalettePicker } from "../components/PalettePicker";
import { Sidebar } from "../components/Sidebar";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Topic } from "../topics";
import { useTrack } from "../tracks";

interface Props {
  /** Page title area in the top bar. */
  heading: ReactNode;
  /** Page-specific controls, placed before the theme toggle. */
  actions?: ReactNode;
  /** Topic highlighted in the sidebar, if any. */
  current?: Topic;
  /** Extra class on `<main>`. */
  mainClassName?: string;
  children: ReactNode;
}

/** Top bar, topic sidebar (a drawer on small screens) and main area, shared by every page. */
export function AppShell({ heading, actions, current, mainClassName = "", children }: Props) {
  const track = useTrack();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <header className="topbar">
        <button className="menu-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle topic list">
          ☰
        </button>
        <Link className="brand" to={track.home} title={`${SITE.name}: ${SITE.tagline}`}>
          <img src={SITE.logo} alt="" width={30} height={30} />
          <span className="brand-text">
            <span className="brand-name">{SITE.name}</span>
            <span className="brand-section">{track.name}</span>
          </span>
        </Link>
        {heading}
        {actions}
        <PalettePicker />
        <ThemeToggle />
      </header>

      <Sidebar current={current} onNavigate={closeMenu} />
      {menuOpen && <div className="scrim" onClick={closeMenu} />}

      <main className={`content ${mainClassName}`}>{children}</main>
    </div>
  );
}
