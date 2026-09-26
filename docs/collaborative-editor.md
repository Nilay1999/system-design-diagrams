# Collaborative Editor (Google Docs)

> Many people edit the same document simultaneously, see each other's cursors, and everyone ends up with exactly the same text, even with network delays and offline edits.

## Requirements

### Functional
- Create, open and edit rich-text documents.
- **Real-time collaboration:** see others' edits and cursors within ~100–200 ms.
- Revision history; restore old versions.
- Comments; sharing with view/comment/edit permissions.
- Offline editing that syncs later.

### Non-functional
- **Convergence:** all replicas reach the same state (strong eventual consistency).
- **Intention preservation:** an edit does what the author meant, even when others' edits interleave.
- Low latency locally. Typing never waits for the server.
- Durable: no acknowledged edit is lost.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Documents | 1 B docs, 10 M opened/day | Active sessions ≈ 1–2 M concurrently at peak |
| Ops | ~2 ops/s per active editor while typing | ~2–4 M ops/s globally at peak, sharded by doc |
| Editors per doc | Usually 1–5, rarely 100+ | Per-document session load is small, so shard by `doc_id` |

## The core problem

Alice and Bob both start from `"cat"`:
- Alice inserts `"s"` at position 3 → `"cats"`
- Bob deletes position 0 → `"at"`

If Bob naively applies Alice's `insert(3, "s")` to `"at"`, the position is wrong. Concurrent operations must be **transformed** or designed to **commute**.

## Two approaches

### Operational Transformation (OT), used by Google Docs
- Every operation is made against a known **revision**.
- A central server **orders** operations. When an op arrives based on an old revision, the server **transforms** it against all ops it missed (`insert(3,"s")` after `delete(0)` becomes `insert(2,"s")`).
- Clients keep pending ops and transform incoming server ops against them.
- A central server makes OT simpler (the Jupiter/Wave model). Peer-to-peer OT is notoriously hard to get right.

### CRDTs (Conflict-free Replicated Data Types), used by Figma-like tools, Yjs, Automerge
- Every character gets a **unique, ordered ID** (e.g. `(counter, site_id)`) instead of an index. Inserts reference neighbours by ID, and deletes leave **tombstones**.
- Operations **commute**, so replicas converge in any delivery order. No central transform is needed, which suits offline and peer-to-peer editing.
- Costs: metadata overhead per character and tombstone growth. Modern implementations (Yjs, Automerge 2) compress this well.

| | OT | CRDT |
| --- | --- | --- |
| Needs central ordering | Yes (practically) | No |
| Offline / P2P | Harder | Natural |
| Memory overhead | Low | Higher (IDs, tombstones) |
| Maturity for rich text | Very high (Docs) | High (Yjs, Automerge) |

## API / protocol

```json
// client → server over WebSocket
{ "type": "op", "doc": "d-1", "base_rev": 41, "client_seq": 7, "op": [{"retain": 3}, {"insert": "s"}] }
// server → sender
{ "type": "ack", "client_seq": 7, "rev": 42 }
// server → other editors
{ "type": "op", "rev": 42, "author": "alice", "op": [...] }
// presence
{ "type": "cursor", "user": "bob", "range": [10, 14] }
```

## High-level design

1. Opening a doc: the **document service** checks ACLs, loads the latest **snapshot** and replays ops after it from the **operation log**.
2. The client connects via the **WebSocket gateway**, which routes all connections for a `doc_id` to the same **collaboration session** (consistent hashing on `doc_id`), so ops for one document are ordered in one place.
3. The session transforms each incoming op, assigns the next revision, **persists it to the op log**, ACKs the sender and broadcasts to the other editors.
4. **Presence/cursors** are ephemeral: broadcast through the session and stored in Redis with a short TTL, never persisted.
5. A **snapshotter** periodically compacts the op log into a new snapshot (every N ops or minutes), keeping load time bounded.

## Deep dives

### Ordering and durability
- Persist before ACK. The op log is append-only per document (a DB table keyed by `(doc_id, rev)`, or a Kafka partition by `doc_id`).
- `rev` is a per-document sequence, so gaps or duplicates are detectable, and clients resend unacked ops after reconnecting.

### Session ownership and failover
- One owner per document at a time (via lease/consistent hashing). If a session server dies, another takes over by loading the snapshot and tailing the op log. Clients reconnect and resend pending ops, which are deduplicated by `(client_id, client_seq)`.

### Offline editing
The client buffers ops locally (IndexedDB). On reconnect, it sends them with their old `base_rev`, and the server transforms them. CRDT-based designs simply merge.

### Version history
Snapshots plus the op log make any revision reconstructible. The UI groups ops into named versions by time and author.

### Large documents and many editors
- Split very large docs into sections or blocks, each with its own sequence.
- For hundreds of viewers, separate **viewers** (read-only fan-out via pub/sub) from **editors**.

### Permissions and comments
ACLs are checked on connect and re-validated on changes. Comments anchor to text ranges and move with edits, because they are transformed like cursors.

## Trade-offs

- **OT + central server:** simpler guarantees and less metadata, but it needs the server online.
- **CRDT:** offline-first and P2P-friendly, but with more metadata and harder rich-text semantics.
- **Snapshot frequency:** frequent snapshots give faster loads but more storage writes.
