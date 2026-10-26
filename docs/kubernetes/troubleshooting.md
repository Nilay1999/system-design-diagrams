# Troubleshooting Playbook

> Almost every Kubernetes problem is found with four commands, in this order: `get` → `describe` → `logs` → `exec`. Practise this loop until it is muscle memory; live-debugging interview rounds test exactly this.

## The idea in one minute

| Step | Command | What it tells you |
| --- | --- | --- |
| 1. Vital signs | `kubectl get pods -o wide` | Status, restarts, node, IP |
| 2. History | `kubectl describe pod <pod>` | Events at the bottom: usually the answer |
| 3. Ask the patient | `kubectl logs <pod> --previous` | What the crashed container said |
| 4. Examine up close | `kubectl exec` / `kubectl debug` | What the pod sees from inside |

## Real-life analogy

> [!TIP]
> **A doctor's checkup.** A good doctor doesn't guess. They check **vital signs** (`kubectl get`), read the **medical history** (`kubectl describe`, the events), **ask the patient** what hurts (`kubectl logs`), and only then **examine up close** (`kubectl exec` / `debug`).

The STATUS column narrows the problem to one family of causes in seconds. Then `describe` and `logs` tell you which one. See the [Decision map](#diagram/decision-map).

## The toolkit

```bash
kubectl get pods -n fooddash -o wide                 # 1. status, restarts, node
kubectl describe pod <pod> -n fooddash               # 2. events at the bottom: usually the answer
kubectl logs <pod> -c app --previous                 # 3. what the crashed container said
kubectl exec -it <pod> -- sh                         # 4. look from inside
kubectl debug -it <pod> --image=nicolaka/netshoot --target=app   # 4b. if the image has no shell
kubectl get events -n fooddash --sort-by=.lastTimestamp
kubectl get endpointslices -l kubernetes.io/service-name=<svc>
kubectl top pods -n fooddash
kubectl port-forward svc/<svc> 8080:80
```

## Symptom → cause → fix

| Symptom | Likely causes | How to confirm | Fix |
| --- | --- | --- | --- |
| `Pending` | Insufficient CPU/memory; taint without toleration; affinity unsatisfiable; PVC unbound or zone mismatch | `describe pod`: "0/3 nodes are available…" | Lower requests, add nodes, fix affinity/tolerations, fix StorageClass |
| `ImagePullBackOff` / `ErrImagePull` | Wrong tag; private registry without `imagePullSecrets`; no IAM pull permission; rate limits | `describe pod` events | Fix the image reference or credentials |
| `CrashLoopBackOff` | App exits on start: bad config, missing env/Secret, DB unreachable, wrong command | `logs --previous`; exit code in `describe` | Fix the config; add a startupProbe if liveness kills a slow start |
| `OOMKilled` (exit 137) | Memory limit too low; JVM heap not sized to container | `describe pod`: Last State reason | Raise the limit; set `MaxRAMPercentage`; find the leak |
| `CreateContainerConfigError` | Referenced ConfigMap/Secret or key missing | `describe pod` | Create it or fix the key name |
| Running but 0/1 Ready | Readiness probe failing: wrong path/port, dependency down | `describe` probe failures; curl from inside | Fix the probe or the dependency |
| Restarts growing slowly | Liveness too aggressive; memory leak | Restart count, `top`, metrics | Tune probe thresholds; profile the app |
| Service returns refused / 503 | Selector doesn't match labels; wrong `targetPort`; no Ready pods | `get endpointslices` is empty | Align labels and ports |
| DNS fails | CoreDNS down; NetworkPolicy blocks port 53 egress | `nslookup svc` from a debug pod | Fix CoreDNS or allow DNS egress |
| Node `NotReady` | Kubelet down, disk/memory pressure, network | `describe node` conditions | Drain, fix or replace the node |
| Evicted pods | Node pressure (disk, memory) | `get pods` shows Evicted | Set proper requests; clean up images/logs |
| Stuck `Terminating` | Finalizer waiting on a controller; node gone | `get pod -o yaml` finalizers | Fix the controller; force delete only as a last resort |

## Exit codes decoded

See [Exit codes & nodes](#diagram/exit-codes).

| Code | Meaning |
| --- | --- |
| 0 | Exited normally. For a web service, that's still a bug: it should run forever |
| 1 | Application error (exception at startup, bad config) |
| 137 | 128 + 9 = SIGKILL: usually **OOMKilled**, or didn't stop within the grace period |
| 143 | 128 + 15 = SIGTERM: a normal shutdown |

## Real incidents to learn from

### 1. "Orders are failing after the deploy"

Walk through it on [The four commands](#diagram/debug-loop).

- `get pods`: new `orders-api` pods in **CrashLoopBackOff**.
- `logs --previous`: `Could not resolve placeholder 'COUPON_SERVICE_URL'`.
- Cause: the new version needs a config key that was never added to the ConfigMap.
- Why customers were mostly fine: `maxUnavailable: 0` kept the old pods serving.
- Fix: add the key, `kubectl rollout restart`. Prevention: config changes go in the same pull request as the code.

### 2. "Pods stuck in Pending during the IPL final"

- `describe pod`: `0/12 nodes are available: 12 Insufficient cpu`.
- The HPA had scaled `orders-api` to 40 replicas, but the node autoscaler had hit its maximum node count.
- Fix: raise the node limit; in the long run, lower the over-sized CPU requests (each pod requested 2 CPUs but used 0.4).

### 3. "payments-api restarts every few hours"

- `describe pod`: Last State: Terminated, Reason: **OOMKilled**, exit code 137.
- The JVM heap was set to 1 GB inside a 1 GB container limit, leaving no room for threads, metaspace and buffers.
- Fix: `-XX:MaxRAMPercentage=75` and a 1.5 GB limit, then confirm with memory graphs in Grafana.

### 4. "Service returns 503, but the pods look fine"

- Pods: Running and Ready. But `get endpointslices` for the Service: **empty**.
- Someone renamed the Deployment's label to `app: order-service`; the Service still selected `app: orders-api`.
- Fix: align the labels. Prevention: keep the Service and Deployment in the same Helm chart, sharing one label value.

### 5. "Random timeouts calling the restaurant API"

- `exec` into a pod, run `nslookup restaurant-api`: slow and sometimes failing.
- A new default-deny NetworkPolicy forgot to allow DNS egress to `kube-system` on port 53.
- Fix: add the DNS allow rule to the namespace.

## Node-level problems

```bash
kubectl get nodes
kubectl describe node <node>     # Conditions: MemoryPressure, DiskPressure, PIDPressure, Ready
```

A node `NotReady` usually means the kubelet stopped, the node ran out of disk (old images and logs), or it lost network. Cordon and drain it, then fix or replace it.

## Watch out

> [!WARNING]
> - Read the **events** first; they explain most problems in plain English.
> - Fix the cause in Git, not just in the cluster, or the next deploy brings the bug back.
> - After an incident, write a short blameless postmortem. Interviewers love hearing "here's an outage I debugged and what we changed."

## Interview questions

**A pod is in CrashLoopBackOff. What do you do?** `logs --previous`, the exit code and last state in `describe`, recent config changes, missing Secrets, dependency reachability, and whether liveness is killing a slow start.

**Latency spikes every few minutes on a Java service. Ideas?** CPU throttling from tight limits (`container_cpu_cfs_throttled_periods_total`), GC pauses vs heap sizing, noisy neighbours, probe timeouts.

**A Service returns 503 but the pods are healthy?** Check the EndpointSlice: an empty one means the selector doesn't match or no pod is Ready; a full one points at `targetPort` or the app itself.
