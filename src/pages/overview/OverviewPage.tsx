import { useEffect } from "react";
import { Link, Navigate } from "react-router";

import { AppShell } from "../../layout/AppShell";
import { pageTitle } from "../../site";
import { groupByCategory, topicPath, useTopics } from "../../topics";
import { useTrack } from "../../tracks";

/** A track's landing page: what the track is, then every topic as a numbered learning path. */
export function OverviewPage() {
  const track = useTrack();
  const catalog = useTopics();

  useEffect(() => {
    document.title = pageTitle(track.overview?.title ?? track.name);
  }, [track]);

  if (!track.overview) return <Navigate to={topicPath(catalog.first)} replace />;
  const { title, lead, points } = track.overview;
  const order = new Map(catalog.topics.map((t, i) => [t, i + 1]));
  const first = catalog.first;
  const last = catalog.topics[catalog.topics.length - 1];

  return (
    <AppShell
      mainClassName="view-overview"
      heading={
        <div className="topic-heading">
          <h1>Overview</h1>
          <p>
            {catalog.topics.length} topics · {catalog.topics.reduce((n, t) => n + t.diagrams.length, 0)} diagrams
          </p>
        </div>
      }
    >
      <div className="overview">
        <section className="hero">
          <img src={track.logo} alt="" width={56} height={56} />
          <div>
            <h2>{title}</h2>
            <p>{lead}</p>
            <div className="hero-actions">
              <Link className="button primary" to={topicPath(first)}>
                Start with “{first.title}” →
              </Link>
              <Link className="button" to={topicPath(last)}>
                {last.title}
              </Link>
            </div>
          </div>
        </section>

        <section className="points">
          {points.map((p) => (
            <div key={p.title} className="point">
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </div>
          ))}
        </section>

        {groupByCategory(catalog.topics).map(([category, topics]) => (
          <section key={category} className="path-group">
            <h2>{category}</h2>
            <div className="card-grid">
              {topics.map((t) => (
                <Link key={t.slug} to={topicPath(t)} className="topic-card">
                  <span className="topic-number">{String(order.get(t)).padStart(2, "0")}</span>
                  <h3>{t.title}</h3>
                  <p>{t.summary}</p>
                  <div className="card-tags">
                    {t.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <span className="card-meta">{t.diagrams.length} diagrams</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
