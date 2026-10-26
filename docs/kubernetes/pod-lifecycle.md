# Pod Lifecycle, Probes & Graceful Shutdown

> Kubernetes tracks every Pod's life stage and uses three kinds of health checks (probes) to decide whether to send it traffic or restart it. When a Pod is removed, it gets a chance to finish its work before it's killed.

## The idea in one minute

| Question | Answer |
| --- | --- |
| What phases can a Pod be in? | Pending, Running, Succeeded, Failed, Unknown |
| What are `CrashLoopBackOff`, `OOMKilled`? | **Reasons** explaining why a container is unhappy, not phases |
| Which probe stops traffic? | **readiness**: the pod leaves the Service, but isn't restarted |
| Which probe restarts the container? | **liveness** (and **startup**, if the app never finishes starting) |
| How does a pod shut down? | Removed from Services and sent SIGTERM at the same time; SIGKILL after the grace period |

## The life of a Pod

See [Phases & reasons](#diagram/phases).

| Phase | Plain meaning | FoodDash moment |
| --- | --- | --- |
| **Pending** | Accepted, but not running yet: waiting for a node, or still downloading the image | A big Java image is still being pulled |
| **Running** | On a node, at least one container is up | `orders-api` is serving orders |
| **Succeeded** | All containers finished with success and won't restart | `report-job` finished tonight's report |
| **Failed** | All containers stopped, at least one with an error | `report-job` crashed on bad data |
| **Unknown** | Kubernetes can't reach the node | The node lost network |

You'll also see words like `CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`. Those aren't phases; they're **reasons** (see *Troubleshooting* for each).

## Restart policies

Set per Pod with `restartPolicy`:

- `Always` (default): restart whenever the container exits. For web services like `orders-api`.
- `OnFailure`: restart only if it exited with an error. For batch jobs.
- `Never`: don't restart. For one-shot debugging tasks.

Restarts wait longer each time (10s, 20s, 40s… up to 5 minutes). That waiting is the "BackOff" in `CrashLoopBackOff`: "it keeps crashing, so I'm waiting longer before trying again."

## Health probes: the three doctors

> [!TIP]
> **Real-life analogy: a new employee at a FoodDash call centre.**
> - **Startup probe:** "Has the new hire finished training yet?" Until they have, don't judge them on anything else. Some people (and JVMs) take a while.
> - **Readiness probe:** "Is this agent available to take calls right now?" If they're on a break, stop routing calls to them, but don't fire them.
> - **Liveness probe:** "Is this agent still responsive at all?" If they've been frozen for a long time, replace them.

See [The three probes](#diagram/probes).

| Probe | Question | If it fails | Typical check | Common mistake |
| --- | --- | --- | --- | --- |
| startupProbe | Has the app finished starting? | Container restarts (after the allowed attempts); other probes wait until it passes | Same endpoint as liveness, with a generous limit | Omitting it, then setting a huge `initialDelaySeconds` on liveness |
| readinessProbe | Can it take traffic **right now**? | Removed from the Service; **not** restarted | `/actuator/health/readiness`: DB pool ready, cache warm | Missing it, so traffic hits pods that are still booting |
| livenessProbe | Is the process stuck or dead? | Container is **restarted** | `/actuator/health/liveness`: only the app itself | Checking the database: a DB blip restarts every pod |

### FoodDash example

```yaml
containers:
  - name: app
    image: fooddash/orders-api:1.4.2
    startupProbe:
      httpGet: { path: /actuator/health/liveness, port: 8080 }
      periodSeconds: 5
      failureThreshold: 30        # up to 30 x 5s = 150s to start
    readinessProbe:
      httpGet: { path: /actuator/health/readiness, port: 8080 }
      periodSeconds: 5
      failureThreshold: 2
    livenessProbe:
      httpGet: { path: /actuator/health/liveness, port: 8080 }
      periodSeconds: 10
      failureThreshold: 3        # 30s of silence before a restart
```

Probe types: `httpGet` (most web apps), `tcpSocket` (is the port open? good for Redis and databases), `exec` (run a command inside; success if exit code 0), and `grpc`.

## A real incident to learn from

FoodDash's team once pointed the **liveness** probe at an endpoint that also checked PostgreSQL. One night the database had a 2-minute failover. Every `orders-api` pod failed liveness, and Kubernetes restarted **all of them at once**. When the database came back, the pods were still booting, so the outage lasted 10 minutes instead of 2. Compare both versions on [Liveness incident](#diagram/probe-incident).

> [!IMPORTANT]
> Liveness checks only "is **my own** process alive?". Dependencies belong in **readiness**, which simply pauses traffic without restarting anything.

## Graceful shutdown: how a Pod says goodbye

When a Pod is deleted (during a deploy, scale-down or node drain), two things happen **in parallel**: the kubelet starts shutting the pod down, and the pod is removed from Service endpoints. Because kube-proxy on every node updates a little later, traffic can still arrive after SIGTERM. Follow it on [Graceful shutdown](#diagram/graceful-shutdown).

1. The pod is marked **Terminating**, and removal from EndpointSlices begins.
2. The `preStop` hook runs if you set one (often `sleep 5` to `sleep 10`, so the network catches up).
3. The app receives **SIGTERM**: "please finish up." It should stop taking new requests, finish in-flight ones, commit Kafka offsets and close DB pools.
4. After `terminationGracePeriodSeconds` (default 30s), any survivor gets **SIGKILL**.

For Spring Boot, set `server.shutdown=graceful`. For Node.js, listen for `SIGTERM` and call `server.close()`. Without this, every deploy drops a few customer orders mid-request.

> [!NOTE]
> Make sure your app is PID 1 in the container, or use a tiny init like `tini`. A shell wrapper script that doesn't forward signals means your app never receives SIGTERM and always gets killed after 30 seconds.

## Watch out

> [!WARNING]
> - No readiness probe = Kubernetes sends traffic the moment the container starts, before Spring has even loaded. Users get errors on every deploy.
> - A liveness probe that's too strict (a 1-second timeout on a busy JVM during garbage collection) causes restart storms.
> - Don't set a huge `initialDelaySeconds` on liveness to cover slow starts; use a **startupProbe** instead.
> - `terminationGracePeriodSeconds` must be longer than `preStop` sleep plus your app's drain time, or SIGKILL arrives mid-drain.

## Interview questions

**Readiness vs liveness vs startup probes?** Readiness gates traffic and never restarts; liveness restarts the container; startup protects slow boots by delaying the other two. Never make liveness depend on a database, or a DB blip restarts your whole fleet.

**How do you achieve zero-downtime deploys?** Rolling updates with `maxUnavailable: 0`, readiness probes, a `preStop` sleep plus graceful SIGTERM handling, PDBs, backward-compatible API and schema changes, and enough replicas spread across zones.

**What does exit code 137 mean?** 128 + 9 (SIGKILL): usually OOMKilled, or the container didn't stop within the grace period. 143 is 128 + 15 (SIGTERM), a normal graceful stop.
