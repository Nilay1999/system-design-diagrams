# Chat System

> WhatsApp/Messenger-style chat: 1:1 and group messages delivered in real time, with sent/delivered/read receipts, presence, and history synced across devices.

## The problem in one minute

Chat looks simple — send text from A to B — but at scale it combines three hard things:

1. **Hundreds of millions of long-lived connections.** Servers must push messages to devices instantly, so every online device keeps a socket open to some server. Those servers are **stateful**: to reach Bob, you have to find the server holding Bob's socket.
2. **No lost, duplicated, or reordered messages,** despite retries, crashes, flaky mobile networks, and several devices per user.
3. **Fan-out:** one group message goes to hundreds of people; one presence change could notify thousands of contacts.

The design answers these with: persist every message **before** acknowledging it; route messages through a **session registry** that maps each device to its chat server; give every message a **sortable ID** per conversation; and let each device **sync from a cursor** whenever it reconnects.

| Decision | Choice | Why |
| --- | --- | --- |
| Transport | WebSocket (or MQTT) per device | Server push with low overhead |
| Routing | Session registry (Redis): device → chat server; one inbox topic per server | Find the recipient's server in one lookup |
| Durability | Persist before ack | An acknowledged message is never lost |
| Ordering | Time-sortable `msg_id` per conversation | History and live messages sort the same way |
| Duplicates | Client-generated `client_msg_id`, deduplicated server-side | Safe retries |
| Storage | Wide-column store partitioned by `(conversation, month)` | Write-heavy, append-only, read by conversation |
| Offline | Store-and-forward + push notification + cursor sync | Works for any number of devices |
| Groups | Fan-out on write for small groups; fan-out on read for huge channels | Keeps work bounded |

## Requirements

### Functional

- 1:1 and group chat (groups up to ~1,000 members); large broadcast channels as an extension.
- Real-time delivery to online devices; **store-and-forward** plus a push notification for offline ones.
- Receipts: sent ✓, delivered ✓✓, read (blue ticks).
- Presence: online / last seen, typing indicators.
- History synced across a user's devices (phone, laptop, web).
- Media: images, video, voice notes, documents.

### Non-functional

| Property | Target |
| --- | --- |
| Latency | < 200 ms end-to-end when both users are online in the same region |
| Durability | No acknowledged message is ever lost |
| Ordering | Messages in a conversation appear in the same order for everyone |
| Duplicates | Never shown twice, even with retries |
| Scale | 500 M daily active users, 150 M concurrently connected |
| Availability | 99.99 %; a server failure causes a reconnect, not data loss |

## Capacity estimation

- **Messages:** 500 M DAU × 40 messages/day = **20 B messages/day** ≈ 230k/s on average, ~**1 M/s** at peak.
- **Connections:** ~30 % of DAU online at peak ≈ **150 M WebSockets**. A tuned server (epoll, small per-connection memory) holds ~100k–500k idle connections; at 100k each → **~1,500 chat servers**.
- **Storage:** ~100 bytes of text + ~100 bytes of metadata per message → 20 B × 200 B = **4 TB/day**, ~1.5 PB/year before replication (×3). Media goes to object storage separately and dwarfs this.
- **Deliveries:** group messages multiply deliveries. If the average message has 5 recipients, that's ~5 M deliveries/s at peak through the routing layer.
- **Registry:** 150 M sessions × ~100 B = **15 GB** in Redis — small, but ~1 M lookups/s, so shard it.

## Protocol and API

Devices keep one persistent WebSocket. Everything that isn't real-time (login, profile, contacts, group management, media upload) uses HTTPS.

```jsonc
// client → server: send (client_msg_id makes retries safe)
{ "type": "send", "client_msg_id": "c-81f2", "conversation_id": "c-1:2", "body": "hi!" }

// server → sender: accepted and stored
{ "type": "ack", "client_msg_id": "c-81f2", "msg_id": 7201938, "ts": 1790000000123 }

// server → recipient devices
{ "type": "message", "msg_id": 7201938, "conversation_id": "c-1:2", "from": "u-1", "body": "hi!" }

// recipient → server: receipts are cumulative ("up to this id")
{ "type": "delivered", "conversation_id": "c-1:2", "up_to": 7201938 }
{ "type": "read",      "conversation_id": "c-1:2", "up_to": 7201938 }

// sync after reconnect
{ "type": "sync", "since": 88410 }

// typing and presence are ephemeral
{ "type": "typing", "conversation_id": "c-1:2" }
```

**Why WebSockets?** They give full-duplex server push with ~2 bytes of framing per message. Long polling is a fallback for hostile networks. Mobile apps also rely on push notifications (APNs/FCM) because the OS kills background sockets.

## Data model

