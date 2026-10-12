import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  DEFAULT_CATEGORY,
  LIMITS,
  emptyDraft,
  nextTabName,
  normalizeDraft,
  parseTags,
  pruneScene,
  toTopic,
  validateDraft,
  type LocalTopic,
} from "./model";

const draft = (over = {}) => normalizeDraft({ ...emptyDraft(), title: "Design Twitter", ...over });

describe("normalizeDraft", () => {
  it("trims text and de-duplicates tags", () => {
    const d = normalizeDraft({ ...emptyDraft(), title: "  T  ", tags: [" a", "b ", "a", " "], statement: "x\n\n" });
    expect(d).toMatchObject({ title: "T", tags: ["a", "b"], statement: "x\n" });
  });
});

describe("validateDraft", () => {
  it("accepts a titled draft", () => {
    expect(validateDraft(draft())).toEqual({});
  });

  it("requires a title", () => {
    expect(validateDraft(draft({ title: "  " })).title).toMatch(/title/);
  });

  it("enforces limits", () => {
    const errors = validateDraft(
      draft({
        title: "x".repeat(LIMITS.title + 1),
        tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`),
        statement: "x".repeat(LIMITS.statement + 1),
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(["statement", "tags", "title"]);
  });
});

describe("parseTags", () => {
  it("splits on commas and drops blanks", () => {
    expect(parseTags(" caching, , sharding ,")).toEqual(["caching", "sharding"]);
  });
});

describe("nextTabName", () => {
  it("picks the next unused number", () => {
    expect(nextTabName([{ id: "a", name: "Diagram" }])).toBe("Diagram 2");
    expect(nextTabName([{ id: "a", name: "Diagram 2" }, { id: "b", name: "x" }])).toBe("Diagram 3");
  });
});

describe("pruneScene", () => {
  it("drops deleted elements and files no image uses", () => {
    const elements = [
      { id: "r", type: "rectangle", isDeleted: false },
      { id: "i", type: "image", fileId: "used", isDeleted: false },
      { id: "j", type: "image", fileId: "gone", isDeleted: true },
    ] as unknown as ExcalidrawElement[];
    const files = { used: { id: "used" }, gone: { id: "gone" }, stray: { id: "stray" } } as unknown as BinaryFiles;
    const scene = pruneScene(elements, files);
    expect(scene.elements.map((e) => e.id)).toEqual(["r", "i"]);
    expect(Object.keys(scene.files)).toEqual(["used"]);
  });
});

describe("toTopic", () => {
  it("presents a local topic as a Topic with stored tabs", () => {
    const local: LocalTopic = {
      ...draft({ category: "" }),
      id: "abc",
      tabs: [{ id: "tab-1", name: "Diagram" }],
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    };
    expect(toTopic(local)).toMatchObject({
      source: "local",
      slug: "abc",
      category: DEFAULT_CATEGORY,
      doc: local.statement,
      diagrams: [{ id: "tab-1", name: "Diagram", stored: true }],
    });
  });
});
