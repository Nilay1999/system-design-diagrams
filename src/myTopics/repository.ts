import { createStore, del, delMany, entries, get, set, setMany, type UseStore } from "idb-keyval";

import { EMPTY_SCENE, newId, newTab, normalizeDraft, type LocalTopic, type StoredScene, type TopicDraft } from "./model";

/**
 * Persistence for My Topics, in IndexedDB (scenes with images outgrow localStorage's ~5 MB).
 * Topics and their scenes are separate databases, so autosaving a canvas never rewrites topic
 * metadata and listing topics never loads every drawing.
 */
export interface LocalTopicRepository {
  list(): Promise<LocalTopic[]>;
  get(id: string): Promise<LocalTopic | undefined>;
  create(draft: TopicDraft): Promise<LocalTopic>;
  /** Apply `change` to the stored topic. Throws if it no longer exists. */
  update(id: string, change: (topic: LocalTopic) => LocalTopic): Promise<LocalTopic>;
  /** Delete a topic and all its scenes. */
  remove(id: string): Promise<void>;

  getScene(topicId: string, tabId: string): Promise<StoredScene>;
  saveScene(topicId: string, tabId: string, scene: StoredScene): Promise<void>;
  removeScene(topicId: string, tabId: string): Promise<void>;

  /** Store a complete topic with its scenes, e.g. from an import. */
  put(topic: LocalTopic, scenes: Record<string, StoredScene>): Promise<void>;
}

const sceneKey = (topicId: string, tabId: string) => `${topicId}/${tabId}`;

export function createLocalTopicRepository(
  topics: UseStore = createStore("sdd-my-topics", "topics"),
  scenes: UseStore = createStore("sdd-my-topic-scenes", "scenes"),
  now: () => Date = () => new Date(),
): LocalTopicRepository {
  const repo: LocalTopicRepository = {
    async list() {
      const all = await entries<string, LocalTopic>(topics);
      return all.map(([, t]) => t).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    get: (id) => get<LocalTopic>(id, topics),

    async create(draft) {
      const at = now().toISOString();
      const topic: LocalTopic = {
        ...normalizeDraft(draft),
        id: newId(),
        tabs: [newTab("Diagram")],
        createdAt: at,
        updatedAt: at,
      };
      await set(topic.id, topic, topics);
      return topic;
    },

    async update(id, change) {
      const current = await get<LocalTopic>(id, topics);
      if (!current) throw new Error(`Topic ${id} no longer exists`);
      const next: LocalTopic = { ...change(current), id, createdAt: current.createdAt, updatedAt: now().toISOString() };
      if (next.tabs.length === 0) throw new Error("A topic needs at least one diagram tab");
      await set(id, next, topics);
      return next;
    },

    async remove(id) {
      const topic = await get<LocalTopic>(id, topics);
      await del(id, topics);
      if (topic) await delMany(topic.tabs.map((t) => sceneKey(id, t.id)), scenes);
    },

    async getScene(topicId, tabId) {
      return (await get<StoredScene>(sceneKey(topicId, tabId), scenes)) ?? EMPTY_SCENE;
    },

    saveScene: (topicId, tabId, scene) => set(sceneKey(topicId, tabId), scene, scenes),

    removeScene: (topicId, tabId) => del(sceneKey(topicId, tabId), scenes),

    async put(topic, sceneMap) {
      await setMany(
        Object.entries(sceneMap).map(([tabId, scene]) => [sceneKey(topic.id, tabId), scene]),
        scenes,
      );
      await set(topic.id, topic, topics);
    },
  };
  return repo;
}

/** Scenes for every tab of a topic, for export. */
export async function scenesOf(repo: LocalTopicRepository, topic: LocalTopic): Promise<Record<string, StoredScene>> {
  const list = await Promise.all(topic.tabs.map((t) => repo.getScene(topic.id, t.id)));
  return Object.fromEntries(topic.tabs.map((t, i) => [t.id, list[i]]));
}
