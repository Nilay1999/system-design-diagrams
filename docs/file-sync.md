# File Storage & Sync (Dropbox / Google Drive)

> Users drop files into a folder, and the files appear on all their devices and can be shared with others. Large files sync fast because only changed parts move.

## The problem in one minute

A sync service has two very different kinds of data:

- **File contents** — huge (exabytes), written once, read occasionally. They need cheap, extremely durable storage and efficient transfer.
- **Metadata** — which files exist, where, which version, who can see them. Small, but every sync decision depends on it, and it must never go backwards or disagree between devices.

The design separates the two. Files are split into **content-addressed chunks** stored in a block store; a file version is just an **ordered list of chunk hashes** stored in a metadata database. Syncing becomes "compare lists of hashes, move only the missing chunks".

| Decision | Choice | Why |
| --- | --- | --- |
| File representation | ~4 MB content-defined chunks, named by SHA-256 | Delta sync and dedup for free |
| Bytes path | Client uploads chunks directly to the block store with pre-signed URLs | App servers never stream file data |
| Metadata store | Sharded SQL, sharded by `namespace_id` | Strong consistency and ordering per user / shared folder |
| Change tracking | A per-namespace journal with a gap-free sequence number | Each device keeps a cursor and asks "what changed since N?" |
| Notifications | Long polling (or WebSocket) on the journal | Devices learn about changes within seconds |
| Conflicts | Optimistic concurrency with `base_version`; loser becomes a "conflicted copy" | Never silently lose a user's edit |
| Durability | Erasure-coded object storage across zones | 11 nines at a fraction of the cost of triple replication |

## Requirements

### Functional

- Upload, download, create, rename, move, and delete files and folders.
- **Automatic sync** across a user's devices, including edits made offline.
- **Version history** (e.g. 30 or 180 days) and restore; a trash for deleted files.
- **Sharing**: share folders with other users (viewer/editor) and create public links.
- Selective sync and on-demand files (mobile, "files on demand" on desktop).

### Non-functional

| Property | Target |
| --- | --- |
| Durability | Never lose a committed file (11 nines) |
| Consistency | A device must never see metadata go backwards; all devices converge |
| Sync latency | A small change appears on other online devices within ~5 s |
| Bandwidth | Don't re-upload data the server already has |
| Scale | 500 M users, 100 M daily active, files up to 50 GB |
| Availability | 99.99 % for metadata; uploads/downloads retry transparently |

## Capacity estimation

- **Storage:** 500 M users × ~10 GB used on average = **5 EB logical**. Dedup across versions and duplicate files typically saves 30–50 %, and erasure coding costs ~1.4× instead of 3× for replication → roughly **3–4 EB physical**.
- **Change rate:** 100 M DAU × ~2 file changes/day = 200 M commits/day ≈ **2,300 commits/s** average, ~7k/s at peak.
- **Upload bandwidth:** assume the average change uploads 2 new chunks after dedup (~8 MB): 2,300 × 8 MB ≈ **18 GB/s** into the block store. This is why bytes must bypass application servers.
- **Metadata:** ~200 files per user × 500 M users = **100 B file records**, plus versions. At ~500 B each, tens of TB → must be sharded.
- **Notification connections:** 100 M DAU with ~2 devices each online → up to **200 M open long polls**. At ~50k–100k connections per server, that's a few thousand notification servers.

## API

```http
# 1. Which chunks does the server still need?
POST /v1/files/diff
{ "namespace_id": "ns_A", "path": "/Q3/report.pptx", "chunk_hashes": ["h1", "h2'", "h3", "…"] }
→ 200 { "missing": ["h2'"], "upload_urls": { "h2'": "https://blocks…?sig=…" } }

# 2. Upload missing chunks straight to the block store (parallel, resumable)
PUT https://blocks…/h2'?sig=…            (compressed chunk bytes)

# 3. Commit the new version
POST /v1/files/commit
{ "namespace_id": "ns_A", "path": "/Q3/report.pptx", "base_version": 41,
  "chunk_hashes": ["h1", "h2'", "h3", "…"], "size": 1073741824, "client_mtime": "…" }
→ 200 { "version": 42, "seq": 90113 }
→ 409 { "error": "conflict", "latest_version": 42 }

# 4. Learn about changes
GET /v1/notify?cursors=ns_A:90112,ns_S:4001        (long poll, ≤ 60 s)
→ 200 { "changed": ["ns_A"] }
GET /v1/changes?namespace_id=ns_A&cursor=90112&limit=500
→ 200 { "entries": [ { "path": "/Q3/report.pptx", "version": 42, "op": "edit", "chunks": ["…"] } ], "cursor": 90113, "has_more": false }

# 5. Download
GET /v1/files?namespace_id=ns_A&path=/Q3/report.pptx&version=42   → chunk list + signed download URLs
```

Other endpoints: `move`, `delete`, `restore(version)`, `share(folder, user, role)`, `create_link(path)`.

## Data model

