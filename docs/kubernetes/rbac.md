# Authentication, RBAC & ServiceAccounts

> Authentication answers "who are you?", RBAC answers "what may you do?", and ServiceAccounts are identities for apps rather than people.

## The idea in one minute

| Gate | Question | How |
| --- | --- | --- |
| 1. Authentication | Who is calling? | Certificates, tokens, OIDC (company SSO), cloud IAM |
| 2. Authorization | May they do this verb on this resource? | **RBAC** |
| 3. Admission | Is the request itself acceptable? | Policies and defaults (see *Pod Security & Admission*) |

Follow a real request on [Three gates](#diagram/three-gates).

## Real-life analogy

> [!TIP]
> **An office access card.** **Authentication** is the security guard checking your ID at the gate. **Authorization (RBAC)** is your access card: it opens the 3rd-floor door and the cafeteria, but not the server room. A **ServiceAccount** is a card issued to a delivery robot instead of a person.

## Authentication: humans

Kubernetes has **no user database**. It trusts an outside source to prove identity:

- **Client certificates** (common on local and kubeadm clusters; hard to revoke, so avoid them for real users).
- **OIDC** with your company login (Okta, Google Workspace, Microsoft Entra ID): the usual production setup.
- **Cloud IAM:** on EKS, your AWS IAM role is mapped to Kubernetes users and groups (EKS access entries).

## RBAC: the four objects

See [RBAC objects](#diagram/rbac-objects).

| Object | Scope | What it is | Analogy |
| --- | --- | --- | --- |
| **Role** | One namespace | A list of allowed actions | "Can open doors on floor 3" |
| **ClusterRole** | Whole cluster (or reusable) | Same, cluster-wide | "Can open the lobby door in every building" |
| **RoleBinding** | One namespace | Gives a Role (or ClusterRole) to someone in a namespace | Handing Priya a floor-3 card |
| **ClusterRoleBinding** | Whole cluster | Gives a ClusterRole everywhere | Handing someone a master key |

Rules are made of **verbs** (`get`, `list`, `watch`, `create`, `update`, `patch`, `delete`) on **resources** (`pods`, `deployments`, `secrets`…). RBAC only **adds** permissions: there's no "deny" rule. If nothing grants it, it's denied.

## FoodDash example: the delivery team

The delivery team may manage their apps in the `delivery` namespace and read logs, but not touch Secrets.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: app-developer, namespace: delivery }
rules:
  - apiGroups: ["apps"]
    resources: [deployments, statefulsets]
    verbs: [get, list, watch, create, update, patch]
  - apiGroups: [""]
    resources: [pods, pods/log, services, configmaps]
    verbs: [get, list, watch]
  - apiGroups: [""]
    resources: [pods/exec]
    verbs: [create]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: delivery-team-devs, namespace: delivery }
subjects:
  - kind: Group
    name: delivery-engineers          # group name from the company SSO
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: app-developer
  apiGroup: rbac.authorization.k8s.io
```

Check permissions any time:

```bash
kubectl auth can-i delete deployments -n delivery --as=priya@fooddash.in --as-group=delivery-engineers
kubectl auth can-i --list -n delivery
kubectl auth can-i list secrets -n fooddash --as=system:serviceaccount:fooddash:orders-api
```

Built-in ClusterRoles save typing: `view` (read-only, no Secrets), `edit`, `admin`, `cluster-admin` (everything; give out very rarely).

## ServiceAccounts: identities for pods

Some apps talk to the Kubernetes API themselves: Prometheus discovering pods to scrape, Argo CD applying manifests, a FoodDash tool that reads a ConfigMap at runtime. They need an identity and limited permissions. See [ServiceAccount tokens](#diagram/serviceaccount-token).

- Every pod runs as a ServiceAccount; if you don't choose, it's `default` in that namespace.
- Kubernetes mounts a **short-lived, audience-bound, auto-rotated token** into the pod. Client libraries pick it up automatically.
- Bind Roles to the ServiceAccount exactly like for humans: `kind: ServiceAccount` in `subjects`.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: orders-api, namespace: fooddash }
automountServiceAccountToken: false     # this app never calls the K8s API: don't give it a token
---
# in the Deployment's pod spec:
#   serviceAccountName: orders-api
```

ServiceAccounts are also the bridge to cloud permissions: on EKS, you link a ServiceAccount to an AWS IAM role so `orders-api` can read from S3 without any stored keys (see *Kubernetes on AWS (EKS)*).

## Watch out

> [!WARNING]
> - **`list` on Secrets reveals their contents**, not just their names. Treat `get`, `list` and `watch` on Secrets as equally sensitive.
> - `pods/exec` lets someone run commands inside a container, which often means they can read its secrets. Grant it carefully in production.
> - Anyone who can create pods in a namespace can mount any Secret in that namespace into a pod. Namespace boundaries matter.
> - Never give CI pipelines `cluster-admin`. Give them only what they deploy (or use GitOps so CI needs no cluster access at all).
> - One ServiceAccount per workload, never a shared `default` with extra permissions.

## Check your understanding

**Role vs ClusterRole?** A Role is namespaced; a ClusterRole is cluster-wide or a reusable template. A RoleBinding can grant a ClusterRole within one namespace.

**How do humans authenticate to Kubernetes?** There are no User objects. In production: OIDC with company SSO, or cloud IAM mapped to groups (EKS access entries). Certificates are fine for labs but hard to revoke.

**How would you give a pod read access to one ConfigMap?** A dedicated ServiceAccount, a Role with `get` on `configmaps` (optionally `resourceNames: [orders-config]`), and a RoleBinding to that ServiceAccount.
