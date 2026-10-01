# Notification System

> One service that every team calls to reach users via iOS/Android push, SMS and email — respecting preferences, never double-sending, and surviving flaky third-party providers.

## The problem in one minute

Without a central notification system, every team writes its own code to call APNs, Twilio and SendGrid — each with different retry logic, no shared opt-out list, and no protection against spamming the same user from five services at once. A notification platform gives all teams one API and takes care of:

- **Deciding**: is this user opted in to this category on this channel? Are they in quiet hours? Have they had too many marketing messages today? Which device tokens, email, or phone number do we use?
- **Delivering** through third-party providers that are slow, rate-limited, and sometimes down — without letting one slow provider delay everything else.
- **Never sending twice**, even though every layer retries.

| Decision | Choice | Why |
| --- | --- | --- |
| Entry point | One API with idempotency keys | Callers can retry safely; one place to enforce rules |
| Pipeline | Separate queues per channel **and** priority | A slow email provider or a marketing blast can't delay OTPs |
| Delivery semantics | At-least-once internally, deduplicated at every hop | No silent drops, no visible duplicates |
| Preferences | Checked before enqueue and again before send | Opt-outs take effect even for scheduled sends |
| Failures | Exponential backoff → dead-letter queue; circuit breakers + vendor failover | Transient errors heal; outages are routed around |
| Campaigns | A scheduler expands segments in batches and paces sends | Providers and our own system aren't flooded |
| Tracking | A notification log updated by workers and provider callbacks | Status, analytics, debugging |

## Requirements

### Functional

- Channels: **push** (APNs for iOS, FCM for Android/web), **SMS**, **email**, and an **in-app inbox**.
- Two kinds of senders: **transactional** (OTP codes, order updates, security alerts), triggered by services one user at a time; and **campaigns** (marketing, announcements) sent to segments of millions, scheduled.
- Templates with variables, localisation, and versions; A/B variants for campaigns.
- User **preferences**: per category and channel opt-in/out, quiet hours, time zone; legal unsubscribe for email.
- Frequency caps (e.g. at most 3 marketing pushes per day).
- Delivery tracking: sent, delivered, opened, clicked, bounced, failed.

### Non-functional

| Property | Target |
| --- | --- |
| Latency | Transactional push/SMS handed to the provider within ~2 s (p99); campaigns can take minutes |
| Reliability | Every accepted notification is attempted (at-least-once); none silently dropped |
| Duplicates | Users never receive the same notification twice |
| Isolation | Problems in one channel or provider don't affect others |
| Scale | ~20 M notifications/day normally; campaigns of 20 M+ users in an hour |
| Cost | SMS costs real money per message — never send SMS that preferences forbid |

## Capacity estimation

| Channel | Volume / day | Average rate | Peak |
| --- | --- | --- | --- |
| Push | 10 M | ~115/s | 10k+/s during campaigns |
| Email | 5 M | ~60/s | a few thousand/s during campaigns |
| SMS | 1 M | ~12/s | a few hundred/s (provider limits) |
| In-app | 5 M | ~60/s | — |

- **Campaign burst:** 20 M users in one hour ≈ 5,500/s sustained. The pipeline must absorb this without delaying transactional traffic — hence separate priority lanes.
- **Notification log:** ~20 M rows/day × ~500 B ≈ 10 GB/day; keep 90 days hot (~1 TB) in a wide-column store with TTL, and ship events to a warehouse for analytics.
- **Preferences and tokens:** 500 M users × ~1 KB ≈ 500 GB, read on every notification → cache heavily.
- **SMS cost:** at ~$0.01–0.05 per message, 1 M SMS/day is $10k–50k/day. Deduplication and preference checks directly save money.

## API

```http
POST /v1/notifications
Idempotency-Key: order-8812-shipped
Content-Type: application/json

{
  "user_id": "u-123",
  "type": "order_shipped",            // maps to a category, default channels, and templates
  "channels": ["push", "email"],       // optional override
  "data": { "order_id": "8812", "eta": "Tuesday" },
  "priority": "high",                  // high = transactional lane, low = bulk lane
  "send_at": null,                     // optional scheduling
  "ttl_s": 3600                        // drop if it can't be sent within an hour (e.g. OTPs)
}

202 Accepted
{ "notification_id": "n-77", "channels": { "push": "queued", "email": "queued", "sms": "suppressed:opted_out" } }
```

```http
POST /v1/campaigns   { "segment_id": "lapsed_30d", "type": "promo_oct", "variants": [...], "schedule": { "local_time": "10:00" } }
GET  /v1/notifications/{id}          → per-channel status history
GET  /v1/users/{id}/inbox?cursor=…   → in-app notifications
PUT  /v1/users/{id}/preferences      { "category": "marketing", "channel": "sms", "enabled": false }
```

`202 Accepted` (not `200`) signals that delivery is asynchronous: the platform has taken responsibility, not delivered yet.

## Data model

