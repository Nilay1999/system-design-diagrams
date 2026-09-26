import { Diagram } from "./dsl";

export default function fileSync() {
  return new Diagram("File Storage & Sync", "Files are split into content-addressed chunks; only changed chunks move, metadata drives sync")
    .node("desktop", "Desktop client (watcher, chunker, local index)", 0, 0.3, "client", { h: 1.2 })
    .node("other", "Other devices", 0, 2.8, "client")
    .node("gw", "API gateway", 1, 1.5, "edge")
    .node("blocks", "Block store (S3) chunks keyed by SHA-256", 1.2, -1.1, "storage", { w: 1.1 })
    .node("meta", "Metadata service", 2, 0.8, "service")
    .node("metadb", "Metadata DB (files, versions, chunk lists)", 3, 0.8, "db", { w: 1.1 })
    .node("notify", "Notification service (long poll / WS)", 2, 2.3, "service")
    .node("changes", "Change log (per namespace)", 3, 2.3, "queue")
    .edge("desktop", "gw", "1. diff · 3. commit")
    .edge("desktop", "blocks", "2. PUT missing chunks")
    .edge("gw", "meta")
    .edge("meta", "metadb", "new version")
    .edge("meta", "changes", "FileChanged", { async: true })
    .edge("changes", "notify", undefined, { async: true })
    .edge("notify", "gw", "notify", { async: true })
    .edge("other", "gw", "poll / fetch changes", { both: true })
    .steps(
      "Sync flow",
      [
        "Client splits the file into ~4 MB chunks and hashes them",
        "Asks metadata which hashes are new; uploads only those",
        "Commits version = ordered list of chunk hashes",
        "Other devices are notified, fetch the new chunk list",
        "They download only chunks they don't already have",
      ],
      4.4,
      -1.1,
    )
    .build();
}
