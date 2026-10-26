import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function architecture() {
  return new Diagram("Cluster architecture", "A control plane (the brain that decides) plus worker nodes (the machines that do the work). Everything talks only to the API server")
    .zone("Control plane (run for you on EKS / GKE / AKS)", ["api", "etcd", "sched", "cm", "ccm"], "#3b5bdb")
    .zone("Worker node 1", ["kubelet1", "rt1", "proxy1", "pods1"], "#0c8599")
    .zone("Worker node 2", ["kubelet2", "rt2", "proxy2", "pods2"], "#0c8599")
    .node("kubectl", "kubectl / CI / dashboard", 2, -1.1, "client", { icon: "terminal" })
    .node("api", "kube-apiserver", 2, 1.2, "control", { detail: ["the only entry point", "authn → RBAC → admission → etcd"] })
    .node("etcd", "etcd", 0.8, 0.2, "db", { detail: "all cluster state" })
    .node("sched", "kube-scheduler", 0.8, 1.2, "control", { detail: "picks a node for new pods", icon: "clock" })
    .node("cm", "kube-controller-manager", 0.8, 2.2, "control", { detail: "Deployment, ReplicaSet, Node, Job… controllers" })
    .node("ccm", "cloud-controller-manager", 0.8, 3.2, "control", { detail: "load balancers, node lifecycle" })
    .node("cloud", "Cloud API (AWS)", -0.45, 3.2, "external", { detail: "ELB, EC2" })
    .node("kubelet1", "kubelet", 3.3, 0.35, "worker", { detail: "runs pods bound to this node" })
    .node("rt1", "containerd", 4.35, 0.35, "worker", { detail: "pulls images, runs containers", icon: "box" })
    .node("proxy1", "kube-proxy", 3.3, 1.4, "worker", { detail: "Service IP → pod IP rules" })
    .node("pods1", "Pods", 4.35, 1.4, "service", { detail: "orders-api, payments-api", icon: "boxes" })
    .node("kubelet2", "kubelet", 3.3, 2.65, "worker", { detail: "runs pods bound to this node" })
    .node("rt2", "containerd", 4.35, 2.65, "worker", { detail: "pulls images, runs containers", icon: "box" })
    .node("proxy2", "kube-proxy", 3.3, 3.7, "worker", { detail: "Service IP → pod IP rules" })
    .node("pods2", "Pods", 4.35, 3.7, "service", { detail: "orders-api, delivery-tracker", icon: "boxes" })
    .edge("kubectl", "api", "HTTPS")
    .edge("api", "etcd", "only writer", { both: true })
    .edge("sched", "api", "watch, bind", { both: true })
    .edge("cm", "api", "watch, fix", { both: true })
    .edge("ccm", "api", undefined, { both: true })
    .edge("ccm", "cloud", "create LB")
    .edge("kubelet1", "api", "watch, report", { both: true })
    .edge("kubelet2", "api", "watch, report", { both: true })
    .edge("kubelet1", "rt1", "CRI")
    .edge("rt1", "pods1", "runs")
    .edge("kubelet2", "rt2", "CRI")
    .edge("rt2", "pods2", "runs")
    .panel(
      "Nobody gives orders",
      [
        "Every component watches the API server and reacts to changes.",
        "The scheduler never tells a kubelet to start a pod: it writes spec.nodeName, and the kubelet sees that on its watch.",
        "So any part can crash, restart and simply read the latest state again.",
      ],
      5.55,
      0.35,
      { width: 330, tone: "info" },
    )
    .panel(
      "Restaurant analogy",
      ["API server = front desk", "etcd = the order book", "scheduler = host who assigns kitchens", "controllers = floor managers", "kubelet = station chef", "kube-proxy = waiter routing orders", "containerd = stoves and tools"],
      5.55,
      2.3,
      { width: 330, tone: "warn" },
    )
    .build();
}

function applyFlow() {
  return new Sequence("What happens on kubectl apply", "The most-asked architecture question: from a YAML file to a pod receiving traffic. Every step is someone noticing a change", { gap: 215 })
    .actor("you", "kubectl", "client", { icon: "terminal" })
    .actor("api", "API server", "control")
    .actor("etcd", "etcd", "db")
    .actor("ctrl", "Deployment + RS controllers", "control", { icon: "workflow" })
    .actor("sched", "Scheduler", "control", { icon: "clock" })
    .actor("kubelet", "kubelet (node 2)", "worker")
    .actor("rt", "containerd + CNI + CSI", "worker", { icon: "box" })
    .actor("eps", "EndpointSlice ctrl + kube-proxy", "edge")
    .phase("1 · Accept the wish")
    .msg("you", "api", "apply orders-api.yaml (HTTPS, your kubeconfig credentials)")
    .msg("api", "api", "authenticate → authorise (RBAC) → mutating admission → validate → validating admission")
    .msg("api", "etcd", "store Deployment (3 replicas)")
    .msg("api", "you", "201 Created", { reply: true })
    .phase("2 · Controllers fill the gap")
    .msg("api", "ctrl", "watch event: new Deployment", { async: true })
    .msg("ctrl", "api", "create ReplicaSet, then 3 Pods with no node (spec.nodeName empty)")
    .phase("3 · Scheduling")
    .msg("api", "sched", "watch event: 3 unscheduled pods", { async: true })
    .msg("sched", "sched", "filter nodes that fit, score the rest")
    .msg("sched", "api", "Binding: pod → node 2 (writes spec.nodeName)")
    .phase("4 · Running on the node")
    .msg("api", "kubelet", "watch event: a pod bound to me", { async: true })
    .msg("kubelet", "rt", "CRI: pull image, create sandbox; CNI: pod IP; CSI: mount volumes")
    .msg("kubelet", "kubelet", "start containers, run startup + readiness probes")
    .msg("kubelet", "api", "patch pod.status: Running, Ready")
    .phase("5 · Traffic")
    .msg("api", "eps", "pod Ready → add its IP to the Service's EndpointSlice", { async: true })
    .msg("eps", "eps", "kube-proxy on every node updates its rules; traffic flows")
    .note("No component calls another directly: each one watches the API server and writes back. That hub-and-spoke design is why the parts can fail independently.", ["you", "eps"], "info")
    .build();
}

