import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { DIFFICULTIES, type Difficulty, type Topic } from "../topics/types";

export { DIFFICULTIES, DIFFICULTY_LABELS, type Difficulty } from "../topics/types";

/** The fields a user edits in the topic form. */
export interface TopicDraft {
  title: string;
  summary: string;
  category: string;
  tags: string[];
  difficulty: Difficulty;
  /** Problem statement, Markdown. */
  statement: string;
}

/** A diagram tab's name; its drawing is stored separately (see `StoredScene`). */
export interface TabMeta {
  id: string;
  name: string;
}

/** A topic the user created, stored in this browser. */
export interface LocalTopic extends TopicDraft {
  id: string;
  /** In display order; never empty. */
  tabs: TabMeta[];
  createdAt: string;
  updatedAt: string;
}

/** The drawing on one tab. Kept apart from `LocalTopic` so autosaving a canvas never rewrites the topic. */
export interface StoredScene {
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles;
}

export const EMPTY_SCENE: StoredScene = { elements: [], files: {} };

export const LIMITS = {
  title: 120,
  summary: 280,
  category: 48,
  tags: 10,
  tag: 32,
  statement: 50_000,
  tabName: 40,
} as const;

export const DEFAULT_CATEGORY = "My Topics";

export const STATEMENT_TEMPLATE = `## Problem

Describe what the system does and who uses it.

## Requirements

**Functional**

-

**Non-functional**

-

## Capacity estimates

## API

## Data model

## High-level design

## Deep dives

## Trade-offs and failure modes
`;

export const emptyDraft = (): TopicDraft => ({
  title: "",
  summary: "",
  category: "",
  tags: [],
  difficulty: "medium",
  statement: STATEMENT_TEMPLATE,
});

export type DraftErrors = Partial<Record<keyof TopicDraft, string>>;

/** Trim and de-duplicate, so stored topics are always tidy. */
export function normalizeDraft(draft: TopicDraft): TopicDraft {
  const tags = [...new Set(draft.tags.map((t) => t.trim()).filter(Boolean))];
  return {
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    category: draft.category.trim(),
    tags,
    difficulty: draft.difficulty,
    statement: draft.statement.trim() + "\n",
  };
}

/** Errors per field for a normalised draft; empty when it can be saved. */
export function validateDraft(draft: TopicDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.title) errors.title = "Give the topic a title.";
  else if (draft.title.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
  if (draft.summary.length > LIMITS.summary) errors.summary = `Keep the summary under ${LIMITS.summary} characters.`;
  if (draft.category.length > LIMITS.category) errors.category = `Keep the category under ${LIMITS.category} characters.`;
  if (draft.tags.length > LIMITS.tags) errors.tags = `Use at most ${LIMITS.tags} tags.`;
  else if (draft.tags.some((t) => t.length > LIMITS.tag)) errors.tags = `Keep each tag under ${LIMITS.tag} characters.`;
  if (!DIFFICULTIES.includes(draft.difficulty)) errors.difficulty = "Pick a difficulty.";
  if (draft.statement.length > LIMITS.statement)
    errors.statement = `Keep the statement under ${LIMITS.statement.toLocaleString()} characters.`;
  return errors;
}

/** Comma-separated text ⇄ tag list, for the tags input. */
export const parseTags = (text: string) => text.split(",").map((t) => t.trim()).filter(Boolean);
export const formatTags = (tags: readonly string[]) => tags.join(", ");

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

export const newTab = (name: string): TabMeta => ({ id: `tab-${newId().slice(0, 8)}`, name });

/** Next free "Diagram N" name. */
export function nextTabName(tabs: readonly TabMeta[]): string {
  const names = new Set(tabs.map((t) => t.name));
  let n = tabs.length + 1;
  while (names.has(`Diagram ${n}`)) n++;
  return `Diagram ${n}`;
}

/** How a local topic appears to the rest of the app. */
export function toTopic(t: LocalTopic): Topic {
  return {
    source: "local",
    slug: t.id,
    title: t.title,
    category: t.category || DEFAULT_CATEGORY,
    summary: t.summary,
    tags: t.tags,
    difficulty: t.difficulty,
    doc: t.statement,
    diagrams: t.tabs.map((tab) => ({ ...tab, stored: true })),
    updatedAt: t.updatedAt,
  };
}

/** What is worth storing from a canvas: live elements, and only the image files they still use. */
export function pruneScene(elements: readonly ExcalidrawElement[], files: BinaryFiles): StoredScene {
  const live = elements.filter((e) => !e.isDeleted);
  const used = new Set<string>(live.flatMap((e) => (e.type === "image" && e.fileId ? [e.fileId] : [])));
  return { elements: live, files: Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id))) };
}
