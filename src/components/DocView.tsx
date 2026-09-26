import { isValidElement, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Topic } from "../topics";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const components: Components = {
  h2: ({ children }) => <h2 id={slugify(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={slugify(textOf(children))}>{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer">
      {children}
    </a>
  ),
};

interface Props {
  topic: Topic;
  onShowDiagram?: () => void;
}

export function DocView({ topic, onShowDiagram }: Props) {
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
          {onShowDiagram && (
            <button className="link diagram-link" onClick={onShowDiagram}>
              Open the architecture diagram →
            </button>
          )}
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
