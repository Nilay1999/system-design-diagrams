import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Chat System — architecture", "Stateful connection servers hold WebSockets; a registry says which server each device is on")
    .zone("Connection tier (stateful)", ["cs1", "cs2"], "#2f9e44")
    .zone("Storage", ["msgs", "inbox", "groups"], "#e67700")
    .node("alice", "Alice", 0, 0, "client", { detail: "phone + laptop" })
    .node("bob", "Bob", 0, 2.4, "client", { detail: "phone" })
    .node("lb", "L4 load balancer", 1, 1.2, "edge", { detail: ["TLS / WebSocket", "long-lived connections"] })
    .node("cs1", "Chat server A", 2.1, 0.3, "service", { detail: ["~100k sockets", "sequences + persists"] })
    .node("cs2", "Chat server B", 2.1, 2.1, "service", { detail: ["~100k sockets", "holds Bob's socket"] })
    .node("registry", "Session registry", 3.2, 1.2, "cache", { detail: ["Redis: device → server", "presence, last_seen"] })
    .node("bus", "Server inboxes", 3.2, 2.6, "queue", { detail: ["one topic per chat server", "Redis Pub/Sub or Kafka"] })
    .node("msgs", "Message store", 4.4, -0.2, "db", { detail: ["Cassandra / ScyllaDB", "(conversation, bucket) → msgs"] })
    .node("inbox", "User inbox", 4.4, 1, "db", { detail: ["per-user conversation list", "unread counts, cursors"] })
    .node("groups", "Group service", 4.4, 2.2, "service", { detail: ["members, roles", "cached member lists"] })
    .node("push", "Push service", 3.2, 3.8, "worker", { detail: "offline devices" })
    .node("apns", "APNs / FCM", 4.4, 3.8, "external")
    .node("media", "Media service", 1, -0.5, "service", { detail: ["pre-signed upload", "S3 + CDN, thumbnails"] })
    .edge("alice", "lb", "WS", { both: true })
    .edge("bob", "lb", "WS", { both: true })
    .edge("alice", "media", "upload photo")
    .edge("lb", "cs1")
    .edge("lb", "cs2")
    .edge("cs1", "msgs", "1. persist")
    .edge("cs1", "registry", "2. where is Bob?")
    .edge("cs1", "bus", "3. publish to B's inbox", { async: true })
    .edge("bus", "cs2", "4. deliver", { async: true })
    .edge("cs1", "inbox", "unread++")
    .edge("cs2", "groups", "group members")
    .edge("bus", "push", "offline", { async: true })
    .edge("push", "apns")
    .panel(
      "Scale",
      ["500 M daily users × 40 msgs = 20 B msgs/day", "≈ 230k msgs/s average, ~1 M/s peak", "~150 M open sockets → ~1,500 chat servers", "~2 TB/day of message text before replication"],
      5.5,
      -0.2,
      { width: 380, tone: "info" },
    )
    .build();
}

function sendFlow() {
  return new Sequence("Sending a 1:1 message", "Persist before acknowledging; route by looking up the recipient's server; receipts flow back the same way", { gap: 225 })
    .actor("alice", "Alice", "client")
    .actor("a", "Chat server A", "service")
    .actor("store", "Message store", "db")
    .actor("reg", "Session registry", "cache")
    .actor("b", "Chat server B", "service")
    .actor("bob", "Bob", "client")
    .actor("push", "Push service", "worker")
    .msg("alice", "alice", "show message with a clock icon; keep in local outbox")
    .msg("alice", "a", "send {client_msg_id c-81f2, conv c-1:2, body}")
    .msg("a", "a", "dedup (alice, c-81f2); assign msg_id (Snowflake: time-ordered)")
    .msg("a", "store", "INSERT message (conv c-1:2, msg_id) + update both inboxes")
    .msg("a", "alice", "ack {c-81f2 → msg_id 7201938} — one tick ✓", { reply: true })
    .msg("a", "reg", "sessions of Bob?")
    .msg("reg", "a", "[{device: phone, server: B}]", { reply: true })
    .alt("Bob has an open connection", "a", "bob")
    .msg("a", "b", "publish to server B's inbox topic", { async: true })
    .msg("b", "bob", "message 7201938")
    .msg("bob", "b", "delivered 7201938")
    .msg("b", "a", "receipt → Alice's server", { async: true })
    .msg("a", "alice", "✓✓ delivered", { reply: true })
    .else("Bob is offline")
    .msg("a", "push", "notify Bob (preview or 'New message')", { async: true })
    .msg("push", "bob", "APNs / FCM wakes the app → it reconnects and syncs", { async: true })
    .end()
    .note("If A crashes after the ack, the message is already stored — Bob gets it on his next sync. If A crashes before the ack, Alice retries with the same client_msg_id and the dedup check prevents a duplicate.", ["alice", "reg"], "info")
    .build();
}

