# DaemonSets, Jobs & CronJobs

> A DaemonSet runs one copy of a pod on every node; a Job runs pods until a task is done; a CronJob runs a Job on a schedule.

## The idea in one minute

| Workload | Runs | Typical uses |
| --- | --- | --- |
| DaemonSet | One pod per (matching) node, added automatically when nodes join | Log agents (Fluent Bit), node-exporter, CNI agents, security agents |
| Job | Pods until N successful completions | DB migrations, batch exports, one-off backfills |
| CronJob | A Job on a cron schedule | Nightly reports, cleanup, token rotation |

Not sure which controller you need? See [Which one?](#diagram/choosing).

## DaemonSet

> [!TIP]
> **Real-life analogy:** every floor of an office building gets exactly one fire extinguisher and one security camera. Add a new floor, and it automatically gets its own. Remove a floor, and its equipment goes too.

Some software must run on **every machine** because it deals with that machine: collecting its logs, measuring its CPU, configuring its network. A Deployment with "replicas: number of nodes" would break the moment a node is added or removed. See [DaemonSet](#diagram/daemonset).

Real examples: Fluent Bit (log collection), Prometheus node-exporter (node metrics), the CNI agent itself (Calico, Cilium), kube-proxy, security agents (Falco).

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: node-exporter, namespace: monitoring }
spec:
  selector: { matchLabels: { app: node-exporter } }
  template:
    metadata: { labels: { app: node-exporter } }
    spec:
      tolerations:
        - operator: Exists          # run even on tainted nodes (e.g. GPU nodes)
      containers:
        - name: exporter
          image: prom/node-exporter:v1.8.2
          ports: [{ containerPort: 9100 }]
```

Use a `nodeSelector` if it should run only on some nodes (e.g. only GPU nodes).

## Job

> [!TIP]
> **Real-life analogy:** a contractor hired to paint one wall. When the wall is painted, the contract is complete. If they get sick halfway, the agency sends another painter to finish.

A Deployment restarts containers that exit, even successfully, because it expects them to run forever. A one-time task (database migration, data backfill, bulk email) should run until it **succeeds**, then stop. Follow the retries on [Job](#diagram/job).

```yaml
apiVersion: batch/v1
kind: Job
metadata: { name: backfill-order-totals, namespace: fooddash }
spec:
  backoffLimit: 3                   # retry up to 3 times on failure
  activeDeadlineSeconds: 1800       # give up after 30 minutes
  ttlSecondsAfterFinished: 86400    # auto-delete one day after finishing
  template:
    spec:
      restartPolicy: OnFailure      # Jobs must use OnFailure or Never
      containers:
        - name: backfill
          image: fooddash/orders-tools:1.4.2
          args: ["backfill-totals", "--since=2026-01-01"]
```

**Parallel Jobs:** `completions: 10` and `parallelism: 3` means "finish 10 successful runs, at most 3 at a time". An **Indexed Job** gives each pod a number (`JOB_COMPLETION_INDEX` 0–9), so pod 4 processes shard 4 of the data. Handy for splitting a huge backfill.

## CronJob

> [!TIP]
> **Real-life analogy:** a standing instruction to the cleaner: "every night at 2:30 AM, clean the kitchen."

FoodDash's `report-job` builds yesterday's sales report for every restaurant at 2:30 AM India time. See how the policies behave over a week on [CronJob](#diagram/cronjob).

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: daily-sales-report, namespace: fooddash }
spec:
  schedule: "30 2 * * *"            # minute hour day month weekday
  timeZone: Asia/Kolkata
  concurrencyPolicy: Forbid         # skip if yesterday's run is still going
  startingDeadlineSeconds: 600      # if missed by >10 min (e.g. cluster down), skip it
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: report
              image: fooddash/report-job:2.1.0
```

`concurrencyPolicy` options: `Allow` (overlaps fine), `Forbid` (skip the new run), `Replace` (kill the old run, start the new one).

```bash
kubectl create job manual-report --from=cronjob/daily-sales-report   # run it now, for testing
kubectl get cronjobs,jobs,pods -n fooddash
```

## Watch out

> [!WARNING]
> - **Make jobs idempotent.** In rare cases a CronJob can run twice, or a Job can retry halfway through. If running twice would send duplicate reports or double-charge someone, add a check ("already done for this date?"), exactly like an idempotent Kafka consumer.
> - Finished Jobs and their pods pile up unless you set `ttlSecondsAfterFinished` or history limits.
> - For multi-step pipelines (step B after step A, fan-out, retries per step), use Argo Workflows or Airflow rather than chaining CronJobs.
> - A sidecar in a Job used to keep it running forever. Native sidecars (init containers with `restartPolicy: Always`) fixed this.

## Check your understanding

**Why can't you use a Deployment for a migration?** A Deployment restarts a container that exits, even with code 0, because it expects it to run forever. A Job treats exit 0 as done.

**What does `concurrencyPolicy: Forbid` do?** If the previous run is still active at the next scheduled time, the new run is skipped.

**How do you split a big batch across pods?** An Indexed Job with `completions` and `parallelism`; each pod reads `JOB_COMPLETION_INDEX` to pick its shard.
