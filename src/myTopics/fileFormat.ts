import { DIFFICULTIES, EMPTY_SCENE, LIMITS, newId, normalizeDraft, validateDraft, type LocalTopic, type StoredScene } from "./model";

/**
 * The `.sdd-topic.json` file a topic is exported to and imported from: the whole topic, statement
 * and every tab's drawing, so it can be shared before there is a backend.
 */
export const FILE_FORMAT = "sdd-topic";
export const FILE_VERSION = 1;
export const FILE_EXTENSION = ".sdd-topic.json";
/** Generous, but stops a stray multi-hundred-MB file from being read into IndexedDB. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface TopicFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  exportedAt: string;
  topic: LocalTopic;
  /** Keyed by tab id. */
  scenes: Record<string, StoredScene>;
}

export function serializeTopic(topic: LocalTopic, scenes: Record<string, StoredScene>, now = new Date()): string {
  const file: TopicFile = { format: FILE_FORMAT, version: FILE_VERSION, exportedAt: now.toISOString(), topic, scenes };
  return JSON.stringify(file);
}

export const topicFileName = (topic: LocalTopic) =>
  (topic.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic") + FILE_EXTENSION;

export class TopicFileError extends Error {
  override name = "TopicFileError";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

function parseScene(v: unknown): StoredScene {
  if (!isRecord(v)) return EMPTY_SCENE;
  return {
    elements: Array.isArray(v.elements) ? (v.elements as StoredScene["elements"]) : [],
    files: isRecord(v.files) ? (v.files as StoredScene["files"]) : {},
  };
}

/**
 * Read an exported topic. The result is a new topic (fresh id, timestamps of `now`), so importing
 * the same file twice gives two copies instead of overwriting one. Throws `TopicFileError` with a
 * message fit to show the user.
 */
export function parseTopicFile(text: string, now = new Date()): { topic: LocalTopic; scenes: Record<string, StoredScene> } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TopicFileError("This file isn't valid JSON.");
  }
  if (!isRecord(data) || data.format !== FILE_FORMAT) throw new TopicFileError("This isn't an exported topic file.");
  if (data.version !== FILE_VERSION)
    throw new TopicFileError(`This file uses format version ${String(data.version)}, which this app can't read.`);
  if (!isRecord(data.topic)) throw new TopicFileError("The file has no topic in it.");

  const t = data.topic;
  const draft = normalizeDraft({
    title: str(t.title),
    summary: str(t.summary),
    category: str(t.category),
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
    difficulty: DIFFICULTIES.includes(t.difficulty as never) ? (t.difficulty as LocalTopic["difficulty"]) : "medium",
    statement: str(t.statement),
  });
  const errors = Object.values(validateDraft(draft));
  if (errors.length > 0) throw new TopicFileError(`The topic can't be imported: ${errors[0]}`);

  const seen = new Set<string>();
  const tabs = (Array.isArray(t.tabs) ? t.tabs : [])
    .filter(isRecord)
    .map((tab) => ({ id: str(tab.id), name: str(tab.name).trim().slice(0, LIMITS.tabName) || "Diagram" }))
    .filter((tab) => /^[\w-]{1,64}$/.test(tab.id) && !seen.has(tab.id) && seen.add(tab.id));
  if (tabs.length === 0) throw new TopicFileError("The topic has no diagram tabs.");

  const sceneData = isRecord(data.scenes) ? data.scenes : {};
  const at = now.toISOString();
  return {
    topic: { ...draft, id: newId(), tabs, createdAt: at, updatedAt: at },
    scenes: Object.fromEntries(tabs.map((tab) => [tab.id, parseScene(sceneData[tab.id])])),
  };
}
