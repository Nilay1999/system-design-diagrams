import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("E-commerce — architecture", "Browsing is cached and eventually consistent; checkout is a saga over strongly consistent services")
    .zone("Storefront (read-heavy, eventual)", ["catalog", "search", "pricing", "es"], "#1971c2")
    .zone("Checkout (strong consistency)", ["order", "inv", "pay"], "#2f9e44")
    .node("user", "Shoppers", 0, 1.3, "client", { detail: "web + app" })
    .node("cdn", "CDN", 1, 0.2, "edge", { detail: "images, static pages" })
    .node("gw", "API gateway / BFF", 1, 1.3, "edge", { detail: ["auth, rate limits", "page composition"] })
    .node("catalog", "Catalog", 2.1, -0.5, "service", { detail: "product details (doc DB)" })
    .node("search", "Search", 3.2, -0.5, "service", { detail: "facets, ranking" })
    .node("es", "Search index", 4.3, -0.5, "db", { detail: "Elasticsearch (via CDC)" })
    .node("pricing", "Pricing", 2.1, 0.55, "service", { detail: "prices + promos, cached" })
    .node("cart", "Cart", 3.2, 0.55, "service", { detail: ["DynamoDB / Redis", "per user"] })
    .node("order", "Order service", 2.1, 2, "service", { detail: ["saga orchestrator", "idempotent checkout"] })
    .node("inv", "Inventory", 3.2, 2, "service", { detail: ["conditional decrements", "reservations with TTL"] })
    .node("pay", "Payment", 2.1, 3.2, "service", { detail: "see Payment System" })
    .node("orderdb", "Orders DB", 1, 3.2, "db", { detail: ["orders + outbox", "shard by user_id"] })
    .node("invdb", "Inventory DB", 4.3, 2, "db", { detail: "row per SKU × warehouse" })
    .node("kafka", "Kafka", 3.2, 3.6, "queue", { detail: "OrderConfirmed, …" })
    .node("fulfil", "Fulfilment + email", 4.3, 3.6, "worker", { detail: "pick, pack, ship, notify" })
    .edge("user", "cdn")
    .edge("user", "gw")
    .edge("gw", "catalog")
    .edge("gw", "pricing")
    .edge("gw", "cart", undefined, { via: [[1.6, 0.9], [3.2, 0.9]] })
    .edge("catalog", "search", undefined, { none: true })
    .edge("search", "es")
    .edge("gw", "order", "POST /checkout")
    .edge("order", "inv", "reserve")
    .edge("inv", "invdb")
    .edge("order", "pay", "charge")
    .edge("order", "orderdb", "state + outbox")
    .edge("orderdb", "kafka", "outbox relay", { async: true, via: [[1, 3.95]] })
    .edge("kafka", "fulfil", undefined, { async: true })
    .panel(
      "Scale",
      ["100 M daily users × 20 page views ≈ 23k views/s", "10 M orders/day ≈ 120/s; flash sales ~10k checkout attempts/s", "500 M SKUs × 5 KB ≈ 2.5 TB catalog", "Never oversell — even for one hot SKU"],
      5.4,
      -0.5,
      { width: 420, tone: "info" },
    )
    .build();
}

