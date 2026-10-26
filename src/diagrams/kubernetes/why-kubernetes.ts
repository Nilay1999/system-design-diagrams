import { Diagram, type DiagramSpec } from "../dsl";

function beforeAfter() {
  return new Diagram("Why Kubernetes — FoodDash on a Friday night", "Left: humans run containers by hand. Right: you declare what you want and a control loop keeps it true")
    .zone("Without Kubernetes: people doing robot work at 9 PM", ["eng", "s1", "s2", "s3"], "#e03131")
    .zone("With Kubernetes: one wish, kept true forever", ["wish", "cp", "n1", "n2", "n3"], "#326ce5")
    .node("eng", "On-call engineer", 0, 1, "client", { detail: "SSH into every server" })
    .node("s1", "Server 1", 1, 0, "worker", { detail: "docker run orders-api ×2", icon: "server" })
    .node("s2", "Server 2", 1, 1, "worker", { detail: "docker run payments-api", icon: "server" })
    .node("s3", "Server 3", 1, 2, "worker", { detail: "disk died at 8:30 PM, 4 containers gone", highlight: true, icon: "server" })
    .edge("eng", "s1", "ssh, docker run")
    .edge("eng", "s2")
    .edge("eng", "s3", "nobody noticed")
    .panel(
      "Friday, by hand",
      ["8 PM: orders jump 5×, someone starts containers by hand", "8:30 PM: a disk dies, customers notice first", "9 PM: a hot-fix, one server at a time, praying", "Every day: which container is where? which port?"],
      0,
      2.85,
      { width: 540, tone: "bad" },
    )
    .node("wish", "Desired state", 2.5, 0, "object", { detail: ["3 × orders-api v1.4", "1 CPU, 1 GB each", "reachable as “orders-api”"] })
    .node("cp", "Control plane", 3.6, 0, "control", { detail: "compares wish vs reality, fixes the gap" })
    .node("n1", "Node 1", 2.5, 1.6, "worker", { detail: "orders-api, payments-api", icon: "server" })
    .node("n2", "Node 2", 3.6, 1.6, "worker", { detail: "orders-api, orders-api ← new", icon: "server" })
    .node("n3", "Node 3", 4.7, 1.6, "worker", { detail: "died → its pods recreated on 1 and 2", highlight: true, icon: "server" })
    .edge("wish", "cp", "kubectl apply")
    .edge("cp", "n1", "schedule")
    .edge("cp", "n2", "heal")
    .edge("cp", "n3")
    .panel(
      "What you get instead",
      [
        "A container crashes → restarted automatically",
        "A server dies → its containers move to healthy servers",
        "Traffic spikes → more copies, even more servers",
        "New version → replaced gradually, one-command rollback",
        "Services find each other by a stable name",
      ],
      2.5,
      2.85,
      { width: 540, tone: "good" },
    )
    .build();
}

function reconciliation() {
  return new Diagram("The reconciliation loop", "The one idea behind every Kubernetes feature: compare what you asked for with what exists, then fix the gap", { icons: false })
    .node("desired", "Desired state (spec)", 0, 1, "object", { detail: ["you write it, stored in etcd", "“3 × orders-api 1.4”"] })
    .node("observe", "Observe actual state", 1, 0, "worker", { detail: "watch streams, not polling" })
    .node("diff", "Compare", 2, 1, "control", { detail: "want 3, see 2 → gap of 1" })
    .node("act", "Act", 1, 2, "service", { detail: ["create or delete pods", "update routes, attach disks"] })
    .edge("desired", "diff", "wish")
    .edge("observe", "diff", "reality")
    .edge("diff", "act", "fix the gap")
    .edge("act", "observe", "world changes, loop again", { async: true })
    .panel(
      "Every controller is this loop",
      [
        "for {",
        "  desired := apiServer.get(object.spec)",
        "  actual  := observe(world)    // watches",
        "  if diff(desired, actual) != nil {",
        "    act(diff)   // pods, iptables, volumes…",
        "  }",
        "  object.status = actual      // report back",
        "}",
      ],
      3.1,
      -0.1,
      { width: 400, mono: true, tone: "info" },
    )
    .panel(
      "Level-triggered, not edge-triggered",
      ["A controller doesn't care which event happened, only what the difference is now.", "So missed events, crashes and network splits heal by themselves on the next pass."],
      3.1,
      1.55,
      { width: 400, tone: "good" },
    )
    .panel("Thermostat analogy", ["You set 24°C. You never switch the AC on and off yourself; the thermostat keeps checking and correcting."], 3.1, 2.45, {
      width: 400,
      tone: "warn",
    })
    .build();
}

function manager() {
  return new Diagram("Kubernetes is a restaurant manager", "A small dhaba runs on the owner; a chain with 50 kitchens needs a manager. Each duty maps to a feature")
    .node("k8s", "Kubernetes", 2, 1.2, "control", { detail: "the manager for your containers", w: 1.1 })
    .node("heal", "Self-healing", 0.5, 0, "service", { detail: "a cook leaves → hire a replacement now", icon: "refresh" })
    .node("scale", "Autoscaling", 3.6, 0, "service", { detail: "dinner rush → call in extra cooks", icon: "scale" })
    .node("sched", "Scheduling", 0, 1.2, "service", { detail: "which kitchen has room for one more cook?", icon: "layers" })
    .node("roll", "Rolling updates", 4.1, 1.2, "service", { detail: "change the menu one kitchen at a time", icon: "git-branch" })
    .node("disc", "Service discovery", 1.25, 2.5, "edge", { detail: "one phone number for orders, any cook answers" })
    .node("config", "Config & secrets", 2.85, 2.5, "object", { detail: "same chef, local menu card per branch", icon: "lock" })
    .edge("k8s", "heal")
    .edge("k8s", "scale")
    .edge("k8s", "sched")
    .edge("k8s", "roll")
    .edge("k8s", "disc")
    .edge("k8s", "config")
    .build();
}

export default [
  { id: "before-after", name: "Before vs after", build: beforeAfter },
  { id: "reconciliation", name: "Reconciliation loop", build: reconciliation },
  { id: "manager", name: "The manager analogy", build: manager },
] satisfies DiagramSpec[];
