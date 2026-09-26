# Distributed Job Scheduler

> Design a service (like Airflow's scheduler, Quartz clustered, or an internal "cron as a service") that runs millions of one-off and recurring jobs on time, reliably, across a fleet of workers.

## Requirements

### Functional
- Submit a job: **one-off** (run at time T or now) or **recurring** (cron expression).
- Job payload: what to run (container image / HTTP callback / handler name) plus parameters.
- View status and history. Cancel, pause and retry jobs.
- Retries with backoff, timeouts, priorities.
- (Optional) Dependencies between jobs (a DAG).

### Non-functional
- **Timeliness:** start within ~1–2 s of the scheduled time.
- **Reliability:** every due job runs **at least once**. No job is silently skipped.
- **Scale:** 10 M scheduled jobs, peaks of ~10k job starts/s (e.g. everything at midnight).
- Highly available, with no single scheduler as a SPOF.

## API

```http
POST /v1/jobs
{ "name": "nightly-report", "schedule": "0 2 * * *", "timezone": "Asia/Kolkata",
  "handler": { "type": "http", "url": "https://reports.internal/run" },
  "retry": { "max_attempts": 5, "backoff": "exponential" }, "timeout_s": 900,
  "idempotency_key": "report-v1" }

GET    /v1/jobs/{id}/runs?limit=20
POST   /v1/jobs/{id}/pause | /resume | /trigger
DELETE /v1/jobs/{id}
```

## Data model

```text
jobs  (job_id, owner, schedule, timezone, handler, retry_policy, timeout,
       next_run_at, status[ACTIVE|PAUSED], partition = hash(job_id) mod P)
       INDEX (partition, next_run_at)

runs  (run_id, job_id, scheduled_for, attempt, status[QUEUED|RUNNING|SUCCEEDED|FAILED|TIMED_OUT],
       worker_id, started_at, heartbeat_at, finished_at, error)
       UNIQUE (job_id, scheduled_for)       ← prevents duplicate runs of the same slot
```

## High-level design

1. **Job API** validates the job and computes `next_run_at` from the cron expression and timezone.
2. Jobs are split into **P partitions**. Each **scheduler instance** holds a **lease** (in etcd/ZooKeeper) on a set of partitions, so exactly one scheduler is responsible for each partition at any time.
3. Every ~1 s each scheduler queries its partitions for `next_run_at ≤ now + small lookahead`, then:
   - inserts a `runs` row (the unique constraint makes this idempotent),
   - pushes the run onto the **ready queue** (by priority),
   - advances `next_run_at` to the next cron occurrence, **in the same transaction**.
4. **Workers** pull runs, mark them RUNNING, **heartbeat** while executing, and record the result.
5. Failures go to a **retry queue** with exponential backoff. After max attempts they go to the **DLQ**, and the owner is alerted.

## Deep dives

### Avoiding double scheduling
- **Leases with fencing tokens**: a scheduler whose lease expired (after a GC pause, say) must not keep enqueuing. Include the lease epoch in writes and reject stale epochs.
- `UNIQUE(job_id, scheduled_for)` on runs is the last line of defense.
- Alternative without a coordinator: `SELECT … FOR UPDATE SKIP LOCKED` on the jobs table lets many schedulers claim due rows safely. It's simple but limited by one DB.

### Exactly-once is impossible, so design for idempotency
A worker can finish the job and then crash before reporting success, so the run gets retried. Jobs must be **idempotent**. Pass `run_id` or an idempotency key to the handler so side effects can be deduplicated.

### Detecting dead workers
Workers heartbeat every ~10 s. A reaper marks RUNNING runs with a stale heartbeat as failed and re-queues them. Timeouts kill runaway jobs.

### Hot spots in time
Everyone schedules "at midnight". Mitigations:
- **Jitter**: let jobs declare a tolerance window (e.g. ±5 min) and spread their start times.
- **Lookahead**: enqueue slightly early into a **delay queue** (or a timing wheel) keyed by exact start time.
- Autoscale workers ahead of known peaks.

### Timing wheel for precision
For very large numbers of near-term timers, a **hierarchical timing wheel** in memory (buckets per second, minute, hour) gives O(1) insertion and firing. The DB remains the durable source of truth.

### Priorities and fairness
Use separate queues per priority, plus **per-tenant quotas**, so one team's 1M-job burst can't starve everyone else.

### DAG / workflow dependencies
Store edges between tasks. A run becomes ready once all its upstream tasks have succeeded. For complex workflows, use a workflow engine (Temporal, Airflow) that persists state per step.

### Missed runs
If the system was down, decide per job: **catch up** (run all missed slots), **run once**, or **skip**. Airflow calls this `catchup`.

## Scaling & reliability

- Partition count P should be larger than the number of schedulers (e.g. 1,024) so leases can rebalance smoothly.
- Scale the jobs table by partition. Keep run history in a separate store with TTL/archival.
- The ready queue is Kafka/SQS/Redis streams, and workers scale horizontally.
- Metrics: schedule delay (actual start − scheduled time), queue lag, failure rate per job.

## Trade-offs

- **DB polling vs timing wheel:** polling is simple and durable. A wheel is precise and cheap but needs recovery from the DB after a restart.
- **Push vs pull workers:** pull gives natural backpressure. Push, via an HTTP callback, is simpler for users but needs rate limiting.
- **Central scheduler + leases vs `SKIP LOCKED`:** the first scales further, the second is simpler to run.
