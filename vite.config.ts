import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, runnerImport, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

type ShareModule = typeof import("./src/share/build");

/** Production URL for link previews: SITE_URL, else Vercel's production domain, else the default. */
function siteUrl(fallback: string): string {
  const fromVercel = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return (process.env.SITE_URL || fromVercel || fallback).replace(/\/+$/, "");
}

/**
 * Writes dist/<path>/index.html for every shareable page, each with its own title and link-preview
 * tags. Link previews (LinkedIn, Slack, X) never run JavaScript, so the SPA's one index.html isn't
 * enough. Static files win over the SPA rewrite in vercel.json, so each page is served directly.
 */
function sharePages(): Plugin {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "share-pages",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const { module: share } = await runnerImport<ShareModule>("/src/share/build.ts", { root, configFile: false, logLevel: "warn" });
      const template = readFileSync(join(outDir, "index.html"), "utf8");
      const block = /<!-- share:start[\s\S]*?<!-- share:end -->/;
      if (!block.test(template)) throw new Error("index.html is missing the <!-- share:start --> … <!-- share:end --> block");
      const url = siteUrl(share.DEFAULT_SITE_URL);
      const generated = (image: string) => existsSync(join(root, "public", image));

      const pages = share.allSharePages();
      for (const page of pages) {
        const image = [page.image, page.fallbackImage, share.siteImage].find(generated) ?? page.image;
        const html = template.replace(block, share.headTags(page, url, image));
        const dir = page.path === "/" ? outDir : join(outDir, page.path);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.html"), html);
      }
      console.log(`share-pages: wrote ${pages.length} pages for ${url}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), sharePages()],
  // Excalidraw reads process.env.IS_PREACT at runtime.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    // Excalidraw ships a few large chunks of its own; they are lazy-loaded.
    chunkSizeWarningLimit: 2500,
  },
});
