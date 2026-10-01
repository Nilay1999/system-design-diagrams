import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Collaborative Editor — architecture", "Every document has exactly one live session that orders its operations; everything else is stateless")
    .zone("Real-time path", ["gw", "router", "s1", "s2", "presence"], "#2f9e44")
    .zone("Durable document state", ["oplog", "snap", "snaps", "meta"], "#e67700")
    .node("alice", "Alice (editor)", 0, 0, "client", { detail: "local copy, applies edits instantly" })
    .node("bob", "Bob (editor)", 0, 1.2, "client", { detail: "local copy + pending ops" })
    .node("viewers", "Viewers", 0, 2.4, "client", { detail: "read-only, many" })
    .node("gw", "WebSocket gateways", 1.1, 1.2, "edge", { detail: ["stateless, sticky per socket", "auth on connect"] })
    .node("router", "Session router", 1.1, 2.6, "service", { detail: ["doc_id → owner", "leases in etcd"] })
    .node("s1", "Session server A", 2.3, 0.5, "service", { detail: ["owns doc d-1 in memory", "OT: transform + assign rev"] })
    .node("s2", "Session server B", 2.3, 1.9, "service", { detail: "owns other documents" })
    .node("presence", "Presence", 2.3, -0.7, "cache", { detail: ["Redis, TTL 30 s", "cursors, selections"] })
    .node("oplog", "Operation log", 3.5, 0.5, "db", { detail: ["(doc_id, rev) PK", "append-only"] })
    .node("snap", "Snapshotter", 4.6, 0.5, "worker", { detail: "every 500 ops or 5 min" })
    .node("snaps", "Snapshots", 4.6, 1.8, "storage", { detail: "S3: doc at rev N" })
    .node("meta", "Document service", 3.5, 1.8, "service", { detail: ["open, ACLs, history", "metadata DB"] })
    .node("async", "Async consumers", 3.5, 3.1, "worker", { detail: ["search index, exports", "notifications for @mentions"] })
    .edge("alice", "gw", "WS", { both: true })
    .edge("bob", "gw", "WS", { both: true })
    .edge("viewers", "gw", "WS")
    .edge("gw", "router", "who owns d-1?")
    .edge("gw", "s1", "ops for d-1", { both: true })
    .edge("gw", "s2")
    .edge("s1", "presence", "cursors")
    .edge("s1", "oplog", "append rev 42")
    .edge("oplog", "snap", undefined, { async: true })
    .edge("snap", "snaps", "write")
    .edge("meta", "snaps")
    .edge("meta", "oplog", "tail since snapshot")
    .edge("oplog", "async", "change feed", { async: true, via: [[4.05, 0.5], [4.05, 3.1]] })
    .panel(
      "Scale",
      ["1 B documents; ~10 M opened per day", "1–2 M concurrent sessions at peak", "~2 ops/s per active typist → a few M ops/s globally", "Most docs have 1–5 editors; shard everything by doc_id"],
      4.6,
      -0.9,
      { width: 400, tone: "info" },
    )
    .build();
}

function editFlow() {
  return new Sequence("Concurrent edits with OT", "Both start from \"cat\" at rev 41. Alice types 's' at the end; Bob deletes the 'c'.", { gap: 260 })
    .actor("alice", "Alice", "client")
    .actor("s", "Session (doc d-1)", "service")
    .actor("log", "Operation log", "db")
    .actor("bob", "Bob", "client")
    .msg("alice", "alice", "apply locally: insert(3, 's') → \"cats\"")
    .msg("bob", "bob", "apply locally: delete(0) → \"at\"")
    .msg("alice", "s", "op {base_rev 41, client_seq 7, insert(3, 's')}")
    .msg("bob", "s", "op {base_rev 41, client_seq 3, delete(0)}")
    .note("Alice's op arrives first, so it becomes rev 42 unchanged.", "s", "info")
    .msg("s", "log", "append (d-1, rev 42, insert(3,'s'), alice#7)")
    .msg("s", "alice", "ack client_seq 7 → rev 42", { reply: true })
    .msg("s", "bob", "rev 42: insert(3, 's') by Alice", { async: true })
    .msg("bob", "bob", "transform against my pending delete(0) → insert(2, 's'); apply → \"ats\"")
    .msg("s", "s", "Bob's op was based on rev 41; transform delete(0) against rev 42 → still delete(0)")
    .msg("s", "log", "append (d-1, rev 43, delete(0), bob#3)")
    .msg("s", "bob", "ack client_seq 3 → rev 43", { reply: true })
    .msg("s", "alice", "rev 43: delete(0) by Bob", { async: true })
    .msg("alice", "alice", "apply delete(0) to \"cats\" → \"ats\"")
    .note("Both converge on \"ats\". Persist before ack: an acknowledged op is never lost.", ["alice", "bob"], "good")
    .build();
}

