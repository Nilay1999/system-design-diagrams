import "fake-indexeddb/auto";
import { createStore } from "idb-keyval";
import { beforeEach, describe, expect, it } from "vitest";

import { emptyDraft } from "./model";
import { createLocalTopicRepository, scenesOf, type LocalTopicRepository } from "./repository";

let repo: LocalTopicRepository;
let clock: number;

beforeEach(() => {
  // A fresh database per test.
  const id = crypto.randomUUID();
  clock = Date.parse("2026-10-08T00:00:00.000Z");
  repo = createLocalTopicRepository(
    createStore(`topics-${id}`, "topics"),
    createStore(`scenes-${id}`, "scenes"),
    () => new Date((clock += 1000)),
  );
});

const scene = (id: string) => ({ elements: [{ id }] as never, files: {} });

describe("LocalTopicRepository", () => {
  it("creates a topic with one blank tab", async () => {
    const t = await repo.create({ ...emptyDraft(), title: " Design Slack " });
    expect(t.title).toBe("Design Slack");
    expect(t.tabs).toHaveLength(1);
    expect(await repo.get(t.id)).toEqual(t);
    expect(await repo.getScene(t.id, t.tabs[0].id)).toEqual({ elements: [], files: {} });
  });

  it("lists most recently updated first", async () => {
    const a = await repo.create({ ...emptyDraft(), title: "A" });
    const b = await repo.create({ ...emptyDraft(), title: "B" });
    expect((await repo.list()).map((t) => t.title)).toEqual(["B", "A"]);
    await repo.update(a.id, (t) => ({ ...t, summary: "changed" }));
    expect((await repo.list()).map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("keeps id and createdAt on update, and refuses to remove the last tab", async () => {
    const t = await repo.create({ ...emptyDraft(), title: "A" });
    const u = await repo.update(t.id, (x) => ({ ...x, id: "hijack", createdAt: "x", title: "B" }));
    expect(u).toMatchObject({ id: t.id, createdAt: t.createdAt, title: "B" });
    expect(u.updatedAt > t.updatedAt).toBe(true);
    await expect(repo.update(t.id, (x) => ({ ...x, tabs: [] }))).rejects.toThrow(/at least one/);
    await expect(repo.update("missing", (x) => x)).rejects.toThrow(/no longer exists/);
  });

  it("stores scenes per tab and deletes them with the topic", async () => {
    const t = await repo.create({ ...emptyDraft(), title: "A" });
    const tab = t.tabs[0].id;
    await repo.saveScene(t.id, tab, scene("r1"));
    expect(await scenesOf(repo, t)).toEqual({ [tab]: scene("r1") });
    await repo.remove(t.id);
    expect(await repo.get(t.id)).toBeUndefined();
    expect(await repo.getScene(t.id, tab)).toEqual({ elements: [], files: {} });
  });

  it("puts an imported topic with its scenes", async () => {
    const t = await repo.create({ ...emptyDraft(), title: "A" });
    const copy = { ...t, id: "copy" };
    await repo.put(copy, { [t.tabs[0].id]: scene("x") });
    expect(await repo.get("copy")).toEqual(copy);
    expect(await repo.getScene("copy", t.tabs[0].id)).toEqual(scene("x"));
  });
});