function pluginInterfaces() {
  return new Diagram("The three plugin interfaces", "The kubelet doesn't run containers, wire networks or attach disks itself: it calls a plugin for each")
    .node("api", "API server", -0.1, 1, "control", { detail: "pod bound to this node" })
    .node("kubelet", "kubelet", 1.05, 1, "worker", { detail: "the node agent" })
    .node("cri", "Container runtime", 2.3, 0, "worker", { detail: ["CRI: containerd, CRI-O", "pull images, create containers"], icon: "box" })
    .node("cni", "Network plugin", 2.3, 1, "edge", { detail: ["CNI: Calico, Cilium, AWS VPC CNI", "pod IP + routes between nodes"] })
    .node("csi", "Storage driver", 2.3, 2, "storage", { detail: ["CSI: EBS, EFS, Longhorn", "attach + mount volumes"] })
    .node("pod", "Running pod", 3.55, 1, "service", { detail: ["containers from CRI", "IP from CNI", "volumes from CSI"], icon: "boxes" })
    .edge("api", "kubelet", "watch")
    .edge("kubelet", "cri", "CRI (gRPC)")
    .edge("kubelet", "cni", "CNI ADD")
    .edge("kubelet", "csi", "CSI mount")
    .edge("cri", "pod")
    .edge("cni", "pod")
    .edge("csi", "pod")
    .panel(
      "Why plugins?",
      [
        "Kubernetes defines the contract; vendors implement it. Swap containerd for CRI-O, or Flannel for Cilium, without changing Kubernetes.",
        "Docker shim was removed in v1.24, but images built with Docker still run: they are standard OCI images.",
      ],
      -0.1,
      2.35,
      { width: 560, tone: "info" },
    )
    .build();
}

function haFailures() {
  return new Diagram("High availability and failure modes", "A production control plane runs 3 of everything. What breaks for FoodDash when each part fails")
    .zone("Highly available control plane", ["api1", "api2", "api3", "etcd1", "etcd2", "etcd3", "sched", "cm"], "#3b5bdb")
    .node("lb", "Load balancer", 0, 1, "edge", { detail: "in front of the API servers" })
    .node("api1", "API server 1", 1.1, 0, "control", { detail: "stateless" })
    .node("api2", "API server 2", 1.1, 1, "control", { detail: "stateless" })
    .node("api3", "API server 3", 1.1, 2, "control", { detail: "stateless" })
    .node("etcd1", "etcd 1", 2.2, 0, "db", { detail: "Raft member" })
    .node("etcd2", "etcd 2", 2.2, 1, "db", { detail: "Raft member" })
    .node("etcd3", "etcd 3", 2.2, 2, "db", { detail: "Raft member" })
    .node("sched", "Scheduler ×3", 3.3, 0.5, "control", { detail: "one leader, others wait (Lease lock)", icon: "clock" })
    .node("cm", "Controller manager ×3", 3.3, 1.5, "control", { detail: "one leader, others wait (Lease lock)" })
    .edge("lb", "api1")
    .edge("lb", "api2")
    .edge("lb", "api3")
    .edge("api1", "etcd1", undefined, { both: true })
    .edge("api2", "etcd2", undefined, { both: true })
    .edge("api3", "etcd3", undefined, { both: true })
    .panel(
      "If this fails…",
      [
        "One worker node → its pods are recreated on other nodes in a few minutes",
        "API server → running apps keep serving, but you can't deploy, scale or fix anything",
        "etcd loses quorum → same as above; lost etcd with no backup = rebuild the cluster",
        "Scheduler → existing pods fine, new pods stay Pending",
        "kubelet on a node → node NotReady, its pods move elsewhere (~5 min)",
      ],
      4.5,
      0,
      { width: 420, tone: "bad" },
    )
    .panel("Quorum math", ["3 members: 2 must agree (survives 1 failure)", "5 members: 3 must agree (survives 2)", "Always an odd number; back up with etcdctl snapshot save"], 4.5, 1.9, {
      width: 420,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "apply-flow", name: "kubectl apply, step by step", build: applyFlow },
  { id: "plugin-interfaces", name: "CRI, CNI, CSI", build: pluginInterfaces },
  { id: "ha-failures", name: "HA & failure modes", build: haFailures },
] satisfies DiagramSpec[];
