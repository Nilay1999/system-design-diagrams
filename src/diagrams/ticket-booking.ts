import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Ticket Booking — architecture", "Browsing is cached and eventually consistent; holding and booking a seat is small, strict, and strongly consistent")
    .zone("Read path (cache everything)", ["search", "es", "seatmap"], "#1971c2")
    .zone("Booking path (correctness first)", ["booking", "redis", "seats", "pay"], "#2f9e44")
    .node("user", "Users", 0, 1, "client", { detail: "web + app" })
    .node("cdn", "CDN + waiting room", 1.1, 1, "edge", { detail: ["static pages, queue page", "admits N users / min"] })
    .node("gw", "API gateway", 2.2, 1, "edge", { detail: ["admission token check", "rate limits, bot defence"] })
    .node("search", "Event search", 3.3, -0.3, "service", { detail: "city, date, venue" })
    .node("es", "Search index", 4.4, -0.3, "db", { detail: "Elasticsearch (via CDC)" })
    .node("seatmap", "Seat map service", 3.3, 0.8, "service", { detail: ["availability per show", "push updates (SSE)"] })
    .node("booking", "Booking service", 3.3, 2.05, "service", { detail: ["hold → pay → confirm", "idempotent APIs"] })
    .node("redis", "Seat holds", 4.4, 2.05, "cache", { detail: ["Redis: hold:{show}:{seat}", "TTL 10 min"] })
    .node("seats", "Seats DB", 4.4, 3.05, "db", { detail: ["PostgreSQL, shard by show_id", "conditional updates"] })
    .node("pay", "Payment service", 3.3, 3.3, "service", { detail: "idempotency keys" })
    .node("psp", "PSP", 4.4, 4.2, "external", { detail: "cards, UPI, wallets" })
    .node("ticket", "Ticketing", 2.2, 3.3, "worker", { detail: ["QR tickets, email / SMS", "from BookingConfirmed"] })
    .node("sweeper", "Hold sweeper", 5.5, 3.05, "worker", { detail: "releases expired DB holds" })
    .edge("user", "cdn")
    .edge("cdn", "gw", "admitted")
    .edge("gw", "search")
    .edge("search", "es")
    .edge("gw", "seatmap")
    .edge("seatmap", "redis", "held seats")
    .edge("gw", "booking", "hold / book")
    .edge("booking", "redis", "SET NX")
    .edge("booking", "seats", "txn")
    .edge("booking", "pay")
    .edge("pay", "psp")
    .edge("booking", "ticket", "confirmed", { async: true })
    .edge("sweeper", "seats")
    .panel(
      "Scale",
      ["Normal: ~120 bookings/s; browsing 100× more", "Hot on-sale: 10 M users for 50k seats", "Seat-map reads > 1 M/s at the peak", "The hard part is contention on a few rows"],
      0,
      2.4,
      { width: 380, tone: "info" },
    )
    .build();
}

function holdBook() {
  return new Sequence("Hold, pay, confirm", "Seats are held for 10 minutes; the database has the final say on who gets each seat", { gap: 225 })
    .actor("u", "User", "client")
    .actor("b", "Booking service", "service")
    .actor("r", "Redis holds", "cache")
    .actor("db", "Seats DB", "db")
    .actor("p", "Payment service", "service")
    .actor("psp", "PSP", "external")
    .msg("u", "b", "POST /holds {show s-1, seats [A11, A12]}")
    .msg("b", "r", "Lua: if none of hold:s-1:A11, A12 exist → SET both NX EX 600 (all or nothing)")
    .break("a seat is already held", "u", "r")
    .msg("b", "u", "409 'just taken' + fresh availability", { error: true })
    .end()
    .msg("b", "db", "UPDATE seats SET status='HELD', hold_id=h-9 WHERE show=s-1 AND seat IN (A11, A12) AND status='AVAILABLE'")
    .msg("b", "u", "201 {hold_id h-9, expires_at +10 min}", { reply: true })
    .msg("u", "b", "POST /bookings {hold_id h-9} Idempotency-Key: k-77")
    .msg("b", "db", "INSERT booking bk-5 PENDING_PAYMENT")
    .msg("b", "p", "charge ₹1,200, key bk-5")
    .msg("p", "psp", "authorise + capture (idempotency key bk-5)")
    .msg("psp", "p", "succeeded", { reply: true })
    .msg("p", "b", "PaymentSucceeded(bk-5)", { async: true })
    .alt("hold still valid", "u", "db")
    .msg("b", "db", "BEGIN; UPDATE seats SET status='BOOKED', booking_id=bk-5 WHERE hold_id=h-9 AND status='HELD'; booking → CONFIRMED; outbox event; COMMIT")
    .msg("b", "u", "booking confirmed, tickets on the way", { reply: true })
    .else("hold expired and the seat was re-sold")
    .msg("b", "p", "refund bk-5 (compensation)", { error: true })
    .msg("b", "u", "sorry — payment refunded", { error: true })
    .end()
    .build();
}

