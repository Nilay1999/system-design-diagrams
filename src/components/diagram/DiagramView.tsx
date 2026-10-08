import { useEffect, useMemo, useState } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

import { DIAGRAM_FONT } from "../../diagrams/dsl";
import { useTheme } from "../../theme/context";
import type { Topic } from "../../topics";
import { Tabs } from "../Tabs";
import { Legend } from "./Legend";
import { editKey, exportName } from "./editStore";
import { exportExcalidraw, exportPng } from "./exporters";
import { createDiagramSource, diagramFontsReady } from "./sources";
import { useSceneEdits } from "./useSceneEdits";

const FIT = { fitToViewport: true, viewportZoomFactor: 0.8 } as const;

interface Props {
  topic: Topic;
  /** Selected tab; falls back to the first one. */
  viewId?: string;
  onViewChange: (id: string) => void;
}

/** Editable Excalidraw canvas for one diagram tab, with local autosave and export. */
export function DiagramView({ topic, viewId, onViewChange }: Props) {
  const { theme } = useTheme();
  const tab = topic.diagrams.find((d) => d.id === viewId) ?? topic.diagrams[0];
  const source = useMemo(() => createDiagramSource(tab), [tab]);
  const key = editKey(topic, tab);
  const fileName = exportName(topic, tab);

  const edits = useSceneEdits(key, source.signature);
  const { saved, ignoreNextChange } = edits;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [showLegend, setShowLegend] = useState(true);

  const initialElements = useMemo(() => saved ?? source.elements(), [saved, source]);
  const initialFiles = useMemo(() => source.files(initialElements), [source, initialElements]);
  const tabs = useMemo(() => topic.diagrams.map((d) => ({ id: d.id, label: d.name })), [topic]);

  // Once the canvas is ready: rebuild an unedited diagram with the real font loaded (the first
  // build may run before it, which clips free-standing text), then fit the diagram into view.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    diagramFontsReady().then(() => {
      if (cancelled) return;
      if (saved === null) {
        ignoreNextChange();
        const elements = source.elements();
        api.addFiles(Object.values(source.files(elements)));
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      }
      api.scrollToContent(undefined, FIT);
    });
    return () => {
      cancelled = true;
    };
  }, [api, saved, source, ignoreNextChange]);

  const reset = () => {
    edits.reset();
    // The canvas remounts; wait for its new API before touching the scene.
    setApi(null);
  };

  return (
    <div className="diagram">
      {tabs.length > 1 && <Tabs className="diagram-tabs" label="Diagram views" items={tabs} value={tab.id} onChange={onViewChange} />}
      <div className="diagram-toolbar">
        <span className={`badge ${edits.edited ? "badge-edited" : ""}`}>
          {edits.edited ? "Edited (saved locally)" : "Original"}
        </span>
        <div className="spacer" />
        {source.hasLegend && <button onClick={() => setShowLegend((s) => !s)}>{showLegend ? "Hide" : "Show"} legend</button>}
        <button onClick={() => api?.scrollToContent(undefined, { ...FIT, animate: true })}>Fit</button>
        <button onClick={() => api && exportPng(api, fileName, theme === "dark")}>PNG</button>
        <button onClick={() => api && exportExcalidraw(api, fileName)}>.excalidraw</button>
        <button onClick={reset} disabled={!edits.edited} title="Discard your edits and restore the original diagram">
          Reset
        </button>
      </div>
      <div className="diagram-canvas">
        <Excalidraw
          key={`${key}:${edits.generation}`}
          excalidrawAPI={setApi}
          initialData={{
            elements: initialElements,
            files: initialFiles,
            // New text typed by the user uses the same font as the diagram.
            appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: DIAGRAM_FONT.id },
          }}
          theme={theme}
          onChange={edits.onChange}
          UIOptions={{ canvasActions: { loadScene: false } }}
        />
        {source.hasLegend && showLegend && <Legend />}
      </div>
    </div>
  );
}