```text
user_contacts     (user_id PK, email, email_verified, phone, phone_verified, locale, time_zone)
device_tokens     (user_id, device_id) PK, platform, app_id, token, last_seen, enabled
preferences       (user_id, category, channel) PK, enabled, updated_at
quiet_hours       (user_id PK, start_local, end_local)
templates         (type, channel, locale, version) PK, subject, body, variables_schema
notifications     (notification_id PK, user_id, type, priority, data, created_at, idempotency_key)
deliveries        (notification_id, channel, attempt) PK, status, provider, provider_msg_id,
                  error, updated_at                                  -- the notification log
frequency_counters  Redis: cap:{user}:{category}:{date} → count, TTL 2 days
idempotency_keys    Redis: idem:{key} → notification_id, TTL 24 h
```

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Notification API | Validate, dedupe with idempotency keys, look up preferences/contacts, render templates, pick channels, enqueue |
| Idempotency store | Redis `SET NX` with a 24-hour TTL |
| Preferences + contacts | Opt-outs, quiet hours, tokens, emails, phone numbers (cached) |
| Templates | Versioned, localised; rendered at enqueue time (or at send time for scheduled messages) |
| Channel × priority queues | Kafka topics `push.high`, `push.low`, `sms.high`, … |
| Channel workers | Call providers with per-provider rate limits; update status; retry or park |
| Scheduler | Delayed sends (quiet hours, `send_at`), campaign expansion |
| Retry queues + DLQ | Backoff for transient errors; park poison messages |
| Notification log | Status of every attempt |
| Callback receiver | Provider webhooks: delivered, bounced, complained, opened, clicked |
| In-app inbox | Stored notifications that the app lists and marks read; also pushed live over the app's WebSocket |

## Transactional flow

