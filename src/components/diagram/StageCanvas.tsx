import { useEffect, useState, type ReactNode } from "react";
import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

import { DIAGRAM_FONT, type Skeleton } from "../../diagrams/dsl";
import { iconFilesFor } from "../../diagrams/icon-files";
import { useTheme } from "../../theme/context";
import { useTrack } from "../../tracks/context";
import { Legend } from "./Legend";
import { diagramFontsReady } from "./sources";

const FIT = { fitToViewport: true, viewportZoomFactor: 0.85, animate: true } as const;

function scene(build: () => Skeleton[]) {
  const elements = convertToExcalidrawElements(build());
  return { elements, files: iconFilesFor(elements) };
}

interface Props {
  /** Builds the diagram to show. Pass a new function to replace the diagram; keep it stable otherwise. */
  build: () => Skeleton[];
  /** Short text in the toolbar saying what is on screen. */
  caption: ReactNode;
}

/**
 * A read-only canvas (pan and zoom, no editing) whose diagram is swapped from code. Used by the
 * step-by-step build, where each decision redraws the design. Nothing is saved.
 */
export function StageCanvas({ build, caption }: Props) {
  const { theme } = useTheme();
  const { legend } = useTrack();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Only the first diagram goes in as initial data; later ones are pushed through the API below.
  const [initial] = useState(() => scene(build));

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // Build once the fonts are in, so text is measured with the real font (see DiagramView).
    diagramFontsReady().then(() => {
      if (cancelled) return;
      const { elements, files } = scene(build);
      api.addFiles(Object.values(files));
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      api.scrollToContent(elements, FIT);
    });
    return () => {
      cancelled = true;
    };
  }, [api, build]);

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <span className="stage-caption">{caption}</span>
        <div className="spacer" />
        <button onClick={() => api?.scrollToContent(undefined, FIT)}>Fit</button>
      </div>
      <div className="diagram-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={{
            elements: initial.elements,
            files: initial.files,
            appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: DIAGRAM_FONT.id },
          }}
          theme={theme}
          viewModeEnabled
          UIOptions={{ canvasActions: { loadScene: false } }}
        />
        <Legend entries={legend} />
      </div>
    </div>
  );
}
