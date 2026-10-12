import type { Topic } from "./types";

const BASE: Record<Topic["source"], string> = { curated: "/topics", local: "/my", community: "/problems" };

/** Canonical URL of a topic, optionally on a diagram tab. The first tab is the default and is left out. */
export function topicPath(topic: Topic, view?: string): string {
  const base = `${BASE[topic.source]}/${topic.slug}`;
  return view && view !== topic.diagrams[0].id ? `${base}/${view}` : base;
}

/** Whether `view` names a tab of `topic` that belongs in the URL (any tab but the default). */
export const isNonDefaultView = (topic: Topic, view: string) =>
  topic.diagrams.some((d, i) => i > 0 && d.id === view);

/** Parse a pre-router link: `#/<slug>` or `#/<slug>/<view>`. */
export function parseLegacyHash(hash: string): { slug?: string; view?: string } {
  const [slug, view] = hash.replace(/^#\/?/, "").split("/");
  return { slug: slug || undefined, view: view || undefined };
}

export const NEW_TOPIC_PATH = "/my/new";
export const editTopicPath = (topic: Topic) => `/my/${topic.slug}/edit`;

/** Topic objects are rebuilt when their source reloads, so compare identity, not references. */
export const sameTopic = (a: Topic | undefined, b: Topic | undefined) =>
  !!a && !!b && a.source === b.source && a.slug === b.slug;
