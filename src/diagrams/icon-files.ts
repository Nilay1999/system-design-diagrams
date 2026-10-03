import type { FileId } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { ICON_FILE_PREFIX } from "./dsl";
import { BRAND_ICONS, GENERIC_ICONS } from "./icons.generated";

/**
 * Turns the icon file ids that the DSL writes into image elements
 * (`icon__<name>__<tint>`) into SVG files Excalidraw can render.
 * Only DiagramView imports this, so the icon data stays in the lazily loaded chunk.
 */

const cache = new Map<string, BinaryFileData>();

function toDataURL(svg: string): DataURL {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(binary)}` as DataURL;
}

function svgFor(fileId: string): string | null {
  if (!fileId.startsWith(ICON_FILE_PREFIX)) return null;
  const [name, tint = "495057"] = fileId.slice(ICON_FILE_PREFIX.length).split("__");
  if (name in BRAND_ICONS) return BRAND_ICONS[name as keyof typeof BRAND_ICONS];
  if (name in GENERIC_ICONS) return GENERIC_ICONS[name as keyof typeof GENERIC_ICONS].replaceAll("currentColor", `#${tint}`);
  return null;
}

export function iconFile(fileId: string): BinaryFileData | null {
  const hit = cache.get(fileId);
  if (hit) return hit;
  const svg = svgFor(fileId);
  if (!svg) return null;
  // A fixed `created` keeps the files identical between builds of the same scene.
  const file: BinaryFileData = { id: fileId as FileId, mimeType: "image/svg+xml", dataURL: toDataURL(svg), created: 0 };
  cache.set(fileId, file);
  return file;
}

/** Files for every icon referenced by these elements. */
export function iconFilesFor(elements: readonly { type: string; fileId?: string | null }[]): BinaryFiles {
  const files: BinaryFiles = {};
  for (const e of elements) {
    if (e.type !== "image" || !e.fileId || files[e.fileId]) continue;
    const file = iconFile(e.fileId);
    if (file) files[e.fileId] = file;
  }
  return files;
}
