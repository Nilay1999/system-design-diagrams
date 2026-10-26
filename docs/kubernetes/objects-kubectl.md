# Objects, kubectl, Namespaces & Labels

> You describe what you want in YAML files, and `kubectl` sends them to the API server. Namespaces divide a cluster into rooms; labels are sticky notes on objects; selectors find objects by their sticky notes.

## The idea in one minute

| Concept | One line |
| --- | --- |
| Object | A record of intent stored in etcd: a Deployment, a Service, a ConfigMap |
| Manifest | A YAML file describing one or more objects |
| `spec` / `status` | What you want / what exists now |
| `kubectl apply` | Create or update objects from files; safe to run again and again |
| Namespace | A named scope for names, permissions, quotas and network rules |
| Label / selector | Key-value tags on objects / queries that find objects by tag |
| Annotation | Extra notes for tools; never used for selecting |

## Declarative vs imperative

> [!TIP]
> **Real-life analogy: ordering food.** **Imperative** is cooking yourself, step by step: "chop onions, heat oil, add spices." If you're interrupted halfway, things are messy. **Declarative** is ordering from a menu: "one paneer tikka, medium spicy." You say *what* you want; the kitchen figures out *how*, and if they burn it, they make another one without you asking.

If FoodDash's production setup lived in people's terminal history ("I think Rahul scaled it to 5 last week?"), nobody would know the true state. YAML files in Git are the single truth: reviewable in pull requests, versioned, and repeatable in any cluster.

| Style | Example | Use it for |
| --- | --- | --- |
| Imperative command | `kubectl create deployment orders-api --image=fooddash/orders-api:1.4` | Quick experiments, exams |
| Imperative command | `kubectl scale deployment orders-api --replicas=5` | Emergencies (then update Git!) |
| Declarative | `kubectl apply -f orders-api.yaml` | Everything real. Run it 100 times; the result is the same |
| Declarative (folder) | `kubectl apply -f k8s/` | Applying a whole app |

`apply` is **idempotent**: if nothing changed, nothing happens; if you changed one line, only that line is updated. It's the same idea as making an API endpoint safe to retry. The [Declarative vs imperative](#diagram/imperative-declarative) diagram shows both the happy path and the drift trap.

## Anatomy of every object

