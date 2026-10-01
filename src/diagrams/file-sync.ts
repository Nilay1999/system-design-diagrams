import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("File Storage & Sync — architecture", "Bytes and metadata take separate paths: chunks go straight to the block store, small metadata commits drive sync")
    .zone("Metadata plane (strongly consistent per namespace)", ["meta", "metadb", "journal"], "#2f9e44")
    .zone("Block plane (content-addressed, immutable)", ["blocksvc", "s3"], "#9c36b5")
    .node("desktop", "Desktop client", 0, 0.4, "client", { detail: ["FS watcher + chunker", "local SQLite: path → chunk hashes"] })
    .node("mobile", "Mobile / web", 0, 2.2, "client", { detail: "on-demand download" })
    .node("gw", "API gateway", 1, 1.3, "edge", { detail: ["auth, rate limits", "routes by namespace"] })
    .node("blocksvc", "Block service", 1.2, -0.9, "service", { detail: ["pre-signed URLs", "verifies SHA-256"] })
    .node("s3", "Block store", 2.3, -0.9, "storage", { detail: ["S3 / Magic Pocket", "erasure coded, 3 AZs"] })
    .node("meta", "Metadata service", 2.2, 1.3, "service", { detail: ["diff, commit, list", "permission checks"] })
    .node("metadb", "Metadata DB", 3.4, 1.3, "db", { detail: ["sharded by namespace_id", "files, versions, chunks"] })
    .node("journal", "Journal", 3.4, 2.6, "queue", { detail: ["ordered change log", "per namespace (seq)"] })
    .node("notify", "Notification service", 2.2, 3, "service", { detail: ["millions of long polls", "wakes devices on change"] })
    .node("cdn", "CDN", 1, 3.3, "edge", { detail: ["shared links, previews", "origin: block store"] })
    .node("workers", "Async workers", 4.5, 2.6, "worker", { detail: ["thumbnails, search index", "GC of unreferenced chunks"] })
    .edge("desktop", "gw", "diff / commit")
    .edge("desktop", "blocksvc", "PUT chunks", { via: [[0.3, -0.9]] })
    .edge("blocksvc", "s3", "store")
    .edge("mobile", "gw")
    .edge("gw", "meta")
    .edge("meta", "metadb", "txn")
    .edge("meta", "journal", "append", { async: true })
    .edge("journal", "notify", "new seq", { async: true })
    .edge("notify", "gw", "wake", { async: true })
    .edge("journal", "workers", undefined, { async: true })
    .edge("mobile", "cdn", "download")
    .panel(
      "Scale",
      ["500 M users, 100 M daily active", "~10 GB per user → ~5 EB logical, far less after dedup", "~2,300 file commits/s average, 3× at peak", "~100 B file records: metadata must be sharded"],
      4.4,
      0.2,
      { width: 400, tone: "info" },
    )
    .build();
}

function upload() {
  return new Sequence("Uploading a change", "Edit 1 MB of a 1 GB file → upload about one chunk, then commit a new version", { gap: 250 })
    .actor("c", "Desktop client", "client")
    .actor("meta", "Metadata service", "service")
    .actor("blk", "Block store", "storage")
    .actor("db", "Metadata DB", "db")
    .actor("j", "Journal", "queue")
    .msg("c", "c", "watcher sees report.pptx change; re-chunk (content-defined, ~4 MB); SHA-256 each chunk; compare with the local index")
    .msg("c", "meta", "POST /diff {namespace, path, hashes: [h1, h2', h3, … h256]}")
    .msg("meta", "db", "which of these hashes exist? (chunks table)")
    .msg("meta", "c", "missing: [h2'] + pre-signed PUT URL", { reply: true })
    .par("upload missing chunks in parallel, each resumable", "c", "blk")
    .msg("c", "blk", "PUT h2' (compressed + encrypted)")
    .msg("blk", "c", "200, hash verified", { reply: true })
    .end()
    .msg("c", "meta", "POST /commit {path, base_version: 41, chunk_list}")
    .alt("base_version is still the latest", "c", "j")
    .msg("meta", "db", "BEGIN; INSERT version 42; UPDATE file.latest = 42; refcount++ on new chunks; append journal seq 90,113; COMMIT")
    .msg("meta", "j", "publish (namespace, seq 90,113)", { async: true })
    .msg("meta", "c", "200 {version: 42, seq: 90,113}", { reply: true })
    .else("someone committed version 42 first")
    .msg("meta", "c", "409 Conflict {latest: 42}", { error: true })
    .msg("c", "c", "save mine as 'report (conflicted copy – Laptop).pptx', then download v42")
    .end()
    .build();
}

