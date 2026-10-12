import { useCallback, useMemo } from "react";

import type { ShippedTab, Topic } from "../../topics";
import { DiagramCanvas, type CanvasHandle } from "./DiagramCanvas";
import { DiagramTabs } from "./DiagramTabs";
import { editKey, exportName } from "./editStore";
import { createDiagramSource, diagramFontsReady } from "./sources";
import { useSceneEdits } from "./useSceneEdits";

interface Props {
  topic: Topic;
  tab: ShippedTab;
  onViewChange: (id: string) => void;
}

/** A diagram that ships with its topic. The user may edit it locally and reset to the original. */
export function ShippedDiagram({ topic, tab, onViewChange }: Props) {
  const source = useMemo(() => createDiagramSource(tab), [tab]);
  const key = editKey(topic, tab);
  const edits = useSceneEdits(key, source.signature);
  const { saved } = edits;

  const initialElements = useMemo(() => saved ?? source.elements(), [saved, source]);
  const initialFiles = useMemo(() => source.files(initialElements), [source, initialElements]);

  // Rebuild an unedited diagram once the real font has loaded: the first build may run before it,
  // which clips free-standing text.
  const onReady = useCallback(
    async (canvas: CanvasHandle, signal: AbortSignal) => {
      await diagramFontsReady();
      if (signal.aborted || saved !== null) return;
      const elements = source.elements();
      canvas.replaceScene(elements, source.files(elements));
    },
    [saved, source],
  );

  return (
    <div className="diagram">
      <DiagramTabs topic={topic} value={tab.id} onChange={onViewChange} />
      <DiagramCanvas
        key={`${key}:${edits.generation}`}
        initialElements={initialElements}
        initialFiles={initialFiles}
        onEdit={edits.onEdit}
        onReady={onReady}
        fileName={exportName(topic, tab)}
        legend={source.hasLegend}
        status={
          <span className={`badge ${edits.edited ? "badge-edited" : ""}`}>
            {edits.edited ? "Edited (saved locally)" : "Original"}
          </span>
        }
        actions={
          <button onClick={edits.reset} disabled={!edits.edited} title="Discard your edits and restore the original diagram">
            Reset
          </button>
        }
      />
    </div>
  );
}
