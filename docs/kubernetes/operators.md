# CRDs, Controllers & Operators

> A CRD teaches Kubernetes a new kind of object (like a PostgreSQL `Cluster`), and an Operator is a controller that knows how to run it, turning a human expert's runbook into code.

## The idea in one minute

| Piece | What it is |
| --- | --- |
| **CRD** (Custom Resource Definition) | Adds a new API type. After installing it, `kubectl get clusters` works like `kubectl get pods` |
| **Custom resource** | One object of that type: your wish ("a 3-node PostgreSQL 16 cluster with daily backups") |
| **Controller / Operator** | Watches those objects and reconciles: creates StatefulSets, Services, Secrets, backup Jobs, and fixes drift |
| **Finalizer** | Lets the controller run cleanup before an object disappears |

See [How an Operator works](#diagram/operator-loop).

## Real-life analogy

> [!TIP]
> **Hiring a specialist.** Your restaurant manager (Kubernetes) knows about cooks, tables and shifts. One day you add a **sushi counter**, and the manager knows nothing about sushi. So you add "sushi order" as a new type on the order form (**CRD**), and hire a **sushi master** who watches for those orders and knows everything: fish freshness, knife care, what to do when the rice cooker breaks (**Operator**). Now anyone can write "2 salmon rolls" on the form, and the specialist handles the rest.

## The problem it solves

Running PostgreSQL with a plain StatefulSet still leaves humans doing the hard parts: set up replication, promote a replica when the primary dies, take backups to S3, upgrade versions safely. An Operator automates that expert knowledge 24/7, using the same reconcile loop Kubernetes uses for everything else.

## FoodDash example: PostgreSQL with CloudNativePG

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: orders-db, namespace: fooddash }
spec:
  instances: 3                    # 1 primary + 2 replicas, automatic failover
  storage: { size: 50Gi, storageClass: gp3 }
  backup:
    barmanObjectStore:
      destinationPath: s3://fooddash-db-backups/orders
    retentionPolicy: "30d"
```

About a dozen lines instead of hundreds of lines of YAML plus a runbook. If the primary pod dies, the Operator promotes a replica and updates the Service so apps reconnect to the new primary ([Automatic failover](#diagram/cnpg-failover)).

## Operators you'll meet in real jobs

Much of the modern Kubernetes ecosystem is "a CRD plus a controller" ([Operators you'll meet](#diagram/ecosystem)).

| Operator / CRD-based tool | Manages |
| --- | --- |
| **Strimzi** | Kafka clusters, topics and users (`Kafka`, `KafkaTopic`) |
| **CloudNativePG** | PostgreSQL clusters, failover, backups |
| **Prometheus Operator** | Prometheus setup; `ServiceMonitor` tells it what to scrape |
| **cert-manager** | TLS certificates (`Certificate`, `Issuer`), auto-renewed from Let's Encrypt |
| **External Secrets Operator** | Syncs secrets from AWS Secrets Manager or Vault |
| **Argo CD** | `Application` objects that point at Git |
| **Karpenter** | `NodePool` objects describing what nodes to launch |
| **KEDA** | `ScaledObject` scaling rules |

## Writing your own (a great portfolio project)

You can build Operators with **Kubebuilder** or **Operator SDK** in Go (or frameworks in Java and Python). A small project, like a `FeatureFlag` CRD that writes ConfigMaps, or a `ScheduledScaling` CRD that scales Deployments before the dinner rush, shows deep understanding.

## Watch out

> [!WARNING]
> - Operators are software with bugs and upgrade paths of their own. Pick mature, well-maintained ones.
> - Deleting a CRD deletes **every** object of that type. Be very careful in production.
> - **Finalizers** let a controller run cleanup before an object disappears (e.g. delete the S3 backups). If the controller is gone, objects with finalizers get stuck in `Terminating`.

## Check your understanding

**What is an Operator?** A custom controller plus CRDs that encode operational knowledge (provision, failover, backup, upgrade) for an application, applying the same reconciliation loop to your own resources. Examples: Strimzi, CloudNativePG, Prometheus Operator, cert-manager.

**How do finalizers relate to sagas?** Both coordinate multi-step cleanup without a distributed transaction: the object can't be deleted until the controller has finished its compensating work and removed the finalizer.

**Operator vs managed database?** An operator gives you portability and control but you own the operations; a managed service (RDS) trades control for far less operational work. Choose based on team skills and requirements.
