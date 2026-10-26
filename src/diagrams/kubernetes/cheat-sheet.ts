import { Diagram, type DiagramSpec } from "../dsl";

function objectMap() {
  return new Diagram("How the objects connect", "Every core object around one Pod. Most arrows are a label selector or a name reference")
    .node("route", "HTTPRoute / Ingress", 0, 0.75, "object", { icon: "route" })
    .node("svc", "Service", 1.25, 0.75, "edge", { detail: "selector" })
    .node("eps", "EndpointSlice", 2.5, 0.75, "object", { detail: "Ready pod IPs", icon: "list" })
    .node("hpa", "HPA", 0, 2, "control", { icon: "scale" })
    .node("dep", "Deployment", 1.25, 2, "object", { detail: "→ ReplicaSet → Pods", icon: "layers" })
    .node("pod", "Pod", 2.5, 2, "service", { detail: "the unit that runs", icon: "box" })
    .node("np", "NetworkPolicy", 3.75, 0.2, "object", { icon: "shield" })
    .node("cm", "ConfigMap", 3.75, 1.4, "object", { icon: "list-checks" })
    .node("sec", "Secret", 3.75, 2.6, "object", { icon: "lock" })
    .node("pdb", "PodDisruptionBudget", 5, 2, "object", { icon: "shield-check" })
    .node("rb", "RoleBinding → Role", 0, 3.25, "object", { icon: "link" })
    .node("sa", "ServiceAccount", 1.25, 3.25, "client", { icon: "bot" })
    .node("node", "Node (kubelet)", 2.5, 3.25, "worker", { icon: "server" })
    .node("pvc", "PVC", 3.75, 3.8, "object", { icon: "file" })
    .node("pv", "PV", 5, 3.8, "storage")
    .node("sc", "StorageClass", 6.25, 3.8, "object", { icon: "list-checks" })
    .edge("route", "svc", "backendRef")
    .edge("svc", "eps")
    .edge("eps", "pod", "pod IPs")
    .edge("hpa", "dep", "scales")
    .edge("dep", "pod", "creates")
    .edge("np", "pod", "firewall")
    .edge("pod", "cm", "env / files")
    .edge("pod", "sec", "env / files")
    .edge("pdb", "pod", "protects")
    .edge("rb", "sa", "grants")
    .edge("sa", "pod", "identity")
    .edge("pod", "node", "scheduled onto")
    .edge("pod", "pvc", "mounts")
    .edge("pvc", "pv", "bound")
    .edge("pv", "sc", "provisioned by")
    .build();
}

function kubectlMap() {
  const d = new Diagram("Which kubectl command answers which question", "The questions you ask every day, and the command for each");
  const rows: [string, string][] = [
    ["What's running, and where?", "kubectl get pods -o wide · kubectl get all -n fooddash"],
    ["Why isn't it working?", "kubectl describe pod <pod> · kubectl get events --sort-by=.lastTimestamp"],
    ["What did the app say?", "kubectl logs <pod> -f · --previous · -l app=orders-api --prefix"],
    ["What does it see from inside?", "kubectl exec -it <pod> -- sh · kubectl debug -it <pod> --image=nicolaka/netshoot"],
    ["Can I reach it?", "kubectl port-forward svc/orders-api 8080:80"],
    ["How do I ship a change?", "kubectl apply -f / -k · kubectl diff · kubectl rollout status | undo | restart"],
    ["Am I allowed?", "kubectl auth can-i create deployments -n fooddash"],
    ["What fields exist?", "kubectl explain deployment.spec.strategy --recursive · kubectl api-resources"],
  ];
  rows.forEach(([q, cmd], i) => {
    const col = i % 2 === 0 ? 0 : 2.75;
    const row = Math.floor(i / 2) * 1.05;
    d.node(`q${i}`, q, col, row, "client", { icon: "search" }).node(`c${i}`, cmd, col + 1.2, row, "worker", { w: 1.3, icon: "terminal" }).edge(`q${i}`, `c${i}`);
  });
  return d
    .panel("Safety first", ["kubectl config current-context before anything destructive. Show the context in your shell prompt (kubectx, kubens, k9s)."], 0, 4.2, {
      width: 520,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "object-map", name: "Object map", build: objectMap },
  { id: "kubectl-map", name: "kubectl by question", build: kubectlMap },
] satisfies DiagramSpec[];
