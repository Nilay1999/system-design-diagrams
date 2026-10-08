import type { Topic } from "./types";

/** Canonical URL of a topic, optionally on a diagram tab. The first tab is the default and is left out. */
export function topicPath(topic: Topic, view?: string): string {
  const base = `/topics/${topic.slug}`;
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
