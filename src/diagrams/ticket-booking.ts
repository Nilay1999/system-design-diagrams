import { Diagram } from "./dsl";

export default function ticketBooking() {
  return new Diagram("Ticket Booking", "Temporary seat holds in Redis, final booking guarded by a transactional check in the DB")
    .node("user", "User", 0, 1, "client")
    .node("waiting", "Virtual waiting room (hot events)", 1, -0.4, "edge")
    .node("gw", "API gateway", 1, 1, "edge")
    .node("search", "Event search (Elasticsearch)", 2, -0.4, "service")
    .node("booking", "Booking service", 2, 1, "service")
    .node("holds", "Seat holds (Redis, TTL 10 min)", 3, -0.4, "cache")
    .node("db", "Bookings DB (Postgres, one row per seat)", 3, 1, "db", { w: 1.1 })
    .node("payment", "Payment service", 2, 2.4, "service")
    .node("psp", "PSP", 3, 2.4, "external")
    .edge("user", "waiting", "hot event")
    .edge("waiting", "gw", "admitted (token)")
    .edge("user", "gw", "browse / book")
    .edge("gw", "search")
    .edge("gw", "booking")
    .edge("booking", "holds", "1. SET seat NX EX")
    .edge("booking", "payment", "2. charge")
    .edge("payment", "psp")
    .edge("booking", "db", "3. BOOKED")
    .note("Search index and seat-map caches are fed by CDC from the Bookings DB.", 1, 3.3)
    .steps(
      "Seat states",
      [
        "AVAILABLE → HELD (Redis NX lock, 10 min TTL)",
        "HELD → BOOKED after payment succeeds",
        "Hold expires → seat is AVAILABLE again",
        "DB write checks the seat is still unbooked",
      ],
      4.4,
      -0.4,
    )
    .build();
}
