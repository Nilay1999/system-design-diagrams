import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function filterScore() {
  return new Diagram("How the scheduler picks a node", "Filter out nodes that can't run the pod, score the rest, bind to the winner")
    .node("pod", "payments-api pod", 0, 1.5, "service", { detail: "requests 1 CPU · no tolerations · anti-affinity" })
    .node("filter", "1. Filter", 1.2, 1.5, "control", { detail: "which nodes CAN run it?", icon: "filter" })
    .node("n1", "node-a", 2.45, 0, "worker", { detail: "✗ Insufficient cpu", highlight: true, icon: "server" })
    .node("n2", "gpu-1", 2.45, 1, "worker", { detail: "✗ untolerated taint dedicated=ml", highlight: true, icon: "server" })
    .node("n3", "node-b", 2.45, 2, "worker", { detail: "✓ fits, but a payments-api pod is already here", icon: "server" })
    .node("n4", "node-c", 2.45, 3, "worker", { detail: "✓ fits", icon: "server" })
    .node("score", "2. Score", 3.7, 2.5, "control", { detail: "preferences, spread, least allocated", icon: "trophy" })
    .node("bind", "3. Bind to node-c", 4.95, 2.5, "service", { detail: "writes spec.nodeName; the kubelet does the rest" })
    .edge("pod", "filter")
    .edge("filter", "n1", undefined, { color: "#e03131" })
    .edge("filter", "n2", undefined, { color: "#e03131" })
    .edge("filter", "n3")
    .edge("filter", "n4")
    .edge("n3", "score", "low")
    .edge("n4", "score", "high")
    .edge("score", "bind")
    .panel("Wedding planner analogy", ["First: which tables have enough empty chairs and allow this guest? Then: which is best (near family, away from the ex)? Then seat them. Waiters (kubelets) serve."], 0, 2.75, {
      width: 360,
      tone: "warn",
    })
    .panel("Read the reason", ["kubectl describe pod → '0/6 nodes are available: 3 Insufficient cpu, 3 node(s) had untolerated taint…'"], 3.7, 0.2, {
      width: 380,
      tone: "info",
    })
    .build();
}

function taintsAffinity() {
  return new Diagram("Dedicated GPU nodes: taint + affinity", "A taint keeps other pods off; node affinity pulls the ML pods in. You need both")
    .zone("GPU nodes · taint dedicated=ml:NoSchedule · label gpu=true", ["g1", "g2"], "#9c36b5")
    .zone("General nodes", ["c1", "c2"], "#0c8599")
    .node("ml", "recommendation-ml pod", 0, 0.5, "service", { detail: "toleration dedicated=ml + nodeAffinity gpu=true", icon: "brain" })
    .node("web", "orders-api pod", 0, 2.85, "service", { detail: "no toleration" })
    .node("g1", "gpu-node-1", 2.45, 0, "worker", { icon: "cpu" })
    .node("g2", "gpu-node-2", 2.45, 1, "worker", { icon: "cpu" })
    .node("c1", "node-a", 2.45, 2.35, "worker", { icon: "server" })
    .node("c2", "node-b", 2.45, 3.35, "worker", { icon: "server" })
    .edge("ml", "g1", "pulled in by affinity")
    .edge("web", "g2", "repelled by the taint", { color: "#e03131" })
    .edge("web", "c1", "lands here")
    .panel(
      "Taint effects",
      ["NoSchedule: new pods without a toleration can't land", "PreferNoSchedule: avoid if possible", "NoExecute: also evicts running pods without a toleration", "A toleration ALLOWS a pod onto a node; it never FORCES it there"],
      3.75,
      -0.1,
      { width: 380, tone: "info" },
    )
    .panel("Other tools", ["nodeSelector: simplest hard rule (disktype: ssd)", "Pod affinity: sit near Redis", "Pod anti-affinity: never two payments-api on one node"], 3.75, 1.55, {
      width: 380,
      tone: "neutral",
    })
    .build();
}

function topologySpread() {
  return new Diagram("Topology spread across availability zones", "6 orders-api replicas, maxSkew 1 over topology.kubernetes.io/zone: 2 per zone, so a zone outage loses only a third")
    .zone("AZ ap-south-1a", ["a1", "a2"], "#0c8599")
    .zone("AZ ap-south-1b", ["b1", "b2"], "#0c8599")
    .zone("AZ ap-south-1c · outage", ["c1", "c2"], "#e03131")
    .node("a1", "orders-api", 0, 0, "service")
    .node("a2", "orders-api", 0, 1, "service")
    .node("b1", "orders-api", 1.2, 0, "service")
    .node("b2", "orders-api", 1.2, 1, "service")
    .node("c1", "orders-api", 2.4, 0, "service", { highlight: true })
    .node("c2", "orders-api", 2.4, 1, "service", { highlight: true })
    .panel(
      "topologySpreadConstraints",
      ["- maxSkew: 1", "  topologyKey: topology.kubernetes.io/zone", "  whenUnsatisfiable: DoNotSchedule", "  labelSelector:", "    matchLabels: { app: orders-api }"],
      0,
      2.15,
      { width: 420, mono: true, tone: "info" },
    )
    .panel(
      "Spread vs anti-affinity",
      ["Anti-affinity is all-or-nothing ('never two on one node'). Spread says 'keep it even', so it still works with more replicas than zones.", "Prefer soft rules (ScheduleAnyway) unless a hard rule is truly needed."],
      3.65,
      0,
      { width: 360, tone: "good" },
    )
    .build();
}

function preemption() {
  return new Sequence("Priority and preemption", "The cluster is full on a busy Friday. payments-api must win over the nightly report-job, never the reverse")
    .actor("sched", "Scheduler", "control", { icon: "clock" })
    .actor("pay", "payments-api pod (business-critical, 100000)", "service")
    .actor("node", "node-c (full)", "worker", { icon: "server" })
    .actor("rep", "report-job pod (default priority)", "service")
    .msg("pay", "sched", "new pod, can't fit anywhere")
    .msg("sched", "sched", "preemption: on which node would evicting lower-priority pods make room?")
    .msg("sched", "rep", "evict (graceful: SIGTERM, grace period)", { error: true })
    .msg("rep", "node", "terminated; its Job will retry later", { reply: true })
    .msg("sched", "pay", "nominated node-c → bind once space frees")
    .msg("pay", "node", "Running")
    .note("Set priorityClassName: business-critical on payments-api and orders-api. Use priorities sparingly: if everything is critical, nothing is.", ["sched", "rep"], "info")
    .build();
}

export default [
  { id: "filter-score", name: "Filter & score", build: filterScore },
  { id: "taints-affinity", name: "Taints & affinity", build: taintsAffinity },
  { id: "topology-spread", name: "Topology spread", build: topologySpread },
  { id: "preemption", name: "Priority & preemption", build: preemption },
] satisfies DiagramSpec[];
