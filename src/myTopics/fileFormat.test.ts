import { describe, expect, it } from "vitest";

import { FILE_FORMAT, FILE_VERSION, TopicFileError, parseTopicFile, serializeTopic, topicFileName } from "./fileFormat";
import { emptyDraft, normalizeDraft, type LocalTopic } from "./model";

const topic: LocalTopic = {
  ...normalizeDraft({ ...emptyDraft(), title: "Design a Pastebin", tags: ["storage"] }),
  id: "orig-id",
  tabs: [
    { id: "tab-a", name: "Architecture" },
    { id: "tab-b", name: "Flows" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const scenes = {
  "tab-a": { elements: [{ id: "r1", type: "rectangle" }] as never, files: {} },
  "tab-b": { elements: [], files: {} },
};
const now = new Date("2026-10-08T12:00:00.000Z");

describe("topic files", () => {
  it("round-trip as a new copy", () => {
    const { topic: imported, scenes: importedScenes } = parseTopicFile(serializeTopic(topic, scenes), now);
    expect(imported.id).not.toBe(topic.id);
    expect(imported).toMatchObject({
      title: topic.title,
      tags: topic.tags,
      statement: topic.statement,
      tabs: topic.tabs,
      createdAt: now.toISOString(),
    });
    expect(importedScenes).toEqual(scenes);
  });

  it("fill in a missing scene with an empty one", () => {
    const text = serializeTopic(topic, { "tab-a": scenes["tab-a"] });
    expect(parseTopicFile(text).scenes["tab-b"]).toEqual({ elements: [], files: {} });
  });

  it("drop tabs with bad or duplicate ids", () => {
    const bad = { ...topic, tabs: [...topic.tabs, { id: "tab-a", name: "dup" }, { id: "../x", name: "bad" }] };
    expect(parseTopicFile(serializeTopic(bad, scenes)).topic.tabs.map((t) => t.id)).toEqual(["tab-a", "tab-b"]);
  });

  it.each([
    ["not JSON", "{", /valid JSON/],
    ["another format", JSON.stringify({ format: "excalidraw" }), /exported topic/],
    ["a newer version", JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION + 1 }), /version/],
    ["no title", serializeTopic({ ...topic, title: "" }, scenes), /title/],
    ["no tabs", serializeTopic({ ...topic, tabs: [] }, scenes), /no diagram tabs/],
  ])("reject %s with a readable message", (_, text, message) => {
    expect(() => parseTopicFile(text)).toThrow(TopicFileError);
    expect(() => parseTopicFile(text)).toThrow(message);
  });

  it("are named after the title", () => {
    expect(topicFileName(topic)).toBe("design-a-pastebin.sdd-topic.json");
    expect(topicFileName({ ...topic, title: "!!!" })).toBe("topic.sdd-topic.json");
  });
});