See the [Data model](#diagram/data-model) diagram.

| Table | Key | Purpose |
| --- | --- | --- |
| `namespaces` | `namespace_id` | A user's root folder, or a shared folder. The unit of sharding and ordering |
| `mounts` | `(user_id, namespace_id)` | Where a shared namespace appears in a user's tree, and their role |
| `files` | `(namespace_id, file_id)` | Current path, latest version, deleted flag |
| `versions` | `(file_id, version)` | Immutable: ordered chunk list, size, who/which device, time |
| `chunks` | `hash` | Global, content-addressed: size, storage location, reference count |
| `journal` | `(namespace_id, seq)` | Gap-free ordered log of every change in the namespace |

**Why shard by namespace?** Every operation a device does — list changes since my cursor, commit a file, move a folder — touches a single namespace. Keeping each namespace on one shard means these operations are single-shard transactions, and the journal sequence can be assigned without distributed coordination. Shared folders are their own namespaces, so their changes are ordered consistently for every member.

**Paths vs IDs:** store files by ID with a `parent_id` (or path) so a folder rename is one row update instead of rewriting every descendant's path.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Desktop client | Watches the file system, chunks and hashes files, keeps a local SQLite index (path → chunk hashes, last synced version, cursors), uploads/downloads chunks, applies remote changes |
| API gateway | Auth, rate limits, routing to the metadata shard for a namespace |
| Metadata service | Diff, commit, list changes, permissions, sharing |
| Metadata DB | Sharded MySQL/Postgres (or a distributed SQL database) |
| Block service + block store | Issues pre-signed URLs, verifies chunk hashes; object storage with erasure coding across zones |
| Journal | Per-namespace ordered change log; also published to Kafka for async consumers |
| Notification service | Holds long polls; wakes devices when a namespace's sequence advances |
| Async workers | Thumbnails and previews, full-text search indexing, virus scanning, garbage collection |
| CDN | Downloads of shared links and previews |

## Uploading a change

See [Upload & commit](#diagram/upload).

1. The client's file-system watcher notices `report.pptx` changed. It waits for writes to settle (the app may still be saving).
2. It re-chunks the file with **content-defined chunking** and hashes each chunk (SHA-256). Comparing with its local index, it already knows most chunks are unchanged.
3. `POST /diff` sends the chunk list. The server replies with only the hashes it doesn't have anywhere, and pre-signed upload URLs for those.
4. The client uploads missing chunks **directly to the block store**, in parallel, compressed and encrypted in transit. Each chunk upload is independent, so a dropped connection only retries one chunk.
5. `POST /commit` with `base_version = 41`. In one transaction on the namespace's shard, the metadata service checks the base version is still the latest, inserts version 42, increments chunk reference counts, and appends a journal entry with the next sequence number.
6. It publishes the new sequence to the notification system and returns.

**The block store verifies hashes** before accepting a chunk, and the commit is rejected if any referenced chunk is missing. A client can never commit a version that points at data the server doesn't have.

## Syncing other devices

See [Sync to other devices](#diagram/download).

1. Each device holds a long poll listing its namespaces and cursors.
2. When a namespace's sequence passes the device's cursor, the poll returns "namespace A changed".
3. The device calls `/changes?cursor=…` and receives entries in order.
4. For each entry, it compares chunk lists with what it has locally and downloads only missing chunks.
5. It reassembles the file in a temporary location, verifies the hashes, and atomically renames it into place. Then it saves the new cursor.

Because the cursor is a position in an ordered journal, a device that was offline for a week simply pages through everything since its cursor. If the journal has been trimmed past its cursor, it falls back to a full listing and reconciles.

## Deep dives

### 1. Chunking and deduplication

See [Chunks & dedup](#diagram/chunks).

- **Delta sync:** editing 1 MB of a 1 GB file re-uploads one or two chunks, not the whole file.
- **Content-defined chunking:** with fixed 4 MB blocks, inserting one byte at the start of a file shifts every block boundary, so every block's hash changes and everything re-uploads. Content-defined chunking slides a rolling hash (Rabin fingerprint, FastCDC) over the bytes and cuts wherever the hash matches a pattern (e.g. the low 22 bits are zero, which gives ~4 MB average chunks). Boundaries depend on the local content, so an insert only changes the chunks around it. Enforce min/max chunk sizes.
- **Dedup:** chunks are stored once and reference-counted, across versions, across files, and (optionally) across users. Cross-user dedup saves the most storage but lets an attacker test whether *someone* has a specific file (by seeing that an upload was skipped). Many providers limit dedup to within an account, or do it server-side only.
- **Compression and encryption:** compress chunks before upload; encrypt at rest with per-chunk keys wrapped by a key-management service.

### 2. Conflicts

Two devices edit the same file while offline, then both come online.

1. Device A commits with `base_version = 41` → version 42.
2. Device B commits with `base_version = 41` → the server sees the latest is 42 → `409 Conflict`.
3. Device B keeps the user's work by saving it as **"report (conflicted copy – Laptop 2026-09-27).pptx"** and then downloads version 42.

The server never merges binary files automatically; it can't know how. For specific formats (text, notes), a client can attempt a three-way merge. For real-time co-editing, see the Collaborative Editor topic.

**Moves and deletes** conflict too: if one device deletes a folder while another adds a file inside it, a common rule is "additions win": restore the folder so the new file isn't lost.

### 3. Notifications at scale

- 200 M idle long polls need an asynchronous server (Netty, Go, Erlang), not thread-per-connection.
- The notification service subscribes to journal updates (via Kafka) and keeps an in-memory map `namespace → waiting connections`.
- It only says "namespace A changed", never the content. The device then asks the metadata service, which checks permissions. This keeps the notification tier simple and stateless apart from connections.
- Clients re-poll with jitter after a timeout, and back off during incidents to avoid a reconnect storm.

### 4. Sharing and permissions

- A shared folder is its own namespace, **mounted** into each member's tree at a path they choose.
- Permission checks happen in the metadata service on every list, diff, and commit. Block downloads use short-lived signed URLs issued only after the check.
- Removing a member deletes the mount; their devices see the folder disappear via their own root namespace's journal.
- Public links map a random token to `(namespace, path, permissions, expiry)`, served through the CDN.

### 5. Version history, trash and garbage collection

- Versions are immutable chunk lists, so restoring version 37 is just committing its chunk list as a new version.
- Deleting a file marks it deleted; it stays in the trash for 30+ days.
- A garbage collector decrements reference counts when versions expire, and deletes chunks at zero — after a safety delay, and only after double-checking no new version started referencing the chunk in the meantime (a race between GC and a dedup hit).

### 6. Large files and weak networks

- Chunks upload in parallel (e.g. 4–8 at a time) with independent retries, so a 50 GB upload survives flaky Wi-Fi.
- The client's local index means it never has to rehash unchanged files after a restart.
- Bandwidth throttling and "pause sync" settings; LAN sync lets devices on the same network fetch chunks from each other.

## Scaling and reliability

- **Metadata:** shard by `namespace_id` over many MySQL/Postgres clusters (or use a distributed SQL database). A very large namespace (a company-wide shared folder) can become a hot shard; split heavy namespaces or cache listing results.
- **Block store:** object storage, or a custom system (Dropbox's Magic Pocket) with **erasure coding** (e.g. 6 data + 3 parity fragments across zones: survives losing 3 fragments for 1.5× storage cost).
- **Separation:** metadata and bytes scale independently; a spike in large uploads doesn't slow down listing.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Upload interrupted | Some chunks missing | Client retries individual chunks; commit is rejected until all exist |
| Commit succeeds, response lost | Client unsure | Retry the commit with the same chunk list and an idempotency key; server returns the existing version |
| Metadata shard down | That namespace can't sync | Replicas with automatic failover; clients back off and retry |
| Notification server dies | Its devices miss wake-ups | Clients reconnect to another server; they always resume from their cursor, so no change is missed |
| Block-store zone outage | Some fragments unavailable | Erasure coding reconstructs from other zones |
| Corrupted chunk | Wrong bytes | Hash verification on upload and download; repair from another fragment |

## Security

- TLS everywhere; encryption at rest with keys in a KMS.
- Signed, short-lived URLs for chunk upload and download, scoped to one chunk.
- Permission checks on every metadata call; audit log for shares and downloads.
- Virus/malware scanning of shared files; abuse detection for public links.

## Observability

- Sync latency: time from commit on one device to the file appearing on another.
- Commit conflict rate; failed uploads by error type.
- Journal lag between the metadata DB and notification service.
- Dedup ratio, storage growth, GC backlog.
- Open long-poll connections per server; reconnect rate.

## Trade-offs to discuss

- **Chunk size:** smaller chunks dedup better and make deltas smaller, but mean more metadata rows and more requests. 4 MB average is a common balance.
- **Long polling vs WebSocket:** long polling works through every proxy and is simple; WebSocket has lower latency and less overhead per message.
- **Strong vs eventual consistency:** metadata per namespace must be strongly consistent (a file must never "go back"); notifications and search indexes can be eventually consistent.
- **Cross-user dedup:** big storage savings vs a privacy leak.

## Interview follow-up questions

- **How does a device that was offline for a month catch up?** Page through the journal from its cursor; if the journal was trimmed, do a full listing and reconcile using chunk hashes.
- **How do you move a folder with 100,000 files?** With ID-based parents it's one metadata update plus one journal entry; clients apply the move locally without downloading anything.
- **How would you support "files on demand"?** Sync metadata only; show placeholders; fetch chunks when a file is opened (via OS file-provider APIs).
- **How do you prevent a client bug from deleting everything?** Soft deletes, the trash, version history, and server-side anomaly detection ("this device deleted 90 % of files in a minute") that pauses and asks the user.
- **How do you handle two users renaming the same folder differently?** Last commit wins for the name (it's metadata); both see the final name; nothing is lost.
