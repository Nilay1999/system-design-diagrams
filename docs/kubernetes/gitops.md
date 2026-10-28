# GitOps & CI/CD with Argo CD

> With GitOps, Git holds the desired state of your cluster, and a tool inside the cluster (Argo CD or Flux) keeps pulling from Git and applying it, so a merge to `main` *is* a deployment.

## The idea in one minute

| Old way (push) | GitOps (pull) |
| --- | --- |
| CI holds cluster-admin credentials and runs `kubectl apply` | CI only builds images and commits a tag; the cluster pulls from Git |
| Manual `kubectl edit` goes unnoticed (drift) | Argo CD shows OutOfSync and can undo it |
| "What's running in prod?" is hard to answer | Look at the Git folder for prod |
| Rollback = rerun an old pipeline | Rollback = `git revert` |
| Disaster recovery = rerun dozens of pipelines | Point Argo CD at Git on a new cluster |

## Real-life analogy

> [!TIP]
> **The architect's blueprint.** A building site works from the **approved blueprint** (Git). Nobody knocks down a wall because someone shouted an instruction. If a worker builds something not on the blueprint, the site inspector (Argo CD) spots the difference and puts it back. To change the building, you get a new blueprint approved (a pull request).

It's the same reconciliation loop from *Why Kubernetes*, applied one level higher: Git is the spec, the cluster is the status.

## How it works for FoodDash

Two repositories, a common setup ([CI/CD pipeline](#diagram/pipeline)):

1. **App repo** (`orders-api`): source code. On merge, **CI** (GitHub Actions) builds and tests the code, builds the Docker image, scans it, pushes `fooddash/orders-api:1.5.0` to ECR, then opens a small commit in the config repo bumping the image tag.
2. **Config repo** (`fooddash-deploy`): Helm values or Kustomize overlays for every environment. **Argo CD** watches it and syncs changes into the cluster (**CD**).

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: orders-api-prod, namespace: argocd }
spec:
  project: default
  source:
    repoURL: https://github.com/fooddash/fooddash-deploy
    path: apps/orders-api/overlays/prod
    targetRevision: main
  destination:
    server: https://kubernetes.default.svc
    namespace: fooddash
  syncPolicy:
    automated:
      prune: true        # delete things removed from Git
      selfHeal: true     # undo manual changes in the cluster
```

Follow a deploy, a drift and a rollback on [Sync, drift, rollback](#diagram/sync-loop).

## What you get

| Benefit | How it shows up |
| --- | --- |
| Audit trail | Every change is a reviewed commit with an author and a reason |
| Easy rollback | `git revert` the bad commit; Argo CD applies the previous state |
| Drift detection | Argo CD's UI shows "OutOfSync" when the cluster differs from Git |
| Security | The cluster pulls from Git; CI never needs cluster credentials |
| Disaster recovery | Point Argo CD at Git on a new cluster and everything is recreated |
| Promotion | dev → staging → prod is just copying a tag between folders via PRs ([Promotion](#diagram/promotion)) |

## Argo CD vs Flux

Both are CNCF graduated projects and do the same core job. **Argo CD** has a polished web UI and is very widely used. **Flux** is lighter and more "Kubernetes-native", with no required UI. Pair either with **Argo Rollouts** or **Flagger** for automated canaries.

## Watch out

> [!WARNING]
> - Secrets still can't sit in Git as plain text. Use External Secrets, Sealed Secrets or SOPS.
> - With `selfHeal: true`, emergency `kubectl` fixes get reverted within minutes. That's the point; make the fix in Git.
> - Keep app code and deployment config in separate repos (or folders with separate pipelines), so a tag bump doesn't trigger a full rebuild loop.

## Check your understanding

**What is GitOps?** Git is the source of truth for desired state; an in-cluster agent (Argo CD, Flux) pulls and reconciles continuously, detects drift, and makes rollbacks a `git revert`. It's the reconciliation loop again, one level up.

**Why is pull-based deployment more secure?** CI no longer holds cluster credentials, so compromising CI doesn't directly compromise the cluster; the cluster only reads from Git.

**How do you roll back with GitOps?** Revert the commit in the config repo. `kubectl rollout undo` would be reverted by self-heal.
