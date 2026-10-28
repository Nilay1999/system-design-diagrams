# StatefulSets

> A StatefulSet runs pods that each keep a **permanent name, network identity and their own disk**, even when they are restarted or moved. Use it for databases, Kafka, ZooKeeper, Elasticsearch: anything where replicas are not interchangeable.

## The idea in one minute

| Guarantee | Example |
| --- | --- |
| **Stable, ordered names** | `kafka-0`, `kafka-1`, `kafka-2`. `kafka-1` dies, a new `kafka-1` replaces it |
| **Stable DNS** (via a headless Service) | `kafka-1.kafka.fooddash.svc.cluster.local` always points to that pod |
| **Own disk per pod** | `volumeClaimTemplates` creates `data-kafka-0`, `data-kafka-1`… and re-attaches the same one forever |
| **Ordered start and stop** | Starts 0 → 1 → 2 (each Ready before the next); stops 2 → 1 → 0 |
| **Ordered updates** | Rolling updates go from the highest number down; `partition` lets you update only some pods first |

## Real-life analogy

> [!TIP]
> **Numbered lockers vs a shared coat rack.** A **Deployment** is a coat rack: any coat on any hook, all hooks identical. A **StatefulSet** is a row of **numbered lockers**: locker 0, locker 1, locker 2. Locker 1 always holds the same person's things. If the locker door breaks and is replaced, it's still locker 1 with the same contents.

## The problem it solves

FoodDash wants to run Kafka with 3 brokers. Each broker:

- has its own data on disk that must never be mixed up with another broker's;
- must be reachable by a **predictable name** so other brokers and clients can find it;
- often must start in a specific order (the first node bootstraps the cluster).

A Deployment gives pods random names, shared or no storage, and parallel startup. Wrong tool. Compare them on [Deployment vs StatefulSet](#diagram/comparison).

| Behaviour | Deployment | StatefulSet |
| --- | --- | --- |
| Pod names | Random hash (`web-7d9f-x2k`) | Ordinal (`postgres-0`, `-1`) |
| Start/stop order | Parallel | Ordered 0 to N-1 up, N-1 to 0 down (unless `podManagementPolicy: Parallel`) |
| Storage | Shared PVC or none | One PVC per pod, kept on scale-down |
| Network identity | Through the Service VIP only | Per-pod stable DNS |
| Rolling updates | Surge-based | Reverse ordinal; `partition` enables staged updates |

## FoodDash example: PostgreSQL

See [PostgreSQL StatefulSet](#diagram/architecture).

```yaml
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: fooddash }
spec:
  clusterIP: None              # headless: gives each pod its own DNS name
  selector: { app: postgres }
  ports: [{ port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: fooddash }
spec:
  serviceName: postgres        # links to the headless Service
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:16
          envFrom: [{ secretRef: { name: postgres-creds } }]
          env: [{ name: PGDATA, value: /var/lib/postgresql/data/pgdata }]
          ports: [{ containerPort: 5432 }]
          volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
  volumeClaimTemplates:        # one PVC per pod, created automatically
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3
        resources: { requests: { storage: 50Gi } }
```

> [!NOTE]
> **Try this:** insert some rows, then `kubectl delete pod postgres-0`. A new `postgres-0` starts, re-attaches `data-postgres-0`, and your rows are still there.

## Ordered operations

Starting, updating and stopping happen one pod at a time ([Ordered operations](#diagram/ordered-ops)):

- **Scale up:** `postgres-0` must be Running and Ready before `postgres-1` is created.
- **Rolling update:** from the highest ordinal down. Set `updateStrategy.rollingUpdate.partition: 2` to update only `postgres-2` first, a built-in canary.
- **Scale down:** in reverse, and the PVCs stay.

## What StatefulSets do NOT do (important!)

A StatefulSet gives identity and storage. It knows nothing about PostgreSQL or Kafka. It won't set up replication between `postgres-0` and `postgres-1`, promote a replica when the primary dies, or take backups and run upgrades safely. See [What it doesn't do](#diagram/operator-boundary).

That database-specific knowledge lives in **Operators**: CloudNativePG for PostgreSQL, Strimzi for Kafka, and others (see *CRDs, Controllers & Operators*). In many real companies the answer is even simpler: use a managed service (Amazon RDS, Amazon MSK) and keep only stateless apps in Kubernetes.

> [!IMPORTANT]
> Saying "it depends, and here's the trade-off" (operator vs managed service vs plain StatefulSet) is usually the right answer.

## Watch out

> [!WARNING]
> - Scaling down or deleting a StatefulSet **keeps** the PVCs (to protect your data). You must delete them yourself, and you pay for them until you do.
> - If a node becomes unreachable, Kubernetes will **not** automatically start a duplicate `postgres-0` elsewhere, because two pods writing the same disk could corrupt it. Someone must confirm the old node is truly gone.
> - `podManagementPolicy: Parallel` starts all pods at once when order doesn't matter (faster for Elasticsearch data nodes).
> - The headless Service must exist and match `serviceName`, or the per-pod DNS names never appear.

## Check your understanding

**Deployment vs StatefulSet vs DaemonSet?** Deployment: interchangeable replicas. StatefulSet: stable name, DNS and per-pod storage, with ordered operations. DaemonSet: one pod per node for node-level agents.

**Would you run PostgreSQL on Kubernetes?** It depends. A managed database (RDS, Aurora) removes the hardest operational work. If it must run in-cluster, use a mature operator like CloudNativePG rather than a hand-written StatefulSet, and plan backups and restores.

**Why doesn't Kubernetes recreate a StatefulSet pod from a dead node right away?** At-most-one semantics: if the old pod is still running on a partitioned node, two pods writing one disk would corrupt data.
