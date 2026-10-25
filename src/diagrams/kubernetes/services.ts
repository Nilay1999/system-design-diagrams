import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function serviceBasics() {
  return new Diagram("How a Service works", "One stable name and IP in front of whichever matching pods are Ready right now")
    .node("caller", "orders-api", 0, 1, "service", { detail: "calls http://payments-api/charge" })
    .node("svc", "Service payments-api", 1.2, 1, "edge", { detail: ["ClusterIP 10.96.12.34", "port 80 → targetPort 8080"] })
    .node("ctrl", "EndpointSlice controller", 0, 2.4, "control", { detail: "watches pods matching app=payments-api" })
    .node("eps", "EndpointSlice", 1.2, 2.4, "object", { detail: "10.244.1.5, 10.244.2.9 (Ready pods only)", icon: "list" })
    .node("p1", "payments-api pod", 2.5, 0, "service", { detail: "10.244.1.5 · Ready" })
    .node("p2", "payments-api pod", 2.5, 1, "service", { detail: "10.244.2.9 · Ready" })
    .node("p3", "payments-api pod", 2.5, 2, "service", { detail: "10.244.3.4 · readiness failing", highlight: true })
    .edge("caller", "svc", "port 80")
    .edge("svc", "p1", ":8080")
    .edge("svc", "p2", ":8080")
    .edge("svc", "p3", "not in the list", { color: "#adb5bd" })
    .edge("ctrl", "eps", "writes")
    .edge("eps", "svc", "backends", { async: true })
    .panel(
      "Customer-care number analogy",
      ["The number never changes, though the agents behind it change every shift. You call one number; any free agent picks up. An agent leaves? Calls go to the others."],
      3.75,
      0,
      { width: 340, tone: "warn" },
    )
    .panel("Readiness + Services", ["A pod failing its readiness probe is quietly dropped from the EndpointSlice. That's how probes and Services work together."], 3.75, 1.2, {
      width: 340,
      tone: "info",
    })
    .build();
}

function serviceTypes() {
  return new Diagram("Service types build on each other", "A LoadBalancer Service also gets a NodePort, which also gets a ClusterIP")
    .node("inet", "Internet", 0, 1, "client", { icon: "globe" })
    .node("lb", "type: LoadBalancer", 1.1, 1, "edge", { detail: "a cloud LB, ~$16–20/month each on AWS" })
    .node("n1", "Node 1 :31234", 2.25, 0.35, "worker", { detail: "type: NodePort (30000–32767)", icon: "server" })
    .node("n2", "Node 2 :31234", 2.25, 1.65, "worker", { detail: "same port on every node", icon: "server" })
    .node("cip", "type: ClusterIP", 3.4, 1, "edge", { detail: "10.96.0.50, inside the cluster only" })
    .node("pods", "Ready pods", 4.55, 1, "service", { icon: "boxes" })
    .edge("inet", "lb")
    .edge("lb", "n1")
    .edge("lb", "n2")
    .edge("n1", "cip")
    .edge("n2", "cip")
    .edge("cip", "pods")
    .panel("ExternalName", ["Just a DNS alias: db → fooddash.abc123.ap-south-1.rds.amazonaws.com. No proxying."], 0, 2.7, { width: 330 })
    .panel("Headless (clusterIP: None)", ["No virtual IP: DNS returns every pod IP. For StatefulSets and client-side load balancing (gRPC)."], 1.1, 2.7, { width: 330, tone: "info" })
    .panel(
      "Don't buy one LB per service",
      ["30 microservices × a LoadBalancer each = 30 cloud bills. Put one LB in front of a Gateway or Ingress controller and keep everything else ClusterIP."],
      2.2,
      2.7,
      { width: 420, tone: "warn" },
    )
    .build();
}

function readinessEndpoints() {
  return new Sequence("Readiness drives the endpoint list", "A pod that stops being Ready leaves the Service within seconds, and comes back on its own")
    .actor("kubelet", "kubelet", "worker")
    .actor("pod", "payments-api pod 3", "service")
    .actor("api", "API server", "control")
    .actor("ctrl", "EndpointSlice controller", "control", { icon: "workflow" })
    .actor("proxy", "kube-proxy (every node)", "edge")
    .msg("kubelet", "pod", "readiness GET /actuator/health/readiness")
    .msg("pod", "kubelet", "503: connection pool exhausted", { reply: true, error: true })
    .msg("kubelet", "api", "pod condition Ready=False")
    .msg("api", "ctrl", "watch event", { async: true })
    .msg("ctrl", "api", "remove 10.244.3.4 from the EndpointSlice")
    .msg("api", "proxy", "watch event", { async: true })
    .msg("proxy", "proxy", "rewrite rules: new connections skip pod 3")
    .phase("A minute later")
    .msg("kubelet", "pod", "readiness check")
    .msg("pod", "kubelet", "200 OK", { reply: true })
    .msg("kubelet", "api", "Ready=True → added back the same way")
    .note("Nothing was restarted. Readiness only moves traffic.", ["kubelet", "proxy"], "good")
    .build();
}

function emptyEndpoints() {
  return new Diagram("The #1 Service bug: empty endpoints", "Real incident: 'Service returns 503, but the pods look fine'")
    .node("svc", "Service orders-api", 0, 0.4, "edge", { detail: "selector: app=orders-api" })
    .node("eps", "EndpointSlice", 0, 1.65, "object", { detail: "0 endpoints", highlight: true, icon: "list" })
    .node("pods", "3 pods, Running and Ready", 1.45, 0.4, "service", { detail: "labels: app=order-service (renamed!)", icon: "boxes" })
    .edge("svc", "pods", "selector matches nothing", { color: "#e03131" })
    .edge("svc", "eps", "reads")
    .steps(
      "Debug it in 4 commands",
      [
        "kubectl get svc orders-api (does it exist, right port?)",
        "kubectl get endpointslices -l kubernetes.io/service-name=orders-api → empty",
        "kubectl get pods --show-labels → labels don't match the selector",
        "kubectl run tmp --rm -it --image=nicolaka/netshoot -- curl http://orders-api",
      ],
      2.75,
      -0.1,
      { width: 420 },
    )
    .panel("Causes", ["Selector doesn't match pod labels", "No pod is Ready", "targetPort doesn't match the container port: 'connection refused'"], 2.75, 1.45, {
      width: 420,
      tone: "bad",
    })
    .build();
}

export default [
  { id: "service-basics", name: "How a Service works", build: serviceBasics },
  { id: "service-types", name: "Service types", build: serviceTypes },
  { id: "readiness-endpoints", name: "Readiness & endpoints", build: readinessEndpoints },
  { id: "empty-endpoints", name: "Empty endpoints bug", build: emptyEndpoints },
] satisfies DiagramSpec[];
