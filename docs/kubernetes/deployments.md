# Deployments & Rolling Updates

> A ReplicaSet keeps an exact number of identical Pods running; a Deployment manages ReplicaSets so you can update versions safely. A rolling update swaps old pods for new ones a few at a time, and a bad version is rolled back with one command.

## The idea in one minute

| Question | Answer |
| --- | --- |
| What keeps N pods alive? | A **ReplicaSet** (you almost never touch it directly) |
| What do you edit? | The **Deployment** |
| What triggers a new rollout? | Any change to the **pod template** (image, env, annotation). Not `replicas` |
| What controls the pace? | `maxSurge` (extra pods allowed) and `maxUnavailable` (missing pods allowed) |
| What's the safety gate? | The **readiness probe**: a new pod that never becomes Ready stops the rollout |
| Does it roll back automatically? | **No.** It stops and reports `ProgressDeadlineExceeded`; you or your pipeline run `rollout undo` |

## Real-life analogy

> [!TIP]
> **A call-centre staffing rule:** "always 10 agents on the floor."
> - The **ReplicaSet** is the supervisor enforcing that number. Someone goes home sick? Call in a replacement. Somehow 11 show up? Send one home.
> - The **Deployment** is the HR manager. When the company introduces new training (a new app version), HR doesn't fire everyone at once. It brings in newly trained agents a few at a time and lets old ones go, so the floor is never empty.

## How it works

