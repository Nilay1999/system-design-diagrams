import { useMemo, useState } from "react";
import { Link } from "react-router";

import { NEW_TOPIC_PATH, SOURCES, groupByCategory, sameTopic, topicPath, useTopics, type Topic } from "../topics";
import { ImportTopicButton } from "./myTopics/ImportTopicButton";

interface Props {
  current?: Topic;
  /** Called after a topic link is followed, e.g. to close the mobile menu. */
  onNavigate: () => void;
}

export function Sidebar({ current, onNavigate }: Props) {
  const catalog = useTopics();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => catalog.search(query), [catalog, query]);

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
      {SOURCES.map(({ source, label, emptyText }) => {
        const topics = matches.filter((t) => t.source === source);
        const status = catalog.status[source];
        // While searching, hide sections with no hits; otherwise show a section if it can explain being empty.
        if (topics.length === 0 && (query || !emptyText)) return null;
        return (
          <section key={source} className="source-section">
            <div className="source-heading">
              <h3>{label}</h3>
              {source === "local" && (
                <div className="source-actions">
                  <Link className="button small primary" to={NEW_TOPIC_PATH} onClick={onNavigate}>
                    + New
                  </Link>
                  <ImportTopicButton className="button small" onImported={onNavigate} />
                </div>
              )}
            </div>
            {status?.state === "pending" && <p className="empty">Loading…</p>}
            {status?.state === "error" && (
              <p className="empty" role="alert">
                {status.message}
              </p>
            )}
            {topics.length === 0 && !status && <p className="empty">{emptyText}</p>}
            {groupByCategory(topics).map(([category, items]) => (
              <section key={category}>
                <h4>{category}</h4>
                <ul>
                  {items.map((t) => (
                    <li key={t.slug}>
                      <TopicLink topic={t} active={sameTopic(t, current)} onClick={onNavigate} />
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
