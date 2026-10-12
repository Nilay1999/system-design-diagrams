import { useMemo } from "react";

import { useLocalTopics } from "../myTopics/queries";
import { toTopic } from "../myTopics/model";
import { CURATED_TOPICS } from "./curated";
import { TopicCatalog, type SourceStatus } from "./catalog";

export * from "./types";
export * from "./paths";
export { SOURCES, TopicCatalog, groupByCategory, type SourceStatus } from "./catalog";

/**
 * Every topic the app can show. This is the one seam for topic sources: curated topics are
 * static, My Topics come from IndexedDB, and community topics (Phase 4) will come from the API.
 */
export function useTopics(): TopicCatalog {
  const local = useLocalTopics();
  return useMemo(() => {
    const status: SourceStatus = {};
    if (local.isPending) status.local = { state: "pending" };
    else if (local.isError) status.local = { state: "error", message: "Your topics couldn't be loaded from this browser's storage." };
    return new TopicCatalog([...(local.data ?? []).map(toTopic), ...CURATED_TOPICS], status);
  }, [local.data, local.isPending, local.isError]);
}