See [Transactional send](#diagram/transactional).

1. The order service calls `POST /notifications` with `Idempotency-Key: order-8812-shipped`.
2. The API runs `SET idem:order-8812-shipped NX EX 86400`. If the key existed, this is a retry: return the original `notification_id` and stop.
3. It loads preferences and contacts: push allowed (2 devices), email allowed, SMS opted out. Not in quiet hours. For a marketing type, it would also check the frequency cap.
4. It renders the templates in the user's locale, writes `PENDING` delivery rows, and enqueues one message per channel on the **high** priority lane. Returns `202`.
5. A push worker consumes the message and claims it with a conditional update (`PENDING → SENDING`). A redelivered duplicate finds `SENDING`/`SENT` and is dropped.
6. It calls APNs/FCM, passing the notification ID as the collapse ID.
7. On success → `SENT`. On `410 Unregistered` → delete the device token (don't retry). On `5xx`/timeout → schedule a retry with backoff.
8. Provider callbacks later update the row to `DELIVERED`, `OPENED`, or `BOUNCED`.

## Campaign flow

See [Campaign send](#diagram/campaign).

1. A marketer creates a campaign: a segment, a template (with A/B variants), and a send time in each user's local time.
2. The campaign service validates and renders previews, and estimates cost (especially for SMS).
3. The scheduler waits for 10:00 in each time zone, then pages through the segment 10k users at a time.
4. For each batch it applies frequency caps and preferences, and submits notifications to the API with idempotency keys `campaign_id:user_id` — so a scheduler crash and restart can't double-send.
5. Enqueueing is paced with a token bucket per provider account (e.g. ≤ 5k/s), on the **low** priority lane.
6. A kill switch pauses the campaign's lane instantly if something is wrong.

## Deep dives

### 1. Why a queue per channel and per priority

- **Isolation:** if SendGrid slows down, only the email queue grows. Push and SMS continue at full speed.
- **Independent scaling:** push workers can scale 10× during a campaign without touching SMS.
- **Priority:** an OTP must never wait behind 20 million marketing emails. Separate lanes (and separate consumer pools) guarantee that; a single queue with priorities can't, because a backlog still has to drain in order.
- **Per-provider rate limits** are enforced by the workers of that queue.

### 2. No duplicates on top of at-least-once delivery

See [Dedup & failover](#diagram/reliability). Every layer can retry, so deduplication happens at every layer:

1. **API:** idempotency key → one notification per logical event.
2. **Worker:** conditional status transitions — only one worker can move a delivery from `PENDING` to `SENDING`.
3. **Provider:** pass the notification ID as a dedup/collapse ID (APNs `apns-collapse-id`, FCM `collapse_key`, email `Message-ID`), so the provider or device collapses repeats.
4. **Device:** the app ignores a notification ID it has already displayed.

The remaining gap: a worker sends to the provider, the provider accepts, and the worker crashes before recording `SENT`. The message is redelivered and the claim check sees `SENDING` with a stale timestamp. Policy: for push, resend (the collapse ID makes the device show it once); for SMS, don't resend without checking the provider's status API, because a duplicate SMS costs money and annoys users.

### 3. Retries and provider failures

- Retry **transient** errors (5xx, timeouts, throttling) with exponential backoff and jitter, via retry topics (`push.retry.30s`, `push.retry.5m`) so the main queue isn't blocked.
- **Don't retry permanent** errors (4xx): invalid token, unsubscribed address, malformed number. Fix the data: delete dead tokens, mark bouncing emails invalid.
- After N attempts, move to the **dead-letter queue** and alert.
- **Circuit breaker** per provider: after a high error rate, stop calling it for a while, and probe with a few requests.
- **Failover:** SMS and email have interchangeable vendors — route to the backup. Push has no alternative (APNs is the only way to reach iPhones), so keep retrying and, for critical alerts, fall back to another channel.
- **TTL:** some messages are worthless if late (an OTP after 10 minutes). Drop them when `ttl_s` has passed instead of delivering stale messages.

### 4. Preferences, quiet hours and frequency caps

- Check opt-outs **before enqueueing** (saves work) and **again right before sending** for scheduled messages (the user may have opted out in between).
- **Quiet hours:** non-urgent notifications during a user's night are put in the scheduler's delay queue until their local morning. Security alerts and OTPs bypass quiet hours.
- **Frequency caps:** Redis counters per user/category/day with `INCR` + TTL. If over the cap, the notification is suppressed (and recorded as such).
- **Legal:** marketing email needs an unsubscribe link and must honour unsubscribes quickly; SMS needs opt-in consent in many countries.

### 5. Templates and localisation

- Templates are versioned; a notification records which version it used.
- Rendering at enqueue time freezes the content; rendering at send time (for scheduled sends) picks up fixes. Choose per type.
- Validate variables against a schema when a template is published, so a missing variable doesn't produce "Hello {{name}}".

### 6. Device tokens

- Apps register tokens on launch; tokens change (reinstall, OS updates) — upsert by `(user_id, device_id)`.
- Remove tokens on provider "unregistered" responses and after long inactivity.
- One user with 5 devices gets 5 pushes; collapse IDs and "mark read everywhere" keep it sane.

### 7. In-app inbox

Store notifications per user (`user_id, created_at DESC`) with read/unread state. The app fetches with a cursor and marks items read. If the user is online, push the new item over the app's existing WebSocket for instant display. Unlike push, the inbox is durable and complete.

## Scaling and reliability

- The API and workers are stateless; scale on request rate and queue lag.
- Queues are durable and replicated; if a worker dies mid-message, the message is redelivered.
- Cache preferences and tokens (with invalidation on update) — they're read for every notification.
- Partition queues by `user_id` so notifications to one user are processed in order.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Provider outage | One channel stalls | Circuit breaker; vendor failover; queue absorbs backlog |
| Provider throttling | Slower sends | Token bucket per provider; backoff on 429 |
| Worker crash after send, before status update | Possible duplicate | Collapse IDs; provider dedup; SMS status check |
| Preferences DB down | Can't decide | Serve from cache; if unknown, send only transactional-critical messages |
| Bad template deployed | Garbage content | Template validation, canary, instant rollback to previous version |
| Campaign bug | Millions of wrong messages | Kill switch on the low lane; start campaigns with a small canary percentage |

## Observability

| Metric | Why |
| --- | --- |
| Time from API accept to provider accept, per channel and priority | The core latency SLO |
| Queue depth and oldest-message age per lane | Backlogs, capacity |
| Provider error rates by code | Outages, bad data |
| Suppressed count by reason (opt-out, cap, quiet hours) | Is the product over-notifying? |
| Delivered / opened / bounced rates | Deliverability; spam-folder problems |
| Duplicate-detected counts at each layer | Health of dedup |
| DLQ size | Messages needing attention |

## Trade-offs to discuss

- **Build vs buy:** providers (and platforms like Braze or Customer.io) handle carrier and APNs details; you still own orchestration, preferences, deduplication and integration with your data.
- **Render early vs late:** early rendering freezes content and simplifies workers; late rendering allows fixes and fresher data.
- **Strict no-duplicates vs no-drops:** you can't have both perfectly around a crash; decide per channel (push: prefer resend; SMS: prefer checking first).
- **You can guarantee handing off to a provider, not that the user sees it:** phones are off, emails go to spam. Design product flows accordingly (e.g. OTP resend buttons).

## Interview follow-up questions

- **How do you avoid waking users at 3 a.m.?** Store time zones, apply quiet hours in the scheduler, and send campaigns at local times.
- **How would you let users see notifications they missed?** The in-app inbox is the durable record; push is a best-effort nudge.
- **How do you handle a user with 10 devices?** Send to all active tokens with the same collapse ID; clear badges across devices on read.
- **How do you stop teams from spamming users?** Per-category frequency caps and priorities enforced centrally; review of new notification types.
- **How do you roll out a new SMS vendor?** Route a small percentage of traffic, compare delivery rates and latency, then shift gradually — with automatic failback.
