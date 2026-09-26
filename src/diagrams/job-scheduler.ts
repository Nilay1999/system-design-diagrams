import { Diagram } from "./dsl";

export default function jobScheduler() {
  return new Diagram("Distributed Job Scheduler", "Schedulers own time partitions via leases, enqueue due runs; workers execute at-least-once")
    .node("client", "Clients (API, cron definitions)", 0, 1, "client")
    .node("api", "Job API", 1, 1, "service")
    .node("jobs", "Job store (definitions, next_run_at)", 2, -0.4, "db")
    .node("sched", "Scheduler instances (one lease per partition)", 2, 1, "service", { h: 1.2 })
    .node("coord", "Coordination (etcd / ZooKeeper leases)", 2, 2.6, "cache")
    .node("runs", "Run history (status, attempts)", 3, -0.4, "db")
    .node("ready", "Ready queue (priority)", 3, 1.1, "queue")
    .node("workers", "Worker pool", 4, 1.1, "worker")
    .node("dlq", "Retry / DLQ (backoff)", 4, 2.6, "queue")
    .edge("client", "api", "create job")
    .edge("api", "jobs", "upsert")
    .edge("sched", "jobs", "due: next_run_at ≤ now")
    .edge("sched", "coord", "lease")
    .edge("sched", "ready", "enqueue run", { async: true })
    .edge("ready", "workers", undefined, { async: true })
    .edge("workers", "runs", "heartbeat / status")
    .edge("workers", "dlq", "failed", { async: true })
    .build();
}
