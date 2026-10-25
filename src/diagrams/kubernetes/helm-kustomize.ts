import { Diagram, type DiagramSpec } from "../dsl";

function helmRender() {
  return new Diagram("How Helm works", "A chart is templates plus default values. Helm fills them in, applies the result, and remembers each release so it can roll back")
    .zone("Chart orders-api/", ["tpl", "values"], "#1971c2")
    .node("tpl", "templates/", 0, 0, "object", { detail: "deployment.yaml, service.yaml, hpa.yaml with {{ .Values.* }}", icon: "file" })
    .node("values", "values.yaml", 0, 1.1, "object", { detail: "defaults: replicaCount 2, image tag", icon: "list-checks" })
    .node("prod", "values-prod.yaml + --set", 0, 2.4, "client", { detail: "replicaCount 6, tag 1.5.1", icon: "file" })
    .node("helm", "helm upgrade --install", 1.4, 1.1, "control", { detail: "render templates with merged values", icon: "terminal" })
    .node("yaml", "Plain manifests", 2.7, 1.1, "object", { detail: "what helm template would print", icon: "files" })
    .node("api", "API server", 4, 1.1, "control")
    .node("hist", "Release history", 2.7, 2.4, "db", { detail: "revisions stored as Secrets in the namespace" })
    .edge("tpl", "helm")
    .edge("values", "helm")
    .edge("prod", "helm", "overrides win")
    .edge("helm", "yaml")
    .edge("yaml", "api", "apply")
    .edge("helm", "hist", "record revision")
    .panel("Form-letter analogy", ["“Dear {{name}}, your order of {{item}} ships on {{date}}.” One template, many letters, and Helm remembers each one it sent so it can recall it (rollback)."], 4, -0.2, {
      width: 330,
      tone: "warn",
    })
    .build();
}

function kustomizeOverlays() {
  return new Diagram("How Kustomize works", "Keep plain YAML in a base; each environment is an overlay of small patches on top. Built into kubectl")
    .zone("base/", ["base"], "#2f9e44")
    .zone("overlays/", ["stg", "prod"], "#9c36b5")
    .node("base", "base", 0, 1, "object", { detail: "deployment.yaml, service.yaml, kustomization.yaml", icon: "files" })
    .node("stg", "staging", 1.4, 0.4, "object", { detail: "replicas 2, LOG_LEVEL=debug", icon: "file" })
    .node("prod", "prod", 1.4, 1.6, "object", { detail: "replicas 6, image tag 1.5.0, namespace fooddash", icon: "file" })
    .node("out1", "kubectl apply -k overlays/staging", 2.8, 0.4, "client", { icon: "terminal" })
    .node("out2", "kubectl apply -k overlays/prod", 2.8, 1.6, "client", { icon: "terminal" })
    .edge("base", "stg", "resources: [../../base]")
    .edge("base", "prod")
    .edge("stg", "out1")
    .edge("prod", "out2")
    .panel("Photocopy analogy", ["Keep the original document untouched and stick notes on each copy: “Mumbai: change the phone number.”"], 0, 2.65, {
      width: 360,
      tone: "warn",
    })
    .panel("Handy generators", ["configMapGenerator adds a content hash to the name, so a config change triggers a rollout automatically."], 1.4, 2.65, {
      width: 360,
      tone: "info",
    })
    .build();
}

function whichOne() {
  return new Diagram("Helm or Kustomize?", "Many teams use both, delivered through Argo CD", { icons: false })
    .node("q", "What are you deploying?", 1.2, 0, "object")
    .node("third", "Third-party software", 0, 1.2, "client", { detail: "Prometheus, cert-manager, Karpenter, Argo CD" })
    .node("own", "Your own services", 2.4, 1.2, "client", { detail: "orders-api, payments-api" })
    .node("helm", "Helm chart from its repo", 0, 2.45, "service", { detail: "pin the chart version; keep values in Git" })
    .node("kust", "Kustomize, or one simple shared chart", 2.4, 2.45, "service", { detail: "env differences as overlays or values files" })
    .edge("q", "third")
    .edge("q", "own")
    .edge("third", "helm")
    .edge("own", "kust")
    .panel(
      "Side by side",
      ["Style: templates with loops and conditions vs plain YAML + patches", "Learning curve: moderate vs gentle", "Release history and rollback: yes vs Git is your history", "Sharing with other teams: excellent vs weaker"],
      3.7,
      0,
      { width: 400, tone: "info" },
    )
    .build();
}

export default [
  { id: "helm-render", name: "How Helm works", build: helmRender },
  { id: "kustomize-overlays", name: "How Kustomize works", build: kustomizeOverlays },
  { id: "which-one", name: "Which one?", build: whichOne },
] satisfies DiagramSpec[];