function checkout() {
  return new Sequence("Checkout saga", "Local transactions in order, inventory and payment, with compensations instead of a distributed transaction", { gap: 235 })
    .actor("c", "Client", "client")
    .actor("o", "Order service", "service")
    .actor("i", "Inventory", "service")
    .actor("p", "Payment", "service")
    .actor("db", "Orders DB", "db")
    .actor("k", "Kafka", "queue")
    .msg("c", "o", "POST /checkout {cart, address, payment method} Idempotency-Key: ck-31")
    .msg("o", "o", "re-price the cart server-side (never trust client prices)")
    .msg("o", "db", "INSERT order o-88 PENDING (idempotency key unique)")
    .msg("o", "i", "reserve [sku-1 × 2, sku-7 × 1] for o-88, TTL 15 min (sorted SKU order)")
    .break("any SKU out of stock", "c", "i")
    .msg("i", "o", "OUT_OF_STOCK sku-7 — partial reservations released", { error: true })
    .msg("o", "c", "409: sku-7 sold out", { error: true })
    .end()
    .msg("i", "o", "reservation r-5", { reply: true })
    .msg("o", "p", "charge ₹3,450 (key = o-88)")
    .alt("payment succeeded", "c", "k")
    .msg("p", "o", "succeeded", { reply: true })
    .msg("o", "i", "commit reservation r-5 (reserved → sold)")
    .msg("o", "db", "BEGIN; order CONFIRMED; INSERT outbox OrderConfirmed; COMMIT")
    .msg("db", "k", "relay publishes OrderConfirmed", { async: true })
    .msg("o", "c", "201 order o-88 confirmed", { reply: true })
    .else("payment declined")
    .msg("o", "i", "release r-5 (compensation)", { error: true })
    .msg("o", "db", "order PAYMENT_FAILED")
    .msg("o", "c", "402: payment declined, try another method", { error: true })
    .end()
    .note("If the service crashes mid-saga, the orchestrator resumes from the order's stored state; every step is idempotent, and reservations expire on their own.", ["o", "db"], "info")
    .build();
}

function flashSale() {
  return new Diagram("Deep dive — flash sale for one hot SKU", "1,000 units, 2 M buyers at 12:00: decide winners in memory, then do the real work at a steady pace")
    .node("buyers", "2 M buyers", 0, 1.2, "client", { detail: "all click 'Buy' at 12:00" })
    .node("wr", "Waiting room + bot checks", 1.1, 1.2, "edge", { detail: ["CDN-served", "CAPTCHA, 1 per account"] })
    .node("gate", "Sale gate", 2.2, 1.2, "service", { detail: "Lua: DECR a random bucket if > 0" })
    .zone("Stock split into 10 Redis buckets", ["b0", "b1", "b9"], "#e03131")
    .node("b0", "stock:sku-1:0", 3.3, 0.2, "cache", { detail: "100 left" })
    .node("b1", "stock:sku-1:1", 3.3, 1.2, "cache", { detail: "97 left" })
    .node("b9", "stock:sku-1:9", 3.3, 2.2, "cache", { detail: "0 → try another" })
    .node("q", "Winners queue", 2.2, 2.6, "queue", { detail: "Kafka, ~1,000 messages" })
    .node("workers", "Order workers", 1.1, 2.6, "worker", { detail: ["normal checkout saga", "at a steady rate"] })
    .node("db", "Inventory DB", 0, 2.6, "db", { detail: "final conditional decrement" })
    .node("lose", "Sold out page", 2.2, 0, "external", { detail: "everyone else, instantly" })
    .edge("buyers", "wr")
    .edge("wr", "gate", "admitted")
    .edge("gate", "b0")
    .edge("gate", "b1")
    .edge("gate", "b9")
    .edge("gate", "lose", "all buckets empty")
    .edge("gate", "q", "winner")
    .edge("q", "workers", undefined, { async: true })
    .edge("workers", "db")
    .panel(
      "Why this works",
      [
        "Redis decides the 1,000 winners in microseconds; 1.99 M losers never touch the database",
        "Ten buckets spread the hot key's contention (or use one Lua-guarded key per shard)",
        "The DB conditional update is still the final guard, so a Redis failover can't oversell",
        "Winners get 'you got it — completing your order'; payment failures return units to a bucket",
      ],
      4.4,
      0.4,
      { width: 470, numbered: true, tone: "info" },
    )
    .build();
}

