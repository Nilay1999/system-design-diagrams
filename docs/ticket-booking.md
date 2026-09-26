# Ticket Booking (BookMyShow / Ticketmaster)

> Sell a fixed number of seats for movies, concerts and matches to crowds that arrive all at once, and never sell the same seat twice.

## Requirements

### Functional
- Browse and search events by city, date, venue.
- View a **seat map** with live availability.
- **Select seats and hold them** for a few minutes while paying.
- Pay and receive a confirmed ticket. Cancellation/refund per policy.

### Non-functional
- **Correctness:** a seat is never double-booked (strong consistency on booking).
- **High availability** for browsing, where eventual consistency is fine.
- Survive **flash crowds**: a Taylor Swift on-sale can bring 10M+ users for 50k seats.
- Fairness: users who arrived first get a fair chance.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Normal traffic | 10 M bookings/day | ~120 bookings/s, browse reads 100× that |
| Hot event | 10 M users in the first minutes for 50k seats | Browse/seat-map reads ~1 M+/s; only a trickle of real bookings can succeed |
| Seat rows | 50k venues × ~5 shows/day × 500 seats | ~125 M seat-show rows/day (archivable after the show) |

The hard part isn't average load. It's **contention on a small number of rows** during spikes.

## API

```http
GET  /v1/events?city=…&date=…
GET  /v1/shows/{show_id}/seats            → seat map with status
POST /v1/shows/{show_id}/holds            { seat_ids: [...] } → hold_id, expires_at   (or 409 seat taken)
POST /v1/bookings                          { hold_id, payment_method, idempotency_key } → booking_id
DELETE /v1/holds/{hold_id}
```

## Data model

```text
events   (event_id, title, venue_id, …)
shows    (show_id, event_id, starts_at)
seats    (show_id, seat_id, section, row, number, price_tier,
          status[AVAILABLE|HELD|BOOKED], hold_id, hold_expires_at, booking_id, version)
          PRIMARY KEY (show_id, seat_id)
bookings (booking_id, user_id, show_id, seat_ids, amount, status, payment_id, created_at)
```

A **relational DB** (Postgres/MySQL) with row-level transactions fits the booking path well. Shard by `show_id` so every seat of a show is in one shard.

## High-level design

1. **Browse/search** is served from Elasticsearch plus caches and CDN (fed by CDC from the DB). It's read-heavy and tolerates staleness.
2. **Hold:** the booking service atomically moves the selected seats `AVAILABLE → HELD` for ~10 minutes.
3. **Pay:** the user pays via the payment service/PSP, using an idempotency key.
4. **Confirm:** on payment success, seats go `HELD → BOOKED` in a DB transaction and a ticket is issued.
5. **Expiry:** if payment doesn't complete, the hold expires and the seats become available again.
6. For hot events, a **virtual waiting room** admits users into the booking flow at a controlled rate.

## Deep dives

### Preventing double booking: three options

**1. Pessimistic locking (DB)**
```sql
BEGIN;
SELECT * FROM seats WHERE show_id = $1 AND seat_id = ANY($2) FOR UPDATE;
-- check all AVAILABLE, else ROLLBACK
UPDATE seats SET status='HELD', hold_id=$3, hold_expires_at=now()+interval '10 min'
 WHERE show_id=$1 AND seat_id = ANY($2);
COMMIT;
```
Simple and correct. Row locks serialize contention on popular seats. Always lock in a consistent order (sorted seat IDs) to avoid deadlocks.

**2. Optimistic concurrency (conditional update)**
```sql
UPDATE seats SET status='HELD', hold_id=$3, version=version+1
 WHERE show_id=$1 AND seat_id=$2 AND status='AVAILABLE';   -- 0 rows → someone else got it
```
No locks held while waiting. Great when conflicts are rare per seat.

**3. Distributed lock / hold in Redis**
`SET hold:{show}:{seat} {user} NX EX 600` for each seat (use a Lua script for all-or-nothing on multiple seats). Very fast, and the TTL expires holds automatically. The final `BOOKED` write still goes through a DB conditional update, so a Redis failover can't cause a double sale.

A common production combination is Redis holds for speed and UX, plus a DB conditional update as the source of truth.

### Hold expiry
- With Redis TTLs, keys disappear on their own. The seat map reads Redis to show held seats.
- With DB holds, readers treat `HELD AND hold_expires_at < now()` as available, and a sweeper resets expired rows.
- Payment callbacks that arrive after expiry must re-check the seat. If it was re-sold, refund automatically.

### Flash crowds: virtual waiting room
- Put a **queue in front of the booking flow**: users get a position/token and are admitted at a rate the backend can handle (e.g. 2,000 users/min).
- Randomize positions among users who arrive before the on-sale time for fairness.
- Serve the waiting page from the CDN. The heavy traffic never reaches booking servers.
- Combine with **rate limiting and bot detection** (CAPTCHA, device fingerprinting, per-account ticket limits).

### Seat map freshness
Push availability updates via WebSocket/SSE to users viewing the same show, or poll every few seconds. It's fine if a seat looks available and the hold fails with a friendly "just taken".

### Payment integration
Idempotency keys on booking and on the PSP call. The saga: hold → pay → confirm, with compensation (release seats, refund) on failure. See *Payment System*.

## Scaling & reliability

- Shard seats by `show_id`. A single show's contention stays in one shard, and different shows scale independently.
- The read path (events, seat maps) is heavily cached, while the write path is small and strongly consistent.
- Pre-scale and pre-warm caches before announced on-sales.

## Trade-offs

- **Pessimistic vs optimistic vs Redis:** simplicity vs throughput vs speed. Always keep a DB-level guard for correctness.
- **Hold duration:** too short and payers lose seats mid-payment; too long and inventory is locked up by abandoners.
- **Fairness vs throughput:** a waiting room adds latency but prevents meltdown and bot advantage.