function download() {
  return new Sequence("Syncing to another device", "Each device keeps a cursor into its namespaces' journals and pulls only what changed", { gap: 250 })
    .actor("d", "Phone / 2nd laptop", "client")
    .actor("n", "Notification service", "service")
    .actor("meta", "Metadata service", "service")
    .actor("blk", "Block store / CDN", "storage")
    .msg("d", "n", "long poll: namespaces {A: seq 90,112, S: seq 4,001} (held ≤ 60 s)")
    .msg("n", "d", "changed: [A]", { reply: true })
    .msg("d", "meta", "GET /changes?ns=A&cursor=90,112")
    .msg("meta", "d", "[{path: report.pptx, version: 42, chunks: [h1, h2', …]}], cursor 90,113", { reply: true })
    .msg("d", "d", "diff against local chunks: need only h2'")
    .msg("d", "blk", "GET h2' (signed URL)")
    .msg("blk", "d", "chunk bytes", { reply: true })
    .msg("d", "d", "rebuild file in a temp path, verify hashes, atomic rename; save cursor 90,113")
    .note("Mobile clients don't pull file contents eagerly: they sync metadata only and download a file when it is opened.", ["d", "meta"], "info")
    .build();
}

function chunks() {
  return new Diagram("Deep dive — chunks, versions & dedup", "A version is just an ordered list of chunk hashes; unchanged chunks are shared, never copied")
    .zone("report.pptx", ["v41", "v42"], "#1971c2")
    .node("v41", "version 41", 0, 0.5, "service", { detail: "[h1, h2, h3, h4]" })
    .node("v42", "version 42", 0, 2, "service", { detail: "[h1, h2', h3, h4]" })
    .node("h1", "chunk h1", 1.4, 0, "storage", { detail: "refs 2" })
    .node("h2", "chunk h2", 1.4, 0.85, "storage", { detail: "refs 1 (history only)" })
    .node("h2n", "chunk h2'", 1.4, 1.7, "storage", { highlight: true, detail: "refs 1, new upload" })
    .node("h3", "chunk h3", 1.4, 2.55, "storage", { detail: "refs 3" })
    .node("h4", "chunk h4", 1.4, 3.4, "storage", { detail: "refs 2" })
    .node("other", "Bob's deck.pptx", 2.7, 2.55, "service", { detail: "contains the same slide → reuses h3" })
    .edge("v41", "h1")
    .edge("v41", "h2")
    .edge("v42", "h2n")
    .edge("v42", "h3")
    .edge("v42", "h4")
    .edge("other", "h3")
    .panel(
      "Content-defined chunking",
      [
        "Fixed 4 MB blocks: inserting 1 byte at the start shifts every later block → everything re-uploads",
        "Instead, slide a rolling hash (Rabin / FastCDC) over the bytes and cut a chunk wherever hash mod 2²² = 0",
        "Boundaries depend on content, so an insert only changes the chunks around it",
        "Min / max sizes (1–8 MB) keep chunk counts sane",
      ],
      2.7,
      -0.2,
      { width: 470, tone: "info" },
    )
    .panel(
      "Dedup scope",
      ["Within a file's versions: always", "Across a user's files: yes", "Across users: saves most, but leaks 'someone has this file' — many providers limit it", "GC deletes a chunk when its refcount reaches 0 (after the trash window)"],
      2.7,
      3.35,
      { width: 470 },
    )
    .build();
}

function dataModel() {
  return new Diagram("Data model", "Metadata is sharded by namespace so each user's (or shared folder's) journal is strictly ordered in one place")
    .table(
      "namespaces",
      "namespaces",
      ["namespace_id  PK", "kind          user_root | shared_folder", "owner_id", "journal_seq   last sequence number"],
      0,
      0,
    )
    .table(
      "mounts",
      "mounts",
      ["user_id        PK part", "namespace_id   PK part", "mount_path     /Team Docs", "role           viewer | editor | owner"],
      0,
      1.7,
    )
    .table(
      "files",
      "files",
      ["namespace_id   shard key", "file_id        PK", "path           /Q3/report.pptx", "latest_version 42", "is_deleted     soft delete (trash)"],
      1.4,
      0,
    )
    .table(
      "versions",
      "versions",
      ["file_id      PK part", "version      PK part", "chunk_list   [h1, h2', h3, h4]", "size, modified_by, device", "created_at"],
      1.4,
      1.9,
    )
    .table(
      "chunks",
      "chunks  (global)",
      ["hash         PK, SHA-256", "size", "storage_key  bucket / placement", "ref_count"],
      2.8,
      1.9,
      { kind: "storage" },
    )
    .table(
      "journal",
      "journal",
      ["namespace_id  PK part", "seq           PK part, gap-free", "file_id, version", "op            add | edit | move | delete"],
      2.8,
      0,
      { kind: "queue" },
    )
    .edge("mounts", "namespaces")
    .edge("files", "namespaces")
    .edge("versions", "files")
    .edge("versions", "chunks")
    .edge("journal", "files")
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "upload", name: "Upload & commit", build: upload },
  { id: "download", name: "Sync to other devices", build: download },
  { id: "chunks", name: "Chunks & dedup", build: chunks },
  { id: "data-model", name: "Data model", build: dataModel },
] satisfies DiagramSpec[];
