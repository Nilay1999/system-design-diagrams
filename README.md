# System Design Diagrams

22 system design write-ups, each paired with an editable [Excalidraw](https://excalidraw.com) architecture diagram, in a React + Vite + TypeScript app.

- **Docs** are plain Markdown in [`docs/`](docs/), so you can read them on GitHub without running anything.
- **Diagrams** are defined as code in [`src/diagrams/`](src/diagrams/) with a small DSL, then rendered as Excalidraw scenes you can pan, zoom, edit and export.

## Topics

| Topic | Category | Key ideas |
| --- | --- | --- |
| [Building Blocks & Interview Framework](docs/fundamentals.md) | Foundations | load balancing, caching, sharding, replication, CAP |
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
- Switch between **Split**, **Document** and **Diagram** views in the top bar. You can link to a view with `?view=diagram#/chat-system`.
- The diagram is a full Excalidraw canvas: drag boxes (arrows stay attached), add notes, restyle anything.
  - Edits are **saved in your browser** (localStorage) per diagram. **Reset** restores the original.
  - Export with **PNG** or **.excalidraw**. The `.excalidraw` file opens on [excalidraw.com](https://excalidraw.com).
- Toggle light/dark mode with the button in the top-right corner.

## Project structure

```text
docs/                       Markdown design documents (one per topic)
src/
  diagrams/
    dsl.ts                  Diagram-as-code helper (grid layout, bound arrows, zones)
    <topic>.ts              One diagram definition per topic
  components/
    DiagramView.tsx         Excalidraw canvas, local persistence, export
    DocView.tsx             Markdown renderer with an on-this-page index
    Sidebar.tsx             Topic navigation and search
  topics.ts                 Topic registry (metadata + doc + diagram)
  App.tsx                   Layout, routing (#/slug), theme and view mode
scripts/
  copy-excalidraw-assets.mjs
```

## Adding a topic

1. Write `docs/<slug>.md`. Every `## Heading` shows up in the page's "On this page" index.
2. Create `src/diagrams/<slug>.ts`:

   ```ts
   import { Diagram } from "./dsl";

   export default function myTopic() {
     return new Diagram("My Topic", "One-line subtitle")
       .zone("Data tier", 2, 0, 1, 2)                 // label, col, row, cols, rows
       .node("client", "Client", 0, 0, "client")      // id, label, col, row, kind
       .node("api", "API service", 1, 0, "service")
       .node("db", "Postgres", 2, 0, "db")
       .node("cache", "Redis", 2, 1, "cache")
       .edge("client", "api", "HTTPS")
       .edge("api", "db", "writes")
       .edge("api", "cache", "reads", { async: true })
       .build();
   }
   ```

   Node kinds (`client`, `edge`, `service`, `worker`, `queue`, `cache`, `db`, `storage`, `external`) each have their own shape and colour, listed in the in-app legend. Coordinates are grid cells, and fractions like `2.5` are allowed.
3. Register it in `src/topics.ts`.

If you change a diagram's source, browsers that saved edits of the old version start from the new version, because saved edits are tied to a hash of the diagram source.

## Tech

React 18, TypeScript, Vite, `@excalidraw/excalidraw`, `react-markdown` + `remark-gfm`.
