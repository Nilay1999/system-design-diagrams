# Requests, Limits & QoS

> **Requests** reserve CPU and memory for a container; **limits** cap the most it can ever use; quotas cap a whole namespace. Getting requests right is the foundation for scheduling, autoscaling and your cloud bill.

## The idea in one minute

| Setting | Who uses it | What happens |
| --- | --- | --- |
| `requests` | The scheduler | A pod only lands on a node whose unreserved capacity covers its requests |
| `limits.cpu` | The Linux kernel (cgroups) | Over the limit → **throttled** (slowed down) |
| `limits.memory` | The Linux kernel | Over the limit → **OOMKilled** (exit 137) and restarted |
| QoS class | The kubelet | Decides eviction order when a node runs out of memory |
| LimitRange | Admission | Fills in default requests/limits per container in a namespace |
| ResourceQuota | Admission | Caps a namespace's total requests, limits and object counts |

## Real-life analogy

> [!TIP]
> **Booking a co-working space.**
> - A **request** is the desk you book. The building guarantees it's yours and won't sell more desks than it has. The scheduler uses requests to decide whether a pod "fits" on a node.
> - A **limit** is the fire-safety maximum: you can spread out into empty space when it's quiet, but never past this line.
> - A **ResourceQuota** is the company's total booking budget: "the delivery team may book at most 40 desks across the building."

## The problem it solves

Without requests, the scheduler packs pods blindly and a node ends up overloaded. Without limits, one buggy `report-job` with a memory leak eats the whole node, and `payments-api` next to it dies too. This is the **noisy neighbour** problem.

See [Requests & scheduling](#diagram/requests-limits): the scheduler adds up *requests* on each node, not actual usage.

## Units

- **CPU:** `1` = one full core. `500m` = 500 millicores = half a core. `250m` = a quarter.
- **Memory:** `512Mi`, `1Gi` (binary units). Careful: `1G` is slightly less than `1Gi`, and `1M` vs `1Mi` mistakes are common.

## CPU vs memory: different punishments

See [CPU vs memory limits](#diagram/cpu-vs-memory).

| Resource | Over the limit | What you'll see |
| --- | --- | --- |
| CPU | **Throttled**: slowed down, never killed | Latency spikes, slow requests, timeouts |
| Memory | **Killed** (OOMKilled, exit code 137) and restarted | Restart count climbing; `OOMKilled` in `kubectl describe` |

CPU is "compressible" (you can just wait for it). Memory isn't (you can't give back half a Java object).

## FoodDash example

```yaml
containers:
  - name: app
    image: fooddash/orders-api:1.4.2
    resources:
      requests:
        cpu: 500m        # reserved: half a core
        memory: 1Gi      # reserved
      limits:
        memory: 1Gi      # same as request: predictable, no surprise OOM kills
                         # no CPU limit: avoids throttling, uses spare CPU when free
    env:
      - name: JAVA_TOOL_OPTIONS
        value: "-XX:MaxRAMPercentage=75"   # heap = 75% of the container's memory
```

That "memory limit = request, no CPU limit" setup is a popular production choice. Some teams do set CPU limits for strict fairness; be ready to explain both sides.

## QoS classes: who gets evicted first

When a node runs out of memory, Kubernetes has to evict someone. It decides by **Quality of Service class**, which it assigns automatically from your settings ([QoS & eviction](#diagram/qos-eviction)):

| QoS class | How you get it | Real-life analogy | Evicted |
| --- | --- | --- | --- |
| **Guaranteed** | Every container has requests = limits for both CPU and memory | Confirmed first-class ticket | Last |
| **Burstable** | Some requests or limits set, but not Guaranteed | Confirmed economy ticket | Middle |
| **BestEffort** | No requests or limits at all | Standby passenger | First |

For FoodDash, `payments-api` should be Guaranteed. A nightly `report-job` can be Burstable.

## LimitRange: defaults for a namespace

Forgetful developers deploy pods with no resources. A LimitRange fills in defaults and enforces min/max per container:

```yaml
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: delivery }
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 256Mi }
      default:        { memory: 512Mi }
      max:            { memory: 4Gi }
```

## ResourceQuota: a budget for a namespace

```yaml
apiVersion: v1
kind: ResourceQuota
metadata: { name: delivery-budget, namespace: delivery }
spec:
  hard:
    requests.cpu: "40"
    requests.memory: 80Gi
    pods: "200"
    persistentvolumeclaims: "20"
```

Both run at admission time, before the pod is stored: see [LimitRange & ResourceQuota](#diagram/quotas). Once a quota on CPU or memory exists, every new pod in that namespace **must** declare requests (or get them from a LimitRange), or it's rejected.

## Watch out

> [!WARNING]
> - **Requests are what you pay for**, not actual usage. A pod requesting 4 CPUs but using 0.2 still blocks 4 CPUs on the node. Over-requesting is the #1 cause of high cloud bills.
> - Old JVMs (before Java 10) ignore container limits and size the heap from the whole machine's memory. Modern JVMs are container-aware, but still set `MaxRAMPercentage`.
> - Node.js has its own heap cap: set `--max-old-space-size` below the container memory limit.
> - Tight CPU limits on a Java service cause latency spikes every few minutes. Check `container_cpu_cfs_throttled_periods_total` before blaming GC.
> - Use the VPA in recommendation mode or Prometheus history to set requests from real data instead of guesses.

## Interview questions

**Requests vs limits, and what happens when exceeded?** Requests drive scheduling and the QoS class; limits are enforced by cgroups. CPU over its limit is throttled; memory over its limit is OOMKilled.

**Why might you not set a CPU limit?** CPU limits throttle a container even when the node has idle CPU, causing latency spikes. With accurate requests, the kernel already shares CPU fairly in proportion to them.

**A Java service is OOMKilled although the heap is set to 1 GB inside a 1 GB limit. Why?** The JVM uses memory outside the heap: threads, metaspace, buffers, code cache. Size the heap as a percentage (`MaxRAMPercentage=75`) and leave headroom.