function openReconnect() {
  return new Sequence("Opening a document & reconnecting", "Load = latest snapshot + ops after it; reconnect = resend unacknowledged ops, deduplicated by client_seq", { gap: 240 })
    .actor("c", "Client", "client")
    .actor("doc", "Document service", "service")
    .actor("snap", "Snapshot store", "storage")
    .actor("log", "Operation log", "db")
    .actor("s", "Session server", "service")
    .msg("c", "doc", "GET /docs/d-1 (auth token)")
    .msg("doc", "doc", "check ACL: alice can edit")
    .msg("doc", "snap", "latest snapshot of d-1 → rev 40,000")
    .msg("doc", "log", "ops where doc = d-1 and rev > 40,000 → 312 ops")
    .msg("doc", "c", "content at rev 40,312 + session endpoint", { reply: true })
    .msg("c", "s", "WS connect {doc d-1, rev 40,312}")
    .opt("session not loaded on this server (first editor or after failover)", "c", "s")
    .msg("s", "s", "acquire lease for d-1; load snapshot + tail the log")
    .end()
    .msg("s", "c", "ops after 40,312 (if any) + presence of others", { reply: true })
    .phase("Network drops for 20 s while Alice keeps typing")
    .msg("c", "c", "buffer ops 8–15 locally (IndexedDB), keep showing them")
    .msg("c", "s", "reconnect {last_seen_rev 40,350, pending client_seq 8–15}")
    .msg("s", "c", "ops 40,351 – 40,377 she missed", { reply: true })
    .msg("c", "c", "transform pending ops over the missed ones")
    .msg("c", "s", "resend ops 8–15 (op 8 was already applied before the drop)")
    .msg("s", "s", "(alice, 8) already in the log → ack with its old rev; transform + apply 9–15")
    .build();
}

function crdt() {
  const d = new Diagram("OT vs CRDT", "OT transforms positions through a central server; a CRDT gives every character a unique ID so edits commute");
  d.zone("Sequence CRDT (RGA / Yjs style): each character has an ID (counter, site)", ["c", "a", "t", "s", "x"], "#1971c2")
    .node("c", "'c'", 0, 0, "service", { w: 0.75, highlight: true, detail: ["(1, A)", "deleted: tombstone"] })
    .node("a", "'a'", 0.95, 0, "service", { w: 0.75, detail: "(2, A)" })
    .node("t", "'t'", 1.9, 0, "service", { w: 0.75, detail: "(3, A)" })
    .node("s", "'s'", 2.85, 0, "service", { w: 0.75, detail: ["(4, A)", "insert after (3, A)"] })
    .node("x", "'!'", 3.8, 0, "service", { w: 0.75, detail: ["(1, B)", "insert after (3, A)"] })
    .edge("c", "a", undefined, { none: true })
    .edge("a", "t", undefined, { none: true })
    .edge("t", "s", undefined, { none: true })
    .edge("s", "x", undefined, { none: true });
  return d
    .panel(
      "How the CRDT converges",
      [
        "Inserts say 'after character (3, A)', never 'at position 3', so other edits can't shift them",
        "Two inserts after the same character are ordered by ID (higher counter first, then site) — every replica picks the same order",
        "Deletes keep a tombstone so later inserts can still find their anchor",
        "Operations commute: apply them in any order and you get the same text",
      ],
      0,
      1.2,
      { width: 560, numbered: true, tone: "info" },
    )
    .panel(
      "How OT converges",
      [
        "Ops are positional: insert(3, 's'), delete(0)",
        "A central server puts ops in one order (revisions)",
        "An op based on an old revision is transformed past every op it missed: insert(3) after delete(0) becomes insert(2)",
        "Clients transform incoming ops against their own pending ops",
      ],
      1.85,
      1.2,
      { width: 560, numbered: true },
    )
    .panel(
      "Choosing",
      [
        "OT + central server: tiny metadata, mature for rich text (Google Docs), but needs the server to order ops",
        "CRDT: offline-first and peer-to-peer friendly (Figma, Yjs, Automerge), costs per-character IDs and tombstones (well compressed today)",
        "Either way you still need: auth, persistence, snapshots, presence, and a server to relay ops",
      ],
      0,
      2.6,
      { width: 1170, tone: "warn" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "edit-flow", name: "Concurrent edits (OT)", build: editFlow },
  { id: "open-reconnect", name: "Open & reconnect", build: openReconnect },
  { id: "ot-vs-crdt", name: "OT vs CRDT", build: crdt },
] satisfies DiagramSpec[];
