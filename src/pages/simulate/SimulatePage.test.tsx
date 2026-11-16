import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../App";
import { memoryStorage } from "../../test/memoryStorage";
import { ThemeContext } from "../../theme/context";

function render(path: string) {
  vi.stubGlobal("window", { localStorage: memoryStorage(), innerWidth: 1400, location: { search: "" } });
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {} }}>
        <App />
      </ThemeContext.Provider>
    </MemoryRouter>,
  );
}

describe("SimulatePage", () => {
  // React warns that layout effects do nothing on the server; that is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => vi.unstubAllGlobals());

  it("shows the running system with its controls, readings and explanation", () => {
    const html = render("/topics/url-shortener/simulate");
    expect(html).toContain("Live simulator");
    expect(html).toContain("A link goes viral"); // an experiment
    expect(html).toContain('type="range"'); // sliders
    expect(html).toContain("Stop Redis cache"); // a failure switch
    expect(html).toContain("Redirects that work"); // a reading
    expect(html).toContain("Everything is healthy"); // the explanation
    expect(html).toContain("<svg"); // the diagram, with no heavy canvas to load
    expect(html).toContain("Redirect servers");
  });

  it("is linked from the topic page, only for topics that have one", () => {
    expect(render("/topics/url-shortener")).toContain('href="/topics/url-shortener/simulate"');
    expect(render("/topics/rate-limiter")).not.toContain("/simulate");
  });

  it("sends topics without a simulator to their normal page", () => {
    expect(render("/topics/rate-limiter/simulate")).not.toContain("Break something");
  });
});
