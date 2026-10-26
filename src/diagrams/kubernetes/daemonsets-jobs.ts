import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function daemonset() {
  return new Diagram("DaemonSet: one pod on every node", "Add a node and it gets its own copy; remove a node and its copy goes too")
    .node("ds", "DaemonSet node-exporter", 0, 1.5, "object", { detail: "tolerations: operator Exists", icon: "layers" })
    .node("n1", "Node 1", 1.35, 0, "worker", { detail: "node-exporter pod", icon: "server" })
    .node("n2", "Node 2", 1.35, 1, "worker", { detail: "node-exporter pod", icon: "server" })
    .node("n3", "GPU node (tainted)", 1.35, 2, "worker", { detail: "node-exporter pod: it tolerates every taint", icon: "server" })
    .node("n4", "Node 4, just joined", 1.35, 3, "worker", { detail: "gets its own pod automatically", icon: "server" })
    .edge("ds", "n1")
    .edge("ds", "n2")
    .edge("ds", "n3")
    .edge("ds", "n4", "auto", { async: true })
    .panel(
      "Real examples",
      ["Fluent Bit: collects the node's logs", "node-exporter: node CPU, memory, disk", "CNI agents: Calico, Cilium", "kube-proxy", "Security agents: Falco"],
      2.65,
      0,
      { width: 340, tone: "info" },
    )
    .panel("Why not a Deployment?", ["replicas = number of nodes breaks the moment a node is added or removed, and nothing guarantees one per node."], 2.65, 1.65, {
      width: 340,
      tone: "warn",
    })
    .build();
}

function job() {
  return new Sequence("Job: run until it succeeds", "backfill-order-totals with backoffLimit 3, activeDeadlineSeconds 1800, ttlSecondsAfterFinished 86400")
    .actor("you", "You / CI", "client")
    .actor("ctrl", "Job controller", "control", { icon: "workflow" })
    .actor("pod1", "pod attempt 1", "service")
    .actor("pod2", "pod attempt 2", "service")
    .msg("you", "ctrl", "kubectl apply -f backfill-job.yaml")
    .msg("ctrl", "pod1", "create pod (restartPolicy: OnFailure or Never)")
    .msg("pod1", "ctrl", "exit 1: database timeout", { reply: true, error: true })
    .msg("ctrl", "ctrl", "failure 1 of 3 allowed; wait (exponential backoff)")
    .msg("ctrl", "pod2", "retry")
    .msg("pod2", "ctrl", "exit 0", { reply: true })
    .msg("ctrl", "ctrl", "1/1 completions → Job Complete")
    .opt("still running after 30 minutes", "ctrl", "pod2")
    .msg("ctrl", "pod2", "activeDeadlineSeconds hit: kill it, Job Failed", { error: true })
    .end()
    .msg("ctrl", "ctrl", "24 h later: ttlSecondsAfterFinished deletes the Job and its pods")
    .note("Parallel: completions 10 + parallelism 3 = finish 10 runs, 3 at a time. Indexed Jobs give each pod JOB_COMPLETION_INDEX 0–9, so pod 4 handles shard 4.", ["you", "pod2"], "info")
    .build();
}

function cronjob() {
  return new Sequence("CronJob: a Job on a schedule", "daily-sales-report at 30 2 * * * (Asia/Kolkata), concurrencyPolicy Forbid, startingDeadlineSeconds 600")
    .actor("cron", "CronJob controller", "control", { icon: "clock" })
    .actor("job", "Job", "object", { icon: "list-checks" })
    .actor("pod", "report-job pod", "service")
    .phase("Monday 2:30 AM")
    .msg("cron", "job", "create Job daily-sales-report-29012345")
    .msg("job", "pod", "run report-job:2.1.0")
    .msg("pod", "job", "exit 0 at 2:48 AM", { reply: true })
    .phase("Tuesday: a huge festival day, the report runs long")
    .msg("cron", "job", "create Job")
    .msg("job", "pod", "run (still going at Wednesday 2:30 AM)")
    .phase("Wednesday 2:30 AM")
    .msg("cron", "cron", "previous run still active → Forbid: skip this run", { error: true })
    .phase("Thursday: the cluster was down from 2:00 to 2:50 AM")
    .msg("cron", "cron", "missed by more than 10 minutes → startingDeadlineSeconds: skip", { error: true })
    .note("concurrencyPolicy: Allow (overlaps fine), Forbid (skip the new run), Replace (kill the old run). Test now with: kubectl create job manual-report --from=cronjob/daily-sales-report", ["cron", "pod"], "info")
    .build();
}

function choosing() {
  return new Diagram("Which workload object?", "Answer two or three questions and the right controller falls out", { icons: false })
    .node("q1", "Does it run forever?", 1.6, 0, "object")
    .node("q2", "One copy on every node?", 0.6, 1.25, "object")
    .node("q4", "On a schedule?", 2.6, 1.25, "object")
    .node("ds", "DaemonSet", 0, 2.5, "service", { detail: "log agents, node-exporter" })
    .node("q3", "Needs a stable identity or its own disk?", 1.2, 2.5, "object")
    .node("cron", "CronJob", 2.3, 2.5, "service", { detail: "nightly report-job" })
    .node("job", "Job", 3.3, 2.5, "service", { detail: "migration, backfill" })
    .node("sts", "StatefulSet", 0.7, 3.8, "service", { detail: "PostgreSQL, Kafka" })
    .node("dep", "Deployment", 1.7, 3.8, "service", { detail: "orders-api, notification-worker" })
    .edge("q1", "q2", "yes")
    .edge("q1", "q4", "no, it finishes")
    .edge("q2", "ds", "yes")
    .edge("q2", "q3", "no")
    .edge("q4", "cron", "yes")
    .edge("q4", "job", "no, once")
    .edge("q3", "sts", "yes")
    .edge("q3", "dep", "no")
    .build();
}

export default [
  { id: "daemonset", name: "DaemonSet", build: daemonset },
  { id: "job", name: "Job", build: job },
  { id: "cronjob", name: "CronJob", build: cronjob },
  { id: "choosing", name: "Which one?", build: choosing },
] satisfies DiagramSpec[];
