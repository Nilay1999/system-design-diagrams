import { describe, expect, it } from "vitest";

import { TRACKS } from "../tracks";
import { headTags, sharePages, SITE } from "./pages";

describe("sharePages", () => {
  const pages = sharePages(TRACKS);

  it("has one page per path", () => {
    const paths = pages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("covers the home page, the Kubernetes overview, topics and diagram tabs", () => {
    const paths = new Set(pages.map((p) => p.path));
    expect(paths.has("/")).toBe(true);
    expect(paths.has("/kubernetes")).toBe(true);
    expect(paths.has("/kubernetes/pods")).toBe(true);
    expect(paths.has("/kubernetes/pods/patterns")).toBe(true);
    expect(paths.has("/topics/rate-limiter")).toBe(true);
    expect(paths.has("/topics/rate-limiter/check-flow")).toBe(true);
  });

  it("names pages after the topic and its section", () => {
    const pods = pages.find((p) => p.path === "/kubernetes/pods")!;
    expect(pods.title).toBe("Pods & Multi-Container Patterns · Kubernetes · Yggdrasil");
    expect(pods.image).toBe("/og/kubernetes/pods.png");
    expect(pages.find((p) => p.path === "/topics/rate-limiter")!.title).toBe("Distributed Rate Limiter · System Design · Yggdrasil");
    expect(pages[0].title).toContain(SITE.name);
  });
});

describe("headTags", () => {
  it("uses absolute URLs and escapes text", () => {
    const html = headTags({ path: "/x", title: 'A & "B"', description: "<d>", image: "/og/x.png", fallbackImage: "/og/site.png" }, "https://example.com");
    expect(html).toContain('<meta property="og:url" content="https://example.com/x" />');
    expect(html).toContain('<meta property="og:image" content="https://example.com/og/x.png" />');
    expect(html).toContain("<title>A &amp; &quot;B&quot;</title>");
    expect(html).toContain('content="&lt;d&gt;"');
  });
});