See the [Data model](#diagram/data-model) diagram.

```text
messages                -- Cassandra / ScyllaDB
  PRIMARY KEY ((conversation_id, bucket), msg_id)     -- bucket = month
  sender_id, type, body | media_ref, client_msg_id, created_at
  CLUSTERING ORDER BY (msg_id DESC)

conversation_members
  PRIMARY KEY (conversation_id, user_id)
  role, joined_at, last_read_msg_id, muted_until

user_inbox              -- the chat list screen
  PRIMARY KEY (user_id, updated_seq DESC)
  conversation_id, last_msg_id, last_msg_preview, unread_count

devices
  PRIMARY KEY (user_id, device_id)
  push_token, platform, identity_key, last_seen
```

- **Why a wide-column store?** Messages are written far more than they're edited, never updated in place, and always read as "the latest N messages of this conversation" — a single partition read in clustering order.
- **Why bucket by month?** A busy group would otherwise grow one partition forever. Buckets keep partitions bounded (tens of MB), and reading history walks back bucket by bucket.
- **Message IDs** are 64-bit Snowflake-style IDs: 41 bits of milliseconds + 10 bits of machine + 12 bits of sequence. They're unique without coordination and roughly time-ordered. For **strict** per-conversation order, a per-conversation sequence number can be assigned by a single owner of the conversation (see deep dive 2).
- **Read receipts** are stored as one `last_read_msg_id` per member, not a row per message per reader.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| L4 load balancer | Spreads new connections; keeps them pinned |
| Chat servers | Hold WebSockets; authenticate; assign IDs; persist; route; deliver; handle receipts |
| Session registry (Redis) | `user/device → chat server`, plus presence and last seen, with TTLs refreshed by heartbeats |
| Server inboxes | One topic per chat server (Redis Pub/Sub, or Kafka partitions); other servers publish messages for its connected devices |
| Message store | Durable history (Cassandra/ScyllaDB) |
| User inbox | Per-user list of conversations, unread counts, sync cursor |
| Group service | Membership, roles, invite links; cached member lists |
| Push service | APNs/FCM for devices without a live socket |
| Media service | Pre-signed uploads to object storage, thumbnails, CDN delivery |

## Sending a message

See [Send 1:1](#diagram/send-flow).

1. Alice's app shows the message immediately with a clock icon and keeps it in a local outbox.
2. It sends `{client_msg_id, conversation_id, body}` over her socket to chat server A.
3. Server A checks `(alice, client_msg_id)` against a short-lived dedup cache — a retried send returns the original ack.
4. It assigns a `msg_id`, **writes the message** to the message store and updates both users' inbox rows.
5. Only then does it **acknowledge** Alice (✓ sent). Persist-before-ack is what makes "no lost messages" true.
6. It looks up Bob's devices in the session registry.
7. For each online device, it publishes to that device's chat server inbox. Server B pushes the message down Bob's socket.
8. Bob's app replies `delivered up_to 7201938`. The receipt travels back to Alice's server(s) and she sees ✓✓.
9. If Bob has no live connection, the push service sends a notification. When Bob opens the app, it reconnects and syncs.

**Delivery is at-least-once** (a device may receive a message twice after a reconnect), and **display is exactly-once** because devices dedupe by `msg_id`.

## Reconnecting and multi-device sync

See [Reconnect & sync](#diagram/sync-flow).

1. On connect, the chat server registers `bob/laptop → this server` in the registry with a TTL.
2. The device sends its last inbox cursor.
3. The server returns the conversations that changed since that cursor, and for each, messages newer than the device's last seen `msg_id` (newest conversations first, paginated).
4. The device acknowledges delivery, and heartbeats every ~30 s to keep its registry entry and presence fresh.
5. Reading a conversation on one device updates `last_read_msg_id`; the server pushes that to the user's other devices so their unread badges clear.

Because every device syncs from the server's history using its own cursor, adding a new device is just "sync from zero" (or from a recent point, with older history loaded on demand).

## Deep dives

### 1. Group messaging

See [Groups & channels](#diagram/group-flow).

- **Small and medium groups (up to ~1,000):** store **one** copy of the message, then fan out deliveries. Look up member devices in the registry in a batch, group them by chat server, and publish **one message per server** with the list of local recipients — for a 180-member group that might be 40 publishes, not 180.
- **Offline members** get unread-count updates and batched push notifications ("5 new messages in Team").
- **Huge channels (100k+ subscribers):** don't fan out per member. Store once; devices currently viewing the channel subscribe to its topic; everyone else sees new messages when they open it (fan-out on read). Unread counts come from comparing the channel's latest `msg_id` with the member's `last_read_msg_id`.
- **Membership changes** are system messages in the conversation, so every device sees joins/leaves in order with the chat.

### 2. Ordering

- Messages from **one sender** stay in order if the client sends them in order over one connection and the server processes them in order.
- Messages from **different senders** in the same conversation can race. Snowflake IDs from different servers are only approximately ordered (clock skew of a few ms). For most chats that's fine: the server order is the truth, and every device sorts by `msg_id`.
- For **strict** order, route all messages of a conversation to one **sequencer** (the conversation's "home" server, chosen by consistent hashing on `conversation_id`), which assigns 1, 2, 3… This costs an extra hop for users on other servers.
- Clients render in `msg_id` order and insert late arrivals in the right place.

### 3. Duplicates and retries

- The client retries a send until it gets an ack, always with the same `client_msg_id`.
- The server keeps `(sender, client_msg_id) → msg_id` for a few minutes (Redis with TTL), and the message row stores `client_msg_id` too, so even a late retry after a server restart is detected.
- Recipients dedupe by `msg_id`, so redelivery after a reconnect is invisible.

### 4. Presence

Presence is surprisingly expensive: a user with 500 contacts going online could trigger 500 notifications, and people go online/offline constantly.

- Devices heartbeat every ~30 s; the registry stores `last_seen`. No heartbeat for ~60–90 s → offline.
- **Don't push presence to everyone.** Push it only to users who have that conversation **open right now** (they subscribe on opening the chat). Others fetch presence lazily when they open the chat.
- Debounce flapping (a phone switching between Wi-Fi and cellular) by waiting a few seconds before announcing "offline".
- Typing indicators are fire-and-forget, never stored, and rate-limited.

### 5. Connection management

- A **connection-assignment service** (or DNS + L4 LB) points new connections at lightly loaded chat servers.
- **Deploys:** drain servers gradually — tell clients to reconnect elsewhere with jittered backoff so millions of sockets don't reconnect in the same second (a reconnect storm can take down the registry).
- **Mobile networks:** keep heartbeats infrequent to save battery; rely on OS push for wake-ups.

### 6. Media

1. The client asks the media service for a pre-signed upload URL.
2. It uploads the (client-side compressed, and with E2E, encrypted) file straight to object storage.
3. It sends a normal chat message containing the media reference, size, and a tiny thumbnail/blur preview.
4. Recipients download through the CDN on demand (auto-download settings per network type).

### 7. End-to-end encryption

With the Signal protocol, the server only relays ciphertext:

- Each device has identity and pre-keys; senders fetch recipients' device keys from the server.
- Each message is encrypted separately **for every recipient device** (for groups, "sender keys" make this efficient).
- Consequences: the server can't search or moderate content, can't generate previews, and multi-device sync needs device-to-device key sharing or per-device encryption.

## Scaling and reliability

- **Chat servers** scale horizontally. Their only state is the sockets; if one dies, its clients reconnect elsewhere and sync — no messages are lost, because they were persisted before ack.
- **Registry:** sharded Redis with replicas. If it's lost, it rebuilds itself as clients reconnect and heartbeat.
- **Message store:** partition by `(conversation_id, bucket)`; replicate ×3 across AZs; `LOCAL_QUORUM` writes.
- **Multi-region:** users connect to their nearest region. A message between regions is persisted in the sender's region, then replicated and delivered through a cross-region bus. Each conversation can have a home region for ordering.

### Failure modes

| Failure | What happens | Handling |
| --- | --- | --- |
| Chat server crashes | ~100k sockets drop | Clients reconnect with backoff, re-register, sync from cursors |
| Registry entry stale (device left) | Delivery goes to a server without that socket | That server reports "not here"; fall back to push; TTL expires the entry |
| Message store slow | Acks slow; clients show the clock icon longer | Alerts; clients keep retrying with the same `client_msg_id` |
| Inbox topic backlog | Deliveries delayed | Scale consumers; messages are safe in the store and will sync |
| Push provider down | Offline users not notified | Retry with backoff; they still sync on next open |
| Reconnect storm after an outage | Registry and auth overloaded | Jittered backoff, connection rate limits, gradual admission |

## Observability

- End-to-end delivery latency (send → delivered receipt) p50/p99.
- Ack latency; messages persisted/s; duplicate sends detected.
- Open connections per server; connects/disconnects per second.
- Registry lookup latency; inbox topic lag.
- Push notification success rate by platform.

## Trade-offs to discuss

- **Persist before deliver** adds a few milliseconds but guarantees durability. Delivering first and persisting later is faster but can lose acknowledged messages.
- **Redis Pub/Sub vs Kafka for routing:** Pub/Sub is lower latency but fire-and-forget (a missed publish is recovered by sync); Kafka is durable and replayable but adds latency and operational weight.
- **Server-side history** (Messenger, Slack) vs **device-only** (early WhatsApp): server history enables multi-device, search and new-device sync; device-only minimises storage and data exposure.
- **Snowflake IDs vs a per-conversation sequencer:** no coordination vs strict order.

## Interview follow-up questions

- **How do you show "delivered" for a group?** Track per-member delivered/read cursors; show ✓✓ when all (or show per-member info on request).
- **How do you delete a message for everyone?** A tombstone system message that clients apply; the server replaces the body. Can't guarantee removal from devices that already have it.
- **How would you add message search?** Server-side: index messages into a search engine partitioned by user. With E2E encryption, search runs on the device.
- **How would you support 1 M-member channels?** Fan-out on read, CDN-cached recent pages, and subscription topics only for active viewers.
- **What happens if two devices of the same user send at the same moment?** Both get distinct `msg_id`s; order is decided by the server; both devices converge on the same history after sync.
