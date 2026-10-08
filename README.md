# System Design Diagrams

**Live site:** https://system-design-diagrams.vercel.app/

24 in-depth system design write-ups, each paired with a set of editable [Excalidraw](https://excalidraw.com) diagrams, in a React + Vite + TypeScript app.

- **Docs** are plain Markdown in [`docs/`](docs/), so you can read them on GitHub without running anything. Each one covers requirements, capacity math, API, data model, architecture, step-by-step request flows, deep dives, failure modes, observability, trade-offs and interview follow-ups.
- **Diagrams** are defined as code in [`src/diagrams/`](src/diagrams/) with a small DSL, then rendered as Excalidraw scenes you can pan, zoom, edit and export. Every topic has 4–5 diagram tabs: a detailed architecture, sequence diagrams for the main request flows, and deep dives (data models, algorithms, state machines).

## Topics

| Topic | Category | Key ideas |
| --- | --- | --- |
| [Building Blocks & Interview Framework](docs/fundamentals.md) | Foundations | load balancing, caching, sharding, replication, CAP |
| [Networking Fundamentals](docs/networking.md) | Foundations | DNS, TCP/UDP, TLS 1.3, HTTP/1.1–3, WebSockets/SSE, NAT, VPCs |
| [Core Concepts: Data & Distributed Systems](docs/core-concepts.md) | Foundations | B-tree vs LSM, isolation levels, Raft, 2PC vs saga, Bloom filters |
| [URL Shortener](docs/url-shortener.md) | Infrastructure | base62, key generation, read-heavy caching |
| [Distributed Rate Limiter](docs/rate-limiter.md) | Infrastructure | token bucket, sliding window, Redis + Lua |
| [Distributed Key-Value Store](docs/key-value-store.md) | Infrastructure | consistent hashing, quorums, gossip, LSM trees |
| [Distributed Cache](docs/distributed-cache.md) | Infrastructure | sharding, eviction, cache-aside, stampedes, hot keys |
| [Distributed Message Queue](docs/message-queue.md) | Infrastructure | partitions, ISR replication, consumer groups, exactly-once |
| [Distributed Job Scheduler](docs/job-scheduler.md) | Infrastructure | leases, fencing, retries, timing wheels |
| [File Storage & Sync (Dropbox)](docs/file-sync.md) | Storage & Collaboration | chunking, dedup, metadata journal, conflicts |
| [Collaborative Editor (Google Docs)](docs/collaborative-editor.md) | Storage & Collaboration | OT vs CRDT, operation log, presence |
| [Chat System](docs/chat-system.md) | Social & Messaging | WebSockets, message routing, presence, receipts |
| [News Feed](docs/news-feed.md) | Social & Messaging | fan-out on write vs read, celebrity problem |
| [Notification System](docs/notification-system.md) | Social & Messaging | per-channel queues, idempotency, retries |
| [Web Crawler](docs/web-crawler.md) | Media & Search | URL frontier, politeness, Bloom filters, SimHash |
| [Search Autocomplete](docs/typeahead.md) | Media & Search | trie with top-k, offline aggregation |
| [Video Streaming Platform](docs/video-streaming.md) | Media & Search | transcoding DAG, HLS/DASH, CDN |
| [Proximity Service (Yelp)](docs/proximity-service.md) | Media & Search | geohash, quadtree, radius search |
| [Leaderboard & Top-K](docs/leaderboard.md) | Data & Analytics | Redis sorted sets, count-min sketch, windows |
| [Ad Click Aggregator](docs/ad-click-aggregator.md) | Data & Analytics | Flink, OLAP, dedup, Lambda architecture |
| [Ride Sharing](docs/ride-sharing.md) | Marketplace & Fintech | geohash/H3, matching, location streams |
| [Ticket Booking (BookMyShow)](docs/ticket-booking.md) | Marketplace & Fintech | seat holds, locking strategies, waiting room |
| [E-commerce Checkout (Amazon)](docs/e-commerce.md) | Marketplace & Fintech | saga, outbox, inventory, flash sales |
| [Payment System](docs/payment-system.md) | Marketplace & Fintech | idempotency, double-entry ledger, reconciliation |

## Running the app

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

`npm install` also copies Excalidraw's fonts into `public/fonts` (see `scripts/copy-excalidraw-assets.mjs`), so diagrams render offline.

## Using the app

- Pick a topic in the sidebar, or search by keyword (e.g. `cache`, `kafka`, `idempotency`).
- Switch between **Split**, **Document** and **Diagram** views in the top bar.
- Each topic has several **diagram tabs** (e.g. *Architecture*, *Redirect flow*, *Key generation & data model*). Links inside a doc (marked ⧉) and the "Diagrams" row under "On this page" open the matching tab.
- Link straight to a tab with `/topics/<topic>/<tab>`, e.g. `/topics/url-shortener/redirect-flow?view=diagram`. Old `#/<topic>/<tab>` links still redirect.
- The diagram is a full Excalidraw canvas: drag boxes (arrows stay attached), add notes, restyle anything.
  - Edits are **saved in your browser** (localStorage) per diagram tab. **Reset** restores the original.
  - Export with **PNG** or **.excalidraw**. The `.excalidraw` file opens on [excalidraw.com](https://excalidraw.com).
- Toggle light/dark mode with the button in the top-right corner.

## Project structure

```text
docs/                       Markdown design documents (one per topic)
src/
  diagrams/
    dsl.ts                  Diagram-as-code helpers: Diagram (grid layout) and Sequence (sequence diagrams)
    <topic>.ts              The diagram tabs for one topic
  topics/
    curated.ts              Curated topic metadata (+ doc + diagram tabs)
    catalog.ts              TopicCatalog: lookup, search, grouping, sidebar sections
    paths.ts                Topic URLs and legacy #/slug parsing
    index.ts                useTopics(): the one place new topic sources plug in
  components/
    diagram/                Excalidraw canvas: source strategies (DSL / raw scene), saved-edit
                            store, autosave hook, exporters, legend
    DocView.tsx             Markdown renderer with an on-this-page index
    Sidebar.tsx             Topic navigation (Curated / Community) and search
    Tabs.tsx                Reusable tab list (view switcher, diagram tabs)
  layout/AppShell.tsx       Top bar, sidebar drawer and main area shared by pages
  pages/topic/              Topic page and its view-mode (split / doc / diagram) hook
  theme/                    ThemeProvider + useTheme
  providers/                Router, TanStack Query and theme providers
  hooks/                    usePreference, useDebouncedCallback
  lib/                      Safe localStorage, download, text and viewport helpers
  api/                      Fetch client + TanStack Query setup for the community API
  App.tsx                   Routes (/topics/:slug/:view?) and legacy #/slug redirects
scripts/
  copy-excalidraw-assets.mjs
```

## Tests

`npm test` runs the unit tests (Vitest) for storage, routing paths, the topic catalog, saved
diagram edits, and integrity checks on every curated topic (unique slugs and tabs, doc links that
point at real tabs). CI runs them before each deploy.

## Adding a topic

1. Write `docs/<slug>.md`. Every `## Heading` shows up in the page's "On this page" index. Link to a diagram tab with `[text](#diagram/<tab-id>)`.
2. Create `src/diagrams/<slug>.ts`. It exports a list of tabs; each tab builds either a `Diagram` (boxes on a grid) or a `Sequence` (a sequence diagram):

   ```ts
   import { Diagram, Sequence, type DiagramSpec } from "./dsl";

   function architecture() {
     return new Diagram("My Topic — architecture", "One-line subtitle")
       .node("client", "Client", 0, 0, "client")                       // id, title, col, row, kind
       .node("api", "API service", 1, 0, "service", { detail: ["stateless", "autoscaled"] })
       .node("db", "Postgres", 2, 0, "db", { detail: "orders, users" })
       .node("cache", "Redis", 2, 1, "cache")
       .zone("Data tier", ["db", "cache"])                             // dashed box around these nodes
       .edge("client", "api", "HTTPS")
       .edge("api", "db", "writes")
       .edge("api", "cache", "reads", { async: true })                 // also: both, none, via: [[col, row]]
       .table("orders", "orders", ["order_id  PK", "user_id", "status"], 0, 2)
       .panel("Notes", ["Anything worth calling out"], 3, 0, { tone: "info" })
       .build();
   }

   function readFlow() {
     return new Sequence("Read flow", "What happens on GET /items/42")
       .actor("c", "Client", "client")
       .actor("api", "API", "service")
       .actor("cache", "Redis", "cache")
       .msg("c", "api", "GET /items/42")
       .msg("api", "cache", "GET item:42")
       .alt("cache hit", "api", "cache")                               // also opt, loop, par, break, critical
       .msg("cache", "api", "value", { reply: true })
       .else("cache miss")
       .msg("api", "api", "load from DB, fill cache")
       .end()
       .note("Anything worth calling out", "api")
       .build();
   }

   export default [
     { id: "architecture", name: "Architecture", build: architecture },
     { id: "read-flow", name: "Read flow", build: readFlow },
   ] satisfies DiagramSpec[];
   ```

   Node kinds (`client`, `edge`, `service`, `worker`, `queue`, `cache`, `db`, `storage`, `external`) each have their own shape and colour, listed in the in-app legend. Coordinates are grid cells and fractions like `2.5` are allowed; box heights grow to fit their text. Use `{ highlight: true }` to draw a node in red (a failure, a hot spot).
3. Register it in `src/topics/curated.ts`.

If you change a diagram's source, browsers that saved edits of the old version start from the new version, because saved edits are tied to a hash of the diagram source.

## Tech

React 18, TypeScript, Vite, `@excalidraw/excalidraw`, `react-markdown` + `remark-gfm`.
