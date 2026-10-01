# E-commerce Checkout (Amazon / Flipkart)

> Design the core of an online store: catalog and search, cart, and a checkout that reserves inventory, takes payment and creates an order. It must never oversell, even during a flash sale.

## The problem in one minute

An online store has two halves with opposite needs:

- **The storefront** — product pages, search, recommendations, cart — is read-heavy and huge (hundreds of millions of products, tens of thousands of page views per second). Slightly stale data is fine; speed and availability matter most.
- **Checkout** — reserve stock, take payment, create the order — is low-volume but must be **exactly right**: never sell a unit you don't have, never charge without creating an order, never create an order twice.

Checkout touches several services (orders, inventory, payment), each with its own database. Instead of a distributed transaction, it runs as a **saga**: a sequence of local transactions with compensating actions if a later step fails. Events between services are published with the **transactional outbox** so no state change is ever announced without being committed (or committed without being announced).

| Decision | Choice | Why |
| --- | --- | --- |
| Storefront | CDN + caches + search index fed by CDC | Fast, scalable, eventually consistent |
| Cart | Per-user document (DynamoDB/Redis); re-validated at checkout | Simple; never trust cart prices |
| Inventory | Conditional decrement (`… AND available >= qty`) + reservations with TTL | Never oversell, no long-held locks |
| Checkout | Orchestrated saga with compensations; idempotency key | Correct without distributed transactions |
| Events | Transactional outbox → Kafka | No lost or phantom events |
| Flash sales | Waiting room + Redis stock buckets decide winners; DB is the final guard | One hot SKU doesn't melt the database |

## Requirements

### Functional

- Browse and search products; product pages with price, availability ("in stock", "only 3 left"), reviews.
- Cart that persists across devices; guest carts merge on login.
- Checkout: address, delivery option, payment, order confirmation.
- Order history and tracking; cancellation before shipping; returns and refunds.
- Flash sales: limited stock at a special price, starting at a fixed time, with per-customer limits.

### Non-functional

| Property | Target |
| --- | --- |
| Storefront latency | Product page p99 < 300 ms; search < 500 ms |
| Storefront availability | 99.99 % — the store stays browsable even if checkout is degraded |
| Inventory correctness | No overselling, ever |
| Checkout correctness | No double orders or double charges; no charge without an order |
| Scale | 100 M daily users, 10 M orders/day, flash-sale spikes of 50–100× |

## Capacity estimation

- **Page views:** 100 M DAU × 20 pages ≈ 2 B/day ≈ **23k/s** average, 3–5× at peak. Most served from CDN and caches.
- **Orders:** 10 M/day ≈ **120/s** average. A flash sale can bring **~10k checkout attempts/s** for a few minutes.
- **Catalog:** 500 M SKUs × ~5 KB ≈ **2.5 TB** of product data; images (many TB) on object storage + CDN.
- **Inventory rows:** 500 M SKUs × a few warehouses ≈ 1–2 B rows, but only a small fraction change on a given day.
- **Order storage:** 10 M × ~5 KB (with items and addresses) ≈ 50 GB/day ≈ 18 TB/year.
- **Hot SKU:** a flash sale might see 2 M buyers for 1,000 units. A single database row can handle only a few thousand conditional updates per second — the core scaling problem.

## API

```http
GET  /v1/products/{sku}
GET  /v1/search?q=running+shoes&brand=…&size=9&sort=relevance&cursor=…

GET  /v1/cart
POST /v1/cart/items          { "sku": "sku-1", "qty": 2 }
DELETE /v1/cart/items/{sku}

POST /v1/checkout
Idempotency-Key: ck-31
{ "cart_version": 14, "address_id": "a-2", "delivery": "standard", "payment_method_id": "pm-1" }
→ 201 { "order_id": "o-88", "status": "CONFIRMED", "total": 3450, "eta": "2026-10-04" }
→ 409 { "error": "out_of_stock", "skus": ["sku-7"] }
→ 409 { "error": "price_changed", "cart": { … } }
→ 402 { "error": "payment_declined" }

GET  /v1/orders?cursor=…
GET  /v1/orders/{order_id}
POST /v1/orders/{order_id}/cancel
```

`cart_version` lets checkout detect that the cart changed in another tab since the user reviewed it.

