import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { TOPICS } from "./topics";
import { Sidebar } from "./components/Sidebar";
import { DocView } from "./components/DocView";

// Excalidraw is by far the heaviest dependency; only load it when a diagram is shown.
const DiagramView = lazy(() => import("./components/DiagramView").then((m) => ({ default: m.DiagramView })));

type View = "split" | "doc" | "diagram";
type Theme = "light" | "dark";

const VIEWS: { id: View; label: string }[] = [
  { id: "split", label: "Split" },
  { id: "doc", label: "Document" },
  { id: "diagram", label: "Diagram" },
];

function slugFromHash(): string {
  const slug = window.location.hash.replace(/^#\/?/, "");
  return TOPICS.some((t) => t.slug === slug) ? slug : TOPICS[0].slug;
}

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked — preferences just won't persist.
  }
}

export default function App() {
  const [slug, setSlug] = useState(slugFromHash);
  const [view, setView] = useState<View>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("view");
    const views = VIEWS.map((v) => v.id);
    if (views.includes(fromUrl as View)) return fromUrl as View;
    return readPref<View>("sdd:view", views, window.innerWidth < 900 ? "doc" : "split");
  });
  const [theme, setTheme] = useState<Theme>(() =>
    readPref<Theme>(
      "sdd:theme",
      ["light", "dark"],
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    ),
  );
  const [menuOpen, setMenuOpen] = useState(false);

  const topic = TOPICS.find((t) => t.slug === slug) ?? TOPICS[0];

  useEffect(() => {
    const onHash = () => setSlug(slugFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref("sdd:theme", theme);
  }, [theme]);

  useEffect(() => writePref("sdd:view", view), [view]);

  useEffect(() => {
    document.title = `${topic.title} · System Design Diagrams`;
    document.querySelector(".doc-pane")?.scrollTo({ top: 0 });
  }, [topic]);

  const select = useCallback((next: string) => {
    window.location.hash = `/${next}`;
    setMenuOpen(false);
  }, []);

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
        <div className="topic-heading">
          <h1>{topic.title}</h1>
          <p>{topic.summary}</p>
        </div>
        <div className="segmented" role="tablist" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              className={view === v.id ? "on" : ""}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          aria-label="Toggle dark mode"
          title="Toggle dark mode"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>

      <Sidebar current={topic} onSelect={select} />
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      <main className={`content view-${view}`}>
        {view !== "diagram" && (
          <div className="doc-pane">
            <DocView topic={topic} onShowDiagram={view === "doc" ? () => setView("diagram") : undefined} />
          </div>
        )}
        {view !== "doc" && (
          <div className="diagram-pane">
            <Suspense fallback={<div className="diagram-loading">Loading diagram…</div>}>
              <DiagramView topic={topic} theme={theme} />
            </Suspense>
          </div>
        )}
      </main>
    </div>
  );
}
