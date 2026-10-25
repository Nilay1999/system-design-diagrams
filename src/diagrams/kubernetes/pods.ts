import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function podAnatomy() {
  return new Diagram("Anatomy of a Pod", "One or more containers that share an IP, can share volumes, and always run together on one node")
    .zone("Pod delivery-tracker-6f9c-x2k4q · IP 10.244.1.17", ["net", "app", "side", "vol"], "#2f9e44")
    .node("kubelet", "kubelet", -1.3, 0.55, "worker", { detail: "starts both containers on the same node" })
    .node("net", "Shared network namespace", 0.65, -0.55, "edge", { detail: "one IP; containers talk on localhost", w: 1.2 })
    .node("app", "app container", 0, 0.55, "service", { detail: "fooddash/delivery-tracker:2.0 · listens on :8080", icon: "box" })
    .node("side", "log-shipper sidecar", 1.4, 0.55, "worker", { detail: "fluent-bit:3.1", icon: "files" })
    .node("vol", "emptyDir volume", 0.7, 1.75, "storage", { detail: "/var/log/app, shared by both" })
    .node("loki", "Log store (Loki)", 2.75, 1.75, "external", { icon: "search" })
    .edge("kubelet", "app", "start")
    .edge("app", "side", "localhost", { both: true })
    .edge("app", "vol", "writes logs")
    .edge("side", "vol", "reads", { both: false })
    .edge("side", "loki", "ships logs", { async: true })
    .panel(
      "Pods are mortal",
      ["A dead pod is never repaired. A new pod with a new name and new IP replaces it.", "So never hard-code pod IPs and never keep data on the pod's own filesystem."],
      -1.35,
      1.55,
      { width: 330, tone: "warn" },
    )
    .panel("Flat analogy", ["Pod = a flat. Containers = roommates: same address, same Wi-Fi, a shared cupboard. They move in and out together."], 2.75, -0.55, {
      width: 330,
      tone: "info",
    })
    .build();
}

function initSidecar() {
  return new Sequence("Init containers and native sidecars", "Init containers run one at a time, to completion, before the app. A sidecar starts first, stays for the pod's whole life, and stops last")
    .actor("kubelet", "kubelet", "worker")
    .actor("wait", "init: wait-for-postgres", "worker", { icon: "timer" })
    .actor("mig", "init: run-migrations", "worker", { icon: "database" })
    .actor("side", "sidecar: log-shipper", "worker", { icon: "files" })
    .actor("app", "app: orders-api", "service")
    .phase("Startup (pod shows Init:0/2, Init:1/2…)")
    .msg("kubelet", "wait", "start")
    .loop("until nc -z postgres 5432", "wait", "wait")
    .msg("wait", "wait", "waiting… sleep 2")
    .end()
    .msg("wait", "kubelet", "exit 0", { reply: true })
    .msg("kubelet", "mig", "start (only after the first succeeded)")
    .msg("mig", "mig", "Flyway migrate: safe to run twice")
    .msg("mig", "kubelet", "exit 0", { reply: true })
    .msg("kubelet", "side", "start (init container with restartPolicy: Always)")
    .msg("kubelet", "app", "start the app: every init step is done")
    .phase("Running")
    .msg("app", "side", "logs via the shared emptyDir", { async: true })
    .phase("Shutdown")
    .msg("kubelet", "app", "SIGTERM")
    .msg("app", "kubelet", "exited", { reply: true })
    .msg("kubelet", "side", "SIGTERM only after the app stopped: no lost log lines")
    .note("If an init container fails, the kubelet retries it per the restart policy and the app never starts. Native sidecars are stable since v1.33 and fixed Jobs that never finished because a sidecar kept running.", ["kubelet", "app"], "info")
    .build();
}

function patterns() {
  return new Diagram("Multi-container patterns", "Only put containers in one pod when they must share a lifecycle and a machine")
    .zone("Sidecar: a helper beside the app", ["sApp", "sHelper"], "#2f9e44")
    .zone("Ambassador: a local proxy to the outside", ["aApp", "aProxy"], "#1971c2")
    .zone("Adapter: a translator", ["dApp", "dAdapter"], "#9c36b5")
    .node("sApp", "app", 0, 0, "service", { detail: "plain HTTP to localhost" })
    .node("sHelper", "Envoy / Fluent Bit / Vault Agent", 1, 0, "worker", { detail: "mTLS, logs, secrets" })
    .node("aApp", "app", 0, 1.55, "service", { detail: "talks to localhost:6379" })
    .node("aProxy", "Redis proxy", 1, 1.55, "worker", { detail: "knows the shards" })
    .node("redis", "Sharded Redis cluster", 2.35, 1.55, "cache")
    .node("dApp", "legacy app", 0, 3.1, "service", { detail: "custom metrics format" })
    .node("dAdapter", "metrics adapter", 1, 3.1, "worker", { detail: "→ Prometheus format", icon: "refresh" })
    .node("prom", "Prometheus", 2.35, 3.1, "external")
    .edge("sApp", "sHelper", "localhost", { both: true })
    .edge("aApp", "aProxy", "localhost")
    .edge("aProxy", "redis", "sharded calls")
    .edge("dApp", "dAdapter", "raw metrics")
    .edge("prom", "dAdapter", "scrape /metrics")
    .panel(
      "One pod or two?",
      [
        "Same pod: the helper is useless without the app and must see its files or localhost.",
        "Separate pods: orders-api and payments-api. They must scale and deploy independently.",
        "Sidecar requests count toward the pod: a heavy mesh proxy on 200 pods is real money.",
      ],
      3.5,
      -0.1,
      { width: 360, tone: "info" },
    )
    .build();
}

export default [
  { id: "pod-anatomy", name: "Pod anatomy", build: podAnatomy },
  { id: "init-sidecar", name: "Init containers & sidecars", build: initSidecar },
  { id: "patterns", name: "Multi-container patterns", build: patterns },
] satisfies DiagramSpec[];
