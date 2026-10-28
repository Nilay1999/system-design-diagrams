import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function pipeline() {
  return new Diagram("CI builds, Git decides, Argo CD deploys", "Two repositories. CI never holds cluster credentials: the cluster pulls from Git")
    .zone("CI (GitHub Actions)", ["ci"], "#1971c2")
    .zone("Inside the cluster", ["argo", "k8s"], "#326ce5")
    .node("dev", "Developer", 0, 0, "client")
    .node("app", "App repo orders-api", 1.2, 0, "object", { detail: "source code + Dockerfile", icon: "git-branch" })
    .node("ci", "Build, test, scan, push", 2.45, 0, "worker", { detail: "Trivy scan, image fooddash/orders-api:1.5.0" })
    .node("ecr", "Amazon ECR", 3.7, 0, "storage", { icon: "package" })
    .node("cfg", "Config repo fooddash-deploy", 2.45, 1.45, "object", { detail: "Helm values / Kustomize overlays per environment", icon: "git-branch" })
    .node("argo", "Argo CD", 2.45, 2.85, "control", { detail: "watches Git, syncs the cluster", icon: "refresh" })
    .node("k8s", "Cluster", 3.7, 2.85, "service", { icon: "kubernetes" })
    .edge("dev", "app", "merge PR")
    .edge("app", "ci", "trigger")
    .edge("ci", "ecr", "push image")
    .edge("ci", "cfg", "commit: bump tag to 1.5.0")
    .edge("argo", "cfg", "pull", { async: true })
    .edge("argo", "k8s", "apply")
    .edge("k8s", "ecr", "pull image", { async: true })
    .panel("Blueprint analogy", ["A building site works only from the approved blueprint (Git). If someone builds something not on it, the inspector (Argo CD) spots the difference and puts it back."], 0, 1.3, {
      width: 360,
      tone: "warn",
    })
    .build();
}

function syncLoop() {
  return new Sequence("Sync, drift and rollback", "The reconciliation loop again, one level up: Git is the spec, the cluster is the status")
    .actor("you", "Engineer", "client")
    .actor("git", "Config repo", "object", { icon: "git-branch" })
    .actor("argo", "Argo CD", "control", { icon: "refresh" })
    .actor("k8s", "Cluster", "service", { icon: "kubernetes" })
    .phase("Deploy = merge")
    .msg("you", "git", "merge PR: orders-api tag 1.5.0")
    .msg("argo", "git", "poll / webhook: new commit")
    .msg("argo", "k8s", "diff → OutOfSync → apply → Synced, Healthy")
    .phase("Drift")
    .msg("you", "k8s", "kubectl edit deploy orders-api (replicas 10, a 'quick fix')", { error: true })
    .msg("argo", "k8s", "OutOfSync detected → selfHeal: back to what Git says")
    .phase("Rollback = revert")
    .msg("you", "git", "git revert the bad commit")
    .msg("argo", "k8s", "apply the previous state")
    .note("prune: true deletes objects removed from Git; selfHeal: true undoes manual changes. Emergency fixes must go through Git, or they're reverted within minutes.", ["you", "k8s"], "warn")
    .build();
}

function promotion() {
  return new Diagram("Promotion through environments", "dev → staging → prod is just copying an image tag between folders, by pull request", { icons: false })
    .node("dev", "overlays/dev", 0, 0, "object", { detail: "tag 1.5.1 · auto-synced on every CI build" })
    .node("stg", "overlays/staging", 1.35, 0, "object", { detail: "tag 1.5.0 · PR approved by the team" })
    .node("prod", "overlays/prod", 2.7, 0, "object", { detail: "tag 1.4.2 · PR + change approval", highlight: false })
    .edge("dev", "stg", "PR: copy tag")
    .edge("stg", "prod", "PR: copy tag")
    .panel(
      "What GitOps gives you",
      [
        "Audit trail: every change is a reviewed commit with an author",
        "Easy rollback: git revert",
        "Drift detection: Argo CD shows OutOfSync",
        "Security: CI needs no cluster credentials",
        "Disaster recovery: point Argo CD at Git on a new cluster",
      ],
      0,
      0.85,
      { width: 560, tone: "good" },
    )
    .panel("Argo CD vs Flux", ["Both CNCF graduated. Argo CD: polished UI, very widely used. Flux: lighter, no required UI. Pair with Argo Rollouts or Flagger for canaries."], 1.85, 0.85, {
      width: 380,
      tone: "info",
    })
    .build();
}

export default [
  { id: "pipeline", name: "CI/CD pipeline", build: pipeline },
  { id: "sync-loop", name: "Sync, drift, rollback", build: syncLoop },
  { id: "promotion", name: "Promotion", build: promotion },
] satisfies DiagramSpec[];
