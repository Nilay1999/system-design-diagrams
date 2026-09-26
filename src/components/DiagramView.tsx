import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  hashElementsVersion,
  hashString,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";

import type { Topic } from "../topics";
import { DIAGRAM_FONT, LEGEND, kindColor } from "../diagrams/dsl";

interface SavedScene {
  /** Hash of the diagram source when the edit was saved; edits to stale sources are discarded. */
  signature: string;
  elements: ExcalidrawElement[];
}

const storageKey = (slug: string) => `sdd:diagram:${slug}`;

function loadSaved(slug: string, signature: string): readonly ExcalidrawElement[] | null {
  try {
    const raw = localStorage.getItem(storageKey(slug));
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedScene;
    if (saved.signature !== signature) return null;
    return restoreElements(saved.elements, null);
  } catch {
    return null;
  }
}

function save(slug: string, scene: SavedScene) {
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(scene));
  } catch {
    // Storage full or blocked — edits simply won't persist.
  }
}

function clearSaved(slug: string) {
  try {
    localStorage.removeItem(storageKey(slug));
  } catch {
    // ignore
  }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  topic: Topic;
  theme: "light" | "dark";
}

export function DiagramView({ topic, theme }: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [generation, setGeneration] = useState(0);
  const [edited, setEdited] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const baseline = useRef<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const skeleton = useMemo(() => topic.diagram(), [topic]);
  const signature = useMemo(() => String(hashString(JSON.stringify(skeleton))), [skeleton]);

  // `generation` is a dependency only to force a fresh read after a reset.
  const saved = useMemo(() => loadSaved(topic.slug, signature), [topic.slug, signature, generation]);
  const initialElements = useMemo(() => saved ?? convertToExcalidrawElements(skeleton), [saved, skeleton]);

  useEffect(() => {
    setEdited(saved !== null);
    baseline.current = null;
  }, [saved]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // Once the canvas is ready: re-measure text with the real diagram font (the first
  // conversion may run before the font has loaded, which clips free-standing text),
  // then fit the whole diagram into view.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        await document.fonts.load(`16px ${DIAGRAM_FONT.name}`);
        await document.fonts.ready;
      } catch {
        // Measure with whatever font is available.
      }
      if (cancelled) return;
      if (saved === null) {
        baseline.current = null;
        api.updateScene({ elements: convertToExcalidrawElements(skeleton), captureUpdate: CaptureUpdateAction.NEVER });
      }
      api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.8 });
    })();
    return () => {
      cancelled = true;
    };
  }, [api, saved, skeleton]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      const version = hashElementsVersion(elements);
      // The first onChange reflects the initial scene, not a user edit.
      if (baseline.current === null) {
        baseline.current = version;
        return;
      }
      if (version === baseline.current) return;
      baseline.current = version;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        save(topic.slug, { signature, elements: elements.filter((e) => !e.isDeleted) });
        setEdited(true);
      }, 400);
    },
    [topic.slug, signature],
  );

  const reset = () => {
    window.clearTimeout(saveTimer.current);
    clearSaved(topic.slug);
    setApi(null);
    setGeneration((g) => g + 1);
  };

  const exportJson = () => {
    if (!api) return;
    const json = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
    download(new Blob([json], { type: "application/json" }), `${topic.slug}.excalidraw`);
  };

  const exportPng = async () => {
    if (!api) return;
    const blob = await exportToBlob({
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: theme === "dark" },
      files: api.getFiles(),
      mimeType: "image/png",
      exportPadding: 32,
    });
    download(blob, `${topic.slug}.png`);
  };

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <span className={`badge ${edited ? "badge-edited" : ""}`}>{edited ? "Edited (saved locally)" : "Original"}</span>
        <div className="spacer" />
        <button onClick={() => setShowLegend((s) => !s)}>{showLegend ? "Hide" : "Show"} legend</button>
        <button onClick={() => api?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.8, animate: true })}>
          Fit
        </button>
        <button onClick={exportPng}>PNG</button>
        <button onClick={exportJson}>.excalidraw</button>
        <button onClick={reset} disabled={!edited} title="Discard your edits and restore the original diagram">
          Reset
        </button>
      </div>
      <div className="diagram-canvas">
        <Excalidraw
          key={`${topic.slug}:${generation}`}
          excalidrawAPI={setApi}
          initialData={{
            elements: initialElements,
            // New text typed by the user uses the same font as the diagram.
            appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: DIAGRAM_FONT.id },
          }}
          theme={theme}
          onChange={onChange}
          UIOptions={{ canvasActions: { loadScene: false } }}
        />
        {showLegend && (
          <ul className="legend" aria-label="Legend">
            {LEGEND.map(({ kind, label }) => {
              const c = kindColor(kind);
              return (
                <li key={kind}>
                  <span className="swatch" style={{ background: c.bg, borderColor: c.stroke }} />
                  {label}
                </li>
              );
            })}
            <li>
              <span className="line" /> sync call
            </li>
            <li>
              <span className="line line-async" /> async / event
            </li>
          </ul>
        )}
      </div>
    </div>
  );
}
