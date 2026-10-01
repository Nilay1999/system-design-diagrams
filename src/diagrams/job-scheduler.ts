import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Distributed Job Scheduler — architecture", "Schedulers own job partitions through leases and enqueue due runs; workers pull and execute at least once")
    .zone("Schedulers", ["s1", "s2", "etcd"], "#2f9e44")
    .zone("Execution", ["qh", "qn", "workers", "retry", "dlq"], "#0c8599")
    .node("client", "Clients", 0, 1, "client", { detail: "API, CLI, UI" })
    .node("api", "Job API", 1, 1, "service", { detail: ["validate cron + timezone", "compute next_run_at"] })
    .node("jobs", "Jobs DB", 1, 2.5, "db", { detail: ["1,024 partitions", "index (partition, next_run_at)"] })
    .node("s1", "Scheduler A", 2.2, 0.3, "service", { detail: ["leases partitions 0–511", "timing wheel for next 60 s"] })
    .node("s2", "Scheduler B", 2.2, 1.6, "service", { detail: ["leases partitions 512–1023", "timing wheel for next 60 s"] })
    .node("etcd", "etcd", 2.2, -0.9, "cache", { detail: ["leases + fencing epochs", "TTL 10 s"] })
    .node("qh", "Ready queue: high", 3.4, 0.3, "queue", { detail: "priority lanes" })
    .node("qn", "Ready queue: normal", 3.4, 1.3, "queue", { detail: "per-tenant quotas" })
    .node("workers", "Worker pool", 4.5, 0.8, "worker", { detail: ["pull, heartbeat every 10 s", "autoscaled on queue depth"] })
    .node("target", "Job targets", 5.6, 0.8, "external", { detail: "HTTP callbacks, containers, handlers" })
    .node("runs", "Runs DB", 4.5, 2.4, "db", { detail: ["one row per scheduled slot", "UNIQUE (job_id, scheduled_for)"] })
    .node("retry", "Retry queue", 3.4, 2.4, "queue", { detail: "exponential backoff" })
    .node("dlq", "Dead letters", 3.4, 3.5, "queue", { highlight: true, detail: "alert the owner" })
    .node("reaper", "Reaper", 5.6, 2.4, "worker", { detail: "stale heartbeat → requeue" })
    .edge("client", "api", "POST /jobs")
    .edge("api", "jobs", "insert")
    .edge("s1", "etcd", "renew lease")
    .edge("s1", "jobs", "due rows", { via: [[1.6, 1.3]] })
    .edge("s2", "jobs", "due rows")
    .edge("s1", "qh", "enqueue run", { async: true })
    .edge("s2", "qn", "enqueue run", { async: true })
    .edge("qh", "workers", undefined, { async: true })
    .edge("qn", "workers", undefined, { async: true })
    .edge("workers", "target", "execute")
    .edge("workers", "runs", "status")
    .edge("runs", "retry", "failed", { async: true })
    .edge("retry", "dlq", "max attempts")
    .edge("retry", "qn", "when due", { async: true })
    .edge("reaper", "runs", "scan")
    .panel(
      "Scale targets",
      ["10 M active jobs, 200 M runs / day", "Peak ~10k starts/s (on the hour, midnight)", "Start within 1–2 s of scheduled time", "Every due run executes at least once"],
      0,
      -0.9,
      { width: 400, tone: "info" },
    )
    .build();
}

