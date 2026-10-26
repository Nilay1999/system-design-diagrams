import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";

import { SITE } from "../site";
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
  /** Extra inline style on `<main>`, e.g. CSS variables. */
  mainStyle?: CSSProperties;
  children: ReactNode;
}

/** Top bar, topic sidebar (a drawer on small screens) and main area, shared by every page. */
export function AppShell({ heading, actions, current, mainClassName = "", mainStyle, children }: Props) {
  const track = useTrack();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, closeMenu]);

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <header className="topbar">
        <button
          className="menu-toggle"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Toggle topic list"
          aria-expanded={menuOpen}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
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
        <ThemeToggle />
      </header>

      <Sidebar current={current} onNavigate={closeMenu} />
      {menuOpen && <div className="scrim" onClick={closeMenu} />}

      <main className={`content ${mainClassName}`} style={mainStyle}>{children}</main>
    </div>
  );
}
