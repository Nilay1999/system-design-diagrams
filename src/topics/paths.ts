import type { Topic, TrackId } from "./types";

/** Where each track's topic pages live. */
export const TRACK_BASE: Record<TrackId, string> = {
  "system-design": "/topics",
  kubernetes: "/kubernetes",
};

/** Canonical URL of a topic, optionally on a diagram tab. The first tab is the default and is left out. */
export function topicPath(topic: Topic, view?: string): string {
  const base = `${TRACK_BASE[topic.track]}/${topic.slug}`;
  return view && view !== topic.diagrams[0].id ? `${base}/${view}` : base;
}

/**
 * URL segment of a topic's step-by-step build, e.g. `/topics/url-shortener/build`. It shares a
 * place in the URL with diagram tab ids, so no tab may use this id (the topic tests check).
 */
export const BUILD_SEGMENT = "build";

/** Name of the step-by-step build, as shown in buttons and titles. */
export const BUILD_LABEL = "Build it step by step";

/** URL of a topic's step-by-step build. Only meaningful for topics that have an `evolution`. */
export const buildPath = (topic: Topic) => `${TRACK_BASE[topic.track]}/${topic.slug}/${BUILD_SEGMENT}`;

/** URL segment and name of a topic's live simulator, e.g. `/topics/url-shortener/simulate`. Same rule as `BUILD_SEGMENT`. */
export const SIM_SEGMENT = "simulate";
export const SIM_LABEL = "Live simulator";

/** URL of a topic's live simulator. Only meaningful for topics that have a `simulation`. */
export const simPath = (topic: Topic) => `${TRACK_BASE[topic.track]}/${topic.slug}/${SIM_SEGMENT}`;

/** Whether `view` names a tab of `topic` that belongs in the URL (any tab but the default). */
export const isNonDefaultView = (topic: Topic, view: string) =>
  topic.diagrams.some((d, i) => i > 0 && d.id === view);

/** Parse a pre-router link: `#/<slug>` or `#/<slug>/<view>`. */
export function parseLegacyHash(hash: string): { slug?: string; view?: string } {
  const [slug, view] = hash.replace(/^#\/?/, "").split("/");
  return { slug: slug || undefined, view: view || undefined };
}
