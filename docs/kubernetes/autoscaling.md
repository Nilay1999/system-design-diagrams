# Autoscaling: HPA, VPA, KEDA & Karpenter

> Kubernetes can automatically add more pods when they're busy (HPA, KEDA), make pods bigger (VPA), and add more machines when pods don't fit (Cluster Autoscaler, Karpenter).

## The idea in one minute

| Autoscaler | Scales | Based on | Notes |
| --- | --- | --- | --- |
| HPA | Number of pods | CPU/memory % of **requests**, custom or external metrics | Needs metrics-server; no requests means no CPU-based HPA |
| VPA | Requests/limits per pod | Historical usage | Don't combine with HPA on the same CPU/memory metric |
| KEDA | Pods, including to zero | Event sources: Kafka lag, SQS depth, Redis lists, cron | Ideal for consumers |
| Cluster Autoscaler | Nodes (in node groups) | Pending pods that can't fit | Slower; works on Auto Scaling Groups |
| Karpenter | Nodes (any instance type) | Pending pods; bin-packs and consolidates | The common choice on EKS today |

See [Three layers](#diagram/three-layers).

## Real-life analogy

> [!TIP]
> **A restaurant on a festival night.** **HPA:** more customers → call in **more waiters**. **VPA:** a waiter is always overloaded → give them a **bigger tray**. **KEDA:** look at the **queue outside the door** and hire waiters before the dining room fills. **Cluster Autoscaler / Karpenter:** waiters have nowhere to stand → **open another dining hall**.

## The problem it solves

FoodDash traffic is spiky: quiet at 4 PM, 6× at 8:30 PM, huge on festival days and during cricket finals. Sizing for the peak wastes money 20 hours a day. Sizing for the average means outages at dinner. Autoscaling follows demand.

## HPA: more pods

The HPA checks a metric every 15 seconds and adjusts `replicas` ([HPA loop](#diagram/hpa-loop)).

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: orders-api, namespace: fooddash }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: orders-api }
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 65 }   # % of the CPU *request*
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0        # react fast to spikes
    scaleDown:
      stabilizationWindowSeconds: 300      # wait 5 min before removing pods (avoid flapping)
```

The math is simple: `desired = ceil(current pods × current usage / target)`. With 4 pods at 90% CPU and a 60% target: ceil(4 × 90 / 60) = **6 pods**.

HPA needs **metrics-server** installed, and pods must have CPU **requests** (percentages are calculated against them). It can also scale on custom metrics like requests per second (via Prometheus Adapter).

## KEDA: scale on events (perfect for consumers)

CPU is a poor signal for a Kafka consumer. `notification-worker` might be at 20% CPU while 50,000 messages wait. **KEDA** scales on the real backlog: Kafka consumer lag, SQS queue length, Redis list length, a cron schedule, and 60+ other sources. It can even scale to **zero** when idle. See [KEDA on Kafka](#diagram/keda-kafka).

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: notification-worker, namespace: fooddash }
spec:
  scaleTargetRef: { name: notification-worker }
  minReplicaCount: 0
  maxReplicaCount: 12            # = number of partitions in the topic
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.fooddash:9092
        consumerGroup: notification-worker
        topic: order-events
        lagThreshold: "500"      # about 1 pod per 500 waiting messages
```

Why cap at 12? A Kafka partition is read by only one consumer in a group. With 12 partitions, pod number 13 would sit idle.

## VPA: right-size pods

The VPA watches actual usage over days and recommends (or applies) better CPU and memory requests. Many teams run it in **recommendation-only** mode (`updateMode: "Off"`) and copy its suggestions into their YAML. Don't let VPA and HPA both act on the same CPU/memory metric; they'll fight.

## Node autoscaling: Cluster Autoscaler vs Karpenter

HPA creates pods, but if nodes are full, those pods sit `Pending`. A node autoscaler notices and adds machines.

|  | Cluster Autoscaler | Karpenter |
| --- | --- | --- |
| How | Grows/shrinks predefined node groups (AWS Auto Scaling Groups) | Looks at pending pods and launches the best-fitting instance type directly |
| Speed | Slower (minutes) | Faster |
| Instance choice | Fixed per group | Picks from many types, Spot or On-Demand |
| Cost savings | Scales down empty nodes | Also **consolidates**: moves pods to pack them onto fewer, cheaper nodes |
| Where | Any cloud | Started on AWS; now also on Azure |

## Putting it together: FoodDash at 8:30 PM

Follow it on [8:30 PM rush](#diagram/dinner-rush).

1. Orders rise; `orders-api` CPU climbs past 65%.
2. HPA raises replicas from 6 to 14.
3. 5 new pods don't fit and go `Pending`.
4. Karpenter sees them and launches 2 new nodes in a minute or two.
5. Pods schedule, pass readiness, and join the Service.
6. At 11 PM, load drops; HPA scales down after the 5-minute window, and Karpenter consolidates and removes the spare nodes.

## Watch out

> [!WARNING]
> - Autoscaling is not instant. New nodes take a minute or two, and JVM apps take time to warm up. For known peaks (8 PM daily, a big sale), **pre-scale** with a scheduled minimum (KEDA's cron trigger works well).
> - Scaling the app doesn't scale the database. 30 pods × 20 DB connections = 600 connections, which may exceed PostgreSQL's limit. Use a pooler (PgBouncer, RDS Proxy).
> - Set `maxReplicas` sensibly. A bug that burns CPU in a loop will happily scale you to 100 pods and a large bill.
> - No CPU requests → the HPA shows `<unknown>` targets and never scales.

## Interview questions

**How does HPA work, and why might it not scale?** It computes `ceil(replicas × current / target)` every 15 seconds. Common reasons it doesn't scale: no resource requests, metrics-server missing, already at `maxReplicas`, or scaling on CPU when the bottleneck is I/O or a queue.

**How would you scale Kafka consumers?** KEDA on consumer lag, capped at the partition count; add partitions ahead of known peaks; make sure nodes can grow (Karpenter).

**Cluster Autoscaler vs Karpenter?** CA resizes predefined node groups; Karpenter provisions the best-fitting instance for pending pods directly, is faster, and consolidates to cut cost.
