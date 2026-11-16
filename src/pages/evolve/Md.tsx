import type { ReactNode } from "react";
import Markdown from "react-markdown";

/** A block of Markdown text (paragraphs, lists, bold, `code`). */
export function Md({ children }: { children: string }) {
  return (
    <div className="markdown build-text">
      <Markdown>{children}</Markdown>
    </div>
  );
}

const Inline = ({ children }: { children?: ReactNode }) => <>{children}</>;

/** One line of Markdown with no wrapping paragraph, safe inside a button or a heading. */
export function InlineMd({ children }: { children: string }) {
  return (
    <span className="markdown">
      <Markdown components={{ p: Inline }}>{children}</Markdown>
    </span>
  );
}
