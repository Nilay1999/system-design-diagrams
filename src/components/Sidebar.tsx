import { useMemo, useState } from "react";

import { CATEGORIES, TOPICS, type Topic } from "../topics";

interface Props {
  current: Topic;
  onSelect: (slug: string) => void;
}

export function Sidebar({ current, onSelect }: Props) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter((t) =>
      [t.title, t.summary, t.category, ...t.tags].some((field) => field.toLowerCase().includes(q)),
    );
  }, [query]);

  return (
    <aside className="sidebar">
      <input
        className="search"
        type="search"
        placeholder="Search topics, e.g. cache"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search topics"
      />
      {CATEGORIES.map((category) => {
        const items = matches.filter((t) => t.category === category);
        if (items.length === 0) return null;
        return (
          <section key={category}>
            <h4>{category}</h4>
            <ul>
              {items.map((t) => (
                <li key={t.slug}>
                  <button
                    className={`topic ${t.slug === current.slug ? "active" : ""}`}
                    onClick={() => onSelect(t.slug)}
                    title={t.summary}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {matches.length === 0 && <p className="empty">No topics match "{query}".</p>}
    </aside>
  );
}
