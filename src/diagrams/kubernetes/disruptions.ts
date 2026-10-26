import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function drainFlow() {
  return new Sequence("Draining a node", "kubectl drain = cordon + evict every pod through the Eviction API, which respects PodDisruptionBudgets")
    .actor("admin", "Admin / Karpenter", "client")
    .actor("api", "API server (Eviction API)", "control")
    .actor("pdb", "PDB payments-api (minAvailable 2)", "object", { icon: "shield-check" })
    .actor("old", "payments-api pod on node-a", "service")
    .actor("rs", "ReplicaSet controller", "control", { icon: "workflow" })
    .actor("new", "replacement on node-d", "service")
    .msg("admin", "api", "kubectl cordon node-a (no new pods land here)")
    .msg("admin", "api", "evict payments-api pod (3 running, 3 healthy)")
    .msg("api", "pdb", "would 2 remain available?")
    .msg("pdb", "api", "yes → allowed", { reply: true })
    .msg("api", "old", "graceful shutdown: preStop, SIGTERM, grace period")
    .msg("rs", "new", "3 wanted, 2 exist → create a replacement")
    .msg("admin", "api", "evict the next payments-api pod (on node-a too)")
    .msg("api", "pdb", "would 2 remain? (replacement not Ready yet)")
    .msg("pdb", "api", "no → 429 Too Many Requests: retry later", { reply: true, error: true })
    .msg("new", "api", "Ready")
    .msg("admin", "api", "retry eviction → allowed now")
    .msg("admin", "api", "… node empty → replace it → kubectl uncordon if reused")
    .build();
}

function voluntaryInvoluntary() {
  return new Diagram("What a PDB protects against", "A PDB controls planned disruptions only. Accidents are handled by replicas spread across nodes and zones")
    .zone("Voluntary (planned)", ["v1", "v2", "v3", "pdb"], "#2f9e44")
    .zone("Involuntary (accidents)", ["i1", "i2", "i3", "spread"], "#e03131")
    .node("v1", "kubectl drain", 0, 0, "client", { icon: "terminal" })
    .node("v2", "Karpenter consolidation", 0, 1, "control", { icon: "server" })
    .node("v3", "Cluster Autoscaler scale-down", 0, 2, "control", { icon: "server" })
    .node("pdb", "PodDisruptionBudget", 1.3, 1, "object", { detail: "minAvailable: 2 → one eviction at a time", icon: "shield-check" })
    .node("i1", "Hardware failure", 2.85, 0, "external", { icon: "siren" })
    .node("i2", "Kernel panic, OOM kill", 2.85, 1, "external", { icon: "siren" })
    .node("i3", "Cloud zone outage", 2.85, 2, "external", { icon: "cloud" })
    .node("spread", "Replicas across nodes and zones", 4.15, 1, "service", { detail: "the only defence" })
    .edge("v1", "pdb", "Eviction API")
    .edge("v2", "pdb")
    .edge("v3", "pdb")
    .edge("i1", "spread")
    .edge("i2", "spread")
    .edge("i3", "spread")
    .panel("Hospital rota analogy", ["'At least 3 doctors on duty in the ER.' Leave requests wait until someone returns. A doctor suddenly falling ill still happens: the rule only covers planned absence."], 0, 2.95, {
      width: 560,
      tone: "warn",
    })
    .build();
}

function upgradeOrder() {
  return new Diagram("Upgrading a cluster", "A new minor version arrives about every four months. One minor version at a time, in this order", { icons: false })
    .node("s1", "1. Read the release notes", 0, 0, "object", { detail: "find removed APIs with pluto or kubent" })
    .node("s2", "2. Control plane", 1.15, 0, "control", { detail: "1.33 → 1.34, never skip a minor" })
    .node("s3", "3. Add-ons", 2.3, 0, "worker", { detail: "CNI, CoreDNS, kube-proxy, CSI drivers" })
    .node("s4", "4. Worker nodes", 3.45, 0, "worker", { detail: "new nodes, drain old ones one by one (PDBs keep apps up)" })
    .node("s5", "5. Watch", 4.6, 0, "client", { detail: "dashboards and error rates the whole time" })
    .edge("s1", "s2")
    .edge("s2", "s3")
    .edge("s3", "s4")
    .edge("s4", "s5")
    .panel(
      "Blue/green clusters",
      ["Bigger companies build a brand-new cluster on the new version, shift traffic gradually with DNS or the load balancer, then retire the old one. GitOps makes recreating everything easy."],
      0,
      0.85,
      { width: 560, tone: "info" },
    )
    .panel("Don't fall behind", ["Each version gets about a year of patches. On EKS, old versions move to paid extended support, then are force-upgraded."], 2.3, 0.85, {
      width: 420,
      tone: "warn",
    })
    .build();
}

function pdbDeadlock() {
  return new Diagram("The PDB deadlock", "2 replicas with minAvailable: 2 means no pod may ever be evicted. Drains hang and upgrades stall")
    .node("drain", "kubectl drain node-a", 0, 1.3, "client", { detail: "retrying forever", highlight: true, icon: "terminal" })
    .node("p1", "payments-api pod 1", 1.35, 0, "service", { detail: "on node-a" })
    .node("p2", "payments-api pod 2", 1.35, 1.3, "service", { detail: "on node-b" })
    .node("pdb", "PDB minAvailable: 2", 2.7, 0.65, "object", { detail: "2 replicas → 0 disruptions allowed", highlight: true, icon: "shield-check" })
    .edge("drain", "p1", "evict?", { color: "#e03131" })
    .edge("p1", "pdb", "check")
    .edge("p2", "pdb", "counts")
    .panel(
      "Fixes",
      ["Use maxUnavailable: 1 instead, or run 3 replicas with minAvailable: 2.", "A PDB is useless with 1 replica: run 2+ or accept downtime.", "PDBs don't spread pods: combine them with topology spread."],
      0,
      2.45,
      { width: 560, tone: "good" },
    )
    .build();
}

export default [
  { id: "drain-flow", name: "Draining a node", build: drainFlow },
  { id: "voluntary-involuntary", name: "Voluntary vs involuntary", build: voluntaryInvoluntary },
  { id: "upgrade-order", name: "Cluster upgrades", build: upgradeOrder },
  { id: "pdb-deadlock", name: "PDB deadlock", build: pdbDeadlock },
] satisfies DiagramSpec[];
