import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkHeadingIds } from "../lib/remarkHeadingIds";

const PLUGINS = [remarkGfm, remarkHeadingIds];

/**
 * Markdown as the app renders it everywhere (GitHub-flavoured, `##`/`###` headings get ids from
 * `outline()`). Raw HTML is never rendered and
 * unsafe link protocols are stripped (react-markdown defaults), so it is safe for user content.
 */
export function MarkdownContent({ children, components }: { children: string; components?: Components }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={PLUGINS} components={components}>
        {children}
      </Markdown>
    </div>
  );
}
