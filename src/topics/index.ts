import { useTrack } from "../tracks/context";
import type { TopicCatalog } from "./catalog";

export * from "./types";
export * from "./paths";
export { SOURCES, TopicCatalog, groupByCategory } from "./catalog";

/**
 * Every topic the current page can show: the catalog of the route's track. This is the one seam for
 * new sources: local topics (Phase 1) and community topics from the API (Phase 4) get merged into a
 * track's catalog, so callers don't change.
 */
export function useTopics(): TopicCatalog {
  return useTrack().catalog;
}
