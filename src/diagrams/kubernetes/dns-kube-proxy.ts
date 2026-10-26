import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function callPath() {
  return new Sequence("orders-api calls payments-api", "CoreDNS is the phonebook; kube-proxy's rules on the caller's own node are the switchboard")
    .actor("app", "orders-api pod", "service")
    .actor("dns", "CoreDNS (kube-system)", "worker", { icon: "globe" })
    .actor("rules", "Kernel rules on this node", "edge", { icon: "network" })
    .actor("pod", "payments-api pod", "service")
    .msg("app", "app", "GET http://payments-api/charge")
    .msg("app", "dns", "A? payments-api.fooddash.svc.cluster.local (from the search list in /etc/resolv.conf)")
    .msg("dns", "app", "10.96.12.34 (the ClusterIP, stable)", { reply: true })
    .msg("app", "rules", "TCP SYN to 10.96.12.34:80")
    .msg("rules", "rules", "DNAT: pick one Ready backend → 10.244.2.9:8080 (per connection)")
    .msg("rules", "pod", "packet arrives with orders-api's real pod IP as the source")
    .msg("pod", "app", "200 OK", { reply: true })
    .note("Nothing 'owns' the ClusterIP. No central proxy, no hop: the rewrite happens on the caller's own node, so there's no bottleneck.", ["app", "pod"], "info")
    .build();
}

function proxyModes() {
  return new Diagram("How kube-proxy routes traffic", "It watches Services and EndpointSlices, then programs the kernel on every node")
    .node("api", "API server", 0, 1, "control")
    .node("kp", "kube-proxy (DaemonSet)", 1.25, 1, "worker", { detail: "one per node", icon: "network" })
    .node("ipt", "iptables mode", 2.55, 0, "worker", { detail: "random pick per connection; slows down with thousands of Services" })
    .node("ipvs", "IPVS mode", 2.55, 1, "worker", { detail: "kernel load balancer, hash tables; round robin, least connections" })
    .node("nft", "nftables mode", 2.55, 2, "worker", { detail: "modern successor of iptables mode" })
    .node("cilium", "Cilium eBPF", 1.25, 2.45, "worker", { detail: "replaces kube-proxy completely; fastest, deep visibility" })
    .edge("api", "kp", "watch Services + EndpointSlices")
    .edge("kp", "ipt")
    .edge("kp", "ipvs")
    .edge("kp", "nft")
    .edge("api", "cilium", "or", { async: true })
    .panel("Try it", ["On a node: iptables -t nat -L KUBE-SERVICES | head", "You'll see one chain per Service, jumping to one per endpoint."], 3.8, 0, { width: 340, tone: "info" })
    .build();
}

function grpcGotcha() {
  return new Diagram("The gRPC / HTTP/2 gotcha", "kube-proxy balances connections, not requests. One long-lived connection means one busy pod")
    .node("client", "delivery-tracker", 0, 1.5, "service", { detail: "gRPC client, one channel" })
    .node("svc", "ClusterIP eta-service", 1.25, 1.5, "edge")
    .node("e1", "eta-service pod 1", 2.5, 0, "service", { detail: "100% of requests", highlight: true })
    .node("e2", "eta-service pod 2", 2.5, 1, "service", { detail: "idle" })
    .node("e3", "eta-service pod 3", 2.5, 2, "service", { detail: "idle" })
    .node("e4", "eta-service pod 4", 2.5, 3, "service", { detail: "idle" })
    .edge("client", "svc", "1 connection, 1000s of calls")
    .edge("svc", "e1", "chosen once, forever", { color: "#e03131" })
    .panel(
      "Fixes",
      [
        "1. Headless Service: DNS returns every pod IP, and the gRPC client balances itself (round_robin policy).",
        "2. A service mesh or L7 proxy (Envoy, Linkerd) balances per request.",
        "Watch out: a headless Service needs a client that re-resolves DNS; some JVM settings cache it forever.",
      ],
      3.75,
      0.6,
      { width: 380, tone: "good" },
    )
    .build();
}

function ndots() {
  return new Sequence("The ndots:5 slowness", "A name with fewer than 5 dots is tried against every search domain before the real one")
    .actor("app", "payments-api pod", "service")
    .actor("dns", "CoreDNS", "worker", { icon: "globe" })
    .actor("up", "Upstream DNS", "external", { icon: "globe" })
    .msg("app", "dns", "api.razorpay.com.fooddash.svc.cluster.local?")
    .msg("dns", "app", "NXDOMAIN", { reply: true, error: true })
    .msg("app", "dns", "api.razorpay.com.svc.cluster.local?")
    .msg("dns", "app", "NXDOMAIN", { reply: true, error: true })
    .msg("app", "dns", "api.razorpay.com.cluster.local?")
    .msg("dns", "app", "NXDOMAIN", { reply: true, error: true })
    .msg("app", "dns", "api.razorpay.com? (finally the real name)")
    .msg("dns", "up", "forward")
    .msg("up", "app", "13.235.x.x", { reply: true })
    .note("Fix: write the name with a trailing dot (api.razorpay.com.) or set dnsConfig options ndots: 2 on latency-sensitive pods.", ["app", "up"], "good")
    .build();
}

export default [
  { id: "call-path", name: "A call, end to end", build: callPath },
  { id: "kube-proxy-modes", name: "kube-proxy modes", build: proxyModes },
  { id: "grpc-gotcha", name: "The gRPC gotcha", build: grpcGotcha },
  { id: "ndots", name: "ndots:5 lookups", build: ndots },
] satisfies DiagramSpec[];
