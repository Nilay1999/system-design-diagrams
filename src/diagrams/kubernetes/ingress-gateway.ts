import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function northSouth() {
  return new Diagram("North-south traffic", "One public entry point fans out by hostname and path. Everything behind it stays a private ClusterIP Service")
    .zone("Private: ClusterIP Services", ["orders", "menus", "track"], "#2f9e44")
    .node("user", "FoodDash app", 0, 1, "client", { icon: "smartphone" })
    .node("lb", "Cloud load balancer", 1.1, 1, "edge", { detail: "the only public IP", icon: "split" })
    .node("gw", "Gateway (Envoy pods)", 2.25, 1, "edge", { detail: "TLS for api.fooddash.in, routing rules" })
    .node("orders", "orders-api", 3.55, 0, "edge", { detail: "/orders" })
    .node("menus", "restaurant-api", 3.55, 1, "edge", { detail: "/menus" })
    .node("track", "delivery-tracker", 3.55, 2, "edge", { detail: "/track" })
    .node("cert", "cert-manager", 2.25, 2.4, "worker", { detail: "issues and renews TLS from Let's Encrypt", icon: "lock" })
    .edge("user", "lb", "HTTPS")
    .edge("lb", "gw")
    .edge("gw", "orders", "/orders")
    .edge("gw", "menus", "/menus")
    .edge("gw", "track", "/track")
    .edge("cert", "gw", "Secret fooddash-tls")
    .panel("Mall reception analogy", ["One main entrance and a reception desk: 'Food court? Second floor, left.' Shops don't each need their own street door."], 0, 2.3, {
      width: 330,
      tone: "warn",
    })
    .build();
}

function gatewayRoles() {
  return new Diagram("Gateway API splits the job by role", "The orders team changes its own routes without touching the shared entrance, and without platform-team tickets")
    .zone("Vendor", ["gc"], "#868e96")
    .zone("Platform team · ns infra", ["gw"], "#3b5bdb")
    .zone("App teams · their own namespaces", ["r1", "r2"], "#c2255c")
    .node("gc", "GatewayClass envoy", 0, 0.55, "object", { detail: "which implementation" })
    .node("gw", "Gateway public-gateway", 1.3, 0.55, "object", { detail: "listeners: ports, hostnames, TLS" })
    .node("r1", "HTTPRoute orders", 2.65, 0, "object", { detail: "ns fooddash · /orders, weights 95/5" })
    .node("r2", "HTTPRoute menus", 2.65, 1.1, "object", { detail: "ns restaurants · /menus" })
    .node("s1", "Service orders-api", 3.95, 0, "edge")
    .node("s2", "Service restaurant-api", 3.95, 1.1, "edge")
    .edge("gw", "gc", "gatewayClassName")
    .edge("r1", "gw", "parentRefs")
    .edge("r2", "gw", "parentRefs")
    .edge("r1", "s1", "backendRefs")
    .edge("r2", "s2", "backendRefs")
    .panel(
      "Why it replaced Ingress",
      ["Ingress covers basic host/path routing; anything more (rewrites, weights, timeouts) needs vendor-specific annotations.", "Gateway API has header matching, weights, redirects and mirroring built in, plus GRPCRoute."],
      0,
      2.15,
      { width: 560, tone: "info" },
    )
    .build();
}

function requestFlow() {
  return new Sequence("A request through the Gateway", "GET https://api.fooddash.in/orders/42 from the mobile app")
    .actor("app", "Mobile app", "client", { icon: "smartphone" })
    .actor("lb", "Cloud LB", "edge", { icon: "split" })
    .actor("gw", "Gateway (Envoy)", "edge")
    .actor("svc", "orders-api Service", "edge")
    .actor("pod", "orders-api pod", "service")
    .msg("app", "lb", "TLS ClientHello, SNI api.fooddash.in")
    .msg("lb", "gw", "forward TCP (or terminate here, depending on setup)")
    .msg("gw", "gw", "terminate TLS with the cert-manager certificate")
    .msg("gw", "gw", "match host api.fooddash.in + PathPrefix /orders → HTTPRoute orders")
    .msg("gw", "gw", "pick a backend by weight: orders-api (95) vs orders-api-canary (5)")
    .msg("gw", "pod", "HTTP to a Ready pod IP from the EndpointSlice (most gateways skip the ClusterIP hop)")
    .msg("pod", "gw", "200 {order 42}", { reply: true })
    .msg("gw", "app", "200 over TLS", { reply: true })
    .note("PathPrefix /orders matches /orders/42 but not /ordersummary. Path rules are a common source of 404s.", ["app", "pod"], "warn")
    .build();
}

function canaryWeights() {
  return new Diagram("Canary releases with route weights", "Send 5% to the new version, watch the metrics, then move up or roll back automatically")
    .node("gw", "Gateway", 0, 1, "edge")
    .node("route", "HTTPRoute orders", 1.15, 1, "object", { detail: "backendRefs weights 95 / 5" })
    .node("stable", "orders-api v1.4", 2.4, 0.35, "service", { detail: "95%" })
    .node("canary", "orders-api-canary v1.5", 2.4, 1.65, "service", { detail: "5%" })
    .node("prom", "Prometheus", 3.65, 1.65, "external", { detail: "error rate, p99 latency" })
    .node("rollout", "Argo Rollouts / Flagger", 3.65, 0.35, "control", { detail: "5% → 25% → 50% → 100%, or roll back", icon: "workflow" })
    .edge("gw", "route")
    .edge("route", "stable", "95%")
    .edge("route", "canary", "5%")
    .edge("canary", "prom", "metrics", { async: true })
    .edge("prom", "rollout", "analysis")
    .edge("rollout", "route", "edit weights", { via: [[3.65, -0.55], [1.15, -0.55]] })
    .panel("Header routing too", ["Send beta testers with x-beta: true to the new version: a matches rule on headers, no weights needed."], 0, 2.4, {
      width: 380,
      tone: "info",
    })
    .build();
}

export default [
  { id: "north-south", name: "North-south traffic", build: northSouth },
  { id: "gateway-roles", name: "Gateway API roles", build: gatewayRoles },
  { id: "request-flow", name: "Request flow", build: requestFlow },
  { id: "canary-weights", name: "Canary by weight", build: canaryWeights },
] satisfies DiagramSpec[];
