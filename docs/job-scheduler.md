# Distributed Job Scheduler

> Design a service (like Airflow's scheduler, Quartz clustered, or an internal "cron as a service") that runs millions of one-off and recurring jobs on time, reliably, across a fleet of workers.

## The problem in one minute

Running `cron` on one machine is easy until that machine dies, or until you have ten million jobs. A distributed scheduler has to answer three questions reliably:

1. **When is each job due?** Millions of timers, many firing at the same moment (midnight, the top of the hour).
2. **Who fires each job?** Exactly one scheduler must be responsible for each job at any time, even while schedulers crash, pause, or restart.
3. **Did it actually run?** Workers crash mid-job, networks drop acknowledgements, and targets time out. Every due run must execute *at least once*, and nothing must be silently skipped.

| Decision | Choice | Why |
| --- | --- | --- |
| Source of truth | Jobs DB with `next_run_at`, partitioned into 1,024 partitions | Durable; partitions let schedulers split the work |
| Ownership | Each scheduler leases a set of partitions in etcd, with a fencing epoch | Exactly one active owner per partition; zombies are rejected |
| Timing | Poll the DB for the next ~60 s, then fire from an in-memory timing wheel | Durable and precise without hammering the DB |
| Duplicate prevention | `UNIQUE (job_id, scheduled_for)` on runs + conditional state transitions | Retries and races can't create two runs for one slot |
| Execution | Workers pull from priority queues, heartbeat, report status | Natural backpressure; dead workers are detected |
| Failure handling | Retry with exponential backoff, then a dead-letter queue | Transient errors heal; poison jobs surface |
| Semantics | At-least-once + idempotent targets | Exactly-once execution is impossible across a network |

## Requirements

### Functional

- Submit a **one-off** job (run at time T, or now) or a **recurring** job (cron expression + time zone).
- A job says **what** to run: an HTTP callback, a container image, or a named handler, plus parameters.
- Retry policy (max attempts, backoff), timeout, priority, and optional allowed start-time jitter.
- Pause, resume, trigger now, cancel, delete.
- See run history: status, attempts, timings, errors, logs link.
- Optional: dependencies between jobs (a DAG), and a policy for runs missed while the system was down.

### Non-functional

| Property | Target |
| --- | --- |
| Timeliness | Start within 1–2 s of the scheduled time (p99), under normal load |
| Reliability | Every due run executes at least once; none are silently skipped |
| Scale | 10 M active jobs; 200 M runs/day; peaks of ~10k starts/s |
| Availability | No single point of failure; survive scheduler and worker crashes |
| Isolation | One tenant's burst can't starve others |

## Capacity estimation

- **Jobs:** 10 M job definitions × ~1 KB = **10 GB**. Fits on one database, but we partition for write throughput and scheduler parallelism.
- **Runs:** 200 M/day ÷ 86,400 ≈ **2,300 runs/s on average**. Peaks are much higher: if 10 % of jobs are hourly and aligned to `:00`, that's 1 M runs in the first seconds of each hour. With allowed jitter spreading them over ~100 s → **~10k starts/s**.
- **Run history:** 200 M × ~500 B ≈ **100 GB/day**. Keep 30 days hot (~3 TB) in a store partitioned by day, archive the rest to object storage.
- **DB writes per run:** create run, mark queued, mark running, heartbeats (one per 10 s), final status → ~5 writes per short run → **~50k writes/s at peak**. That's why heartbeats should update a lightweight store (or be batched), and why runs are partitioned.
- **Workers:** if the average run takes 30 s, 2,300 runs/s × 30 s ≈ **70k concurrent runs** on average. At 50 concurrent runs per worker → ~1,400 workers, autoscaled for peaks.

## API

```http
POST /v1/jobs
Content-Type: application/json
Idempotency-Key: 2b7c…

{
  "name": "nightly-report",
  "schedule": { "cron": "0 2 * * *", "timezone": "Asia/Kolkata" },   // or { "at": "2026-10-01T09:00:00Z" }
  "target": { "type": "http", "url": "https://reports.internal/run", "method": "POST",
              "body": { "report": "sales" } },
  "retry": { "max_attempts": 5, "backoff": "exponential", "initial_delay_s": 30, "max_delay_s": 3600 },
  "timeout_s": 900,
  "priority": "normal",               // high | normal | low
  "jitter_s": 120,                    // may start up to 2 min late to smooth peaks
  "misfire_policy": "run_once",       // run_all | run_once | skip
  "concurrency": "forbid"             // allow | forbid | replace (overlapping runs)
}

201 Created
{ "job_id": "job_7Qx…", "next_run_at": "2026-09-27T20:30:00Z" }
```

```http
GET    /v1/jobs/{id}
GET    /v1/jobs/{id}/runs?status=FAILED&limit=20&cursor=…
POST   /v1/jobs/{id}/pause | /resume | /trigger
POST   /v1/runs/{run_id}/cancel
DELETE /v1/jobs/{id}
```

The target receives the run context so it can deduplicate:

```http
POST https://reports.internal/run
X-Run-Id: run_9f2c
X-Scheduled-For: 2026-09-27T20:30:00Z
X-Attempt: 2
```

## Data model

```sql
CREATE TABLE jobs (
  job_id         TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  partition      SMALLINT NOT NULL,        -- hash(job_id) % 1024
  schedule       JSONB NOT NULL,           -- cron + timezone, or a single timestamp
  target         JSONB NOT NULL,
  retry_policy   JSONB NOT NULL,
  timeout_s      INT NOT NULL,
  priority       TEXT NOT NULL,
  status         TEXT NOT NULL,            -- ACTIVE | PAUSED | DELETED
  next_run_at    TIMESTAMPTZ,              -- null when there is no future run
  version        INT NOT NULL              -- optimistic concurrency for edits
);
CREATE INDEX jobs_due ON jobs (partition, next_run_at) WHERE status = 'ACTIVE';

CREATE TABLE runs (
  run_id         TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  attempt        INT NOT NULL,             -- incremented on each retry of this slot
  status         TEXT NOT NULL,            -- SCHEDULED | QUEUED | RUNNING | SUCCEEDED | FAILED | LOST | RETRY_WAIT | DEAD | CANCELLED
  worker_id      TEXT,
  heartbeat_at   TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  error          TEXT,
  UNIQUE (job_id, scheduled_for)           -- one row per scheduled slot, however many attempts
);
-- Optional: run_attempts (run_id, attempt, worker_id, started_at, finished_at, error) for full history.
CREATE INDEX runs_stale ON runs (status, heartbeat_at) WHERE status = 'RUNNING';

CREATE TABLE partition_epochs (            -- fencing
  partition      SMALLINT PRIMARY KEY,
  epoch          BIGINT NOT NULL
);
```

**Why store `next_run_at` instead of evaluating cron expressions on the fly?** Because "which jobs are due in the next minute?" becomes a cheap index range scan. The API computes the first `next_run_at`; the scheduler computes each following one when it fires a run.

**Time zones and DST:** always evaluate cron in the job's time zone and store `next_run_at` in UTC. Decide what happens when a local time doesn't exist (spring forward: skip or shift) or happens twice (fall back: run once).

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Job API | Validate jobs, compute the first `next_run_at`, CRUD, run history |
| Jobs DB | Job definitions and the due-time index; partitioned |
| etcd | Partition leases with TTLs and monotonically increasing epochs |
| Schedulers | Own partitions; find due jobs; create runs; arm timers; advance `next_run_at` |
| Timing wheel | In-memory, per scheduler; fires timers for the next ~60 s precisely |
| Ready queues | Priority lanes (high / normal / low), with per-tenant quotas |
| Workers | Pull runs, call the target, heartbeat, report results |
| Runs DB | One row per attempt; the state machine lives here |
| Retry queue | Holds failed runs until their backoff expires |
| Dead-letter queue | Runs that exhausted retries; alerts the owner |
| Reaper | Finds runs whose worker stopped heartbeating and requeues them |

## The scheduling loop

See [Scheduling tick](#diagram/tick).

Every second, each scheduler:

1. **Renews its lease** in etcd. If the lease is lost, it stops scheduling those partitions immediately.
2. **Queries due jobs** in its partitions: `next_run_at ≤ now + 60 s`, in batches.
3. For each job, in **one transaction**:
   - insert a run row for `(job_id, scheduled_for)` — `ON CONFLICT DO NOTHING` makes this idempotent;
   - advance `next_run_at` to the following cron slot;
   - only if the partition's stored epoch is ≤ this scheduler's epoch (fencing).
4. **Arms a timer** in the timing wheel for `scheduled_for` (plus random jitter within the job's allowance).
5. When the timer fires, **enqueues** the run on the right priority queue and marks it `QUEUED`.

After a crash, the new lease holder reads runs still in `SCHEDULED` for its partitions and re-arms their timers, so nothing is lost between "committed" and "enqueued".

## Executing a run

See [Executing a run](#diagram/execution) and [Run state machine](#diagram/state-machine).

1. A worker pulls a run with a visibility timeout (the message reappears if not acknowledged).
2. It claims the run with a **conditional update**: `SET status='RUNNING', worker_id=? WHERE run_id=? AND status='QUEUED'`. If zero rows change, another worker already has it; the message is dropped.
3. It calls the target with `run_id`, `scheduled_for` and `attempt`.
4. While the job runs, it heartbeats every ~10 s.
5. On success: `SUCCEEDED`, acknowledge the message.
6. On failure or timeout: `FAILED`; if attempts remain, schedule a retry after `initial_delay × 2^(attempt−1)` (capped, with jitter) → `RETRY_WAIT` → `QUEUED`. Otherwise `DEAD` and alert.
7. If the worker dies, heartbeats stop. The **reaper** marks the run `LOST` after ~60 s and requeues it.

Every transition is a conditional update (`WHERE status = <expected>`), so a late worker, the reaper, and a user's cancel can't all "win" the same run.

## Deep dives

### 1. Exactly one scheduler per partition: leases and fencing

See [Leases & timing wheel](#diagram/leases).

- The job space is split into many more partitions (1,024) than schedulers (say 5–20). Each scheduler acquires leases on a share of them in etcd. When a scheduler joins or dies, partitions are redistributed.
- A lease has a TTL (e.g. 10 s) and is kept alive by heartbeats.
- **The zombie problem:** a scheduler can pause (GC, VM migration, network split) for longer than the TTL. Its lease expires, another scheduler takes over — and then the first one wakes up still believing it owns the partition.
- **Fencing tokens:** every lease grant comes with a monotonically increasing **epoch**. Every write the scheduler makes carries its epoch, and the database rejects writes with an epoch lower than the highest it has seen for that partition. The zombie's writes fail, so it can't create duplicate runs or move `next_run_at`.
- `UNIQUE (job_id, scheduled_for)` is a second safety net.

**Simpler alternative:** with a single relational database, schedulers can skip leases and claim due rows with `SELECT … FOR UPDATE SKIP LOCKED`. Many schedulers can run safely in parallel. It's easy to operate but bounded by one database's throughput.

### 2. Firing timers precisely: the timing wheel

Polling the DB every second for "due now" rows works but is imprecise and expensive at scale. Instead, each scheduler loads the next 60 s of due runs and keeps them in a **hierarchical timing wheel**:

- A seconds wheel has 60 slots; each slot holds a list of timers. A pointer advances one slot per second and fires everything in the slot.
- Timers further out go into a minutes wheel or an hours wheel, and **cascade** down to the finer wheel as their time approaches.
- Insert and fire are **O(1)** (a priority heap is O(log n)), and millions of timers fit in a few MB.
- The wheel is only a cache: after a restart it's rebuilt from the DB.

### 3. The midnight problem

Humans love round numbers. A large share of cron jobs fire at `0 0 * * *` or `0 * * * *`, producing a spike 100× the average.

- **Jitter:** jobs declare how late they may start (`jitter_s`). The scheduler spreads them uniformly across that window.
- **Early loading:** schedulers load runs 60 s ahead, so the DB queries are spread out; only the timer firing is concentrated.
- **Pre-scaling:** the load is predictable, so scale workers up a few minutes before the hour.
- **Priorities:** high-priority runs are dequeued first when capacity is short.

### 4. At-least-once, and why exactly-once is impossible

A worker can call the target, the target can finish, and the worker can crash before recording success. The reaper will requeue the run, and the target will run again. No protocol can prevent this across a network, because the worker can't atomically "do the side effect" and "record that it did".

So the contract is **at-least-once**, and targets must be **idempotent**:

- Use `X-Run-Id` as an idempotency key: record processed run IDs and skip repeats.
- Make work naturally idempotent: "generate report for 2026-09-27" overwrites the same file; "send an email" needs a dedup table.

### 5. Overlapping runs, misfires, and dependencies

- **Concurrency policy:** if a run takes longer than the interval, should the next one start? `allow`, `forbid` (skip or delay the new one), or `replace` (cancel the old one). Kubernetes CronJobs use the same three options.
- **Misfire policy** after downtime: `run_all` (catch up every missed slot — careful with thousands of backlogged runs), `run_once` (one run now), or `skip` (resume at the next slot). Airflow's `catchup` flag is the same idea.
- **DAGs:** store task dependencies; a task becomes ready when all upstream tasks succeed. For long, multi-step workflows with state, use a workflow engine (Temporal, Airflow, Step Functions) that persists each step.

### 6. Fairness between tenants

A single team submitting a million jobs must not delay everyone else. Give each tenant a concurrency quota and a rate limit on starts, and use weighted fair queuing when pulling from queues. Separate priority lanes stop low-priority batch work from blocking time-critical jobs.

## Scaling and reliability

- **Partitions:** 1,024 partitions is far more than the number of schedulers, so leases can be rebalanced smoothly as schedulers come and go.
- **Jobs DB:** shard by `partition`. The due-index scan per partition stays small.
- **Runs:** high write volume; partition by day and by job hash; move history older than 30 days to cheap storage.
- **Heartbeats:** write them to a fast store (Redis, or a separate narrow table), not the main runs table, or batch them.
- **Queues:** Kafka, SQS, or Redis streams; workers scale horizontally on queue depth.

### Failure modes

| Failure | What happens | Handling |
| --- | --- | --- |
| Scheduler crashes | Its partitions stop firing | Lease expires in ≤ 10 s; another scheduler takes over and re-arms `SCHEDULED` runs |
| Scheduler pauses (zombie) | It may try to keep scheduling | Fencing epoch rejects its writes |
| etcd unavailable | Leases can't be renewed | Schedulers stop scheduling (safe) — runs are delayed, not duplicated; etcd is a 3/5-node quorum to make this rare |
| Worker dies mid-run | Run stuck in `RUNNING` | Reaper requeues after missed heartbeats |
| Target down | Runs fail | Retry with backoff; circuit-break per target; DLQ |
| DB slow | Schedule delay grows | Alert on schedule lag; shed low-priority runs |
| Whole region down | Nothing fires | Warm standby region with replicated DB; decide per job whether a late run is still useful |

## Observability

| Metric | Why |
| --- | --- |
| **Schedule lag** = actual start − scheduled time (p50/p99) | The headline SLO |
| Due-but-not-enqueued runs | Detects stuck partitions |
| Queue depth and age per priority | Worker capacity |
| Run success / failure / timeout rate per job and tenant | Health of targets |
| Lost runs (reaper actions) | Worker stability |
| DLQ size | Jobs needing human attention |
| Lease changes per minute | Unstable schedulers |

## Trade-offs to discuss

- **DB polling vs timing wheel:** polling alone is simple and durable but imprecise and heavy on the DB. The wheel is precise and cheap but must be rebuilt after restarts. Combining them gives both.
- **Leases + fencing vs `SKIP LOCKED`:** leases scale across many databases and schedulers; `SKIP LOCKED` is far simpler but tied to one database.
- **Pull vs push to workers:** pull gives natural backpressure and simple scaling; push (HTTP callbacks directly from the scheduler) is simpler for users but needs rate limiting per target.
- **Build vs buy:** Kubernetes CronJobs, Airflow, Temporal and cloud schedulers cover most needs. Build your own when you need millions of tenant-defined jobs with strict timing.

## Interview follow-up questions

- **How do you guarantee a job doesn't run twice at the same time?** Concurrency policy `forbid` plus a per-job lock (conditional update on a `running_run_id` column) — while accepting that retries after a crash can still overlap if the old worker is only paused, so targets should still be idempotent.
- **How do you support "run every 10 seconds" for a million jobs?** That's 100k runs/s — batch them: group jobs with the same schedule into one run that fans out, or use a streaming system instead of a scheduler.
- **How would you let users see logs for a run?** Workers stream stdout/stderr to a log store keyed by `run_id`; the API returns a link.
- **How would you handle a job whose target is slow and holds a worker for hours?** Make the target asynchronous: it acknowledges quickly and reports completion via a callback; the worker is freed and the run stays `RUNNING` with a longer heartbeat deadline.
- **What if the clock on a scheduler is wrong?** Use NTP and compare against the DB server's `now()`; leases are based on etcd's clock, not the scheduler's.
