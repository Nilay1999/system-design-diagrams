# CLAUDE.md

Guidance for Claude Code sessions working in this repo. The README covers the user-facing details; this file covers how the project is put together, the conventions to follow, and what's in progress.

## Working with the owner

- Write in plain language. Avoid dense or overly compressed phrasing, in docs and in replies.
- **Never use browser automation** (the Claude-in-Chrome tools), not even to check the UI. Verify with `npm test`, `npx tsc -b`, `npm run build`, the layout lint, and scripts. To look at a generated image, render it to PNG with `@resvg/resvg-js` and read the file. When something can only be judged visually, say so and ask the owner to look.
- Naming and visual choices (site name, themes) are the owner's call. Offer a few options with a recommendation rather than picking silently.
- Commit or push only when asked.

## What this is

**Yggdrasil**, "the tree of engineering knowledge": a React 18 + Vite + TypeScript site where every topic is a Markdown write-up beside editable Excalidraw diagrams. It has two sections ("tracks"), which never mix:

| Track | URL | Content |
| --- | --- | --- |
| System Design | `/topics/<slug>/<tab?>` | 24 designs, docs in `docs/*.md`, diagrams in `src/diagrams/*.ts` |
| Kubernetes | `/kubernetes` (overview), `/kubernetes/<slug>/<tab?>` | 29 topics, docs in `docs/kubernetes/*.md`, diagrams in `src/diagrams/kubernetes/*.ts` |

Live site: https://yggdrasil-books.vercel.app (deployed by `.github/workflows/deploy.yml` on push to `main`).

## Commands

```bash
npm install          # also copies Excalidraw fonts into public/fonts
npm run dev          # http://localhost:5173
npm test             # Vitest: unit tests, topic integrity, diagram layout lint
npx tsc -b           # typecheck
npm run build        # tsc + vite build + writes per-page share HTML (see below)
npm run og           # redraw link-preview images in public/og/ (commit them)
npm run icons        # regenerate src/diagrams/icons.generated.ts
```

Run `npx tsc -b && npm test && npm run build` before calling any change done.

## Architecture

- `src/site.ts`: site name, tagline, logo (`public/yggdrasil.svg`), and `pageTitle()` ("Topic · Section · Yggdrasil").
- `src/tracks/`: a `Track` is a self-contained library: id, section `name`, small `logo`, `home`, its `TopicCatalog`, sidebar `sources`, diagram `legend`, optional `overview` (landing-page text; both tracks have one). `TrackRoute` provides the track to its routes and sets `<html data-track>`. `useTopics()` returns the current track's catalog, so pages don't care which track they're in.
- `src/App.tsx`: routes. System Design under `/` (the System Design `OverviewPage`, which is also the site home) and `/topics/...`; Kubernetes under `/kubernetes` (index = `OverviewPage`).
- `src/topics/`: `Topic` (has `track`), `curated.ts` (System Design list), `kubernetes.ts` (Kubernetes list, sidebar order = list order), `paths.ts` (`TRACK_BASE`, `topicPath`).
- `src/diagrams/dsl.ts`: diagram-as-code. `Diagram` (grid: col × 330px, row × 170px; nodes 210px wide) and `Sequence`. Node kinds include Kubernetes-specific `control` (control plane) and `object` (API objects). `K8S_LEGEND` relabels the kinds for the Kubernetes track. Icons are inferred from text (`icon-rules.ts`) or set with `{ icon: "name" }` (names in `icons.generated.ts`).
- `src/diagrams/layout-lint.ts`: reports overlapping boxes, boxes crossing a zone border, and arrows passing through a box they don't connect. `src/topics/kubernetes.test.ts` runs it on every Kubernetes tab. Fix a failing arrow with `{ via: [[col, row]] }` waypoints or by moving nodes. It does not check edge-label placement.
- `src/components/DocView.tsx`: Markdown rendering. Supports `[text](#diagram/<tab-id>)` links, GitHub-style callouts via `src/lib/remarkCallouts.ts` (`> [!TIP]`, `[!NOTE]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`), and light YAML/bash highlighting (`src/lib/highlight.ts`).
- `src/components/diagram/editStore.ts`: user edits saved in localStorage. Keys are prefixed by track (`kubernetes:<slug>`), so slugs can repeat across tracks safely. System Design keys are unchanged from before tracks existed; don't change them.