function tick() {
  return new Sequence("A scheduling tick", "Every second each scheduler claims due runs for the partitions it leases", { gap: 250 })
    .actor("s", "Scheduler A", "service")
    .actor("etcd", "etcd", "cache")
    .actor("db", "Jobs + runs DB", "db")
    .actor("wheel", "Timing wheel (in memory)", "service")
    .actor("q", "Ready queue", "queue")
    .msg("s", "etcd", "KeepAlive(lease 42) — lease epoch stays 17")
    .alt("lease lost (GC pause, network split)", "s", "etcd")
    .msg("s", "s", "stop scheduling partitions 0–511 immediately", { error: true })
    .end()
    .msg("s", "db", "SELECT jobs WHERE partition IN (0–511) AND next_run_at ≤ now + 60 s AND status = ACTIVE LIMIT 5,000")
    .msg("db", "s", "due and soon-due jobs", { reply: true })
    .loop("for each job", "s", "wheel")
    .msg("s", "db", "BEGIN; INSERT run (job_id, scheduled_for) ON CONFLICT DO NOTHING; UPDATE job SET next_run_at = next cron slot WHERE epoch ≤ 17; COMMIT")
    .msg("s", "wheel", "add timer at scheduled_for (+ jitter if the job allows)")
    .end()
    .msg("wheel", "wheel", "tick: fire every timer in the current 1-second slot")
    .msg("wheel", "q", "enqueue run {run_id, job_id, attempt 1, deadline}", { async: true })
    .note("If the scheduler crashes after COMMIT but before the timer fires, the next lease holder re-reads runs still in SCHEDULED state and re-arms them. The UNIQUE constraint stops duplicates.", ["s", "q"], "info")
    .build();
}

function execution() {
  return new Sequence("Executing a run", "Pull, heartbeat, report — and what happens when a worker dies mid-run", { gap: 240 })
    .actor("q", "Ready queue", "queue")
    .actor("w", "Worker", "worker")
    .actor("runs", "Runs DB", "db")
    .actor("t", "Job target", "external")
    .actor("reaper", "Reaper", "worker")
    .actor("rq", "Retry queue", "queue")
    .msg("w", "q", "pull (visibility timeout 60 s)")
    .msg("q", "w", "run 9f2c, attempt 1", { reply: true })
    .msg("w", "runs", "UPDATE status = RUNNING, worker = w-17, heartbeat_at = now WHERE status = QUEUED")
    .msg("w", "t", "POST /run {run_id: 9f2c, idempotency_key}")
    .loop("while the job runs", "w", "runs")
    .msg("w", "runs", "heartbeat_at = now (every 10 s)")
    .end()
    .alt("success", "q", "rq")
    .msg("t", "w", "200 OK", { reply: true })
    .msg("w", "runs", "status = SUCCEEDED, finished_at")
    .msg("w", "q", "ack / delete message")
    .else("failure or timeout")
    .msg("w", "runs", "status = FAILED, error")
    .msg("w", "rq", "attempt 2 at now + 30 s × 2^(attempt−1) ± jitter", { async: true })
    .else("worker dies (no more heartbeats)")
    .msg("reaper", "runs", "find RUNNING with heartbeat_at < now − 60 s")
    .msg("reaper", "runs", "status = LOST")
    .msg("reaper", "rq", "requeue attempt 2", { async: true })
    .end()
    .note("The target may already have done the work before the worker died, so it can run twice. Targets must be idempotent — that's why run_id is passed along.", ["w", "t"], "warn")
    .build();
}

function stateMachine() {
  return new Diagram("Run state machine", "Every run row moves through these states; transitions are conditional updates so two actors can't both win")
    .node("scheduled", "SCHEDULED", 0, 1, "service", { detail: "row created, timer armed" })
    .node("queued", "QUEUED", 1, 1, "queue", { detail: "in the ready queue" })
    .node("running", "RUNNING", 2, 1, "worker", { detail: "worker heartbeating" })
    .node("succeeded", "SUCCEEDED", 3.2, 0, "service", { detail: "terminal" })
    .node("failed", "FAILED", 3.2, 1, "external", { detail: "error or timeout recorded" })
    .node("dead", "DEAD", 4.4, 1, "external", { highlight: true, detail: "max attempts; owner alerted" })
    .node("lost", "LOST", 2.4, 2.3, "external", { highlight: true, detail: "reaper: heartbeat stopped" })
    .node("wait", "RETRY_WAIT", 1, 2.3, "queue", { detail: "backoff timer" })
    .node("cancelled", "CANCELLED", 1, 0, "client", { detail: "user cancelled" })
    .edge("scheduled", "queued", "timer fires")
    .edge("queued", "running", "claimed")
    .edge("running", "succeeded", "ok")
    .edge("running", "failed", "error")
    .edge("running", "lost")
    .edge("failed", "wait", "attempts left")
    .edge("lost", "wait")
    .edge("wait", "queued", "backoff over")
    .edge("failed", "dead", "no attempts left")
    .edge("queued", "cancelled", "cancel")
    .panel(
      "Conditional transitions",
      ["UPDATE runs SET status='RUNNING', worker=? WHERE run_id=? AND status='QUEUED'", "0 rows updated → someone else already claimed it: drop the message", "Same pattern for every arrow in this diagram"],
      0,
      3.3,
      { width: 600, tone: "info" },
    )
    .build();
}

