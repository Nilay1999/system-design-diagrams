import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

import { DIAGRAM_FONT } from "../../diagrams/dsl";
import { useTheme } from "../../theme/context";
import { Legend } from "./Legend";
import { exportExcalidraw, exportPng } from "./exporters";
import { useSceneChanges } from "./useSceneChanges";

const FIT = { fitToViewport: true, viewportZoomFactor: 0.8 } as const;

/** Handed to `onReady`. */
export interface CanvasHandle {
  api: ExcalidrawImperativeAPI;
  /** Swap the scene from code. Not undoable, and not reported as an edit. */
  replaceScene(elements: readonly ExcalidrawElement[], files: BinaryFiles): void;
}

interface Props {
  initialElements: readonly ExcalidrawElement[];
  initialFiles: BinaryFiles;
  /** Called for user edits only, not for loads, scrolling or selection. */
  onEdit: (elements: readonly ExcalidrawElement[], files: BinaryFiles) => void;
  /** Runs once the canvas is ready, before the drawing is fitted into view. Stop early if `signal` aborts. */
  onReady?: (canvas: CanvasHandle, signal: AbortSignal) => Promise<void> | void;
  /** Base name for exported files. */
  fileName: string;
  /** Whether to offer the DSL node-kind legend. */
  legend?: boolean;
  /** Start of the toolbar, e.g. a save-state badge. */
  status: ReactNode;
  /** Extra toolbar buttons, after the built-in ones. */
  actions?: ReactNode;
}

/**
 * Toolbar + Excalidraw canvas, shared by every kind of diagram. It reads its initial data once:
 * give it a `key` that changes whenever it should start over from new data. Edit detection is
 * per mount, so a fresh canvas never mistakes its own load for an edit.
 */
export function DiagramCanvas({ initialElements, initialFiles, onEdit, onReady, fileName, legend, status, actions }: Props) {
  const { theme } = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [showLegend, setShowLegend] = useState(true);
  const ready = useRef(onReady);
  useLayoutEffect(() => {
    ready.current = onReady;
  });
  const { onChange, ignoreNextChange } = useSceneChanges(onEdit);

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const replaceScene: CanvasHandle["replaceScene"] = (elements, files) => {
      ignoreNextChange();
      api.addFiles(Object.values(files));
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    };
    (async () => {
      await ready.current?.({ api, replaceScene }, controller.signal);
      if (!controller.signal.aborted) api.scrollToContent(undefined, FIT);
    })();
    return () => controller.abort();
  }, [api, ignoreNextChange]);

  return (
    <>
      <div className="diagram-toolbar">
        {status}
        <div className="spacer" />
        {legend && <button onClick={() => setShowLegend((s) => !s)}>{showLegend ? "Hide" : "Show"} legend</button>}
        <button onClick={() => api?.scrollToContent(undefined, { ...FIT, animate: true })}>Fit</button>
        <button onClick={() => api && exportPng(api, fileName, theme === "dark")}>PNG</button>
        <button onClick={() => api && exportExcalidraw(api, fileName)}>.excalidraw</button>
        {actions}
      </div>
      <div className="diagram-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={{
            elements: initialElements,
            files: initialFiles,
            // New text typed by the user uses the same font as the diagrams.
            appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: DIAGRAM_FONT.id },
          }}
          theme={theme}
          onChange={(elements, _appState, files) => onChange(elements, files)}
          UIOptions={{ canvasActions: { loadScene: false } }}
        />
        {legend && showLegend && <Legend />}
      </div>
    </>
  );
}
