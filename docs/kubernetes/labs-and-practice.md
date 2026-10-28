# Labs, Practice & 8-Week Plan

> Know Kubernetes at three depths: definitions ("what is a Service?"), mechanisms ("what happens when…?") and judgement ("how would you design or debug…?"). Aim for the second and third, and anchor what you learn in something you've built.

## The idea in one minute

| What | How |
| --- | --- |
| Learn each topic | Be able to **draw it**, **write its YAML from memory**, and **break it and fix it** with kubectl |
| Practise | 11 hands-on labs on a local `kind` cluster, each with a "break it" exercise |
| Prove it | A capstone project that puts every topic together |
| Certify | CKAD first for backend roles; CKA later for platform/SRE roles |
| Timeline | 8 weeks at 10–12 hours a week ([8-week plan](#diagram/study-plan)) |

## Hands-on labs (kind)

kind (Kubernetes in Docker) runs each node as a container: fast, free and multi-node. You need Docker (or Podman), `kubectl`, `kind`, `helm`, and optionally `k9s`.

```yaml
# kind-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: lab
nodes:
  - role: control-plane
    extraPortMappings:
      - { containerPort: 30080, hostPort: 8080 }   # reach NodePort 30080 at localhost:8080
  - role: worker
  - role: worker
```

```bash
kind create cluster --config kind-config.yaml
kubectl get nodes -o wide
kubectl get pods -n kube-system        # find etcd, apiserver, scheduler, coredns, kube-proxy
```

| Lab | Do | Break it |
| --- | --- | --- |
| 0. Cluster | Create a 3-node kind cluster; look at static pods in `/etc/kubernetes/manifests` | — |
| 1. Pods | Probes, requests/limits, an init container | Liveness at `/nope`; a 300M stress in a 128Mi limit; a bad image tag |
| 2. Deployments | 4 replicas, `maxSurge 1`, `maxUnavailable 0`; watch two ReplicaSets shift | Roll out a bad tag; remove readiness and roll out a 500-returning app |
| 3. Services | ClusterIP, NodePort, headless; read iptables rules | Wrong selector → empty EndpointSlice; scale to 0 |
| 4. Config | Your own app reading config three ways | Missing key → `CreateContainerConfigError` |
| 5. StatefulSet | PostgreSQL; delete `postgres-0` and keep your rows | Delete the PVC while the pod runs; explain the finalizer |
| 6. Gateway | Route two Services; 90/10 canary by weight | — |
| 7. Autoscaling | HPA under load; drain with a PDB | Remove CPU requests → `<unknown>` targets |
| 8. Security | RBAC with `auth can-i`; restricted namespace; NetworkPolicies with Calico/Cilium | Try to run a root pod |
| 9. Batch | Flyway Job, CronJob with `Forbid`, a DaemonSet | Taint a node without a toleration |
| 10. Capstone | The project below | Chaos tests under load |

## Capstone: your portfolio project

Build a small event-driven system and deploy it the way a production team would ([Capstone project](#diagram/capstone)): `orders-api` (Spring Boot) writes to PostgreSQL and publishes `OrderCreated` to Kafka; `inventory-service` (Node.js or Go) consumes it and uses Redis as a cache; both sit behind a Gateway.

| Requirement | Kubernetes features exercised |
| --- | --- |
| Two stateless services, 3 replicas each | Deployment, probes, requests/limits, graceful shutdown, topology spread |
| PostgreSQL | StatefulSet + PVC, or the CloudNativePG operator |
| Kafka | Strimzi operator |
| External routing | Gateway API `HTTPRoute`, canary by weight |
| Config and credentials | ConfigMap, Secret, External Secrets with a local Vault (bonus) |
| Scaling | HPA on `orders-api`; KEDA on Kafka lag for `inventory-service` |
| Resilience | PDBs; kill pods and nodes during a load test with zero failed requests |
| Security | Dedicated ServiceAccounts, restricted Pod Security, default-deny NetworkPolicies |
| Observability | kube-prometheus-stack, a Grafana dashboard, OpenTelemetry traces across Kafka |
| Delivery | GitHub Actions builds, scans and pushes; Argo CD syncs from Git |

## Core questions with model answers

**Why Kubernetes over plain Docker or ECS?** Declarative desired state with self-healing, built-in discovery and load balancing, rolling deploys and rollbacks, autoscaling and a huge extension ecosystem. The cost is complexity; for a small team, ECS or a PaaS can be the better call.

**Walk me through `kubectl apply` to a running pod.** Authn → authz → admission → etcd → Deployment controller → ReplicaSet controller → scheduler binding → kubelet with CRI/CNI/CSI → probes → EndpointSlice and kube-proxy.

**Readiness vs liveness vs startup?** Readiness gates traffic; liveness restarts; startup protects slow boots. Never make liveness depend on a database.

**How do you achieve zero-downtime deploys?** `maxUnavailable: 0`, readiness probes, `preStop` sleep plus graceful SIGTERM handling, PDBs, backward-compatible schema changes (expand and contract), replicas spread across zones.

**What happens if the control plane goes down?** Pods keep running and serving; nothing can change (no scheduling, scaling, healing or config updates) until it's back.

## Scenario questions

Answer every scenario in the same five steps: requirements, architecture, Kubernetes primitives, failure modes, observability ([Answering scenarios](#diagram/answer-shape)).

| Scenario | What a strong answer covers |
| --- | --- |
| Payments service at 99.95% on EKS | 3 AZs, topology spread, PDB, `maxUnavailable: 0`, HPA, priority class, idempotency keys, outbox, RDS Multi-AZ, SLO alerts |
| Kafka consumers fall behind during a sale | KEDA on lag capped at partition count; more partitions ahead of time; Karpenter headroom; back-pressure and a DLQ |
| Latency spikes every few minutes on a Java service | CPU throttling from tight limits, GC vs heap sizing, noisy neighbours, probe timeouts |
| One gRPC backend pod gets all the traffic | Connection-level balancing; headless Service + client-side LB, or a mesh |
| Multi-tenant cluster for 10 teams | Namespace per team, RBAC via groups, ResourceQuota + LimitRange, NetworkPolicy, restricted PSS, policy engine, cost labels |
| Migrate a monolith from EC2 | Containerise, externalise config, health endpoints, graceful shutdown, strangler pattern behind a Gateway, keep the DB managed |
| Cluster upgrade with no downtime | Check deprecated APIs, control plane first, then node pools by surge or blue/green, PDBs respected |

> [!IMPORTANT]
> A lab is not production. Building the capstone and testing how it fails teaches a lot, but real traffic, real data and real on-call bring problems a lab never shows.

## 8-week plan and certification

| Week | Focus | Checkpoint |
| --- | --- | --- |
| 1 | Foundations, architecture, pods | Explain the `kubectl apply` flow aloud in 3 minutes |
| 2 | Deployments, Services, DNS | Debug a broken Service selector in under 5 minutes |
| 3 | Config, Secrets, StatefulSets | Run your own Spring Boot app with config + Postgres |
| 4 | Scheduling, scaling, security | Write HPA, PDB, Role and NetworkPolicy YAML from memory |
| 5 | Troubleshooting + Helm; start the capstone | Fix 10 "break it" scenarios using only kubectl |
| 6 | Gateway API, KEDA, Argo CD in the capstone | Capstone deploys from Git with one command |
| 7 | Observability, failure tests; first killer.sh simulator | Simulator score noted; weak domains listed |
| 8 | Timed drills, review weak spots | Sit CKAD; publish the capstone repo |

|  | CKAD | CKA |
| --- | --- | --- |
| Focus | Building, deploying, configuring apps | Installing, operating, troubleshooting clusters |
| Format | Online, proctored, hands-on at a command line | Same |
| Duration | About 2 hours | 2 hours |

Check the current price, passing score and Kubernetes version on the CNCF / Linux Foundation pages before booking; they change.

## Exam technique

> [!TIP]
> - Never write YAML from scratch: `kubectl create … --dry-run=client -o yaml > x.yaml`, then edit.
> - Set up at the start: `alias k=kubectl`, `export do="--dry-run=client -o yaml"`, `export now="--force --grace-period=0"`.
> - `kubectl explain pod.spec.containers.livenessProbe --recursive` beats searching the docs.
> - Always switch to the context and namespace given in each question. Wrong cluster = zero marks.
> - Skip any low-value question that takes more than 5 minutes, and come back later.

## Resources

- [kubernetes.io Concepts](https://kubernetes.io/docs/concepts/) and [Tasks](https://kubernetes.io/docs/tasks/): the primary source and your exam reference.
- *Kubernetes in Action* (Lukša) for internals; *Kubernetes Patterns* (Ibryam, Huß) for design patterns.
- The killer.sh simulator (included with the exam) and KodeKloud labs for timed practice.
- [kind](https://kind.sigs.k8s.io/) and the [Gateway API docs](https://gateway-api.sigs.k8s.io/).
- *Kubernetes the Hard Way* once you finish CKAD: building a cluster by hand makes the architecture permanent.