function orderStates() {
  return new Diagram("Order lifecycle & the transactional outbox", "State changes and the events announcing them are written in one transaction")
    .node("pending", "PENDING", 0, 0, "service", { detail: "created, idempotency key" })
    .node("reserved", "RESERVED", 1.1, 0, "service", { detail: "stock held 15 min" })
    .node("confirmed", "CONFIRMED", 2.2, 0, "service", { detail: "paid" })
    .node("shipped", "SHIPPED", 3.3, 0, "worker", { detail: "tracking number" })
    .node("delivered", "DELIVERED", 4.4, 0, "worker")
    .node("failed", "PAYMENT_FAILED", 1.1, 1.2, "external", { detail: "reservation released" })
    .node("cancelled", "CANCELLED", 2.2, 1.2, "external", { detail: "refund + restock" })
    .node("returned", "RETURNED", 4.4, 1.2, "external", { detail: "refund after inspection" })
    .edge("pending", "reserved")
    .edge("reserved", "confirmed", "paid")
    .edge("confirmed", "shipped")
    .edge("shipped", "delivered")
    .edge("reserved", "failed")
    .edge("confirmed", "cancelled", "before shipping")
    .edge("delivered", "returned")
    .zone("Transactional outbox", ["svc", "tx", "relay", "bus"], "#e8590c")
    .node("svc", "Order service", 0, 2.7, "service")
    .node("tx", "One DB transaction", 1.1, 2.7, "db", { detail: ["UPDATE orders …", "INSERT outbox …"] })
    .node("relay", "Outbox relay", 2.2, 2.7, "worker", { detail: "poll or CDC (Debezium)" })
    .node("bus", "Kafka", 3.3, 2.7, "queue", { detail: "at-least-once" })
    .node("consumers", "Fulfilment, email, analytics", 4.4, 2.7, "worker", { detail: "dedupe by event id" })
    .edge("svc", "tx")
    .edge("tx", "relay", "new rows")
    .edge("relay", "bus", "publish")
    .edge("bus", "consumers", undefined, { async: true })
    .build();
}

function dataModel() {
  return new Diagram("Data model", "Inventory is the contended table; orders are sharded by user for order history")
    .table(
      "inventory",
      "inventory  (shard by sku)",
      ["sku              PK part", "warehouse_id     PK part", "on_hand          physical units", "available        sellable now", "reserved         held by checkouts", "version"],
      0,
      0,
    )
    .table(
      "reservations",
      "reservations",
      ["reservation_id   PK", "order_id", "sku, warehouse_id, qty", "status           HELD | COMMITTED | RELEASED", "expires_at       sweeper releases"],
      0,
      2,
    )
    .table(
      "orders",
      "orders  (shard by user_id)",
      ["order_id         PK", "user_id", "status", "total, currency", "address_snapshot", "payment_id", "idempotency_key  UNIQUE"],
      1.9,
      0,
    )
    .table("items", "order_items", ["order_id", "sku, qty", "unit_price       price at purchase time"], 1.9, 2.2)
    .table(
      "outbox",
      "outbox",
      ["event_id         PK", "aggregate_id     order_id", "type             OrderConfirmed", "payload          JSON", "published_at     null until relayed"],
      3.7,
      0,
      { kind: "queue" },
    )
    .edge("reservations", "inventory")
    .edge("items", "orders")
    .edge("outbox", "orders")
    .panel(
      "The never-oversell statement",
      ["UPDATE inventory", "   SET available = available - :qty,", "       reserved  = reserved  + :qty", " WHERE sku = :sku AND warehouse_id = :wh", "   AND available >= :qty;", "-- 0 rows updated → out of stock"],
      3.7,
      1.9,
      { width: 420, mono: true, tone: "good" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "checkout", name: "Checkout saga", build: checkout },
  { id: "flash-sale", name: "Flash sale", build: flashSale },
  { id: "order-states", name: "Order lifecycle & outbox", build: orderStates },
  { id: "data-model", name: "Data model", build: dataModel },
] satisfies DiagramSpec[];
