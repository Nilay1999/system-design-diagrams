import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Notification System — architecture", "One front door for every team; per-channel, per-priority queues so a slow provider never blocks the rest")
    .zone("Decide (who, what, which channel)", ["api", "idem", "prefs", "tmpl"], "#2f9e44")
    .zone("Deliver (isolated per channel + priority)", ["qpush", "qsms", "qemail", "wpush", "wsms", "wemail"], "#0c8599")
    .node("svc", "Product services", 0, 0.4, "client", { detail: "orders, auth, social" })
    .node("camp", "Campaign tool", 0, 2.2, "client", { detail: "segments + schedules" })
    .node("api", "Notification API", 1.1, 0.4, "service", { detail: ["validate, dedupe", "choose channels"] })
    .node("idem", "Idempotency store", 0.3, -0.9, "cache", { detail: "Redis SET NX, 24 h" })
    .node("prefs", "Preferences + contacts", 1.25, -0.9, "db", { detail: ["opt-outs, quiet hours", "device tokens, email, phone"] })
    .node("tmpl", "Templates", 2.2, -0.9, "db", { detail: "versioned, localised" })
    .node("sched", "Scheduler", 1.1, 2.2, "worker", { detail: ["campaign expansion", "quiet-hours delays"] })
    .node("qpush", "push.high / push.low", 3.3, -0.3, "queue", { detail: "Kafka topics" })
    .node("qsms", "sms.high / sms.low", 3.3, 0.8, "queue")
    .node("qemail", "email.high / email.low", 3.3, 1.9, "queue")
    .node("wpush", "Push workers", 4.4, -0.3, "worker", { detail: "token bucket per app" })
    .node("wsms", "SMS workers", 4.4, 0.8, "worker", { detail: "vendor failover" })
    .node("wemail", "Email workers", 4.4, 1.9, "worker", { detail: "bulk-send API" })
    .node("apns", "APNs / FCM", 5.5, -0.3, "external")
    .node("twilio", "Twilio / backup vendor", 5.5, 0.8, "external")
    .node("ses", "SES / SendGrid", 5.5, 1.9, "external")
    .node("log", "Notification log", 4.4, 3.2, "db", { detail: ["status per attempt", "Cassandra, TTL 90 d"] })
    .node("hooks", "Provider callbacks", 5.5, 3.2, "service", { detail: "delivered, bounced, opened" })
    .node("retry", "Retry + DLQ", 3.3, 3.2, "queue", { detail: "backoff, then park" })
    .edge("svc", "api", "POST /notifications")
    .edge("camp", "sched", "campaign")
    .edge("sched", "api", "batches, rate-limited")
    .edge("api", "idem", "seen key?")
    .edge("api", "prefs")
    .edge("api", "tmpl", "render")
    .edge("api", "qpush", undefined, { async: true })
    .edge("api", "qsms", undefined, { async: true })
    .edge("api", "qemail", undefined, { async: true })
    .edge("qpush", "wpush", undefined, { async: true })
    .edge("qsms", "wsms", undefined, { async: true })
    .edge("qemail", "wemail", undefined, { async: true })
    .edge("wpush", "apns")
    .edge("wsms", "twilio")
    .edge("wemail", "ses")
    .edge("wemail", "log", "status")
    .edge("hooks", "log", "update")
    .edge("wemail", "retry", "5xx / timeout", { async: true })
    .build();
}

function transactional() {
  return new Sequence("Sending one transactional notification", "\"Your order shipped\" — dedupe, respect preferences, deliver, record, retry safely", { gap: 225 })
    .actor("svc", "Order service", "client")
    .actor("api", "Notification API", "service")
    .actor("redis", "Idempotency store", "cache")
    .actor("prefs", "Preferences", "db")
    .actor("q", "push.high", "queue")
    .actor("w", "Push worker", "worker")
    .actor("apns", "APNs / FCM", "external")
    .actor("log", "Notification log", "db")
    .msg("svc", "api", "POST {user u-123, type order_shipped, data} Idempotency-Key: order-8812-shipped")
    .msg("api", "redis", "SET idem:order-8812-shipped NX EX 86400")
    .break("key already existed (a retry)", "svc", "redis")
    .msg("api", "svc", "202 with the original notification_id", { reply: true })
    .end()
    .msg("api", "prefs", "channels allowed for 'order updates'? quiet hours? device tokens?")
    .msg("prefs", "api", "push ✓ (2 devices), email ✓, SMS ✗; no quiet hours", { reply: true })
    .msg("api", "log", "INSERT notification n-77 (PENDING) per channel")
    .msg("api", "q", "{n-77, token, rendered payload}", { async: true })
    .msg("api", "svc", "202 Accepted {notification_id n-77}", { reply: true })
    .msg("q", "w", "consume", { async: true })
    .msg("w", "log", "UPDATE status SENDING WHERE id = n-77 AND status = PENDING")
    .msg("w", "apns", "send (apns-collapse-id = n-77)")
    .alt("200 accepted", "w", "log")
    .msg("w", "log", "status SENT, provider id")
    .else("410 Unregistered token")
    .msg("w", "prefs", "delete that device token", { error: true })
    .else("5xx / timeout")
    .msg("w", "q", "requeue to retry topic: attempt 2 after 30 s ± jitter", { async: true })
    .end()
    .build();
}

