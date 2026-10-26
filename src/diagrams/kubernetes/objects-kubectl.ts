import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function objectAnatomy() {
  return new Diagram("Anatomy of every Kubernetes object", "Four parts in every YAML file. spec is your wish; status is reality; controllers spend their life making them match")
    .table(
      "yaml",
      "orders-api.yaml",
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: orders-api",
        "  namespace: fooddash",
        "  labels: { app: orders-api }",
        "spec:                 # you write",
        "  replicas: 3",
        "  template: …",
        "status:               # K8s writes",
        "  replicas: 3",
        "  readyReplicas: 2",
      ],
      0,
      0,
      { kind: "object" },
    )
    .panel("apiVersion + kind", ["Which API group and version, and what type of thing this is. kubectl api-resources lists them all."], 1.75, -0.15, { width: 340 })
    .panel("metadata", ["Identity: name (unique within the namespace), namespace, labels for selecting, annotations for tools."], 1.75, 0.55, { width: 340, tone: "info" })
    .panel("spec — desired state", ["What you want. You write it, it lives in Git, and kubectl apply sends it."], 1.75, 1.25, { width: 340, tone: "good" })
    .panel("status — actual state", ["What exists now. Written only by Kubernetes. readyReplicas 2 of 3 means a controller is still closing the gap."], 1.75, 1.95, {
      width: 340,
      tone: "warn",
    })
    .build();
}

function imperativeDeclarative() {
  return new Sequence("Declarative vs imperative", "apply is idempotent: run it 100 times, get the same result. But changes made only in the cluster get undone")
    .actor("you", "You", "client")
    .actor("git", "Git repo (YAML)", "object", { icon: "git-branch" })
    .actor("api", "API server", "control")
    .phase("Declarative: describe the result")
    .msg("you", "git", "commit orders-api.yaml (replicas: 3)")
    .msg("you", "api", "kubectl apply -f orders-api.yaml")
    .msg("api", "you", "deployment.apps/orders-api created", { reply: true })
    .msg("you", "api", "kubectl apply -f orders-api.yaml  (again, nothing changed)")
    .msg("api", "you", "deployment.apps/orders-api unchanged", { reply: true })
    .msg("you", "api", "kubectl diff -f orders-api.yaml  (preview a change before applying)")
    .phase("The drift trap")
    .msg("you", "api", "kubectl scale deploy/orders-api --replicas=5  (emergency, not in Git)", { error: true })
    .msg("api", "api", "replicas = 5")
    .msg("git", "api", "next apply or GitOps sync: replicas: 3", { async: true })
    .msg("api", "api", "back to 3: the emergency fix is silently undone", { error: true })
    .note("Git must stay the truth. Imperative commands are fine for experiments and emergencies, then update the YAML.", ["you", "api"], "warn")
    .build();
}

function labelsSelectors() {
  return new Diagram("Labels and selectors: the glue", "Pods have random names, so objects find each other by labels. Every arrow here is a label query")
    .node("svc", "Service orders-api", 0, 0.4, "edge", { detail: "selector: app=orders-api" })
    .node("rs", "ReplicaSet", 0, 1.55, "object", { detail: "selector: app=orders-api, wants 2" })
    .node("np", "NetworkPolicy", 0, 2.75, "object", { detail: "podSelector: app=payments-api" })
    .node("p1", "orders-api-7d9f8-x2k4q", 2, 0, "service", { detail: "app=orders-api, env=prod", icon: "box" })
    .node("p2", "orders-api-7d9f8-m81zp", 2, 1, "service", { detail: "app=orders-api, env=prod", icon: "box" })
    .node("p3", "orders-api-7d9f8-q7c3d", 2, 2, "service", { detail: "label removed (app-), debug=true", highlight: true, icon: "box" })
    .node("p4", "payments-api-55c6f-z9k2", 2, 3, "service", { detail: "app=payments-api" })
    .edge("svc", "p1", "traffic")
    .edge("svc", "p2")
    .edge("rs", "p1", "counts")
    .edge("rs", "p2")
    .edge("np", "p4", "firewall applies")
    .panel(
      "Who uses selectors",
      ["Service → the pods that get its traffic", "Deployment / ReplicaSet → the pods it owns and counts", "NetworkPolicy → the pods a rule applies to", "Affinity rules → pods to sit near or away from", "You → kubectl get pods -l app=orders-api,env=prod"],
      3.2,
      -0.1,
      { width: 360, tone: "info" },
    )
    .panel(
      "Debug trick: quarantine a sick pod",
      [
        "kubectl label pod orders-api-7d9f8-q7c3d app-",
        "The Service stops sending it traffic, the ReplicaSet stops counting it and starts a fresh replacement, and the sick pod stays around for you to debug.",
      ],
      3.2,
      1.45,
      { width: 360, tone: "warn" },
    )
    .panel("The #1 typo", ["A Service selecting app: order-api (missing s) matches zero pods. Everything looks green; every request fails."], 3.2, 2.65, {
      width: 360,
      tone: "bad",
    })
    .build();
}

function namespaces() {
  return new Diagram("Namespaces: rooms inside one cluster", "Names are unique per namespace. Permissions, quotas and network rules attach here, but namespaces are not a network wall")
    .zone("namespace: payments", ["pay", "pg", "payRbac", "payQuota"], "#c2255c")
    .zone("namespace: delivery", ["dt", "redis", "dRbac", "dNp"], "#2f9e44")
    .zone("namespace: kube-system", ["dns", "kp"], "#495057")
    .node("pay", "payments-api", 0, 0, "service")
    .node("pg", "payments-postgres", 1, 0, "db", { icon: "postgres" })
    .node("payRbac", "RoleBinding", 0, 1.1, "object", { detail: "payments-team may edit here", icon: "lock" })
    .node("payQuota", "ResourceQuota", 1, 1.1, "object", { detail: "at most 20 CPU, 40 Gi", icon: "gauge" })
    .node("dt", "delivery-tracker", 2.35, 0, "service")
    .node("redis", "Redis", 3.35, 0, "cache")
    .node("dRbac", "RoleBinding", 2.35, 1.1, "object", { detail: "delivery-engineers may edit here", icon: "lock" })
    .node("dNp", "NetworkPolicy", 3.35, 1.1, "object", { detail: "who may talk to these pods", icon: "shield" })
    .node("dns", "CoreDNS", 4.7, 0, "worker", { icon: "globe" })
    .node("kp", "metrics-server", 4.7, 1.1, "worker", { icon: "gauge" })
    .edge("dt", "pg", "can connect by default!", { color: "#e03131" })
    .panel(
      "Cluster-wide objects have no namespace",
      ["Nodes, PersistentVolumes, StorageClasses, ClusterRoles, CRDs, and Namespaces themselves.", "List them with: kubectl api-resources --namespaced=false"],
      0,
      2.35,
      { width: 520, tone: "info" },
    )
    .panel("Common layouts", ["One namespace per team (payments, delivery), per app, or per environment (dev, staging).", "Many companies keep prod in a separate cluster: namespaces share nodes and the control plane."], 1.8, 2.35, {
      width: 520,
      tone: "warn",
    })
    .build();
}

export default [
  { id: "object-anatomy", name: "Object anatomy", build: objectAnatomy },
  { id: "imperative-declarative", name: "Declarative vs imperative", build: imperativeDeclarative },
  { id: "labels-selectors", name: "Labels & selectors", build: labelsSelectors },
  { id: "namespaces", name: "Namespaces", build: namespaces },
] satisfies DiagramSpec[];
