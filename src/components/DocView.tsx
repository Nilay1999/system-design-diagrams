import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Topic } from "../topics";
import { slugify, textOf } from "../lib/text";

/** Links of the form `#diagram/<view-id>` open that diagram tab instead of navigating. */
const DIAGRAM_LINK = /^#diagram\/([\w-]+)$/;

interface Props {
  topic: Topic;
  /** Id of the diagram tab currently on screen, or undefined when the diagram pane is hidden. */
  activeDiagram?: string;
  onOpenDiagram: (id?: string) => void;
}

export function DocView({ topic, activeDiagram, onOpenDiagram }: Props) {
  const components: Components = useMemo(
    () => ({
      h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
      h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
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

  const toc = useMemo(
    () =>
      [...topic.doc.matchAll(/^## (.+)$/gm)].map((m) => {
        const title = m[1].replace(/[`*_]/g, "").trim();
        return { title, id: slugify(title) };
      }),
    [topic.doc],
  );

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <article className="doc">
      <div className="doc-tags">
        <span className="category">{topic.category}</span>
        {topic.tags.map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
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
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {topic.doc}
        </Markdown>
      </div>
    </article>
  );
}
