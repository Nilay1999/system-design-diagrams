# Notification System

> One service that every team calls to reach users via iOS/Android push, SMS and email — respecting preferences, never double-sending, and surviving flaky third-party providers.

## Requirements

### Functional
- Channels: **push (APNs, FCM), SMS, email** (in-app optional).
- Triggered by internal services (transactional) or campaigns (bulk/scheduled).
- Templates with localisation.
- User **preferences and opt-outs** per channel and category; quiet hours.
- Delivery status tracking (sent, delivered, opened, failed).

### Non-functional
- **At-least-once** delivery internally, **no user-visible duplicates**.
- Transactional (OTP, security alerts) delivered within seconds; marketing can be slower.
- Isolation: a slow email provider must not delay push notifications.
- Scale: 10 M notifications/day typical, spikes of millions in minutes for campaigns.

## Estimation

| Channel | Volume/day | Avg rate |
| --- | --- | --- |
| Push | 10 M | ~115/s (bursts 10k+/s for campaigns) |
| Email | 5 M | ~60/s |
| SMS | 1 M | ~12/s (cost-sensitive!) |

## API

```http
POST /v1/notifications
Idempotency-Key: order-8812-shipped
{
  "user_id": "u-123",
  "type": "order_shipped",          // maps to category + template
  "channels": ["push", "email"],     // optional; defaults from type
  "data": { "order_id": "8812", "eta": "Tue" },
  "priority": "high"
}
```

Bulk campaigns take a segment ID and a schedule instead of a single `user_id`.

## Data model

```text
user_contact     (user_id, email, phone, verified flags)
device_tokens    (user_id, device_id, platform, token, last_seen)
preferences      (user_id, category, channel, enabled, quiet_hours)
templates        (type, channel, locale, version, subject, body)
notification_log (notification_id, user_id, channel, status, provider_msg_id, timestamps)
```

## High-level design

1. **Notification service** validates the request, checks the **idempotency key** (Redis `SET NX` with TTL), loads preferences and contact info, renders the template, and decides the channels.
2. It enqueues one message per channel onto **per-channel queues** (Kafka topics or SQS queues), split further by priority.
3. **Channel workers** consume, call the third-party provider, and record the result.
4. Failures go to a **retry queue** with exponential backoff; after N attempts → **dead-letter queue** for inspection.
5. Provider callbacks (delivery receipts, bounces, opens) update the notification log and analytics.

## Deep dives

### Why a queue per channel (and per priority)?
- **Isolation:** SendGrid slowing down fills only the email queue.
- **Independent scaling:** push workers can scale 10× during a campaign.
- **Priority:** OTPs never wait behind a marketing blast.

### Exactly-once *effect* over at-least-once delivery
- Idempotency key at the API edge rejects duplicate requests.
- Workers write `notification_id` status transitions with conditional updates (`PENDING → SENT` only once); a redelivered message that sees `SENT` is dropped.
- Many providers accept an idempotency/dedup ID too — pass `notification_id` through.

### Retries
- Retry on 5xx/timeouts with exponential backoff + jitter; don't retry on 4xx (invalid token, unsubscribed).
- On APNs/FCM "unregistered token" responses, **delete the device token**.
- Circuit-break a failing provider and fail over to a secondary (e.g. Twilio → alternate SMS vendor).

### Preferences, rate limits and quiet hours
- Check opt-outs **before** enqueueing (and re-check in the worker for scheduled sends).
- Per-user frequency caps (e.g. ≤ 3 marketing pushes/day) prevent notification fatigue.
- Quiet hours: delay non-urgent notifications to the user's local morning via a scheduler (delay queue or time-bucketed table).

### Bulk campaigns
- A scheduler expands a segment into user IDs in batches and enqueues them at a controlled rate so providers aren't overwhelmed.
- Respect provider rate limits with a token bucket per provider account.

### Templates
Versioned templates rendered server-side (Handlebars/Mustache) with localisation; preview and A/B variants in the template store.

## Scaling & reliability

- Stateless service and workers → scale horizontally.
- Queues are durable; if workers die, messages are redelivered.
- Monitor queue depth/age per channel; autoscale workers on lag.
- Notification log can be large — store in a wide-column store with TTL, and ship events to a warehouse for analytics.

## Trade-offs

- **Build vs buy:** providers handle carrier/APNs specifics; you own orchestration, preferences and dedup.
- **Push vs pull for in-app:** in-app inbox is stored and fetched; push is fire-and-forget with no guarantee of display.
- **Delivery guarantees:** you can guarantee handing off to a provider; you cannot guarantee a user sees it.
