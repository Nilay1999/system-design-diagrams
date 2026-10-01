# Ticket Booking (BookMyShow / Ticketmaster)

> Sell a fixed number of seats for movies, concerts and matches to crowds that arrive all at once, and never sell the same seat twice.

## The problem in one minute

Most of the time, ticket booking is an ordinary, modest-traffic web app. The difficulty shows up in two places:

1. **Correctness under contention.** Two people click the same seat at the same moment. Exactly one must get it — always, even with retries, crashes, and payment delays.
2. **Flash crowds.** A big on-sale brings millions of people for tens of thousands of seats within minutes. Almost all of them will fail to get a ticket; the system must fail them **gracefully and fairly** instead of falling over.

So the design separates a **read path** (browsing, search, seat maps — heavily cached, eventually consistent) from a small, strict **booking path** (hold → pay → confirm with conditional writes in a strongly consistent database), and puts a **virtual waiting room** in front of the booking path for hot events.

| Decision | Choice | Why |
| --- | --- | --- |
| Booking store | Relational DB, seats sharded by `show_id` | Row-level transactions; a booking touches one shard |
| Double-booking guard | Conditional updates (`… WHERE status = 'AVAILABLE'`) as the final authority | Correct regardless of caches and retries |
| Holds | Redis keys with a 10-minute TTL (+ DB status) | Fast, auto-expiring, all-or-nothing via Lua |
| Payment | Hold → pay → confirm saga with idempotency keys; refund as compensation | Never charge without a seat, or give a seat without payment |
| Flash crowds | CDN-served waiting room admitting users at a controlled rate; random order for early arrivals | Protects the backend and is fair |
| Browsing | Search index + caches fed by CDC; seat map updates pushed via SSE | Cheap reads at huge scale |

## Requirements

### Functional

- Browse and search events by city, date, venue, genre.
- View a show's **seat map** with live availability and prices.
- **Select seats and hold them** for a few minutes while paying.
- Pay and receive a confirmed ticket (QR code by email/app).
- Cancel / refund according to the event's policy.
- Per-user ticket limits for popular events.

### Non-functional

| Property | Target |
| --- | --- |
| Correctness | A seat is never sold twice; a user is never charged without a booking |
| Availability | Browsing highly available; booking available during flash crowds (via queueing) |
| Latency | Seat map < 300 ms; hold < 500 ms |
| Fairness | Earlier or randomly-ordered users get a fair chance; bots are throttled |
| Scale | ~10 M bookings/day normally; 10 M+ concurrent users for a hot on-sale |

## Capacity estimation

- **Normal load:** 10 M bookings/day ≈ **120 bookings/s**, with browsing ~100× higher (~12k reads/s).
- **Hot on-sale:** 10 M users arrive within minutes for 50k seats. If unprotected, seat-map reads could exceed **1 M/s**, and hold attempts would mostly collide on the best seats. At most 50k bookings can succeed; the goal is to process them in, say, 30 minutes → ~30 bookings/s actually completing, with hold attempts maybe 10× that.
- **Seat rows:** 50k screens/venues × ~5 shows/day × ~500 seats ≈ **125 M seat-show rows/day**. Past shows are archived, so the live table holds only upcoming shows (a few billion rows across shards).
- **Holds in Redis:** at most the number of seats currently being purchased — small (hundreds of thousands of keys at peak).

The challenge is not average throughput; it's **contention on a few thousand rows** and **absorbing a crowd** that can't all be served.

## API

```http
GET  /v1/events?city=bengaluru&date=2026-10-03&q=…
GET  /v1/shows/{show_id}/seats                    → seat map: section, row, seat, price tier, status
GET  /v1/shows/{show_id}/seats/stream             → SSE: seat status changes

POST /v1/shows/{show_id}/holds
     { "seat_ids": ["A11", "A12"] }
     → 201 { "hold_id": "h-9", "expires_at": "…+10 min", "amount": 1200 }
     → 409 { "error": "seats_unavailable", "taken": ["A12"] }

POST /v1/bookings
     Idempotency-Key: k-77
     { "hold_id": "h-9", "payment_method_id": "pm-1" }
     → 202 { "booking_id": "bk-5", "status": "PENDING_PAYMENT" }

GET    /v1/bookings/{id}                           → status, tickets
DELETE /v1/holds/{hold_id}                         → release early
POST   /v1/bookings/{id}/cancel                    → refund per policy
```

For hot events, every booking-path call also carries a signed **admission token** from the waiting room.

## Data model

