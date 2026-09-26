# E-commerce Checkout (Amazon / Flipkart)

> Design the core of an online store: catalog and search, cart, and a checkout that reserves inventory, takes payment and creates an order. It must never oversell, even during a flash sale.

## Requirements

### Functional
- Browse and search products. Product detail pages with price and stock status.
- Add to cart; cart persists across devices.
- Checkout: address, payment, order confirmation.
- Order history and status tracking; cancellations and returns.
- Flash sales: limited stock at a special price, starting at a fixed time.

### Non-functional
- **Catalog/search:** very read-heavy, low latency, eventual consistency OK.
- **Inventory/checkout:** strongly consistent. **No overselling.**
- High availability. The storefront should stay up even if checkout is degraded.
- Scale: 100 M DAU, 10 M orders/day, flash-sale spikes 50–100× normal.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Product page views | 100 M DAU × 20 | ~23k/s avg, much more at peak → CDN + caches |
| Orders | 10 M/day | ~120 orders/s avg; flash sale ~10k checkout attempts/s |
| Catalog | 500 M SKUs × 5 KB | ~2.5 TB of product data, plus images on CDN |

## Service decomposition

| Service | Data store | Consistency |
| --- | --- | --- |
| Catalog | Document DB + search index (Elasticsearch) | Eventual |
| Pricing | KV/SQL + cache | Eventual (validated at checkout) |
| Cart | DynamoDB/Redis keyed by user | Per-user |
| Inventory | SQL (row per SKU per warehouse) | **Strong** |
| Order | SQL + outbox | **Strong** |
| Payment | SQL + ledger | **Strong** (see *Payment System*) |
| Fulfilment/shipping | Event-driven | Eventual |

## API

```http
GET  /v1/products/{sku}                 GET /v1/search?q=…&filters=…
POST /v1/cart/items                     { sku, qty }
POST /v1/checkout                       { cart_id, address_id, payment_method, idempotency_key } → order_id
GET  /v1/orders/{order_id}
```

## High-level design

1. **Browse:** the CDN serves images and static pages. The catalog/search services serve product data from caches and the search index. Stock is shown as "in stock / only 3 left" from a cached, approximate value.
2. **Cart:** a simple per-user document. Prices and stock are re-validated at checkout, not trusted from the cart.
3. **Checkout** is a **saga** run by the order service:
   1. Create order `PENDING` (idempotency key).
   2. **Reserve inventory:** conditional decrement per SKU, with a reservation TTL.
   3. **Charge payment.**
   4. Mark order `CONFIRMED` and commit the reservation.
   5. Publish `OrderConfirmed` via the **transactional outbox** → fulfilment, email, analytics.
4. **Compensation:** if payment fails, release the reservation. If confirming fails after the charge, refund.

## Deep dives

### Never oversell
```sql
UPDATE inventory
   SET available = available - :qty, reserved = reserved + :qty
 WHERE sku = :sku AND warehouse = :wh AND available >= :qty;   -- 0 rows → out of stock
```
- The conditional update is atomic and needs no explicit locks, because the row lock is held only for the statement.
- Reservations expire (e.g. 15 min). A sweeper returns unpaid reservations to `available`.
- Multi-SKU carts: reserve SKUs in sorted order and release all of them if any one fails.

### Flash sales (hot SKU contention)
Thousands of buyers updating **one inventory row** serializes on its lock.
- **Pre-load stock into Redis** and decrement atomically (`DECRBY` with a Lua check `≥ 0`). Only winners proceed to the DB order path. The DB remains the final guard.
- **Split the counter** into N buckets (`sku:stock:0..N`), each holding a slice of the stock. Buyers try a random bucket.
- **Queue checkout requests** (Kafka) and process them at a fixed rate. Return "you're in line" and notify users of the result asynchronously.
- Add a waiting room, per-user purchase limits, bot protection, and pre-warmed caches for the product page.

### Saga vs 2PC
Distributed two-phase commit across inventory, payment and order is slow and blocks on coordinator failure. **Sagas** (a sequence of local transactions plus compensations) are the standard. Use an orchestrator (order service or Temporal) for visibility.

### Transactional outbox
Write the order state change **and** an `outbox` row in the same DB transaction. A relay (poller or Debezium CDC) publishes outbox rows to Kafka. This avoids the dual-write problem ("DB committed but event lost").

### Idempotency everywhere
Checkout, payment and fulfilment handlers all dedupe by key. Retries are expected: clients refresh, and message brokers deliver at least once.

### Search & catalog
Product updates flow to the search index via CDC. Faceted search uses Elasticsearch aggregations. Ranking combines relevance, popularity, availability and sponsored placement.

### Cart
Guest carts live in a cookie/local storage and merge into the user's cart at login. Cart reads are frequent, so cache them. Show a price-change warning at checkout.

## Scaling & reliability

- **Graceful degradation:** if recommendations or reviews are down, still render the product page. If checkout is overloaded, queue users rather than failing.
- Shard orders by `user_id` (for order history) and inventory by `sku`.
- Cell-based deployment per region, with inventory ownership per warehouse region.

## Trade-offs

- **Show exact stock vs cached stock:** exact counts on the page don't scale. Show approximate stock and enforce exactness at reservation.
- **Reserve at add-to-cart vs at checkout:** reserving at add-to-cart locks up stock with abandoned carts. Most stores reserve at checkout.
- **Sync vs async checkout:** synchronous is better UX normally. Async (queued) survives flash sales.
