import { Diagram } from "./dsl";

export default function collaborativeEditor() {
  return new Diagram("Collaborative Editor", "One collaboration session per document orders ops (OT) or merges them (CRDT)")
    .node("alice", "Alice (editor)", 0, 0, "client")
    .node("bob", "Bob (editor)", 0, 2, "client")
    .node("gw", "WebSocket gateway (route by doc_id)", 1, 1, "edge")
    .node("collab", "Collaboration service (doc session: OT / CRDT)", 2, 1, "service", { h: 1.2 })
    .node("presence", "Presence & cursors (Redis)", 2, -0.4, "cache")
    .node("oplog", "Operation log (append-only, seq per doc)", 3, 0.3, "queue")
    .node("snap", "Snapshotter (compaction)", 4, 0.3, "worker")
    .node("docs", "Document snapshots (S3 / DB)", 4, 1.8, "storage")
    .node("docsvc", "Document service (open, ACL, history)", 2, 2.7, "service")
    .edge("alice", "gw", "ops over WS", { both: true })
    .edge("bob", "gw", "ops over WS", { both: true })
    .edge("gw", "collab")
    .edge("collab", "presence", "cursors")
    .edge("collab", "oplog", "persist op (seq n)")
    .edge("oplog", "snap", undefined, { async: true })
    .edge("snap", "docs", "snapshot every N ops")
    .edge("gw", "docsvc", "open doc")
    .edge("docsvc", "docs", "snapshot + tail ops")
    .steps(
      "Edit flow",
      [
        "Client applies the edit locally (optimistic)",
        "Sends op {doc, base_rev, op} to the session",
        "Server transforms it against newer ops, assigns rev",
        "Persists, ACKs sender, broadcasts to other editors",
        "Clients transform any pending local ops and apply",
      ],
      5.2,
      -0.4,
    )
    .build();
}