See [Data model](#diagram/data-model).

```sql
CREATE TABLE seats (                       -- sharded by show_id
  show_id          BIGINT,
  seat_id          TEXT,                   -- 'A11'
  section          TEXT,
  row_label        TEXT,
  seat_number      INT,
  price_tier       TEXT,
  status           TEXT NOT NULL,          -- AVAILABLE | HELD | BOOKED
  hold_id          TEXT,
  hold_expires_at  TIMESTAMPTZ,
  booking_id       TEXT,
  version          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (show_id, seat_id)
);

CREATE TABLE bookings (
  booking_id       TEXT PRIMARY KEY,
  user_id          BIGINT,
  show_id          BIGINT,
  seat_ids         TEXT[],
  amount           NUMERIC(12,2),
  currency         CHAR(3),
  status           TEXT,                   -- PENDING_PAYMENT | CONFIRMED | CANCELLED | REFUNDED
  payment_id       TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ
);
```

Events, venues and shows are small, read-mostly tables (also indexed into Elasticsearch for search). **Sharding by `show_id`** keeps every seat of a show on one shard, so holding several seats is a single-shard transaction, and different shows never contend with each other.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| CDN + waiting room | Serves static pages and the queue page; admits users to the booking flow at a controlled rate |
| API gateway | Verifies admission tokens, rate-limits, blocks bots |
| Event search | Search over the index (fed by CDC), cached |
| Seat map service | Merges seat status from the DB with live holds from Redis; pushes changes over SSE |
| Booking service | Holds, bookings, confirmations; the only writer of seat status |
| Seat holds (Redis) | `hold:{show}:{seat}` keys with TTL |
| Seats DB | Source of truth for seat status and bookings |
| Payment service | Charges through the PSP with idempotency keys; refunds |
| Ticketing | Issues QR tickets and sends them, from `BookingConfirmed` events |
| Hold sweeper | Releases DB holds whose time has passed |

## Hold, pay, confirm

See [Hold, pay, confirm](#diagram/hold-book).

1. The user selects seats A11 and A12 and calls `POST /holds`.
2. A Lua script in Redis checks that neither `hold:s-1:A11` nor `hold:s-1:A12` exists and sets both with a 10-minute TTL — all or nothing. If either is taken, return `409` with fresh availability.
3. The booking service records the hold in the DB with a conditional update: `UPDATE seats SET status='HELD', hold_id='h-9', hold_expires_at=… WHERE show_id=… AND seat_id IN (…) AND status='AVAILABLE'`. If fewer rows than seats are updated, roll back and release the Redis keys.
4. The user confirms with `POST /bookings` and an idempotency key. The booking is created as `PENDING_PAYMENT`.
5. The payment service charges via the PSP, using the booking ID as the PSP idempotency key — a retry can never charge twice.
6. On `PaymentSucceeded`: in one transaction, move the seats `HELD → BOOKED` **only if they are still held by `h-9`**, mark the booking `CONFIRMED`, and write an outbox event. Ticketing sends the tickets.
7. If the hold had expired and the seats were sold to someone else, the conditional update affects 0 rows → refund the payment automatically and apologise.

## Deep dives

### 1. Preventing double booking

See [Seat states & locking](#diagram/seat-states).

**Pessimistic locking**

```sql
BEGIN;
SELECT seat_id, status FROM seats
 WHERE show_id = $1 AND seat_id = ANY($2)
 ORDER BY seat_id            -- consistent order avoids deadlocks
 FOR UPDATE;
-- if any status <> 'AVAILABLE' → ROLLBACK and return 409
UPDATE seats SET status = 'HELD', hold_id = $3, hold_expires_at = now() + interval '10 minutes'
 WHERE show_id = $1 AND seat_id = ANY($2);
COMMIT;
```

Simple and correct. On a hot show, transactions on the same seats queue behind each other, which limits throughput but never correctness.

**Optimistic concurrency**

```sql
UPDATE seats SET status = 'HELD', hold_id = $3, version = version + 1
 WHERE show_id = $1 AND seat_id = $2 AND status = 'AVAILABLE';
-- 1 row → you got it; 0 rows → someone else did
```

No locks are held while a user thinks. Ideal when conflicts per seat are rare — which is true for most shows.

**Redis holds + DB guard**

`SET hold:{show}:{seat} {hold_id} NX EX 600`, via Lua for multiple seats. Very fast and self-expiring. Redis isn't the source of truth: after a failover a hold could be lost, so the database's conditional update is still what decides `BOOKED`. Most production systems combine Redis holds (speed, user experience) with database guards (correctness).

### 2. Hold expiry

- Redis TTLs remove abandoned holds automatically; the seat map shows the seat as available again.
- In the DB, a seat with `status = 'HELD' AND hold_expires_at < now()` is treated as available by the hold query (`… WHERE status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at < now())`), and a sweeper resets such rows periodically.
- The hold time is shown to the user as a countdown. It must cover a slow payment (3-D Secure, UPI approval on another phone) — typically 8–15 minutes.
- A payment that succeeds after its hold expired is caught by the conditional confirm and refunded.

### 3. Flash crowds: the virtual waiting room

See [Waiting room](#diagram/waiting-room).

- Before the on-sale, users land on a **waiting page served from the CDN** — millions of users cost the backend almost nothing.
- Everyone who arrives **before** the start time is given a **random** position (so refreshing at 09:59:59.9 is pointless); later arrivals queue in order.
- The queue service admits users at a rate the booking path can handle (e.g. 2,000/minute), issuing a **signed admission token** valid for ~10 minutes. The gateway rejects booking calls without a valid token.
- When inventory runs out, the queue tells everyone still waiting right away.
- Combine with **bot defences**: CAPTCHA at queue entry, device fingerprinting, per-account and per-card ticket limits, and verified fan programmes.

### 4. Seat map freshness

- The seat map is read far more often than seats change. Serve it from a cache (per show, ~1–2 s TTL) combining DB status with live Redis holds.
- Push changes to viewers of the same show via SSE/WebSocket so seats grey out as others hold them.
- Accept that the map can be a second behind: a hold attempt on a "just taken" seat returns a friendly `409` with the updated map.

### 5. Payments and the booking saga

The booking is a small saga: **hold seats → charge → confirm** (or, on failure, **refund → release**). Each step is idempotent:

- `POST /bookings` deduplicates on the idempotency key.
- The PSP call uses the booking ID as its idempotency key.
- The confirm step is a conditional update; repeating it changes nothing.
- A reconciliation job compares PSP records with bookings daily and fixes any stragglers (e.g. charged but not confirmed → confirm or refund). See the Payment System topic.

### 6. General admission and other inventory types

Not all events have numbered seats. For general admission (e.g. 10,000 standing tickets), keep a **counter** per tier and decrement with a conditional update (`UPDATE tiers SET available = available - 2 WHERE tier_id = ? AND available >= 2`). For extreme contention, split the counter into several sub-counters (buckets) and decrement a random one.

## Scaling and reliability

- Shard seats and bookings by `show_id`. Contention for one show stays on one shard; different shows scale independently.
- Read path: CDN, caches, search index — scaled independently of booking.
- Pre-scale and warm caches before announced on-sales; test with load that matches the expected crowd.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Redis failover loses holds | Some holds vanish early | DB conditional update still prevents double booking; user may see "seat lost" |
| Payment succeeds, confirm fails | Charged without a ticket | Retry confirm from the event; reconciliation; refund if seats are gone |
| User double-clicks "Pay" | Duplicate bookings/charges | Idempotency keys on booking and PSP |
| Booking DB shard overloaded by a hot show | Slow holds | Waiting room throttles admission; optimistic updates avoid lock queues |
| Waiting room service down | Crowd hits the backend directly | Fail closed for hot events (show "try again"), never fail open |
| Bots | Tickets scalped | CAPTCHA, fingerprinting, per-account limits, purchase velocity checks |

## Observability

- Hold success rate and `409` rate per show (contention).
- Time from hold to confirmation; hold expiry rate (abandonment).
- Payment success rate; charged-but-not-confirmed count (should be ~0).
- Waiting room: queue length, admission rate, time in queue.
- Double-booking detector: a periodic query for seats referenced by two confirmed bookings (should always be empty).

## Trade-offs to discuss

- **Pessimistic vs optimistic vs Redis:** simplicity vs throughput vs speed — always keep a DB-level guard.
- **Hold duration:** too short and payers lose seats mid-payment; too long and abandoned carts lock inventory.
- **Fairness vs throughput:** a waiting room adds waiting time but prevents meltdowns and bot advantage.
- **Best-seat selection by the system vs user choice:** auto-assigning the best available seats reduces contention dramatically (no one fights over the same seat), at the cost of user choice.

## Interview follow-up questions

- **How do you let a group of 6 sit together?** Search for contiguous available seats in a row (precomputed "gaps" per row), then hold them all atomically.
- **How would you implement "best available" seats?** Score seats by view quality; the hold call picks the best contiguous block and holds it in one transaction.
- **What if the PSP is down during an on-sale?** Extend holds while payments are queued, or pause admission from the waiting room.
- **How do you handle resale / transfers?** Transfer creates a new ticket for the recipient and invalidates the old QR; resale runs through the same hold → pay → confirm flow.
- **How do you stop one user from holding 200 seats to block others?** Per-user hold limits and admission tokens bound to the account.
