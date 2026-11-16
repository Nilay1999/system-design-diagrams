import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../App";
import { memoryStorage } from "../../test/memoryStorage";
import { ThemeContext } from "../../theme/context";

/** Server-render the app at `path`, with `saved` as the reader's stored progress. The canvas stays a placeholder. */
function render(path: string, saved?: unknown) {
  const localStorage = memoryStorage();
  if (saved) localStorage.setItem("sdd:evolve:system-design:url-shortener", JSON.stringify(saved));
  vi.stubGlobal("window", { localStorage, innerWidth: 1400, location: { search: "" } });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {} }}>
        <App />
      </ThemeContext.Provider>
    </MemoryRouter>,
  );
}

describe("BuildPage", () => {
  // React warns that layout effects do nothing on the server; that is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.unstubAllGlobals());

  it("opens on the starting design", () => {
    const html = render("/topics/url-shortener/build");
    expect(html).toContain("Start with the simplest thing that works");
    expect(html).toContain("Bring on the first problem");
    expect(html).toContain("Loading diagram");
  });

  it("asks for a decision and holds back the answer until one is made", () => {
    const html = render("/topics/url-shortener/build", { step: 1, picks: {} });
    expect(html).toContain("What do you change first?");
    expect(html).toContain("Move to a bigger machine");
    expect(html).not.toContain("Best fit");
    expect(html).not.toContain("Next problem");
  });

  it("explains the reader's pick and the design's own choice once decided", () => {
    const html = render("/topics/url-shortener/build", { step: 1, picks: { "scale-out": "bigger-machine" } });
    expect(html).toContain("Your pick");
    expect(html).toContain("Falls short");
    expect(html).toContain("It treats the load problem"); // feedback on the pick
    expect(html).toContain("This fixes both problems at once"); // feedback on the best choice
    expect(html).not.toContain("A cache will help soon"); // the third stays closed until clicked
    expect(html).toContain("What the design does now");
    expect(html).toContain("Next problem");
  });

  it("ends on a summary with the score", () => {
    const picks = {
      "scale-out": "load-balancer",
      cache: "cache",
      "split-paths": "more-servers",
      storage: "key-value",
      codes: "leased-ranges",
      analytics: "event-stream",
    };
    const html = render("/topics/url-shortener/build", { step: 7, picks });
    expect(html).toContain("You built it");
    expect(html).toMatch(/<strong>5<\/strong> of <strong>6<\/strong>/);
    expect(html).toContain("You picked");
  });

  it("links to the build from the topic page", () => {
    expect(render("/topics/url-shortener")).toContain('href="/topics/url-shortener/build"');
    expect(render("/topics/rate-limiter")).not.toContain("/build");
  });
});
