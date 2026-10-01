# Collaborative Editor (Google Docs)

> Many people edit the same document simultaneously, see each other's cursors, and everyone ends up with exactly the same text, even with network delays and offline edits.

## The problem in one minute

Each editor keeps a **local copy** of the document and applies their own keystrokes immediately — typing can't wait for a server round trip. That means several copies are changing at the same time, and edits arrive at each copy in different orders. The system must guarantee that:

1. **Every copy converges** to the same text once all edits are delivered.
2. **Each edit keeps its intent**: if Bob deletes a word while Alice types earlier in the paragraph, Bob's delete still removes that word, not whatever slid into its old position.
3. **Nothing acknowledged is ever lost**, and a reconnecting client can catch up.

Two families of algorithms solve (1) and (2): **Operational Transformation (OT)**, which transforms positional edits through a central order, and **CRDTs**, which give every character a unique identity so edits commute. The rest of the system is about routing all editors of a document to one place, persisting operations, and loading documents quickly.

| Decision | Choice | Why |
| --- | --- | --- |
| Concurrency algorithm | OT with a central server per document (CRDT is the alternative) | Simple guarantees, tiny metadata, proven for rich text |
| Ordering point | One live **session** per document, owned by one server via a lease | All ops for a doc are ordered in one place |
| Transport | WebSockets through stateless gateways | Low latency both ways |
| Durability | Append each op to an operation log **before** acknowledging | Acknowledged edits survive crashes |
| Loading | Periodic snapshots + ops since the snapshot | Opening a doc with a million ops stays fast |
| Presence | Ephemeral, in Redis with TTLs, never in the op log | Cursors change constantly and don't need history |

## Requirements

### Functional

- Create, open and edit rich-text documents (text plus formatting, lists, tables, images).
- **Real-time collaboration:** see others' edits and cursors within ~100–200 ms.
- Revision history: browse and restore earlier versions; see who changed what.
- Comments and suggestions anchored to text ranges.
- Sharing with view / comment / edit permissions; link sharing.
- **Offline editing** that syncs when the connection returns.

### Non-functional

| Property | Target |
| --- | --- |
| Local latency | Keystrokes render instantly (no network wait) |
| Remote latency | Others see an edit within ~200 ms (same region) |
| Convergence | All replicas reach the same state (strong eventual consistency) |
| Durability | No acknowledged edit is ever lost |
| Scale | 1 B documents, ~1–2 M concurrently open at peak, up to ~100 simultaneous editors per doc |
| Availability | Editing continues through server failures (brief reconnects are OK) |

## Capacity estimation

- **Active sessions:** 10 M documents opened per day; with average session lengths and daily peaks, ~**1–2 M concurrent** open documents at peak.
- **Operation rate:** an active typist produces ~2–5 ops/s (clients batch keystrokes into ops every ~100 ms). With ~1 M people typing at peak: **~2–5 M ops/s** globally. Per document, it's tiny: even 50 editors produce a few hundred ops/s.
- **Op log growth:** each op is ~100 bytes with metadata. 3 M ops/s × 100 B ≈ 300 MB/s ≈ **25 TB/day** before compaction. Snapshots let old ops move to cheap storage (still needed for full history) or be squashed into coarser history entries.
- **Snapshots:** a typical document is 10–100 KB. 1 B docs × 50 KB ≈ **50 TB** of latest snapshots, plus historical ones.
- **WebSocket connections:** 2 M concurrent editors/viewers at ~50k connections per gateway → ~40+ gateways, with headroom → ~100.

Key insight: **the load per document is small, and documents are independent**, so we shard everything by `doc_id`.

## Protocol

Messages over the WebSocket:

