import { CURATED_TOPICS } from "./curated";
import { TopicCatalog } from "./catalog";

export * from "./types";
export * from "./paths";
export { SOURCES, TopicCatalog, groupByCategory } from "./catalog";

const catalog = new TopicCatalog(CURATED_TOPICS);

/**
 * Every topic the app can show. This is the one seam for new sources: local topics (Phase 1)
 * and community topics from the API (Phase 4) get merged in here, so callers don't change.
 */
export function useTopics(): TopicCatalog {
  return catalog;
}