function campaign() {
  return new Sequence("A marketing campaign to 20 M users", "Expand the segment gradually and pace sends so providers and our own API aren't flooded", { gap: 240 })
    .actor("m", "Marketer", "client")
    .actor("c", "Campaign service", "service")
    .actor("seg", "Segment store", "db")
    .actor("s", "Scheduler", "worker")
    .actor("api", "Notification API", "service")
    .actor("q", "push.low", "queue")
    .msg("m", "c", "create campaign: segment 'lapsed_30d', template v3 (A/B), send 10:00 local time")
    .msg("c", "c", "validate template + render previews; estimate cost")
    .msg("c", "s", "schedule per time zone (10:00 in each zone)")
    .loop("for each time zone when its 10:00 arrives", "s", "q")
    .msg("s", "seg", "page user ids (10k per page)")
    .msg("s", "s", "apply frequency cap: ≤ 2 marketing pushes / user / day")
    .msg("s", "api", "batch of notifications, key = campaign_id:user_id")
    .msg("api", "q", "enqueue at ≤ 5k / s (token bucket per provider account)", { async: true })
    .end()
    .note("Low-priority lanes can be paused instantly (kill switch) if the campaign has a bug. Transactional lanes are unaffected.", ["s", "q"], "warn")
    .build();
}

function reliability() {
  return new Diagram("Deep dive — no duplicates, no silent drops", "At-least-once inside the system, deduplicated at every hop; failing providers are routed around")
    .zone("Notification status (conditional transitions)", ["pending", "sending", "sent", "delivered", "failed", "dead", "suppressed"], "#1971c2")
    .node("pending", "PENDING", 0, 1, "service")
    .node("suppressed", "SUPPRESSED", 0, 2.3, "external", { detail: "opted out / capped" })
    .node("sending", "SENDING", 1, 1, "worker", { detail: "claimed by a worker" })
    .node("sent", "SENT", 2, 0.3, "service", { detail: "provider accepted" })
    .node("delivered", "DELIVERED / OPENED", 3, 0.3, "service", { detail: "from callbacks" })
    .node("failed", "FAILED", 2, 1.7, "external", { detail: "retryable error" })
    .node("dead", "DEAD", 3, 1.7, "external", { highlight: true, detail: "max attempts → DLQ" })
    .edge("pending", "sending")
    .edge("pending", "suppressed")
    .edge("sending", "sent")
    .edge("sent", "delivered")
    .edge("sending", "failed")
    .edge("failed", "sending", "retry", { via: [[1.5, 2.3]] })
    .edge("failed", "dead")
    .panel(
      "Where duplicates are stopped",
      [
        "API: Idempotency-Key → SET NX (same request twice = one notification)",
        "Worker: UPDATE … WHERE status = PENDING (a redelivered message finds SENDING/SENT and is dropped)",
        "Provider: pass notification_id as collapse-id / dedup id",
        "Device: app ignores a notification id it already showed",
      ],
      4,
      0,
      { width: 470, numbered: true, tone: "info" },
    )
    .panel(
      "Provider failover",
      [
        "Circuit breaker per provider: open after 50 % errors in 30 s",
        "SMS: fail over to a secondary vendor; email: to a second account / region",
        "Push has no alternative provider → keep retrying with backoff; fall back to email for critical alerts",
        "Never retry 4xx (bad token, unsubscribed) — fix the data instead",
      ],
      4,
      1.6,
      { width: 470, tone: "warn" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "transactional", name: "Transactional send", build: transactional },
  { id: "campaign", name: "Campaign send", build: campaign },
  { id: "reliability", name: "Dedup & failover", build: reliability },
] satisfies DiagramSpec[];
