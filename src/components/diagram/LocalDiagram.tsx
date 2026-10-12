import { useMemo, useRef, useState, type ReactNode } from "react";
import { restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { LIMITS, pruneScene, type StoredScene } from "../../myTopics/model";
import { useLocalScene, useSaveScene, useTabActions } from "../../myTopics/queries";
import type { StoredSceneSpec, Topic } from "../../topics";
import { DiagramCanvas } from "./DiagramCanvas";
import { DiagramTabs } from "./DiagramTabs";

const SAVE_DELAY_MS = 400;

interface Props {
  topic: Topic;
  tab: StoredSceneSpec;
  onViewChange: (id: string) => void;
}

/** A My Topics diagram: the drawing is the user's own content, autosaved to this browser. */
export function LocalDiagram({ topic, tab, onViewChange }: Props) {
  const scene = useLocalScene(topic.slug, tab.id);
  const actions = useTabActions(topic.slug);
  const [renaming, setRenaming] = useState(false);

  const addTab = () => actions.add.mutateAsync().then(onViewChange);

  const deleteTab = () => {
    if (!window.confirm(`Delete the tab "${tab.name}" and its drawing? This can't be undone.`)) return;
    const next = topic.diagrams.find((d) => d.id !== tab.id)!;
    onViewChange(next.id);
    actions.remove.mutate(tab.id);
  };

  const tabActions = (
    <>
      <button onClick={() => setRenaming(true)}>Rename tab</button>
      <button onClick={deleteTab} disabled={topic.diagrams.length < 2} title="A topic needs at least one tab">
        Delete tab
      </button>
    </>
  );

  return (
    <div className="diagram">
      <DiagramTabs
        topic={topic}
        value={tab.id}
        onChange={onViewChange}
        trailing={
          <button className="add-tab" onClick={addTab} disabled={actions.add.isPending} aria-label="Add a diagram tab" title="Add a diagram tab">
            +
          </button>
        }
      />
      {scene.isPending ? (
        <div className="diagram-loading">Loading drawing…</div>
      ) : scene.isError ? (
        <div className="diagram-loading">This drawing couldn't be loaded from your browser's storage.</div>
      ) : (
        <LocalCanvas
          key={`${topic.slug}/${tab.id}`}
          topicId={topic.slug}
          tabId={tab.id}
          initial={scene.data}
          fileName={`${topic.slug}-${tab.id}`}
          status={
            renaming ? (
              <RenameInput
                initial={tab.name}
                onDone={(name) => {
                  setRenaming(false);
                  if (name && name !== tab.name) actions.rename.mutate({ tabId: tab.id, name });
                }}
              />
            ) : undefined
          }
          actions={tabActions}
        />
      )}
    </div>
  );
}

type SaveState = "saved" | "saving" | "error";

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Saved in this browser",
  saving: "Saving…",
  error: "Couldn't save. Is storage full or blocked?",
};

interface CanvasProps {
  topicId: string;
  tabId: string;
  initial: StoredScene;
  fileName: string;
  /** Replaces the save-state badge, e.g. with the rename field. */
  status?: ReactNode;
  actions: ReactNode;
}

/** One tab's canvas. Keyed per tab, so its save state starts fresh on every tab. */
function LocalCanvas({ topicId, tabId, initial, fileName, status, actions }: CanvasProps) {
  const saveScene = useSaveScene();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  // Stored scenes may come from an imported file; restoring fills in anything missing or outdated.
  const elements = useMemo(() => restoreElements(initial.elements, null), [initial]);

  const save = useDebouncedCallback((elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
    saveScene(topicId, tabId, pruneScene(elements, files)).then(
      () => setSaveState("saved"),
      () => setSaveState("error"),
    );
  }, SAVE_DELAY_MS);

  const onEdit = (elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
    setSaveState("saving");
    save(elements, files);
  };

  return (
    <DiagramCanvas
      initialElements={elements}
      initialFiles={initial.files}
      onEdit={onEdit}
      fileName={fileName}
      status={status ?? <span className={`badge ${saveState === "error" ? "badge-error" : ""}`}>{SAVE_LABELS[saveState]}</span>}
      actions={actions}
    />
  );
}

/** Inline field for a tab's name: Enter or blur saves, Escape cancels. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  // Escape then the resulting blur would otherwise finish twice.
  const finished = useRef(false);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(name);
  };
  return (
    <input
      className="rename-input"
      autoFocus
      value={value}
      maxLength={LIMITS.tabName}
      aria-label="Tab name"
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
