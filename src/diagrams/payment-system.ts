import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Payment System — architecture", "Correctness over scale: idempotency at every hop, an append-only double-entry ledger, and daily reconciliation")
    .zone("Payment platform (PostgreSQL, ACID)", ["api", "idem", "paysvc", "exec", "paydb", "ledger"], "#2f9e44")
    .node("checkout", "Checkout / order service", 0, 0.9, "client", { detail: "one Idempotency-Key per attempt" })
    .node("browser", "Browser / app", 0, -1.4, "client", { detail: "PSP hosted fields (card never touches us)" })
    .node("api", "Payment API", 1.1, 0.9, "service", { detail: "validate, authenticate caller" })
    .node("idem", "Idempotency store", 1.1, 2.1, "db", { detail: ["key → status + response", "unique constraint"] })
    .node("paysvc", "Payment service", 2.2, 0.9, "service", { detail: ["state machine", "saga + outbox"] })
    .node("risk", "Risk / fraud", 2.2, -0.4, "service", { detail: "score, require 3-D Secure?" })
    .node("exec", "PSP executor", 3.3, 0.9, "worker", { detail: ["routes to a PSP", "PSP key = payment_id"] })
    .node("psp", "PSPs", 4.5, 0.9, "external", { detail: ["Stripe, Adyen, …", "card networks, banks"] })
    .node("hooks", "Webhook handler", 4.5, 2.2, "service", { detail: ["verify signature + timestamp", "dedupe event id"] })
    .node("paydb", "Payments DB", 2.2, 2.1, "db", { detail: ["payments, events, outbox", "conditional updates"] })
    .node("ledger", "Ledger", 3.3, 2.1, "db", { detail: ["double-entry, append-only", "balances derived"] })
    .node("kafka", "Kafka", 3.3, 3.3, "queue", { detail: "PaymentSucceeded, …" })
    .node("recon", "Reconciliation", 4.5, 3.3, "worker", { detail: "match ledger vs PSP settlement files" })
    .node("orders", "Order service, wallet, payouts", 2.2, 3.3, "worker", { detail: "consume events idempotently" })
    .edge("browser", "psp", "card details → token", { via: [[4.5, -1.4]] })
    .edge("checkout", "api", "POST /payments")
    .edge("api", "idem", "claim key")
    .edge("api", "paysvc")
    .edge("paysvc", "risk")
    .edge("paysvc", "exec")
    .edge("exec", "psp", "authorise / capture")
    .edge("psp", "hooks", "webhook", { async: true })
    .edge("hooks", "paydb", "apply transition", { via: [[3.85, 1.55], [2.2, 1.55]] })
    .edge("paysvc", "paydb")
    .edge("paydb", "ledger", "entries (same txn)")
    .edge("ledger", "kafka", "outbox relay", { async: true })
    .edge("kafka", "orders", undefined, { async: true })
    .edge("recon", "ledger", "compare")
    .panel(
      "Scale",
      ["1 M payments / day ≈ 12 TPS (peaks ~100)", "One well-tuned Postgres primary is enough", "Hard part: never double-charge, never lose money", "Amounts as integers in minor units (paise / cents)"],
      5.6,
      -0.4,
      { width: 400, tone: "info" },
    )
    .build();
}

function payIn() {
  return new Sequence("A card payment (pay-in)", "Claim the idempotency key, charge with our payment id as the PSP's key, trust the webhook", { gap: 225 })
    .actor("c", "Checkout", "client")
    .actor("api", "Payment API", "service")
    .actor("db", "Payments DB", "db")
    .actor("x", "PSP executor", "worker")
    .actor("psp", "PSP", "external")
    .actor("u", "Customer's bank (3DS)", "client")
    .actor("h", "Webhook handler", "service")
    .msg("c", "api", "POST /payments {order o-981, ₹4,999.00 = 499900 paise, token pm_tok} Idempotency-Key: ik-5")
    .msg("api", "db", "INSERT idempotency (ik-5, IN_PROGRESS) — ON CONFLICT → return stored result / 409 if in flight")
    .msg("api", "db", "INSERT payment pay_77 CREATED → PENDING (+ event row)")
    .msg("api", "x", "execute pay_77")
    .msg("x", "psp", "create charge (Idempotency-Key: pay_77)")
    .alt("PSP requires 3-D Secure", "c", "u")
    .msg("psp", "x", "requires_action + redirect URL", { reply: true })
    .msg("x", "db", "PENDING → REQUIRES_ACTION")
    .msg("api", "c", "202 {next_action: redirect}", { reply: true })
    .msg("c", "u", "customer approves in the bank's app / OTP")
    .else("no challenge")
    .msg("psp", "x", "processing", { reply: true })
    .end()
    .msg("psp", "h", "webhook charge.succeeded (signed)", { async: true })
    .msg("h", "h", "verify signature + timestamp; dedupe by PSP event id")
    .msg("h", "db", "BEGIN; UPDATE payment SET SUCCEEDED WHERE id = pay_77 AND status IN (PENDING, REQUIRES_ACTION); ledger entries; outbox PaymentSucceeded; COMMIT")
    .msg("api", "db", "idempotency ik-5 → COMPLETED with the response body")
    .note("A retry of the same checkout with ik-5 returns this stored response; a retry from our executor reuses PSP key pay_77, so the card is never charged twice.", ["c", "x"], "info")
    .build();
}

