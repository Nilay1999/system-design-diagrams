// Copies Excalidraw's font files into public/ so the canvas works offline and
// text is measured with the right font instead of waiting on a CDN.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const dest = join(root, "public", "fonts");

if (!existsSync(src)) {
  console.warn("[copy-excalidraw-assets] fonts not found, Excalidraw will fall back to its CDN");
} else {
  cpSync(src, dest, { recursive: true });
  console.log("[copy-excalidraw-assets] copied fonts to public/fonts");
}
