# Packaging: Helm & Kustomize

> Helm turns your YAML into a reusable template with settings you fill in per environment; Kustomize keeps plain YAML and layers small patches on top.

## The idea in one minute

|  | Helm | Kustomize |
| --- | --- | --- |
| Style | Templates with variables, loops, conditions | Plain YAML + patches |
| Learning curve | Moderate (Go templates get messy) | Gentle |
| Release history and rollback | Yes | No (Git is your history) |
| Sharing with other teams/companies | Excellent (chart repositories) | Weaker |
| Typical use | Third-party software; reusable internal charts | Your own apps' environment differences |

## Real-life analogy

> [!TIP]
> - **Helm** is a **form letter**: "Dear {{name}}, your order of {{item}} ships on {{date}}." One template, many letters. Helm also tracks every letter it sent, so it can recall one (rollback).
> - **Kustomize** is a **photocopy with sticky notes**: you keep the original document untouched and stick notes on the copy for each branch: "Mumbai: change the phone number."

## The problem they solve

FoodDash's `orders-api` needs a Deployment, Service, HPA, PDB, ConfigMap, ServiceAccount and HTTPRoute: seven files. Multiply by 3 environments and 10 services, and you have 210 nearly identical files. Copy-paste means prod and staging drift apart, and a fix in one place is forgotten in another.

## Helm

A **chart** is a folder of templates plus default values. Helm merges your values over the defaults, renders the templates, applies the result, and records a numbered **release revision** ([How Helm works](#diagram/helm-render)).

```text
orders-api/
  Chart.yaml            # name, version
  values.yaml           # default settings
  values-prod.yaml      # prod overrides
  templates/
    deployment.yaml
    service.yaml
    hpa.yaml
```

```yaml
# templates/deployment.yaml (excerpt)
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          resources: {{- toYaml .Values.resources | nindent 12 }}
```

```yaml
# values-prod.yaml
replicaCount: 6
image: { repository: fooddash/orders-api, tag: "1.5.0" }
resources:
  requests: { cpu: 500m, memory: 1Gi }
  limits:   { memory: 1Gi }
```

```bash
helm install orders-api ./orders-api -n fooddash -f values-prod.yaml
helm upgrade orders-api ./orders-api -n fooddash -f values-prod.yaml --set image.tag=1.5.1
helm history orders-api -n fooddash
helm rollback orders-api 3 -n fooddash
helm template ./orders-api -f values-prod.yaml     # show the final YAML without installing
```

Helm's biggest everyday use is **installing other people's software**. Prometheus, Grafana, Redis, cert-manager, Argo CD and Karpenter all ship as charts.

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
```

## Kustomize

Built into `kubectl`. No template language: plain YAML plus overlays ([How Kustomize works](#diagram/kustomize-overlays)).

```text
k8s/
  base/
    deployment.yaml
    service.yaml
    kustomization.yaml
  overlays/
    staging/kustomization.yaml
    prod/
      kustomization.yaml
      replicas-patch.yaml
```

```yaml
# overlays/prod/kustomization.yaml
resources: [../../base]
namespace: fooddash
images:
  - name: fooddash/orders-api
    newTag: "1.5.0"
patches:
  - path: replicas-patch.yaml
configMapGenerator:
  - name: orders-config
    literals: [LOG_LEVEL=info]      # adds a hash to the name, so changes trigger a rollout
```

```bash
kubectl apply -k overlays/prod
kubectl kustomize overlays/prod      # preview
```

## Which one?

Many teams use **both**: Helm for third-party tools, Kustomize (or one simple shared Helm chart) for their own services, all deployed through Argo CD. See [Which one?](#diagram/which-one).

## Watch out

> [!WARNING]
> - Never put real secrets in `values.yaml` committed to Git.
> - Helm templates with deep `if`/`range` logic become hard to read. Keep charts simple; one chart per service, or one shared chart for all similar services.
> - Always run `helm template` or `helm diff` before upgrading production, to see exactly what will change.
> - Pin third-party chart versions, and read their changelogs before bumping them.

## Interview questions

**Helm vs Kustomize?** Helm is a templating and packaging tool with releases and rollbacks, good for distributing software. Kustomize patches plain YAML with overlays and is built into kubectl. Many teams use Helm for third-party charts and Kustomize or a simple chart for their own, delivered through Argo CD.

**How does Helm roll back?** Each upgrade is stored as a numbered revision (as a Secret in the namespace); `helm rollback` re-applies an earlier revision's rendered manifests.

**How do you make a config change restart pods automatically?** A checksum of the ConfigMap in a pod annotation (Helm), or `configMapGenerator`, which puts a content hash in the ConfigMap's name (Kustomize).