### Link previews (LinkedIn, Slack, X)

Previews don't run JavaScript. `src/share/pages.ts` lists every shareable page (home, track overviews, topics, every diagram tab) with title, description and image. A plugin in `vite.config.ts` loads it at build time (via Vite's `runnerImport`) and writes `dist/<path>/index.html` for each page, replacing the `<!-- share:start --> … <!-- share:end -->` block in `index.html`. Static files take priority over the SPA rewrite in `vercel.json`.

- Absolute URLs: `SITE_URL` env, else `VERCEL_PROJECT_PRODUCTION_URL`, else `DEFAULT_SITE_URL`.
- `scripts/build-og-images.mjs` (`npm run og`) draws 1200×630 cards into `public/og/` (site, one per track, one per topic) with `@resvg/resvg-js` and the system Inter font. The images are committed, not built in CI (CI has no Inter). A missing topic image falls back to the track image.

### Theme

One colour theme, Nordic (deep teal top bar, sea-green accent, gold), the same in both tracks. `<html data-theme="light|dark">` is set by `src/theme/ThemeProvider.tsx` and switched with `ThemeToggle`. The light and dark values are the CSS variables on `:root` at the top of `src/styles.css`; the "Theme" section further down holds the rules that read the extra ones (`--topbar-*`, `--block-*`, `--tok-*`, `--accent-2`). Colour changes must keep text contrast ≥ 4.5:1 (check with a quick script; there's no visual check).

## Adding a Kubernetes topic

1. Write `docs/kubernetes/<slug>.md`: `# Title`, a `>` one-line summary, `## The idea in one minute` (a table), a `> [!TIP]` real-life analogy, the mechanics, a FoodDash example with YAML, `## Watch out` as a `> [!WARNING]` list, and `## Interview questions`. Use the FoodDash services (`orders-api`, `payments-api`, `restaurant-api`, `delivery-tracker`, `notification-worker`, `report-job`) for examples.
2. Write `src/diagrams/kubernetes/<slug>.ts` exporting 2–4 `DiagramSpec`s. **Every tab must be linked from the doc** with `[text](#diagram/<id>)`; the tests enforce this.
3. Register it in `src/topics/kubernetes.ts` (title, category, summary, tags).
4. Run `npm test` (layout lint included), then `npm run og` and commit the new image.

System Design topics follow the same pattern with `docs/`, `src/diagrams/` and `src/topics/curated.ts` (see the README).

## Status (as of 2026-10-25)

Work is on branch `feat/kubernetes-track`. Done: the Kubernetes track (29 topics, ~98 diagrams), the Yggdrasil name and logo, per-page share HTML and preview images, and the Nordic theme (the other palettes and the theme dropdown were removed on 2026-10-26).

Open items:

- **Preview images.** `public/og/` cards still use the old navy and purple; they could be redrawn in the Nordic colours (`scripts/build-og-images.mjs`, then `npm run og`).
- **Domain.** Moving from `system-design-diagrams.vercel.app` to `yggdrasil-books.vercel.app` (code, README and `DEFAULT_SITE_URL` updated 2026-10-26). The owner adds the domain in Vercel (Settings → Domains), renames the project to `yggdrasil`, and sets `SITE_URL=https://yggdrasil-books.vercel.app`. After deploying, check links with LinkedIn Post Inspector, and confirm Vercel serves `dist/kubernetes/index.html` at `/kubernetes`.
- **Bundle size.** All docs load eagerly, so the main JS grew from ~830 KB to ~1.3 MB. An option is to lazy-load the Kubernetes track's catalog.
- **Icon placeholders.** Diagram icons appeared as placeholder squares in an early check, in both tracks. It's unconfirmed whether this is just loading time.
- The original Kubernetes source guides live only on the owner's machine; their content is already in `docs/kubernetes/`.
