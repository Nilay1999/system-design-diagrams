import { exportToBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { download } from "../../lib/download";

/** Download the current scene as an `.excalidraw` file that excalidraw.com can open. */
export function exportExcalidraw(api: ExcalidrawImperativeAPI, fileName: string) {
  const json = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local");
  download(new Blob([json], { type: "application/json" }), `${fileName}.excalidraw`);
}

/** Download the current scene as a PNG with a background, in the given theme. */
export async function exportPng(api: ExcalidrawImperativeAPI, fileName: string, dark: boolean) {
  const blob = await exportToBlob({
    elements: api.getSceneElements(),
    appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: dark },
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: 32,
  });
  download(blob, `${fileName}.png`);
}
