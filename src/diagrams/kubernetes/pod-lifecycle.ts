import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function phases() {
  return new Diagram("Pod phases", "Five phases, plus the 'reasons' you see in kubectl get pods, which are not phases at all", { icons: false })
    .node("pending", "Pending", 0, 1, "object", { detail: ["accepted, not running yet", "waiting for a node or an image pull"] })
    .node("running", "Running", 1.3, 1, "service", { detail: ["bound to a node", "at least one container up"] })
    .node("succeeded", "Succeeded", 2.6, 0.2, "service", { detail: ["all containers exited 0", "won't restart (Jobs)"] })
    .node("failed", "Failed", 2.6, 1.8, "service", { detail: ["all stopped", "at least one with an error"], highlight: true })
    .node("unknown", "Unknown", 1.3, 2.45, "external", { detail: "the node can't be reached" })
    .edge("pending", "running", "scheduled, image pulled")
    .edge("running", "succeeded", "all exit 0")
    .edge("running", "failed", "one exits non-zero")
    .edge("running", "unknown", "node lost network")
    .panel(
      "Reasons, not phases",
      [
        "CrashLoopBackOff: keeps crashing; waits longer before each retry",
        "ImagePullBackOff: wrong tag, or no permission to pull",
        "OOMKilled: went over its memory limit (exit 137)",
        "CreateContainerConfigError: a ConfigMap or Secret is missing",
      ],
      3.85,
      0,
      { width: 380, tone: "bad" },
    )
    .panel(
      "restartPolicy",
      ["Always (default): web services like orders-api", "OnFailure: batch jobs", "Never: one-shot debugging", "Restarts back off: 10s, 20s, 40s… up to 5 min"],
      3.85,
      1.55,
      { width: 380, tone: "info" },
    )
    .build();
}

function probes() {
  return new Diagram("The three health probes", "Three doctors with three different questions, and three very different consequences when the answer is no")
    .node("kubelet", "kubelet", 0, 1, "worker", { detail: "runs every probe on its node" })
    .node("startup", "startupProbe", 1.2, 0, "object", { detail: "Has it finished starting? (30 × 5s = 150s)", icon: "timer" })
    .node("ready", "readinessProbe", 1.2, 1, "object", { detail: "Can it take traffic right now?", icon: "activity" })
    .node("live", "livenessProbe", 1.2, 2, "object", { detail: "Is the process stuck or dead?", icon: "activity" })
    .node("gate", "Other probes wait", 2.45, 0, "control", { detail: "fails too long → container restarted", icon: "timer" })
    .node("eps", "Service endpoints", 2.45, 1, "edge", { detail: "fail → removed from traffic, NOT restarted" })
    .node("restart", "Restart container", 2.45, 2, "service", { detail: "fail 3× → killed and restarted", highlight: true, icon: "refresh" })
    .edge("kubelet", "startup")
    .edge("kubelet", "ready")
    .edge("kubelet", "live")
    .edge("startup", "gate", "until it passes")
    .edge("ready", "eps", "on failure")
    .edge("live", "restart", "on failure")
    .panel(
      "What each should check",
      [
        "liveness: only this process (/actuator/health/liveness). Never the database.",
        "readiness: may check dependencies: DB pool ready, cache warm (/actuator/health/readiness).",
        "startup: same endpoint as liveness, with a generous limit for slow JVMs.",
      ],
      3.7,
      -0.1,
      { width: 360, tone: "good" },
    )
    .panel("Probe types", ["httpGet: most web apps", "tcpSocket: is the port open? (Redis, databases)", "exec: run a command, exit 0 = healthy", "grpc: the gRPC health protocol"], 3.7, 1.45, {
      width: 360,
      tone: "info",
    })
    .build();
}

function probeIncident() {
  return new Sequence("A real incident: the liveness probe that checked the database", "A 2-minute database failover became a 10-minute outage")
    .actor("db", "PostgreSQL", "db", { icon: "postgres" })
    .actor("pods", "orders-api pods ×4", "service")
    .actor("kubelet", "kubelet", "worker")
    .actor("svc", "Service endpoints", "edge")
    .phase("Bad: liveness also checks PostgreSQL")
    .msg("db", "db", "2-minute failover starts", { error: true })
    .msg("kubelet", "pods", "GET /health (includes a DB check)")
    .msg("pods", "kubelet", "503, 503, 503", { reply: true, error: true })
    .msg("kubelet", "pods", "liveness failed → restart ALL pods at once", { error: true })
    .msg("db", "db", "back after 2 minutes")
    .msg("pods", "pods", "still booting JVMs and warming caches: outage lasts 10 minutes", { error: true })
    .phase("Good: liveness checks only the process; readiness checks dependencies")
    .msg("db", "db", "2-minute failover starts", { error: true })
    .msg("kubelet", "pods", "readiness GET /health/readiness")
    .msg("pods", "kubelet", "503 (DB unreachable)", { reply: true })
    .msg("kubelet", "svc", "mark not Ready → removed from endpoints, no restart")
    .msg("kubelet", "pods", "liveness GET /health/liveness")
    .msg("pods", "kubelet", "200: the process is fine", { reply: true })
    .msg("db", "db", "back after 2 minutes")
    .msg("kubelet", "svc", "readiness passes → add pods back. Outage: 2 minutes")
    .note("Rule: liveness asks 'is MY process alive?'. Anything about dependencies belongs in readiness, which pauses traffic without restarting anything.", ["db", "svc"], "good")
    .build();
}

function gracefulShutdown() {
  return new Sequence("Graceful shutdown", "How a pod says goodbye during a deploy, scale-down or node drain, without dropping customer orders")
    .actor("api", "API server", "control")
    .actor("eps", "Endpoints + kube-proxy", "edge")
    .actor("kubelet", "kubelet", "worker")
    .actor("app", "orders-api container", "service")
    .actor("client", "Caller", "client")
    .msg("api", "api", "pod deleted → marked Terminating")
    .par("both happen at the same time", "api", "kubelet")
    .msg("api", "eps", "remove pod IP from endpoints (takes a moment to reach every node)", { async: true })
    .msg("api", "kubelet", "pod is Terminating", { async: true })
    .end()
    .msg("kubelet", "app", "preStop hook: sleep 5–10s so every node's rules catch up")
    .msg("client", "app", "a few late requests still arrive: still served")
    .msg("kubelet", "app", "SIGTERM to PID 1")
    .msg("app", "app", "stop accepting, finish in-flight requests, commit Kafka offsets, close DB pools")
    .msg("app", "kubelet", "exit 0", { reply: true })
    .opt("still running after terminationGracePeriodSeconds (default 30s)", "kubelet", "app")
    .msg("kubelet", "app", "SIGKILL (exit 137)", { error: true })
    .end()
    .note("Spring Boot: server.shutdown=graceful. Node.js: on SIGTERM call server.close(). Make sure your process is PID 1 (or use tini), or it never receives SIGTERM.", ["api", "client"], "info")
    .build();
}

export default [
  { id: "phases", name: "Phases & reasons", build: phases },
  { id: "probes", name: "The three probes", build: probes },
  { id: "probe-incident", name: "Liveness incident", build: probeIncident },
  { id: "graceful-shutdown", name: "Graceful shutdown", build: gracefulShutdown },
] satisfies DiagramSpec[];
