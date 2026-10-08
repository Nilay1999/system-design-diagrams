import { useCallback, useState, type ReactNode } from "react";

import { Sidebar } from "../components/Sidebar";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Topic } from "../topics";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <div className={`app ${menuOpen ? "menu-open" : ""}`}>
      <header className="topbar">
        <button className="menu-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle topic list">
          ☰
        </button>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>System Design Diagrams</span>
        </div>
        {heading}
        {actions}
        <ThemeToggle />
      </header>

      <Sidebar current={current} onNavigate={closeMenu} />
      {menuOpen && <div className="scrim" onClick={closeMenu} />}

      <main className={`content ${mainClassName}`}>{children}</main>
    </div>
  );
}