```jsonc
// client → server: an edit based on the last revision the client had seen
{ "type": "op", "doc": "d-1", "base_rev": 41, "client_id": "alice-tab-3", "client_seq": 7,
  "op": [ { "retain": 3 }, { "insert": "s" } ] }

// server → sender: accepted as revision 42 (after any transformation)
{ "type": "ack", "client_seq": 7, "rev": 42 }

// server → everyone else: the (possibly transformed) op
{ "type": "op", "rev": 42, "author": "alice", "op": [ { "retain": 3 }, { "insert": "s" } ] }

// presence, not persisted
{ "type": "cursor", "user": "bob", "range": [10, 14], "color": "#e8590c" }
```

Operations use a **retain / insert / delete** format over the document (as in Quill's Delta or ProseMirror steps): "keep 3 characters, insert 's'". Formatting is expressed as attributes on inserted or retained ranges.

REST endpoints handle everything that isn't real-time: `GET /docs/{id}` (snapshot + ops), `GET /docs/{id}/history`, `POST /docs/{id}/restore`, sharing and comments.

## Data model

| Store | Key | Contents |
| --- | --- | --- |
| Document metadata (SQL) | `doc_id` | Title, owner, ACLs, created/updated, latest snapshot rev |
| Operation log | `(doc_id, rev)` | The op, author, `client_id`, `client_seq`, timestamp |
| Dedup index | `(doc_id, client_id, client_seq)` → `rev` | Detects re-sent ops after reconnects |
| Snapshots (object storage) | `(doc_id, rev)` | Full document state at a revision |
| Presence (Redis) | `presence:{doc_id}` | user → cursor, selection, last seen; TTL ~30 s |
| Comments (SQL) | `comment_id` | doc, anchor (range, transformed like a cursor), thread, status |

The operation log can be a wide-column store (Cassandra/Bigtable) keyed by `doc_id` with `rev` as the clustering key, or a sharded SQL table. Reads are always "ops for doc X after rev N", which both do well.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| WebSocket gateways | Terminate connections, authenticate, forward messages to the document's session server. Stateless apart from sockets |
| Session router | Knows which session server owns each document (leases in etcd, or consistent hashing on `doc_id`) |
| Session servers | Hold the live state of the documents they own; transform, order, persist and broadcast ops |
| Operation log | Durable, append-only per document |
| Snapshotter | Periodically materialises a snapshot from the log (every ~500 ops or 5 minutes of activity) |
| Document service | Opening documents, ACL checks, history, restore |
| Presence store | Cursors and "who's here", with short TTLs |
| Async consumers | Search indexing, exports (PDF/DOCX), @mention notifications, activity feeds |

**Why one session per document?** OT needs a single, total order of operations for each document. Putting every editor's connection behind one owner makes that order trivial: the session processes ops one at a time, assigning revisions 42, 43, 44… Documents are independent, so thousands of sessions run in parallel across servers.

## Editing flow with OT

See [Concurrent edits (OT)](#diagram/edit-flow). Both Alice and Bob start from `"cat"` at revision 41.

1. Alice types `s` at the end; her client applies `insert(3, 's')` locally → `"cats"` and sends it with `base_rev = 41`.
2. At the same time Bob deletes the `c`; his client applies `delete(0)` locally → `"at"` and sends it with `base_rev = 41`.
3. Alice's op reaches the session first. Nothing happened since rev 41, so it's stored unchanged as **rev 42**, persisted, acknowledged, and broadcast.
4. Bob's client receives rev 42 while its own `delete(0)` is still unacknowledged. It transforms the incoming op against its pending op: Alice's insert at position 3 moves to position 2 because a character before it was deleted. Bob now sees `"ats"`.
5. Bob's op reaches the session with `base_rev = 41`. The session transforms it against rev 42 (Alice's insert at position 3 doesn't affect a delete at position 0), stores it as **rev 43**, and broadcasts.
6. Alice applies `delete(0)` → `"ats"`. Both copies converge.

### The transform function

For two concurrent operations `a` and `b` on the same state, `transform(a, b)` returns `(a', b')` such that applying `a` then `b'` gives the same result as `b` then `a'`. For plain-text inserts and deletes:

```text
transform(insert(p1, s), insert(p2, t)):
    if p1 < p2 or (p1 == p2 and site1 < site2): shift the second insert right by len(s)
    else: shift the first insert right by len(t)

transform(insert(p, s), delete(q, n)):
    if p <= q: the delete moves right by len(s)
    elif p >= q + n: the insert moves left by n
    else: the insert lands inside the deleted range → place it at q
```

Rich text multiplies the cases (formatting, splits, tables), which is why production OT libraries are carefully tested. The **client side** keeps a queue of unacknowledged ops and transforms each incoming server op against that queue before applying it — the "Jupiter" model used by Google Docs. Only one op per client is in flight at a time; later edits are buffered and composed together.

## Opening documents and reconnecting

See [Open & reconnect](#diagram/open-reconnect).

**Opening:**

1. The document service checks the ACL, loads the latest snapshot (say rev 40,000), reads the ops after it from the log (312 ops), and returns the document at rev 40,312.
2. The client opens a WebSocket to the document's session. If no session exists (the first editor, or after a failover), the session server acquires the document's lease and loads the same snapshot + ops.
3. The session sends any ops newer than the client's revision and the current presence list.

**Reconnecting after a network drop:**

1. While offline, the client keeps editing and buffers ops locally (IndexedDB for durability across tab reloads).
2. On reconnect, it tells the session the last revision it saw and its pending `client_seq` range.
3. The session sends the ops it missed; the client transforms its pending ops over them.
4. The client resends its pending ops. Any op the server already applied before the drop is recognised by `(client_id, client_seq)` and acknowledged with its original revision instead of being applied twice.

## Deep dives

### 1. OT vs CRDT

See [OT vs CRDT](#diagram/ot-vs-crdt).

A **sequence CRDT** (RGA, YATA/Yjs, Automerge) gives every character a globally unique ID, typically `(counter, site_id)`. An insert says "put `s` **after character (3, A)**", not "at position 3". Concurrent inserts after the same character are ordered by ID, deterministically, on every replica. Deletes mark characters as tombstones so later inserts can still find their anchors. Because operations refer to IDs rather than positions, they **commute**: any replica applying the same set of operations, in any order, reaches the same text.

| | OT | CRDT |
| --- | --- | --- |
| Needs a central server to order ops | Yes, in practice | No |
| Offline and peer-to-peer editing | Possible, harder | Natural |
| Metadata per character | None | An ID, plus tombstones for deletes |
| Server CPU | Transforms ops | Merges ops (or just relays them) |
| Rich-text maturity | Very high (Google Docs) | High (Yjs, Automerge, Figma's multiplayer uses a CRDT-like approach) |
| Undo | Transform-based, tricky | Also tricky (undo must be a new op) |

Many modern editors use CRDTs with a server anyway — for auth, persistence and relaying — so the architecture looks almost the same. The main difference is that the server doesn't need to transform anything, and offline merges are easier.

### 2. Session ownership and failover

- The session router keeps `doc_id → server` via leases in etcd (or consistent hashing with a lease to fence the old owner).
- If a session server dies, its leases expire. The next connection for each document triggers a new owner to load snapshot + log.
- Clients reconnect automatically and resend unacknowledged ops, which are deduplicated.
- **Fencing:** the op log rejects appends whose `rev` isn't exactly `last_rev + 1`. A zombie owner that lost its lease will fail its next append, so two servers can never both assign rev 43.

### 3. Durability and ordering

- **Persist before ack:** the session appends to the op log, then acknowledges. If it crashes between the two, the client resends, and the dedup index returns the existing revision.
- Revisions are per-document and gap-free, so any client can detect a missing op and request it.
- To reduce write load, the session can batch several ops into one log write every ~50 ms, acknowledging them together.

### 4. Snapshots, history and restore

- The snapshotter materialises the document every ~500 ops or after a period of inactivity. Loading then needs at most a few hundred ops of replay.
- **History UI:** group ops into "versions" by author and time gaps (e.g. 5 minutes idle). Show a diff by reconstructing two snapshots.
- **Restore** isn't rewinding the log. It creates a new op that transforms the current document into the old content, so collaborators' views stay consistent and the restore itself is undoable.

### 5. Presence and cursors

- Cursor positions are sent frequently (throttled to ~10/s per user) and broadcast by the session.
- They're **transformed like ops**: when text is inserted before Bob's cursor, his cursor moves right.
- Stored only in memory and Redis with a TTL, never in the op log. If a tab closes without saying goodbye, the TTL removes it.

### 6. Large documents and many participants

- **Viewers vs editors:** hundreds of viewers don't send ops. Broadcast to them through a pub/sub fan-out tier so the session only serves editors.
- **Very large documents** (a 500-page spec): split into blocks or sections with separate sequences, and load the visible part first.
- **Hot documents** (an all-company doc during an event): rate-limit cursor updates, batch broadcasts, and cap concurrent editors.

### 7. Comments and suggestions

- A comment anchors to a range. The range is transformed with every op, like a cursor, so it stays attached to the right text. If the anchored text is deleted, the comment becomes "orphaned" but stays visible.
- Suggestions ("track changes") are ops stored with a `suggested` flag; accepting one converts it to a normal op.

## Scaling and reliability

- **Shard by `doc_id`** everywhere: session ownership, op log, snapshots, presence.
- **Gateways** scale horizontally; they only proxy frames.
- **Regions:** a document's session lives in one region (usually near most of its editors). Remote editors see slightly higher latency. Moving a session between regions is a planned handover: drain, persist, move the lease.

### Failure modes

| Failure | What users see | Handling |
| --- | --- | --- |
| Gateway dies | Brief disconnect | Client reconnects to another gateway; resends pending ops |
| Session server dies | ~Seconds of "reconnecting…" | Lease expires; new owner loads snapshot + log; ops deduplicated |
| Op log slow | Acks slow; typing still instant locally | Batch appends; alert on ack latency |
| Network partition for one client | Offline mode | Local buffer; merge on reconnect |
| Bad op (bug) corrupts a document | Wrong content | Validate ops server-side; restore from an earlier snapshot; op log allows replay with a fixed transform |

## Security

- ACL check when opening, when connecting the WebSocket, and re-checked when permissions change (the session disconnects users who lose access).
- Viewers' connections are read-only: the session rejects ops from them.
- Rate-limit ops per connection to stop a malicious client from flooding a document.

## Observability

- Op round-trip time (send → ack) p50/p99.
- Remote propagation latency (op accepted → received by other editors).
- Reconnects per minute; duplicate ops detected.
- Session load time (snapshot + replay length).
- Transform errors or divergence detected (clients can send a periodic checksum of their document to compare with the server's).

## Trade-offs to discuss

- **OT + central server vs CRDT:** simpler guarantees and less metadata vs offline-first and serverless merging.
- **Snapshot frequency:** frequent snapshots make loads faster but cost more writes and storage.
- **One op in flight per client vs pipelining:** one in flight keeps client-side transformation simple; pipelining lowers latency on slow links but complicates the algorithm.
- **Where sessions live:** one region per document is simple; multi-region editing needs cross-region ordering (or a CRDT).

## Interview follow-up questions

- **Why not just lock paragraphs?** Locks make collaboration feel slow and break down with offline edits; OT/CRDT let everyone type anywhere.
- **Why not last-writer-wins per character?** Positions shift with every edit, so "the same character" isn't well defined without transformation or unique IDs.
- **How do you implement undo?** Undo creates an inverse op of the user's own last change, transformed past everyone else's later changes — you only undo your own edits.
- **How would you detect divergence in production?** Clients periodically send a hash of their document at a revision; the session compares it with its own and forces a reload on mismatch.
- **How would you support 1,000 simultaneous editors?** Split the document into independently-sequenced blocks, batch broadcasts, and throttle presence.