A bare Pod that dies stays dead. You need something that (a) keeps N copies alive and (b) lets you change the version without downtime. ReplicaSet does (a). Deployment adds (b), plus history and rollback. See [Deployment → ReplicaSet → Pods](#diagram/ownership).

```text
Deployment (orders-api)
   └── ReplicaSet (orders-api-7d9f8)     <- one per version of the pod template
          ├── Pod orders-api-7d9f8-x2k4q
          ├── Pod orders-api-7d9f8-m81zp
          └── Pod orders-api-7d9f8-q7c3d
```

- Each time the **pod template** changes, the Deployment hashes it (the `pod-template-hash` label), creates a **new** ReplicaSet, and moves pods from old to new.
- The old ReplicaSet is kept, scaled to 0, so you can roll back instantly.
- The ReplicaSet finds "its" pods using the label **selector**. That's why the selector and the template labels must match.

## FoodDash example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: fooddash
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: orders-api           # "the pods I own have this label" (immutable)
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  minReadySeconds: 10            # must stay Ready 10s before counting as good
  progressDeadlineSeconds: 600   # report failure if stuck for 10 minutes
  template:                      # the cookie cutter for every pod
    metadata:
      labels:
        app: orders-api          # must match the selector above
    spec:
      containers:
        - name: app
          image: fooddash/orders-api:1.4.2
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits:   { memory: 1Gi }
          readinessProbe:
            httpGet: { path: /actuator/health/readiness, port: 8080 }
```

```bash
kubectl apply -f orders-api.yaml
kubectl get deploy,rs,pods -l app=orders-api
kubectl scale deploy orders-api --replicas=5
kubectl delete pod <one-of-them>      # watch a replacement appear immediately
```

> [!NOTE]
> **See self-healing with your own eyes.** In one terminal run `kubectl get pods -w`. In another, delete a pod. It goes `Terminating`, and a brand-new pod appears `Pending` → `ContainerCreating` → `Running`. That's the ReplicaSet's reconciliation loop: "3 wanted, 2 exist, create 1."

## How a rolling update works

> [!TIP]
> **Real-life analogy: changing the seats on a moving bus.** You can't stop FoodDash on a Friday night to upgrade it. A rolling update replaces the seats one row at a time while passengers keep riding. At every moment, enough seats are available.

Two knobs control the pace:

- `maxSurge`: how many **extra** pods may exist above the desired count during the update.
- `maxUnavailable`: how many pods may be **missing** below the desired count.

FoodDash `orders-api` has 4 replicas, `maxSurge: 1`, `maxUnavailable: 0`. Updating from 1.4 to 1.5 ([Rolling update](#diagram/rolling-update)):

1. Start one 1.5 pod (now 5 pods: 4 old + 1 new).
2. Wait until the new pod passes its **readiness probe** and stays Ready for `minReadySeconds`.
3. Stop one 1.4 pod (back to 4).
4. Repeat until all 4 run 1.5.

Capacity never drops below 4. A new pod that never becomes Ready stops the rollout, and the old pods keep serving.

### Commands

```bash
kubectl set image deploy/orders-api app=fooddash/orders-api:1.5.0
kubectl annotate deploy/orders-api kubernetes.io/change-cause="v1.5.0: new coupon logic"
kubectl rollout status deploy/orders-api       # watch progress
kubectl rollout history deploy/orders-api      # list versions
kubectl rollout undo deploy/orders-api         # back to previous
kubectl rollout undo deploy/orders-api --to-revision=3
kubectl rollout restart deploy/orders-api      # fresh pods, same version (e.g. to reload a Secret)
kubectl rollout pause deploy/orders-api        # batch several edits into one rollout
kubectl rollout resume deploy/orders-api
```

## Release strategies compared

See [Release strategies](#diagram/strategies).

| Strategy | Real-life analogy | How | Good for | Downside |
| --- | --- | --- | --- | --- |
| **Rolling update** | Replacing bus seats row by row | Built-in default | Most services | Old and new versions run together for a while |
| **Recreate** | Closing the shop to renovate | `type: Recreate`: kill all, then start new | Apps that can't run two versions at once | Downtime |
| **Blue/green** | Building a second shop next door, then moving the signboard | Two Deployments; switch the Service's selector | Instant switch and instant rollback | Double the servers during the switch |
| **Canary** | Giving a new dish to 5% of customers first | Send a small share of traffic to the new version, watch metrics, increase | Risky changes, high-traffic apps | Needs traffic-splitting tools |

**Canary in practice:** Gateway API supports weighted routing, so you can send 95% to stable and 5% to canary. **Argo Rollouts** or **Flagger** automate it: shift 5% → 25% → 50% → 100%, checking error rate and latency in Prometheus at each step, and roll back automatically if things look bad.

## The database problem nobody mentions

During a rolling update, version 1.4 and 1.5 serve traffic **at the same time**, on the **same database**. If 1.5 renames the column `amount` to `total_amount`, every 1.4 pod breaks immediately.

The fix is the **expand and contract** pattern ([Expand & contract](#diagram/expand-contract)):

1. **Expand:** add the new column `total_amount`; code writes both columns.
2. Backfill old rows (a Job).
3. Deploy code that reads `total_amount`.
4. **Contract:** in a later release, drop `amount`.

The same rule applies to API contracts and Kafka message schemas: always stay backward-compatible for at least one version.

## When to use a Deployment (and when not)

| Your workload | Use |
| --- | --- |
| Stateless web API or Kafka consumer (`orders-api`, `notification-worker`) | **Deployment** |
| Database, Kafka broker, anything needing stable identity and its own disk | StatefulSet |
| One copy on every node (log agent) | DaemonSet |
| Run to completion (report, migration) | Job / CronJob |

## Watch out

> [!WARNING]
> - Changing only `replicas` does **not** create a new ReplicaSet or rollout; only template changes do.
> - The `selector` can't be changed after creation. Pick good labels up front.
> - Two Deployments with overlapping selectors will fight over the same pods. Keep labels unique per app.
> - Stateless means **stateless**: no user sessions in memory, no files on local disk. Store sessions in Redis, files in S3.
> - Kubernetes does **not** roll back automatically when a rollout fails. Your CI/CD pipeline or Argo Rollouts must run the undo.
> - `kubectl rollout undo` changes the cluster, not Git. With GitOps, roll back by reverting the commit instead.

## Check your understanding

**How does a rolling update work?** The controller creates a new ReplicaSet for the new template and scales it up while scaling the old one down, within `maxSurge` and `maxUnavailable`. Pods only count once readiness passes for `minReadySeconds`.

**Why keep old ReplicaSets?** They are the rollback history: `rollout undo` simply scales an old ReplicaSet back up. `revisionHistoryLimit` controls how many are kept.

**How do you ship a breaking database change with zero downtime?** Expand and contract: add the new schema, deploy code compatible with both, backfill, switch reads, and remove the old schema in a later release.