## Data model

See [Data model](#diagram/data-model).

| Store | Key | Notes |
| --- | --- | --- |
| Catalog (document DB) | `sku` | Title, attributes, images, seller; indexed into Elasticsearch |
| Prices (KV + cache) | `sku` | Base price, promotions, validity windows |
| Cart (DynamoDB/Redis) | `user_id` | Items, quantities, version |
| `inventory` (SQL) | `(sku, warehouse_id)` | `on_hand`, `available`, `reserved`, `version` |
| `reservations` | `reservation_id` | Order, SKU, quantity, status, `expires_at` |
| `orders` (SQL, by `user_id`) | `order_id` | Status, totals, address snapshot, payment id, idempotency key |
| `order_items` | `(order_id, sku)` | Quantity, **price at purchase time** |
| `outbox` | `event_id` | Events written with the state change |

Orders store a **snapshot** of the address and the unit prices, because both can change later and the order must not.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Service | Data store | Consistency |
| --- | --- | --- |
| Catalog | Document DB + search index | Eventual |
| Search | Elasticsearch | Eventual (seconds) |
| Pricing | KV + cache | Eventual for display; re-checked at checkout |
| Cart | DynamoDB / Redis | Per user |
| Inventory | SQL, sharded by SKU | **Strong** |
| Order | SQL + outbox, sharded by user | **Strong** |
| Payment | SQL + double-entry ledger | **Strong** (see the Payment System topic) |
| Fulfilment, email, analytics | Event-driven | Eventual |

## Checkout

See [Checkout saga](#diagram/checkout).

1. `POST /checkout` with an idempotency key. A retry returns the same result instead of creating a second order.
2. The order service re-prices the cart **server-side** (promotions, taxes, shipping) and checks `cart_version`.
3. It creates the order as `PENDING`.
4. **Reserve inventory:** for each SKU, in sorted order, a conditional decrement moves units from `available` to `reserved` and creates a reservation with a 15-minute TTL. If any SKU fails, it releases the reservations already made and returns `409`.
5. **Charge payment** with the order ID as the idempotency key.
6. On success, in one transaction: commit the reservation (reserved → sold), set the order `CONFIRMED`, and insert an `OrderConfirmed` outbox row. Return `201`.
7. The outbox relay publishes the event; fulfilment, email, loyalty points and analytics react to it.
8. On payment failure: **compensate** — release the reservation, mark the order `PAYMENT_FAILED`, ask the user for another method.

If the order service crashes halfway, the saga resumes from the order's stored state. Every step is idempotent, and unpaid reservations expire on their own.

## Deep dives

### 1. Never oversell

```sql
UPDATE inventory
   SET available = available - :qty,
       reserved  = reserved  + :qty
 WHERE sku = :sku AND warehouse_id = :wh
   AND available >= :qty;          -- 0 rows updated → not enough stock
```

- The check and the decrement are one atomic statement. The row lock lasts only for the statement, not while a user types their card number.
- A **reservation** holds stock for the duration of payment; a sweeper returns expired reservations to `available`.
- **Multi-SKU carts:** reserve in a consistent (sorted) order to avoid deadlocks, and release all on any failure.
- **Multiple warehouses:** pick a warehouse (nearest with stock) per SKU; the conditional update is per warehouse row.

### 2. Flash sales: one very hot row

See [Flash sale](#diagram/flash-sale). Thousands of buyers per second all updating **one** inventory row serialise on its lock; latency explodes and the database suffers.

1. **Waiting room + bot defences** in front, served from the CDN; one unit per account.
2. **Decide winners in memory:** pre-load the sale stock into Redis, split across N buckets (`stock:sku-1:0..9`, 100 units each). A Lua script decrements a random non-empty bucket only if it's above zero. That takes microseconds and runs ~100k times/s.
3. **Losers** get "sold out" immediately and never touch the database.
4. **Winners** are put on a queue and processed by order workers at a steady rate, running the normal checkout saga — including the database's conditional decrement, which remains the final guard against overselling (e.g. if Redis fails over).
5. If a winner's payment fails, the unit goes back into a bucket for the next buyer (or a short waitlist).

### 3. Saga vs two-phase commit

Two-phase commit across order, inventory and payment would lock resources across services and block if the coordinator fails — and the payment provider won't take part in your 2PC anyway. A **saga** uses local transactions plus compensations (release stock, refund). An **orchestrator** (the order service, or a workflow engine like Temporal) keeps the state machine in one place, which makes failures easy to see and retry.

### 4. Transactional outbox

See [Order lifecycle & outbox](#diagram/order-states).

The dual-write problem: "update the order in the database, then publish to Kafka" can fail between the two steps, leaving the system either with a confirmed order nobody ships, or an event for an order that never committed.

- Write the state change **and** an `outbox` row in the same database transaction.
- A relay (polling, or CDC with Debezium) publishes outbox rows to Kafka and marks them published.
- Delivery is at-least-once, so consumers deduplicate by `event_id`.

### 5. Idempotency everywhere

Retries are normal: users double-click, apps retry on timeouts, Kafka redelivers.

- Checkout: idempotency key stored with the order (unique constraint).
- Payment: the PSP call uses the order ID as its idempotency key.
- Consumers: a processed-events table or naturally idempotent updates.

### 6. Prices and the cart

- The cart stores SKUs and quantities, not trusted prices. Prices are recomputed at checkout; if they changed, show the difference and ask for confirmation.
- Guest carts live in local storage or a cookie and merge into the account cart at login.
- Cart reads are frequent (header badge on every page) → cache.

### 7. Search and catalog

- Product changes flow from the catalog DB to Elasticsearch via CDC within seconds.
- Faceted search uses aggregations (brand, size, price ranges).
- Ranking blends text relevance, popularity, conversion rate, availability and sponsored placements.
- Availability shown on listings is approximate (cached); exactness is enforced at reservation.

## Scaling and reliability

- **Graceful degradation:** if recommendations, reviews or even search are down, product pages still render; if checkout is overloaded, queue users rather than failing.
- **Sharding:** orders by `user_id` (order history is per user); inventory by `sku`.
- **Cell-based regions:** each region serves its customers; inventory is owned by the region that owns the warehouse.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Payment succeeds, confirm write fails | Charged, no order | Saga retries confirm; reconciliation; refund if it can't confirm |
| Order service crashes mid-saga | Stuck `PENDING` order | Orchestrator resumes; reservation TTL frees stock |
| Inventory service down | Can't checkout | Show a friendly error; storefront still works |
| Outbox relay down | Events delayed | Rows wait in the outbox; nothing lost |
| Double click on "Place order" | Duplicate order | Idempotency key |
| Flash sale overload | Database meltdown | Waiting room, Redis gate, queued winners |
| Search index lag | Stale listings | Acceptable; availability rechecked at checkout |

## Observability

- Checkout funnel: cart → checkout → reserve → pay → confirm, with failure reasons.
- Reservation expiry rate (abandonment), oversell detector (should always be zero).
- Payment success rate by method; "charged but not confirmed" count (should be ~0).
- Outbox lag; consumer lag.
- Page latency and cache hit rates on the storefront.

## Trade-offs to discuss

- **Exact vs cached stock on pages:** exact counts don't scale for browsing; show approximate stock and enforce exactness at reservation.
- **Reserve at add-to-cart vs checkout:** reserving early locks stock in abandoned carts; most stores reserve at checkout (ticketing does the opposite, because seats are unique).
- **Synchronous vs queued checkout:** synchronous gives the best normal experience; queued survives flash sales.
- **Orchestration vs choreography:** an orchestrator keeps the saga visible in one place; pure event choreography is more decoupled but harder to follow and debug.

## Interview follow-up questions

- **How do you handle a cart with items from several sellers or warehouses?** Split into shipments (sub-orders) after payment; reserve per warehouse.
- **How do you implement "notify me when back in stock"?** Subscribe users per SKU; an inventory event fans out notifications in batches, rate-limited.
- **How do coupons work without being abused?** Validate at checkout; record redemptions with a unique constraint per user/coupon; limit total redemptions with a counter.
- **How do you process returns?** A return order with its own state machine: approved → received → inspected → refunded, restocking on inspection.
- **How would you handle tax across regions?** A tax service computes tax at checkout from the address and item categories; the order stores the computed tax as part of its snapshot.
