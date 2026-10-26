import { useMemo, useState } from "react";
import { Link, NavLink } from "react-router";

import { groupByCategory, topicPath, useTopics, type Topic } from "../topics";
import { SITE } from "../site";
import { TRACKS, useTrack } from "../tracks";

interface Props {
  current?: Topic;
  /** Called after a topic link is followed, e.g. to close the mobile menu. */
  onNavigate: () => void;
}

export function Sidebar({ current, onNavigate }: Props) {
  const track = useTrack();
  const catalog = useTopics();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => catalog.search(query), [catalog, query]);

  return (
    <aside className="sidebar">
      <p className="site-name">{SITE.name}</p>
      <nav className="track-switch" aria-label="Library">
        {TRACKS.map((t) => (
          <Link
            key={t.id}
            to={t.home}
            className={t === track ? "on" : ""}
            aria-current={t === track ? "true" : undefined}
            onClick={onNavigate}
          >
            <img src={t.logo} alt="" width={14} height={14} />
            <span>{t.name}</span>
          </Link>
        ))}
      </nav>
      <input
        className="search"
        type="search"
        placeholder={track.searchPlaceholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search topics"
      />
      {track.overview && !query && (
        <NavLink
          to={track.home}
          end
          className={({ isActive }) => `topic overview-link ${isActive ? "active" : ""}`}
          onClick={onNavigate}
        >
          Overview & learning path
        </NavLink>
      )}
      {track.sources.map(({ source, label, emptyText }) => {
        const topics = matches.filter((t) => t.source === source);
        // While searching, hide sections with no hits; otherwise show a section if it can explain being empty.
        if (topics.length === 0 && (query || !emptyText)) return null;
        return (
          <section key={source} className="source-section">
            <h3>{label}</h3>
            {topics.length === 0 && <p className="empty">{emptyText}</p>}
            {groupByCategory(topics).map(([category, items]) => (
              <section key={category}>
                <h4>{category}</h4>
                <ul>
                  {items.map((t) => (
                    <li key={t.slug}>
                      <TopicLink topic={t} active={t === current} onClick={onNavigate} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </section>
        );
      })}
      {matches.length === 0 && <p className="empty">No topics match "{query}".</p>}
    </aside>
  );
}

function TopicLink({ topic, active, onClick }: { topic: Topic; active: boolean; onClick: () => void }) {
  return (
    <Link
      to={topicPath(topic)}
      className={`topic ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      title={topic.summary}
    >
      {topic.title}
    </Link>
  );
}
