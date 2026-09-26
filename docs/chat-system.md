# Chat System

> WhatsApp/Messenger-style chat: 1:1 and group messages delivered in real time, with sent/delivered/read receipts, presence, and history sync across devices.

## Requirements

### Functional
- 1:1 and group chat (groups up to ~500 members).
- Real-time delivery when online; **store-and-forward** + push notification when offline.
- Receipts: sent ✓, delivered ✓✓, read.
- Online/last-seen presence.
- Message history synced across a user's devices.
- Media attachments (images, video) — stored separately.

### Non-functional
- Low latency: < 200 ms end-to-end within a region.
- **No message loss**; per-conversation **ordering**; no visible duplicates.
- 500 M DAU, highly available.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| DAU | 500 M, 40 messages/day | 20 B messages/day ≈ 230k msg/s avg, ~1 M/s peak |
| Concurrent connections | ~30 % online | ~150 M WebSockets; at ~100k conns/server ≈ 1,500 chat servers |
| Storage | 100 B/message text | 2 TB/day ≈ 730 TB/year (before replication) |

## API / protocol

Clients hold a **persistent WebSocket** (or MQTT) connection. HTTP is used for everything else (login, profile, group management, media upload).

```json
// client → server
{ "type": "send", "client_msg_id": "c-81f2", "conversation_id": "g-42", "body": "hi!" }
// server → client (ack)
{ "type": "ack", "client_msg_id": "c-81f2", "msg_id": 7201938, "ts": 1790000000123 }
// server → recipient
{ "type": "message", "msg_id": 7201938, "conversation_id": "g-42", "from": "u-1", "body": "hi!" }
// recipient → server
{ "type": "delivered", "msg_id": 7201938 }
```

Why WebSockets? Server push with low overhead. Long polling works as a fallback; SSE is one-directional.

## Data model

Messages are write-heavy, append-only, and read by conversation in time order — ideal for a **wide-column store** (Cassandra/ScyllaDB/HBase).

```text
messages
  PRIMARY KEY ((conversation_id, bucket), msg_id)   -- bucket = month, bounds partition size
  sender_id, body / media_ref, created_at
  CLUSTERING ORDER BY (msg_id DESC)

conversation_members       (conversation_id) → user_id, role, last_read_msg_id
user_conversations         (user_id) → conversation_id, last_msg_id, unread_count  -- inbox
```

**Message IDs** must be sortable within a conversation: a Snowflake-style 64-bit ID (timestamp + machine + sequence), or a per-conversation sequence number assigned by the conversation's owner.

## High-level design

Components (see diagram):

- **Chat servers** – stateful; hold WebSocket connections.
- **Session & presence store** (Redis) – `user_id → {chat_server, device}` plus heartbeat timestamps.
- **Message bus** – routes a message to the chat server holding the recipient's connection (Kafka partitions or Redis Pub/Sub channels per server).
- **Message store** – durable history.
- **Push notification service** – APNs/FCM for offline users.

### Send flow (1:1)
1. Alice's app sends the message over her WebSocket to chat server A.
2. A assigns `msg_id`, **persists** it, then **ACKs** Alice (✓ sent). Persist-before-ack is what guarantees no loss.
3. A looks up Bob's session(s) in the registry.
4. If online, publish to server B's inbox; B pushes to Bob; Bob ACKs → ✓✓ delivered is sent back to Alice.
5. If offline, enqueue a push notification. Bob fetches missed messages on reconnect.

### Sync on reconnect
Each device stores the last `msg_id` it has seen per conversation (or a global per-user cursor). On reconnect it calls `sync(cursor)` and receives everything newer — this also handles multi-device.

## Deep dives

### Group messaging
- **Small groups (≤ a few hundred):** fan-out on write — look up members, deliver to each online member's server, one stored copy of the message.
- **Very large channels:** fan-out on read — members pull from the channel's log; avoid per-member writes.

### Ordering and duplicates
- Order is guaranteed **per conversation** by the sortable `msg_id` assigned by one server (or a per-conversation sequencer).
- Clients retry sends with the same `client_msg_id`; the server deduplicates on `(sender, client_msg_id)` → idempotent.
- Recipients dedupe by `msg_id`.

### Presence
- Clients heartbeat every ~30 s; the registry stores `last_seen`. Missing heartbeats for ~60 s → offline.
- Don't broadcast every status change to every contact — publish to subscribers of *currently open* conversations, and let others fetch lazily. Presence fan-out is one of the most expensive parts of chat at scale.

### Connection management
- L4 load balancer or DNS-based assignment; a **service discovery** layer (ZooKeeper/etcd) picks the least-loaded chat server.
- On deploys, drain servers gracefully: tell clients to reconnect elsewhere with jittered backoff to avoid a reconnect storm.

### Media
Upload to object storage via pre-signed URL, then send a message containing the media reference + thumbnail. Serve via CDN.

### End-to-end encryption
With the Signal protocol, servers only see ciphertext. Server-side search and moderation become impossible; multi-device requires per-device keys (sender encrypts for each device).

## Scaling & reliability

- Chat servers are stateful: if one dies, its clients reconnect to another and re-sync from their cursor — no data lost because messages were persisted before ACK.
- Partition the message store by `conversation_id`; bucket by time to bound partition size.
- Keep the session registry replicated; it can be rebuilt from reconnects if lost.

## Trade-offs

- **Persist before deliver** adds latency (~a few ms) but guarantees durability.
- **Pub/Sub vs Kafka for routing:** Redis Pub/Sub is lower latency but fire-and-forget; Kafka is durable and replayable but adds latency.
- **Storing history server-side** (Messenger) vs **device-only** (early WhatsApp): server-side enables multi-device and search; device-only reduces storage and exposure.
