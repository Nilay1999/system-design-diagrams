import { Diagram, type DiagramSpec } from "../dsl";

function flatNetwork() {
  return new Diagram("The flat pod network", "Every pod gets its own IP and can reach every other pod, on any node, without NAT. A CNI plugin builds it")
    .zone("Node 1 · pod CIDR 10.244.1.0/24", ["pa", "cni1"], "#0c8599")
    .zone("Node 2 · pod CIDR 10.244.2.0/24", ["pb", "cni2"], "#0c8599")
    .node("pa", "orders-api", 0, 0, "service", { detail: "10.244.1.5" })
    .node("cni1", "CNI agent (Calico / Cilium)", 0, 1.15, "worker", { detail: "routes 10.244.2.0/24 → node 2", icon: "network" })
    .node("pb", "payments-api", 2.2, 0, "service", { detail: "10.244.2.9" })
    .node("cni2", "CNI agent", 2.2, 1.15, "worker", { detail: "routes 10.244.1.0/24 → node 1", icon: "network" })
    .edge("pa", "pb", "src 10.244.1.5 → dst 10.244.2.9, no NAT")
    .edge("cni1", "cni2", "VXLAN, BGP or VPC routes", { both: true })
    .panel(
      "The three network rules",
      ["1. Every pod gets its own unique IP.", "2. Any pod can reach any other pod, even on another node, without NAT.", "3. Node agents (like the kubelet) can reach every pod on their node."],
      3.45,
      -0.1,
      { width: 360, tone: "info" },
    )
    .panel(
      "Common CNIs",
      ["AWS VPC CNI: real VPC IPs; watch subnet size", "Calico: BGP or overlay; strong policy support", "Cilium: eBPF; can replace kube-proxy", "Flannel: simple VXLAN; does NOT enforce NetworkPolicies"],
      3.45,
      1.15,
      { width: 360, tone: "neutral" },
    )
    .build();
}

function lockdown() {
  return new Diagram("Locking down the payments namespace", "Default deny, then allow only what's needed. Green arrows are allowed; the red one is what default-deny stops")
    .zone("namespace payments · default-deny (ingress + egress)", ["papi", "pg"], "#c2255c")
    .node("bank", "Bank API", 1.3, -0.95, "external", { detail: "egress 443 allowed for payments-api", icon: "landmark" })
    .node("oapi", "orders-api", 0, 0, "service", { detail: "ns fooddash" })
    .node("rapi", "restaurant-api (compromised)", 0, 1.45, "service", { detail: "ns fooddash", highlight: true })
    .node("papi", "payments-api", 1.3, 0.5, "service")
    .node("pg", "payments-postgres", 2.6, 0.5, "db", { icon: "postgres" })
    .node("dns", "CoreDNS", 2.6, 2.05, "worker", { detail: "kube-system", icon: "globe" })
    .edge("oapi", "papi", "8080 allowed", { color: "#2f9e44" })
    .edge("papi", "pg", "5432 allowed", { color: "#2f9e44" })
    .edge("papi", "bank", "443", { color: "#2f9e44" })
    .edge("papi", "dns", "53 allowed", { color: "#2f9e44" })
    .edge("rapi", "pg", "blocked", { color: "#e03131" })
    .panel(
      "Policies in this namespace",
      ["1. default-deny: podSelector {} with policyTypes Ingress + Egress", "2. postgres-from-payments-api: ingress 5432 only from app=payments-api", "3. allow-dns: egress UDP+TCP 53 to kube-dns", "4. orders → payments-api 8080, payments-api → bank 443"],
      3.9,
      -0.1,
      { width: 400, tone: "info" },
    )
    .panel("Forget rule 3 and…", ["every lookup fails with 'unknown host', and every error looks like a networking bug."], 3.9, 1.35, { width: 400, tone: "bad" })
    .build();
}

function andVsOr() {
  return new Diagram("One dash changes the meaning", "namespaceSelector and podSelector in one list item = AND. As two items = OR")
    .table("and", "AND: one list item", ["from:", "  - namespaceSelector:", "      matchLabels: { team: orders }", "    podSelector:", "      matchLabels: { app: orders-api }"], 0, 0, {
      kind: "object",
    })
    .table("or", "OR: two list items", ["from:", "  - namespaceSelector:", "      matchLabels: { team: orders }", "  - podSelector:", "      matchLabels: { app: orders-api }"], 1.7, 0, {
      kind: "object",
    })
    .panel("Allows", ["orders-api pods that are in team=orders namespaces. Only those."], 0, 1.35, { width: 360, tone: "good" })
    .panel("Allows", ["ANY pod in team=orders namespaces, plus orders-api pods in this namespace. Much wider than intended."], 1.7, 1.35, {
      width: 360,
      tone: "bad",
    })
    .build();
}

export default [
  { id: "flat-network", name: "The flat network", build: flatNetwork },
  { id: "lockdown", name: "Payments lockdown", build: lockdown },
  { id: "and-vs-or", name: "AND vs OR selectors", build: andVsOr },
] satisfies DiagramSpec[];
