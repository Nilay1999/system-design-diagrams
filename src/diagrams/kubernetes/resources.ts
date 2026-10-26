import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function requestsLimits() {
  return new Diagram("Requests decide where a pod fits", "The scheduler adds up requests, not real usage. A node is 'full' when its requests are, even if the CPU is idle")
    .zone("Node ip-10-0-1-23 · allocatable 4 CPU, 16 Gi", ["p1", "p2", "p3", "free"], "#0c8599")
    .node("sched", "Scheduler", 0, 1, "control", { detail: "sums requests on each node", icon: "clock" })
    .node("p1", "orders-api ×2", 1.3, 0, "service", { detail: "requests 500m, 1 Gi each" })
    .node("p2", "payments-api", 2.35, 0, "service", { detail: "requests = limits: 1 CPU, 2 Gi" })
    .node("p3", "report-job", 1.3, 1.1, "service", { detail: "requests 250m, 512 Mi" })
    .node("free", "Unreserved", 2.35, 1.1, "external", { detail: "1.75 CPU, 11.5 Gi left", icon: "gauge" })
    .node("newpod", "restaurant-api", 0, 2.45, "service", { detail: "requests 3 CPU → doesn't fit → Pending", highlight: true })
    .edge("sched", "p1", "fits")
    .edge("sched", "newpod", "0/1 nodes: Insufficient cpu", { color: "#e03131" })
    .panel(
      "Request vs limit",
      [
        "Request = the desk you book. Guaranteed, and what the scheduler uses to decide if a pod fits.",
        "Limit = the fire-safety maximum. You can spread into empty space, never past this line.",
        "Requests are what you pay for: a pod requesting 4 CPU but using 0.2 still blocks 4 CPU.",
      ],
      3.65,
      -0.1,
      { width: 380, tone: "info" },
    )
    .panel("Units", ["CPU: 1 = one core, 500m = half a core, 250m = a quarter", "Memory: 512Mi, 1Gi (binary). 1G is slightly less than 1Gi"], 3.65, 1.35, {
      width: 380,
      tone: "neutral",
    })
    .build();
}

function cpuVsMemory() {
  return new Diagram("CPU vs memory: different punishments", "CPU can wait, so it's throttled. Memory can't be handed back, so the container is killed")
    .zone("CPU is compressible: slowed, never killed", ["cpuApp", "throttle", "slow"], "#1971c2")
    .zone("Memory is not: killed and restarted", ["memApp", "oom", "restart"], "#e03131")
    .node("cpuApp", "orders-api wants 1.5 CPU", 0, 0, "service", { detail: "limit: 1 CPU" })
    .node("throttle", "CFS throttling", 1.2, 0, "worker", { detail: "cgroup pauses the container each period", icon: "timer" })
    .node("slow", "Latency spikes", 2.4, 0, "client", { detail: "slow requests, timeouts, no restart", icon: "activity" })
    .node("memApp", "payments-api heap grows to 1.1 Gi", 0, 1.55, "service", { detail: "limit: 1 Gi" })
    .node("oom", "Kernel OOM killer", 1.2, 1.55, "worker", { detail: "exit 137, reason OOMKilled", highlight: true, icon: "siren" })
    .node("restart", "Container restarted", 2.4, 1.55, "service", { detail: "restart count climbs → CrashLoopBackOff", icon: "refresh" })
    .edge("cpuApp", "throttle", "over limit")
    .edge("throttle", "slow")
    .edge("memApp", "oom", "over limit")
    .edge("oom", "restart")
    .panel(
      "A popular production setup",
      [
        "memory limit = memory request: predictable, no surprise OOM kills",
        "no CPU limit: no throttling, spare CPU is used when free (some teams do set it for strict fairness)",
        "JVM: -XX:MaxRAMPercentage=75 so the heap leaves room for threads and metaspace",
        "Node.js: --max-old-space-size below the container memory limit",
      ],
      0,
      2.75,
      { width: 760, tone: "good" },
    )
    .build();
}

function qosEviction() {
  return new Diagram("QoS classes: who gets evicted first", "When a node runs out of memory, the kubelet evicts pods in this order. Kubernetes assigns the class from your settings")
    .node("pressure", "Node memory pressure", 0, 1, "worker", { detail: "kubelet must free memory now", highlight: true, icon: "siren" })
    .node("be", "BestEffort", 1.35, 0, "service", { detail: ["no requests or limits at all", "standby passenger"] })
    .node("bu", "Burstable", 1.35, 1, "service", { detail: ["some requests or limits set", "economy ticket · report-job"] })
    .node("gu", "Guaranteed", 1.35, 2, "service", { detail: ["requests = limits, CPU and memory", "first class · payments-api"] })
    .edge("pressure", "be", "evicted 1st", { color: "#e03131" })
    .edge("pressure", "bu", "2nd", { color: "#e8590c" })
    .edge("pressure", "gu", "last", { color: "#2f9e44" })
    .panel(
      "How you get each class",
      [
        "Guaranteed: every container has requests = limits for CPU and memory",
        "Burstable: at least one request or limit, but not Guaranteed",
        "BestEffort: no requests or limits anywhere in the pod",
        "Check it: kubectl describe pod → QoS Class",
      ],
      2.65,
      0,
      { width: 380, tone: "info" },
    )
    .panel("FoodDash choice", ["payments-api: Guaranteed", "orders-api: Burstable (memory limit = request, no CPU limit)", "nightly report-job: Burstable"], 2.65, 1.45, {
      width: 380,
      tone: "good",
    })
    .build();
}

function quotas() {
  return new Sequence("LimitRange and ResourceQuota at admission", "Defaults are filled in, then the namespace budget is checked, before anything is stored")
    .actor("dev", "Developer", "client")
    .actor("api", "API server", "control")
    .actor("lr", "LimitRange (mutating)", "object", { icon: "list-checks" })
    .actor("rq", "ResourceQuota (validating)", "object", { icon: "gauge" })
    .actor("etcd", "etcd", "db")
    .msg("dev", "api", "create pod in namespace delivery (forgot resources)")
    .msg("api", "lr", "fill defaults")
    .msg("lr", "api", "requests 100m / 256Mi, limit 512Mi; max 4Gi enforced", { reply: true })
    .msg("api", "rq", "check the namespace budget")
    .alt("within budget: 38 of 40 CPU used, +0.1", "api", "etcd")
    .msg("rq", "api", "admit", { reply: true })
    .msg("api", "etcd", "store pod")
    .msg("api", "dev", "201 Created", { reply: true })
    .else("over budget")
    .msg("rq", "api", "deny: exceeded quota delivery-budget, requested cpu=4, used 38, limited 40", { reply: true, error: true })
    .msg("api", "dev", "403 Forbidden", { error: true })
    .end()
    .note("Once a namespace has a CPU or memory quota, every new pod must declare requests (or get them from a LimitRange), or it's rejected.", ["dev", "etcd"], "warn")
    .build();
}

export default [
  { id: "requests-limits", name: "Requests & scheduling", build: requestsLimits },
  { id: "cpu-vs-memory", name: "CPU vs memory limits", build: cpuVsMemory },
  { id: "qos-eviction", name: "QoS & eviction", build: qosEviction },
  { id: "quotas", name: "LimitRange & ResourceQuota", build: quotas },
] satisfies DiagramSpec[];