function waitingRoom() {
  return new Sequence("Virtual waiting room for a hot on-sale", "Absorb 10 M users at the edge; admit them at the rate the booking path can handle", { gap: 250 })
    .actor("u", "User", "client")
    .actor("cdn", "CDN waiting page", "edge")
    .actor("q", "Queue service", "service")
    .actor("gw", "API gateway", "edge")
    .actor("b", "Booking flow", "service")
    .msg("u", "cdn", "open event page before 10:00 on-sale")
    .msg("cdn", "q", "join queue (device fingerprint, CAPTCHA passed)")
    .msg("q", "q", "everyone who joined before 10:00 gets a RANDOM position; later arrivals queue in order")
    .msg("q", "u", "token {position 482,113, est. wait 38 min}", { reply: true })
    .loop("every 20–30 s (served from the edge)", "u", "q")
    .msg("u", "q", "poll position")
    .end()
    .msg("q", "q", "admit 2,000 users / min — tuned to booking capacity and remaining seats")
    .msg("q", "u", "your turn: signed admission token (valid 10 min)", { reply: true })
    .msg("u", "gw", "GET seat map + POST /holds with admission token")
    .msg("gw", "gw", "verify signature + expiry; per-account ticket limit")
    .msg("gw", "b", "forward")
    .note("When seats sell out, the queue tells everyone still waiting immediately — no point letting them hammer the system.", ["q", "b"], "warn")
    .build();
}

function seatStates() {
  return new Diagram("Deep dive — seat states & locking", "Every transition is a conditional write; three ways to make the hold step safe")
    .node("avail", "AVAILABLE", 0, 1, "service")
    .node("held", "HELD", 1.2, 1, "cache", { detail: "hold_id, expires in 10 min" })
    .node("booked", "BOOKED", 2.4, 1, "service", { detail: "booking_id" })
    .node("refund", "CANCELLED", 2.4, 2.2, "external", { detail: "refund per policy" })
    .edge("avail", "held", "hold (only if AVAILABLE)")
    .edge("held", "booked", "payment ok")
    .edge("held", "avail", "expire / release", { via: [[0.6, 0.15]] })
    .edge("booked", "refund", "cancel")
    .edge("refund", "avail", "re-sell", { via: [[0, 2.2]] })
    .panel(
      "1. Pessimistic lock",
      ["SELECT … FOR UPDATE on the seat rows (sorted ids to avoid deadlocks)", "Check all AVAILABLE, then UPDATE", "Simple and correct; contention serialises on hot seats"],
      3.6,
      -0.2,
      { width: 440 },
    )
    .panel(
      "2. Optimistic (conditional update)",
      ["UPDATE … SET status='HELD' WHERE seat=? AND status='AVAILABLE'", "0 rows → someone else won; no locks held while waiting", "Best when conflicts per seat are rare"],
      3.6,
      0.95,
      { width: 440, tone: "info" },
    )
    .panel(
      "3. Redis hold + DB guard",
      ["SET hold:{show}:{seat} NX EX 600 (Lua for several seats)", "Very fast; TTL frees abandoned holds", "Final BOOKED write is still a DB conditional update, so a Redis failover can't double-sell"],
      3.6,
      2.1,
      { width: 440, tone: "good" },
    )
    .build();
}

function dataModel() {
  return new Diagram("Data model", "Seats for one show live on one shard, so a booking is a single-shard transaction")
    .table("events", "events", ["event_id     PK", "title, category, artist", "venue_id", "on_sale_at", "max_tickets_per_user"], 0, 0)
    .table("shows", "shows", ["show_id      PK", "event_id", "starts_at", "seat_layout_id", "status"], 0, 1.8)
    .table(
      "seats",
      "seats  (shard key: show_id)",
      ["show_id          PK part", "seat_id          PK part (A11)", "section, row, number", "price_tier", "status           AVAILABLE | HELD | BOOKED", "hold_id, hold_expires_at", "booking_id", "version"],
      1.5,
      0,
    )
    .table(
      "bookings",
      "bookings",
      ["booking_id     PK", "user_id, show_id", "seat_ids       [A11, A12]", "amount, currency", "status         PENDING_PAYMENT | CONFIRMED | CANCELLED", "payment_id", "idempotency_key  UNIQUE"],
      3.2,
      0,
    )
    .edge("shows", "events")
    .edge("seats", "shows")
    .edge("bookings", "seats")
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "hold-book", name: "Hold, pay, confirm", build: holdBook },
  { id: "waiting-room", name: "Waiting room", build: waitingRoom },
  { id: "seat-states", name: "Seat states & locking", build: seatStates },
  { id: "data-model", name: "Data model", build: dataModel },
] satisfies DiagramSpec[];
