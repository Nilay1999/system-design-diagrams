import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import { memoryStorage } from "../../test/memoryStorage";
import { topic } from "../../test/fixtures";
import { editKey, editStore, exportName } from "./editStore";

const el = (id: string, isDeleted = false) => ({ id, isDeleted }) as ExcalidrawElement;

describe("editKey / exportName", () => {
  const curated = topic();
  const community = topic({ source: "community" });
  const [first, second] = curated.diagrams;

  it("keeps the pre-tabs key for a curated topic's first tab", () => {
    expect(editKey(curated, first)).toBe("url-shortener");
    expect(editKey(curated, second)).toBe("url-shortener:redirect-flow");
  });

  it("prefixes other sources so slugs can't collide", () => {
    expect(editKey(community, community.diagrams[0])).toBe("community:url-shortener");
  });

  it("names exports after the topic and tab", () => {
    expect(exportName(curated, first)).toBe("url-shortener");
    expect(exportName(curated, second)).toBe("url-shortener-redirect-flow");
  });
});

describe("editStore", () => {
  let backend: Storage;
  beforeEach(() => {
    backend = memoryStorage();
    vi.stubGlobal("window", { localStorage: backend });
  });

  it("saves under the legacy key, without deleted elements", () => {
    editStore.save("url-shortener", "sig", [el("a"), el("b", true)]);
    expect(JSON.parse(backend.getItem("sdd:diagram:url-shortener")!)).toEqual({ signature: "sig", elements: [el("a")] });
  });

  it("drops edits made on another version of the diagram", () => {
    editStore.save("k", "v1", [el("a")]);
    expect(editStore.load("k", "v1")).toEqual([el("a")]);
    expect(editStore.load("k", "v2")).toBeNull();
  });

  it("ignores malformed saves and clears", () => {
    backend.setItem("sdd:diagram:k", JSON.stringify({ signature: "v1" }));
    expect(editStore.load("k", "v1")).toBeNull();
    editStore.save("k", "v1", []);
    editStore.clear("k");
    expect(backend.getItem("sdd:diagram:k")).toBeNull();
  });
});