function leases() {
  return new Diagram("Deep dive — leases, fencing & the timing wheel", "How exactly one scheduler owns each partition, and how it fires thousands of timers cheaply")
    .zone("Partition leases in etcd", ["etcd", "sa", "sb", "sc"], "#2f9e44")
    .node("etcd", "etcd", 0, 1, "cache", { detail: ["/leases/p0-341 → A, epoch 17", "/leases/p342-682 → B, epoch 9", "/leases/p683-1023 → C, epoch 4"] })
    .node("sa", "Scheduler A", 1.2, 0, "service", { highlight: true, detail: ["long GC pause", "lease expired, doesn't know yet"] })
    .node("sb", "Scheduler B", 1.2, 1, "service", { detail: "healthy" })
    .node("sc", "Scheduler C", 1.2, 2, "service", { detail: ["took over p0–341", "epoch 18"] })
    .node("db", "Jobs DB", 2.4, 1, "db", { detail: ["stores last epoch per partition", "rejects writes with epoch < 18"] })
    .edge("etcd", "sb", "keep-alive")
    .edge("etcd", "sc", "grant epoch 18")
    .edge("sa", "db", "write, epoch 17 → rejected")
    .edge("sc", "db", "write, epoch 18 → ok")
    .zone("Hierarchical timing wheel (per scheduler)", ["hours", "minutes", "seconds", "fire"], "#1971c2")
    .node("hours", "Hours wheel", 3.6, -0.1, "service", { detail: "24 slots" })
    .node("minutes", "Minutes wheel", 3.6, 1, "service", { detail: "60 slots" })
    .node("seconds", "Seconds wheel", 3.6, 2.1, "service", { detail: ["60 slots, pointer moves 1 / s", "slot = list of timers"] })
    .node("fire", "Enqueue runs", 4.8, 2.1, "queue", { detail: "all timers in this slot" })
    .edge("hours", "minutes", "cascade when the hour arrives")
    .edge("minutes", "seconds", "cascade when the minute arrives")
    .edge("seconds", "fire", "tick")
    .panel(
      "Why fencing tokens",
      [
        "A lease holder can be paused for longer than the lease TTL and wake up still believing it owns the partition",
        "Every write carries the lease epoch; the DB keeps the highest epoch seen per partition and rejects older ones",
        "So a zombie scheduler cannot enqueue or advance next_run_at after losing its lease",
      ],
      0,
      3.1,
      { width: 560, tone: "warn" },
    )
    .panel(
      "Why a timing wheel",
      ["Insert and fire are O(1) — a heap is O(log n)", "Millions of timers need only a few MB", "The DB stays the source of truth; the wheel is rebuilt from it after a restart"],
      3.6,
      3.1,
      { width: 420, tone: "info" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "tick", name: "Scheduling tick", build: tick },
  { id: "execution", name: "Executing a run", build: execution },
  { id: "state-machine", name: "Run state machine", build: stateMachine },
  { id: "leases", name: "Leases & timing wheel", build: leases },
] satisfies DiagramSpec[];
