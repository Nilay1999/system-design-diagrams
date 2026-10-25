import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function sidecarMesh() {
  return new Diagram("Sidecar service mesh (Istio)", "Your app still calls http://payments-api. A proxy beside it adds encryption, retries and metrics")
    .zone("orders-api pod", ["oa", "oe"], "#2f9e44")
    .zone("payments-api pod", ["pe", "pa"], "#2f9e44")
    .node("istiod", "istiod (control plane)", 1.6, -1.15, "control", { detail: "routes, policies, certificates", icon: "istio" })
    .node("oa", "orders-api", 0, 0.4, "service", { detail: "plain HTTP, no mesh code" })
    .node("oe", "Envoy sidecar", 1.05, 0.4, "worker", { icon: "envoy" })
    .node("pe", "Envoy sidecar", 2.25, 0.4, "worker", { icon: "envoy" })
    .node("pa", "payments-api", 3.3, 0.4, "service")
    .edge("oa", "oe", "localhost")
    .edge("oe", "pe", "mTLS")
    .edge("pe", "pa", "localhost")
    .edge("istiod", "oe", "config + certs", { async: true })
    .edge("istiod", "pe", "config + certs", { async: true })
    .panel(
      "What you get, with no code changes",
      [
        "Automatic mTLS between every pair of services",
        "Identity-based rules: only orders-api may POST /charge",
        "Retries, timeouts, circuit breaking",
        "Traffic splitting: 5% to payments-api v2",
        "Golden metrics (rate, errors, latency) for every service pair",
        "Fault injection: add a 3s delay to 10% of calls in staging",
      ],
      0,
      1.65,
      { width: 520, tone: "good" },
    )
    .panel("Courier analogy", ["One courier company handles all internal mail: every letter sealed and signed, tracked, and retried by one standard rule."], 1.75, 1.65, {
      width: 360,
      tone: "warn",
    })
    .build();
}

function mtlsCall() {
  return new Sequence("A call through the mesh", "orders-api → payments-api POST /charge with mTLS, authorization and a retry policy")
    .actor("oa", "orders-api", "service")
    .actor("oe", "orders Envoy", "worker", { icon: "envoy" })
    .actor("pe", "payments Envoy", "worker", { icon: "envoy" })
    .actor("pa", "payments-api", "service")
    .actor("istiod", "istiod", "control", { icon: "istio" })
    .phase("At startup")
    .msg("istiod", "oe", "certificate for spiffe://…/sa/orders-api, routes, policies", { async: true })
    .msg("istiod", "pe", "certificate for spiffe://…/sa/payments-api, policies", { async: true })
    .phase("Each request")
    .msg("oa", "oe", "POST http://payments-api/charge (intercepted)")
    .msg("oe", "pe", "mTLS handshake: both sides prove their identity")
    .msg("pe", "pe", "AuthorizationPolicy: orders-api may POST /charge → allow")
    .msg("pe", "pa", "plain HTTP on localhost")
    .msg("pa", "pe", "503 (one replica restarting)", { reply: true, error: true })
    .msg("oe", "pe", "retry once, only because this call carries an idempotency key")
    .msg("pa", "oa", "200 OK (metrics and trace spans recorded on both sides)", { reply: true })
    .note("Retrying a non-idempotent POST /charge can double-charge a customer. Retry only safe calls, or use idempotency keys.", ["oa", "istiod"], "bad")
    .build();
}

function ambient() {
  return new Diagram("Ambient mode: no sidecars", "A shared per-node proxy handles mTLS; an optional waypoint adds L7 features only where you need them")
    .zone("Node 1", ["oa", "zt1"], "#0c8599")
    .zone("Node 2", ["pa", "zt2"], "#0c8599")
    .node("oa", "orders-api", 0, 0, "service")
    .node("zt1", "ztunnel", 0, 1.15, "worker", { detail: "per node: L4 mTLS", icon: "lock" })
    .node("pa", "payments-api", 2.4, 0, "service")
    .node("zt2", "ztunnel", 2.4, 1.15, "worker", { detail: "per node: L4 mTLS", icon: "lock" })
    .node("wp", "waypoint proxy", 1.2, 2.45, "edge", { detail: "optional: retries, routing, L7 auth", icon: "envoy" })
    .edge("oa", "zt1")
    .edge("zt1", "zt2", "mTLS tunnel")
    .edge("zt2", "pa")
    .edge("zt1", "wp", "only if L7 is needed", { async: true })
    .edge("wp", "zt2", undefined, { async: true })
    .panel("Trade-off", ["Fewer containers and less memory per pod, no sidecar startup races.", "Linkerd and Cilium mesh are other popular choices."], 3.65, 0, {
      width: 340,
      tone: "info",
    })
    .build();
}

function retryStorm() {
  return new Diagram("Retries multiply", "If three layers each retry 3 times, one failing call becomes 27 calls, right when the service is already struggling", { icons: false })
    .node("client", "Mobile app", 0, 0, "client", { detail: "retries 3×" })
    .node("gw", "Gateway", 1.15, 0, "edge", { detail: "retries 3× each" })
    .node("mesh", "Mesh sidecar", 2.3, 0, "worker", { detail: "retries 3× each" })
    .node("svc", "restaurant-api", 3.45, 0, "service", { detail: "receives 27 calls", highlight: true })
    .edge("client", "gw", "3")
    .edge("gw", "mesh", "9")
    .edge("mesh", "svc", "27", { color: "#e03131" })
    .panel("Rule", ["Configure retries in exactly one layer, with a timeout and backoff, and only for idempotent calls."], 0, 0.85, { width: 500, tone: "good" })
    .build();
}

export default [
  { id: "sidecar-mesh", name: "Sidecar mesh", build: sidecarMesh },
  { id: "mtls-call", name: "A call through the mesh", build: mtlsCall },
  { id: "ambient", name: "Ambient mode", build: ambient },
  { id: "retry-storm", name: "Retries multiply", build: retryStorm },
] satisfies DiagramSpec[];