Every YAML file has the same four parts. Once you see this, all objects look familiar ([Object anatomy](#diagram/object-anatomy)).

```yaml
apiVersion: apps/v1          # which API group and version this object belongs to
kind: Deployment             # what type of thing this is
metadata:                    # identity: name, namespace, labels
  name: orders-api
  namespace: fooddash
  labels:
    app: orders-api
spec:                        # WHAT YOU WANT (desired state) - you write this
  replicas: 3
  # ...
# status:                    # WHAT EXISTS NOW (actual state) - Kubernetes writes this
#   readyReplicas: 3
```

`spec` is your wish; `status` is reality. Controllers spend their whole life making `status` match `spec`.

## kubectl basics you'll use every day

```bash
kubectl get pods                         # list
kubectl get pods -o wide                 # + node and IP
kubectl get deploy,svc -n fooddash       # several types, one namespace
kubectl describe pod orders-api-7d9f     # details + recent events (your best friend)
kubectl logs orders-api-7d9f -f          # follow logs
kubectl exec -it orders-api-7d9f -- sh   # shell inside the container
kubectl apply -f orders-api.yaml         # create or update
kubectl delete -f orders-api.yaml        # remove
kubectl diff -f orders-api.yaml          # preview what apply would change
kubectl explain deployment.spec.strategy # built-in docs for any field
```

> [!TIP]
> Never write YAML from a blank page. Generate it, then edit:
> `kubectl create deployment orders-api --image=fooddash/orders-api:1.4 --dry-run=client -o yaml > orders-api.yaml`

### kubeconfig and contexts

`kubectl` reads `~/.kube/config` to know **which cluster** to talk to and **who you are**. A *context* = cluster + user + default namespace.

```bash
kubectl config get-contexts
kubectl config use-context fooddash-prod     # careful!
kubectl config set-context --current --namespace=fooddash
```

## Namespaces

> [!TIP]
> **Real-life analogy: an office building with a floor per team.** Each floor has its own meeting room called "Room A", and nobody gets confused, because "Room A on floor 3" is different from "Room A on floor 5". Each floor can also have its own access-card rules and its own budget.

FoodDash has a payments team, a delivery team and a data team on one cluster. Without separation, the delivery team could accidentally delete `payments-api`, or a runaway data job could eat all the cluster's memory.

A namespace is a named scope. Names must be unique *within* a namespace, not across the cluster. Namespaces are where you attach ([Namespaces](#diagram/namespaces)):

- **RBAC permissions:** "delivery team can edit only the `delivery` namespace" (see *Authentication, RBAC & ServiceAccounts*)
- **ResourceQuotas:** "the `data` namespace may use at most 40 CPUs" (see *Requests, Limits & QoS*)
- **NetworkPolicies:** "nothing outside `payments` may talk to its database" (see *Pod Networking & NetworkPolicies*)

```bash
kubectl create namespace payments
kubectl get pods -n payments
kubectl get pods -A                     # all namespaces
```

Built-in namespaces: `default` (where things go if you don't say), `kube-system` (Kubernetes' own components like CoreDNS), `kube-public`, `kube-node-lease` (node heartbeats).

Common layouts: one namespace per team, per app, or per environment. Many companies keep **prod in a separate cluster** entirely, because namespaces share the same nodes and control plane.

## Labels and selectors

> [!TIP]
> **Real-life analogy: a warehouse with sticky notes.** Every box has notes like `fragile`, `city=mumbai`, `express`. A worker can say "bring me every box marked `city=mumbai` AND `express`" without knowing box numbers.

Pods come and go with random names like `orders-api-7d9f8-x2k4q`. You can't track them by name, so labels give a stable way to group them.

```yaml
metadata:
  name: orders-api-7d9f8-x2k4q
  labels:
    app: orders-api
    team: orders
    env: prod
    version: "1.4.2"
```

A **selector** is a query over labels. It's how Kubernetes objects find each other, the glue of the whole system ([Labels & selectors](#diagram/labels-selectors)):

| Who uses selectors | To find what |
| --- | --- |
| Service | The pods that should receive its traffic |
| Deployment / ReplicaSet | The pods it owns and counts |
| NetworkPolicy | The pods a firewall rule applies to |
| Pod affinity rules | Pods to sit near or away from |
| You, in kubectl | `kubectl get pods -l app=orders-api,env=prod` |

```bash
kubectl get pods -l app=orders-api
kubectl get pods -l 'env in (staging, prod)'
kubectl get pods -l app=orders-api --show-labels
kubectl label pod orders-api-7d9f8-x2k4q debug=true
```

> [!NOTE]
> **Real FoodDash trick.** A pod is misbehaving and you want to investigate without killing it. Remove its `app` label: `kubectl label pod orders-api-7d9f8-x2k4q app-`. The Service stops sending it traffic, and the Deployment no longer counts it, so it creates a fresh replacement. The sick pod stays around for you to debug.

## Annotations

Sticky notes are for sorting; a long note taped to the box ("delivered by Ravi, call before 6 PM") is for information. Annotations hold extra data that **tools** read, and are never used for selecting:

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    kubernetes.io/change-cause: "Fix double-charge bug, JIRA PAY-231"
    owner-slack: "#team-orders"
```

## Watch out

> [!WARNING]
> - The most expensive mistake in Kubernetes is running a command against **prod** when you meant **dev**. Show the current context in your shell prompt (`kubectx`, `kubens` and `k9s` help).
> - YAML is whitespace-sensitive. Use 2 spaces, never tabs. A wrong indent silently puts a field in the wrong place.
> - If you `kubectl edit` or `scale` in production but don't update Git, the next `apply` (or GitOps sync) undoes your change.
> - A Service whose selector has a typo (`app: order-api`) matches **zero** pods. Everything looks green, but every request fails.
> - Namespaces are **not** a security wall by default. Pods in different namespaces can talk freely until you add NetworkPolicies.
> - Use the recommended label keys: `app.kubernetes.io/name`, `app.kubernetes.io/version`, `app.kubernetes.io/part-of: fooddash`.

## Interview questions

**What's the difference between `kubectl create` and `kubectl apply`?** `create` is imperative and fails if the object exists. `apply` is declarative and idempotent: it creates or updates the object to match the file, changing only what differs.

**How do pods in different namespaces talk?** Through the Service's DNS name, `service.namespace.svc.cluster.local`. Namespaces don't isolate traffic unless NetworkPolicies say so.

**Labels vs annotations?** Labels are short, queryable tags used by selectors (Services, ReplicaSets, policies). Annotations hold arbitrary metadata for tools and humans and can't be selected on.
