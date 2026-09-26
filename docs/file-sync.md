# File Storage & Sync (Dropbox / Google Drive)

> Users drop files into a folder, and the files appear on all their devices and can be shared with others. Large files sync fast because only changed parts move.

## Requirements

### Functional
- Upload, download, delete, rename files and folders.
- Automatic **sync across devices**, including offline edits.
- **Version history** and restore.
- Share files/folders with other users (view/edit).

### Non-functional
- **Reliability and durability:** never lose a file (11 nines, via object storage).
- **Bandwidth efficiency:** avoid re-uploading unchanged data.
- Sync latency of a few seconds for small changes.
- Scale: 500 M users, 100 M DAU, files up to 50 GB.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Storage | 500 M users × 10 GB avg used | 5 EB logical, much less after dedup |
| Uploads | 100 M DAU × 2 file changes/day | ~2,300 file commits/s avg |
| Metadata | ~200 files/user × 500 M | 100 B file records → must be sharded |

## API

```http
POST /v1/files/diff        { path, chunk_hashes: [...] }       → hashes the server lacks + pre-signed upload URLs
PUT  <pre-signed URL>       (chunk bytes, direct to object storage)
POST /v1/files/commit      { path, base_version, chunk_hashes } → new version or 409 conflict
GET  /v1/changes?cursor=…  (long poll)                           → list of changed entries + new cursor
GET  /v1/files/{id}?version=n                                     → chunk list + download URLs
```

## Data model

```text
namespaces  (namespace_id, owner)                       -- a user's root or a shared folder
files       (namespace_id, file_id, path, latest_version, is_deleted)
versions    (file_id, version, chunk_hashes[], size, modified_by, created_at)
chunks      (hash PK, size, storage_key, ref_count)      -- content-addressed, deduplicated
journal     (namespace_id, seq, file_id, version, op)    -- ordered change log per namespace
```

Shard metadata by `namespace_id`, so all of one user's (or one shared folder's) metadata lives together and its journal can be strictly ordered.

## High-level design

1. The **desktop client** watches the filesystem, splits changed files into **~4 MB chunks** (fixed-size, or content-defined chunking so an insert doesn't shift every later chunk), and hashes each chunk with SHA-256.
2. It asks the **metadata service** which hashes are new (the diff). The server returns pre-signed URLs only for chunks it doesn't already have.
3. The client uploads missing chunks **directly to the block store** (S3), in parallel and resumably.
4. The client **commits** the new version (an ordered list of chunk hashes) with its `base_version`. The metadata service appends an entry to the namespace **journal**.
5. The **notification service** wakes other devices (long polling or WebSocket). They call `/changes?cursor`, receive the new chunk lists, and download only chunks they lack.

## Deep dives

### Chunking and deduplication
- **Delta sync:** editing 1 MB of a 1 GB file re-uploads only one or two chunks.
- **Content-defined chunking** (Rabin fingerprints) picks chunk boundaries from the content itself, so inserting bytes early in a file only changes nearby chunks.
- **Dedup:** identical chunks, across versions or even across users, are stored once (refcounted). Cross-user dedup has privacy implications. Some providers only dedupe within an account.
- Compress chunks before upload. Encrypt at rest.

### Conflict handling
Two devices edit the same file offline. The second commit carries a stale `base_version`, so the server returns `409`. The client saves its copy as **"file (conflicted copy – Laptop).docx"**. Automatic merging only makes sense for specific formats.

### Notifications at scale
- Long polling: each device holds a request open until the namespace journal has a new entry or a ~60 s timeout.
- The notification service subscribes to journal updates (Kafka) and wakes the relevant connections. It needs to hold millions of idle connections, so use an async server.

### Sharing
Shared folders are separate **namespaces** mounted into each member's tree. Permissions are checked by the metadata service. Share links map to a namespace + path with a token.

### Version history and deletion
Versions are immutable chunk lists. Restoring a version is just committing an old list. Deleted files stay recoverable for N days. Garbage collection decrements chunk refcounts and deletes chunks at zero.

### Large uploads and weak networks
Chunked, parallel, resumable uploads. The client retries individual chunks. The client keeps a local SQLite index of paths → chunk hashes so it can compute diffs without rehashing everything.

### Download / serving
Serve popular shared files via CDN with signed URLs. Mobile clients fetch files on demand instead of syncing everything.

## Scaling & reliability

- Metadata: sharded SQL (e.g. MySQL per namespace range) or a distributed SQL store; strong consistency per namespace.
- Block store: object storage (or a custom system like Dropbox's Magic Pocket) with erasure coding across zones.
- Metadata and blocks are separated, so each scales independently.

## Trade-offs

- **Chunk size:** smaller chunks give better dedup and delta but more metadata and requests. 4 MB is a common balance.
- **Long polling vs WebSocket:** long polling is simpler through proxies. WebSocket gives lower latency.
- **Strong consistency** for metadata (users must never see a file "go back"), eventual for notifications.
