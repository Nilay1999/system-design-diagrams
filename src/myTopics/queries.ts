import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { download } from "../lib/download";
import { parseTopicFile, serializeTopic, topicFileName } from "./fileFormat";
import { newTab, nextTabName, normalizeDraft, type LocalTopic, type StoredScene, type TopicDraft } from "./model";
import { scenesOf } from "./repository";
import { useRepository } from "./RepositoryContext";

export const myTopicKeys = {
  all: ["my-topics"] as const,
  list: () => [...myTopicKeys.all, "list"] as const,
  scene: (topicId: string, tabId: string) => [...myTopicKeys.all, "scene", topicId, tabId] as const,
};

export function useLocalTopics() {
  const repo = useRepository();
  return useQuery({ queryKey: myTopicKeys.list(), queryFn: () => repo.list(), staleTime: Infinity });
}

/** The drawing on one tab. Only this browser tab writes it, so the cache is kept current by `useSaveScene`. */
export function useLocalScene(topicId: string, tabId: string) {
  const repo = useRepository();
  return useQuery({
    queryKey: myTopicKeys.scene(topicId, tabId),
    queryFn: () => repo.getScene(topicId, tabId),
    staleTime: Infinity,
  });
}

export function useSaveScene() {
  const repo = useRepository();
  const client = useQueryClient();
  return useCallback(
    async (topicId: string, tabId: string, scene: StoredScene) => {
      client.setQueryData(myTopicKeys.scene(topicId, tabId), scene);
      await repo.saveScene(topicId, tabId, scene);
    },
    [repo, client],
  );
}

/** A mutation that refreshes the topic list when it succeeds. */
function useTopicsMutation<V, R>(fn: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => client.invalidateQueries({ queryKey: myTopicKeys.list() }),
  });
}

export function useCreateTopic() {
  const repo = useRepository();
  return useTopicsMutation((draft: TopicDraft) => repo.create(draft));
}

export function useUpdateTopic() {
  const repo = useRepository();
  return useTopicsMutation(({ id, draft }: { id: string; draft: TopicDraft }) =>
    repo.update(id, (t) => ({ ...t, ...normalizeDraft(draft) })),
  );
}

export function useDeleteTopic() {
  const repo = useRepository();
  return useTopicsMutation((id: string) => repo.remove(id));
}

/** Import an exported topic file as a new topic. */
export function useImportTopic() {
  const repo = useRepository();
  return useTopicsMutation(async (text: string): Promise<LocalTopic> => {
    const { topic, scenes } = parseTopicFile(text);
    await repo.put(topic, scenes);
    return topic;
  });
}

/** Add, rename and remove diagram tabs of one topic. */
export function useTabActions(topicId: string) {
  const repo = useRepository();
  const add = useTopicsMutation(async () => {
    let tabId = "";
    await repo.update(topicId, (t) => {
      const tab = newTab(nextTabName(t.tabs));
      tabId = tab.id;
      return { ...t, tabs: [...t.tabs, tab] };
    });
    return tabId;
  });
  const rename = useTopicsMutation(({ tabId, name }: { tabId: string; name: string }) =>
    repo.update(topicId, (t) => ({ ...t, tabs: t.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab)) })),
  );
  const remove = useTopicsMutation(async (tabId: string) => {
    await repo.update(topicId, (t) => ({ ...t, tabs: t.tabs.filter((tab) => tab.id !== tabId) }));
    await repo.removeScene(topicId, tabId);
  });
  return { add, rename, remove };
}

/** Download a topic, statement and drawings, as one file that `useImportTopic` reads back. */
export function useExportTopic() {
  const repo = useRepository();
  return useCallback(
    async (id: string) => {
      const topic = await repo.get(id);
      if (!topic) throw new Error(`Topic ${id} no longer exists`);
      const json = serializeTopic(topic, await scenesOf(repo, topic));
      download(new Blob([json], { type: "application/json" }), topicFileName(topic));
    },
    [repo],
  );
}