function unknownOutcome() {
  return new Sequence("When the PSP call times out", "A timeout is not a failure — the charge may have happened. Find out before doing anything else", { gap: 260 })
    .actor("x", "PSP executor", "worker")
    .actor("psp", "PSP", "external")
    .actor("db", "Payments DB", "db")
    .actor("rq", "Retry scheduler", "worker")
    .msg("x", "psp", "create charge (Idempotency-Key: pay_77)")
    .msg("x", "x", "no response after 10 s", { error: true })
    .msg("x", "db", "status stays PENDING, mark outcome UNKNOWN; never mark FAILED here")
    .msg("x", "rq", "check pay_77 again in 30 s, 2 min, 10 min …", { async: true })
    .loop("until the outcome is known (or a webhook arrives first)", "x", "rq")
    .msg("rq", "psp", "GET charge by idempotency key / our reference pay_77")
    .alt("PSP has a charge", "x", "rq")
    .msg("psp", "rq", "succeeded (or failed)", { reply: true })
    .msg("rq", "db", "conditional transition to that status + ledger entries")
    .else("PSP has no record")
    .msg("rq", "psp", "retry the create with the SAME key pay_77 — safe by construction")
    .end()
    .end()
    .note("If the webhook and the poller both report success, the second conditional update matches 0 rows and does nothing.", ["x", "db"], "good")
    .build();
}

function ledger() {
  return new Diagram("Deep dive — state machine & double-entry ledger", "Status changes are conditional updates; money movements are balanced, append-only entries")
    .zone("Payment status", ["created", "pending", "action", "succeeded", "failed", "refunded"], "#1971c2")
    .node("created", "CREATED", 0, 0, "service")
    .node("pending", "PENDING", 1, 0, "service", { detail: "sent to PSP" })
    .node("action", "REQUIRES_ACTION", 2, -0.9, "worker", { detail: "3-D Secure" })
    .node("succeeded", "SUCCEEDED", 3, 0, "service", { detail: "money captured" })
    .node("failed", "FAILED", 2, 0.9, "external", { highlight: true, detail: "declined / expired" })
    .node("refunded", "REFUNDED", 4, 0, "external", { detail: "partial or full" })
    .edge("created", "pending")
    .edge("pending", "action")
    .edge("action", "succeeded")
    .edge("pending", "succeeded")
    .edge("pending", "failed")
    .edge("succeeded", "refunded")
    .table(
      "entries",
      "ledger_entries for pay_77 (₹4,999.00 order, 5 % platform fee)",
      ["txn      account                 debit      credit", "t-1      psp_clearing            4,999.00", "t-1      merchant_payable                   4,749.05", "t-1      platform_fee_revenue                 249.95", "                                  ────────   ────────", "                                  4,999.00   4,999.00", "", "refund (t-2) = new reversing entries, never an UPDATE"],
      0,
      1.9,
      { kind: "db" },
    )
    .panel(
      "Ledger rules",
      [
        "Every transaction's debits equal its credits (sum = 0)",
        "Entries are never updated or deleted; corrections are new entries",
        "Account balance = sum of its entries (cache it, but it must be recomputable)",
        "Status update + ledger entries + outbox row commit in one DB transaction",
      ],
      2.6,
      1.9,
      { width: 440, numbered: true, tone: "good" },
    )
    .build();
}

function recon() {
  return new Diagram("Reconciliation", "The safety net under every other mechanism: compare our books with the PSP's and the bank's")
    .node("psp", "PSP settlement report", 0, 0, "external", { detail: "daily CSV / API: charges, fees, refunds, chargebacks" })
    .node("bank", "Bank statement", 0, 1.3, "external", { detail: "money actually received" })
    .node("ingest", "Ingest + normalise", 1.2, 0.65, "worker", { detail: ["parse formats", "convert to minor units"] })
    .node("match", "Matcher", 2.4, 0.65, "worker", { detail: ["by PSP reference / payment id", "amount, currency, date"] })
    .node("ledger", "Our ledger", 2.4, -0.6, "db", { detail: "entries for the day" })
    .node("ok", "Matched", 3.6, 0, "service", { detail: "≈ 99.9 % of lines" })
    .node("auto", "Auto-fix", 3.6, 1.3, "worker", { detail: ["missed webhook → apply status", "fee differences → adjust entry"] })
    .node("ops", "Finance ops queue", 4.8, 1.3, "client", { highlight: true, detail: "anything unexplained" })
    .edge("psp", "ingest")
    .edge("bank", "ingest")
    .edge("ingest", "match")
    .edge("ledger", "match")
    .edge("match", "ok")
    .edge("match", "auto", "mismatch")
    .edge("auto", "ops", "can't explain")
    .panel(
      "Typical mismatches",
      ["Charge at the PSP but PENDING with us (lost webhook)", "Our SUCCEEDED but missing at the PSP (bug!)", "Amount / currency / FX differences", "Chargebacks and refunds initiated outside our system"],
      4.8,
      -0.4,
      { width: 400, tone: "warn" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "pay-in", name: "Card payment", build: payIn },
  { id: "unknown-outcome", name: "Timeouts & unknown outcomes", build: unknownOutcome },
  { id: "ledger", name: "States & ledger", build: ledger },
  { id: "reconciliation", name: "Reconciliation", build: recon },
] satisfies DiagramSpec[];