function groupFlow() {
  return new Sequence("Group messages & large channels", "Small groups: one stored copy, fan out to online members. Huge channels: members pull", { gap: 240 })
    .actor("s", "Sender", "client")
    .actor("cs", "Sender's chat server", "service")
    .actor("g", "Group service", "service")
    .actor("store", "Message store", "db")
    .actor("inboxes", "Server inboxes", "queue")
    .actor("m", "Online members", "client")
    .msg("s", "cs", "send to group g-42 (180 members)")
    .msg("cs", "g", "members of g-42 (cached, version 57)")
    .msg("cs", "store", "INSERT one copy (conv g-42, msg_id)")
    .msg("cs", "s", "ack ✓", { reply: true })
    .msg("cs", "cs", "look up servers for all members' devices (batched registry read)")
    .loop("for each chat server that has members online (≈ 40 servers, not 180 messages)", "cs", "m")
    .msg("cs", "inboxes", "one publish per server with the list of local recipients", { async: true })
    .msg("inboxes", "m", "server pushes to each local member socket", { async: true })
    .end()
    .msg("cs", "cs", "offline members: bump unread counts; batched push notifications")
    .phase("Channels with 100k+ members")
    .note("Don't fan out per member. Store once; online viewers of the channel subscribe to its topic; everyone else sees it when they open the channel (fan-out on read). Unread counts are computed lazily from the member's last_read_msg_id.", ["s", "m"], "warn")
    .build();
}

function syncFlow() {
  return new Sequence("Reconnect & multi-device sync", "Every device keeps its own cursor; the server is the source of truth for history", { gap: 250 })
    .actor("d", "Bob's laptop", "client")
    .actor("cs", "Chat server", "service")
    .actor("reg", "Session registry", "cache")
    .actor("inbox", "User inbox", "db")
    .actor("store", "Message store", "db")
    .msg("d", "cs", "WS connect (token, device_id)")
    .msg("cs", "reg", "SET session bob/laptop → this server, TTL 90 s")
    .msg("d", "cs", "sync {since: inbox cursor 88,410}")
    .msg("cs", "inbox", "conversations changed since cursor 88,410")
    .msg("inbox", "cs", "[c-1:2 (3 unread), g-42 (17 unread)]", { reply: true })
    .loop("for each changed conversation", "cs", "store")
    .msg("cs", "store", "SELECT msgs WHERE conv = ? AND msg_id > device's last_msg_id LIMIT 200")
    .end()
    .msg("cs", "d", "missed messages, newest conversations first", { reply: true })
    .msg("d", "cs", "delivered up to msg_id … (per conversation)")
    .loop("while connected", "d", "reg")
    .msg("d", "cs", "heartbeat every 30 s")
    .msg("cs", "reg", "refresh TTL, last_seen = now")
    .end()
    .note("Read on the phone → 'read up to msg_id X' is stored per user, and pushed to the user's other devices so their unread badges clear too.", ["d", "inbox"], "info")
    .build();
}

function dataModel() {
  return new Diagram("Data model", "Messages are append-only and read by conversation in time order — a wide-column store fits")
    .table(
      "messages",
      "messages  (Cassandra)",
      [
        "conversation_id   partition key part",
        "bucket            partition key part (month)",
        "msg_id            clustering key, DESC",
        "sender_id",
        "type              text | image | video | system",
        "body / media_ref",
        "client_msg_id     for dedup",
        "created_at",
      ],
      0,
      0,
    )
    .table(
      "members",
      "conversation_members",
      ["conversation_id   partition key", "user_id           clustering key", "role              member | admin", "joined_at", "last_read_msg_id  read receipts", "muted_until"],
      0,
      2.25,
    )
    .table(
      "inbox",
      "user_inbox",
      ["user_id           partition key", "updated_seq       clustering key", "conversation_id", "last_msg_id, last_msg_preview", "unread_count"],
      1.8,
      0,
    )
    .table(
      "devices",
      "devices",
      ["user_id           partition key", "device_id         clustering key", "push_token, platform", "identity_key      (E2E encryption)", "last_seen"],
      1.8,
      1.9,
    )
    .edge("members", "messages")
    .edge("inbox", "messages")
    .panel(
      "Why these keys",
      [
        "(conversation, month) bounds partition size — a busy group can't grow one partition forever",
        "msg_id is time-sortable (Snowflake), so 'latest 50' is one sequential read",
        "user_inbox ordered by updated_seq = the chat list screen in one query",
        "last_read_msg_id per member gives read receipts and unread counts without per-message rows",
      ],
      3.5,
      0,
      { width: 440, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "send-flow", name: "Send 1:1", build: sendFlow },
  { id: "group-flow", name: "Groups & channels", build: groupFlow },
  { id: "sync-flow", name: "Reconnect & sync", build: syncFlow },
  { id: "data-model", name: "Data model", build: dataModel },
] satisfies DiagramSpec[];
