# Scheduling: Where Pods Land

> The scheduler picks a node for every new pod. You can steer it with preferences (affinity), restrictions (taints), spreading rules and priorities.

## The idea in one minute

| Tool | Direction | Use it to | Example |
| --- | --- | --- | --- |
| `nodeSelector` | Pod picks node (simple) | Pin to a node type | `disktype: ssd` |
| Node affinity | Pod picks node (expressive) | Required or preferred rules, `In`/`NotIn` | Run on `arm64`, prefer Spot |
| Pod affinity | Pod near pods | Co-locate for latency | `delivery-tracker` next to its Redis |
| Pod anti-affinity | Pod away from pods | Spread replicas for HA | No two `payments-api` pods on one node |
| Taints + tolerations | Node repels pods | Dedicate nodes | GPU nodes for ML |
| Topology spread | Even spread | Balance across zones/nodes | 6 replicas over 3 AZs = 2 each |
| PriorityClass | Who wins under pressure | Preempt lower-priority pods | Payments over batch jobs |

## Real-life analogy

> [!TIP]
> **Seating guests at a wedding.** The planner (scheduler) seats guests (pods) at tables (nodes). First, **filter**: which tables have enough empty chairs, and which tables is this guest allowed at? Then **score**: among valid tables, which is best? Near family, away from the ex, not all cousins at one table. Then seat them. The planner doesn't serve food; the waiters (kubelets) do.

The scheduler places pods using **requests** (not actual usage), the constraints you declare, and scoring. See [Filter & score](#diagram/filter-score).

## 1. nodeSelector: "only at tables marked VIP"

```bash
kubectl label node ip-10-0-1-23 disktype=ssd
```

```yaml
spec:
  nodeSelector:
    disktype: ssd
```

## 2. Node affinity: richer rules

Like nodeSelector, but with OR, NOT, and "preferred" (soft) vs "required" (hard).

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:      # hard rule
      nodeSelectorTerms:
        - matchExpressions:
            - { key: kubernetes.io/arch, operator: In, values: [arm64] }   # cheaper Graviton nodes
    preferredDuringSchedulingIgnoredDuringExecution:     # soft rule
      - weight: 50
        preference:
          matchExpressions:
            - { key: karpenter.sh/capacity-type, operator: In, values: [spot] }
```

"IgnoredDuringExecution" means: if a node's labels change later, already-running pods aren't kicked off.

## 3. Pod affinity and anti-affinity: "seat near / away from"

- **Pod affinity:** put `delivery-tracker` on the same node (or zone) as its Redis cache to cut latency.
- **Pod anti-affinity:** never put two `payments-api` pods on the same node, so one node failure can't take out all payment capacity.

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector: { matchLabels: { app: payments-api } }
        topologyKey: kubernetes.io/hostname       # "no two on the same node"
```

## 4. Taints and tolerations: "reserved tables"

> [!TIP]
> A table with a "Reserved for the bride's family" sign (taint). Guests stay away unless they have the matching invitation (toleration).

```bash
kubectl taint nodes gpu-node-1 dedicated=ml:NoSchedule
```

```yaml
tolerations:
  - { key: dedicated, operator: Equal, value: ml, effect: NoSchedule }
```

| Effect | Meaning |
| --- | --- |
| `NoSchedule` | New pods without a toleration can't land here |
| `PreferNoSchedule` | Try to avoid; allowed if nothing else fits |
| `NoExecute` | Also evicts already-running pods without a toleration |

> [!IMPORTANT]
> A toleration **allows** a pod onto a tainted node; it doesn't **force** it there. To dedicate GPU nodes to FoodDash's ML recommendation service, use **both**: a taint (keep others out) + node affinity (pull ML pods in). See [Taints & affinity](#diagram/taints-affinity).

Kubernetes uses taints itself: a node that becomes unreachable gets a `NoExecute` taint, and pods are evicted after about 5 minutes by default.

## 5. Topology spread constraints: "spread evenly across tables"

Anti-affinity is all-or-nothing. Topology spread says "keep it even". FoodDash runs in 3 AWS availability zones; with 6 `orders-api` replicas you want 2 per zone, so a zone outage loses only a third ([Topology spread](#diagram/topology-spread)).

```yaml
topologySpreadConstraints:
  - maxSkew: 1                                   # zones may differ by at most 1 pod
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector: { matchLabels: { app: orders-api } }
```

## 6. Priority and preemption: "VIPs can bump others"

When the cluster is full, a **PriorityClass** decides who matters most. A high-priority pod that can't fit may **evict** (preempt) lower-priority pods ([Priority & preemption](#diagram/preemption)).

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata: { name: business-critical }
value: 100000
description: "payments and orders"
---
# in the pod spec:
#   priorityClassName: business-critical
```

FoodDash: on a busy Friday, `payments-api` should bump the nightly `report-job`, never the reverse.

## Watch out

> [!WARNING]
> - Too many hard rules make pods unschedulable. `kubectl describe pod` shows exactly why: "0/6 nodes are available: 3 Insufficient cpu, 3 node(s) had untolerated taint…"
> - The scheduler only places pods once. It doesn't rebalance later. If nodes become uneven, the **descheduler** can evict pods so they get placed again.
> - Prefer **soft** rules (`preferred…`, `ScheduleAnyway`) unless a hard rule is truly required.

## Interview questions

**A pod is stuck in Pending. What do you check?** `kubectl describe pod` events: insufficient resources, taints without tolerations, unsatisfiable affinity, an unbound PVC (often a zone mismatch). Then the node autoscaler's logs.

**Taints vs affinity?** Affinity attracts pods to nodes; taints repel pods from nodes. To dedicate nodes you need both.

**How do you survive a zone outage?** Spread replicas across zones with topology spread constraints, size each zone to carry the load, and use PDBs for planned disruptions.
