import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CURATED_TOPICS } from "../topics/curated";
import { outline } from "../lib/text";
import { MarkdownContent } from "./MarkdownContent";

const renderedIds = (markdown: string) =>
  [...renderToStaticMarkup(<MarkdownContent>{markdown}</MarkdownContent>).matchAll(/<h[23] id="([^"]+)"/g)].map((m) => m[1]);

describe("MarkdownContent", () => {
  it("gives repeated headings distinct ids", () => {
    expect(renderedIds("## API\n\ntext\n\n## API\n\n### API")).toEqual(["api", "api-1", "api-2"]);
  });

  it("never renders raw HTML or javascript: links", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent>{'<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))'}</MarkdownContent>,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });

  // The page index links to ids computed from the source; they must match what's rendered.
  it.each(CURATED_TOPICS.map((t) => [t.slug, t.doc] as const))("%s: index ids match rendered heading ids", (_, doc) => {
    expect(renderedIds(doc)).toEqual(outline(doc).map((h) => h.id));
  });
});
