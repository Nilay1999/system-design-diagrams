import { useMemo, type ReactNode } from "react";
import type { Components } from "react-markdown";

import { DIFFICULTY_LABELS, type Topic } from "../topics";
import { outline } from "../lib/text";
import { MarkdownContent } from "./MarkdownContent";

/** Links of the form `#diagram/<view-id>` open that diagram tab instead of navigating. */
const DIAGRAM_LINK = /^#diagram\/([\w-]+)$/;

interface Props {
  topic: Topic;
  /** Id of the diagram tab currently on screen, or undefined when the diagram pane is hidden. */
  activeDiagram?: string;
  onOpenDiagram: (id?: string) => void;
  /** Controls shown beside the tags, e.g. edit and export for My Topics. */
  actions?: ReactNode;
}

export function DocView({ topic, activeDiagram, onOpenDiagram, actions }: Props) {
  const components: Components = useMemo(
    () => ({
      a: ({ href, children }) => {
        const view = href?.match(DIAGRAM_LINK)?.[1];
        if (view) {
          return (
            <a
              href={href}
              className="diagram-ref"
              onClick={(e) => {
                e.preventDefault();
                onOpenDiagram(view);
              }}
            >
              {children}
            </a>
          );
        }
        return (
          <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [onOpenDiagram],
  );

  const toc = useMemo(() => outline(topic.doc).filter((h) => h.depth === 2), [topic.doc]);

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <article className="doc">
      <div className="doc-tags">
        <span className="category">{topic.category}</span>
        {topic.difficulty && (
          <span className={`tag difficulty difficulty-${topic.difficulty}`}>{DIFFICULTY_LABELS[topic.difficulty]}</span>
        )}
        {topic.tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
        {actions && <div className="doc-actions">{actions}</div>}
      </div>
      {toc.length > 0 && (
        <nav className="toc" aria-label="On this page">
          <strong>On this page</strong>
          <ol>
            {toc.map((h) => (
              <li key={h.id}>
                <button className="link" onClick={() => scrollTo(h.id)}>
                  {h.title}
                </button>
              </li>
            ))}
          </ol>
          <div className="toc-diagrams">
            <strong>Diagrams</strong>
            {topic.diagrams.map((d) => (
              <button
                key={d.id}
                className={`link ${d.id === activeDiagram ? "current" : ""}`}
                onClick={() => onOpenDiagram(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        </nav>
      )}
      <MarkdownContent components={components}>{topic.doc}</MarkdownContent>
    </article>
  );
}
