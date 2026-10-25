# Pods & Multi-Container Patterns

> A Pod is the smallest thing Kubernetes runs: one or more containers that live together, share one IP address, and always sit on the same machine. Init containers do setup work *before* your app starts; sidecars are helpers that run *alongside* it.

## The idea in one minute

| Fact | Why it matters |
| --- | --- |
| Every Pod gets its **own IP** | Pods behave like small VMs on one big network |
| Containers in a Pod share the network | They reach each other on `localhost` |
| Containers in a Pod can share volumes | A helper can read files the app writes |
| Pods are **mortal** | A dead Pod is replaced by a *new* Pod with a new name and IP |
| You rarely create Pods yourself | Controllers (Deployment, StatefulSet, Job) create and replace them |

See [Pod anatomy](#diagram/pod-anatomy).

## Real-life analogy

> [!TIP]
> **A flat with roommates.** A Pod is a **flat**; the containers are **roommates**. They share the same address (IP), the same Wi-Fi (network, so they talk on `localhost`), and can share a storage cupboard (volumes). They move in together and move out together. Most Pods have just one roommate: your app. Sometimes a helper moves in too, like a log shipper.

## The problem it solves

Why not just run containers directly? Because some containers truly belong together. FoodDash's `delivery-tracker` writes logs to a file, and a small helper container ships that file to the logging system. They must be on the same machine, see the same files, and start and stop together. A Pod is the wrapper that guarantees this.

The Pod also gives Kubernetes one consistent unit to schedule, health-check and assign an IP to, no matter how many containers are inside.

## How it works

- Every Pod gets its **own IP** inside the cluster.
- Containers in a Pod share the network: if the app listens on port 8080, its neighbour reaches it at `localhost:8080`.
- Pods are **mortal**. When a Pod dies, it is never repaired. A **new** Pod with a **new name and new IP** replaces it. This is the "cattle, not pets" idea: servers are numbered cattle, not named pets you nurse back to health.
- Because of that, you almost never create Pods by hand. You create a **Deployment** or another controller, which creates and replaces Pods for you.

## FoodDash example: the simplest Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: orders-api
  labels:
    app: orders-api
spec:
  containers:
    - name: app
      image: fooddash/orders-api:1.4.2
      ports:
        - containerPort: 8080
      env:
        - name: SPRING_PROFILES_ACTIVE
          value: prod
```

```bash
kubectl apply -f pod.yaml
kubectl get pod orders-api -o wide             # see its IP and node
kubectl logs orders-api
kubectl port-forward pod/orders-api 8080:8080  # then curl localhost:8080 on your laptop
kubectl delete pod orders-api                  # gone forever: nothing recreates a bare Pod
```

Try that last command, then the same thing with a Deployment. The Deployment's Pod comes back within seconds. That difference is the whole reason controllers exist.

## A production-grade Pod spec

Most of these fields get their own topic later; this is what a real `orders-api` pod template looks like once everything is in place.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: orders-api
  labels: { app: orders-api, tier: backend }
spec:
  serviceAccountName: orders-api
  terminationGracePeriodSeconds: 30
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
  initContainers:
    - name: wait-for-db                 # runs to completion before app starts
      image: busybox:1.36
      command: ['sh', '-c', 'until nc -z postgres 5432; do sleep 2; done']
  containers:
    - name: app
      image: fooddash/orders-api:1.4.2  # never use :latest in prod
      ports: [{ containerPort: 8080, name: http }]
      env:
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: db-creds, key: password } }
      resources:
        requests: { cpu: 250m, memory: 512Mi }   # used by the scheduler
        limits:   { memory: 512Mi }              # memory limit = request avoids OOM surprises
      startupProbe:                      # protects slow JVM startup
        httpGet: { path: /actuator/health/liveness, port: http }
        failureThreshold: 30
        periodSeconds: 5
      readinessProbe:                    # gates traffic
        httpGet: { path: /actuator/health/readiness, port: http }
        periodSeconds: 5
      livenessProbe:                     # restarts a hung process
        httpGet: { path: /actuator/health/liveness, port: http }
        periodSeconds: 10
        failureThreshold: 3
      lifecycle:
        preStop:
          exec: { command: ['sh', '-c', 'sleep 10'] }  # let endpoints drain
```

## Init containers

> [!TIP]
> **Real-life analogy:** before a restaurant opens, someone unlocks the doors, switches on the gas and checks the fridge. Only after **all** of that is done do the chefs start cooking. If the gas check fails, nobody starts cooking.

`orders-api` crashes on startup if PostgreSQL isn't reachable yet, or if the schema hasn't been migrated. You don't want that logic tangled into your app.

Init containers run **one at a time, in order**, and each must finish successfully before the next starts. Only then do the main containers start. If one fails, Kubernetes retries it (following the restart policy). While they run, the pod shows `Init:0/2`, `Init:1/2`, and so on. Follow it on [Init containers & sidecars](#diagram/init-sidecar).

```yaml
spec:
  initContainers:
    - name: wait-for-postgres
      image: busybox:1.36
      command: ['sh', '-c', 'until nc -z postgres 5432; do echo waiting; sleep 2; done']
    - name: run-migrations
      image: fooddash/orders-migrations:1.4.2     # Flyway with the SQL scripts baked in
      envFrom: [{ secretRef: { name: orders-db } }]
  containers:
    - name: app
      image: fooddash/orders-api:1.4.2
```

Other uses: download a large ML model or config file into a shared volume, fix file permissions, register with an external system.

## Sidecar containers

> [!TIP]
> **Real-life analogy:** a chef with an assistant standing next to them all shift, handling the plating and labelling, so the chef just cooks.

Every FoodDash service needs the same extras: ship logs, encrypt traffic, refresh secrets. Building these into six services in three languages is wasteful. A sidecar does it once, in one container, for any app.

Common sidecars in real jobs:

- **Log shipper** (Fluent Bit) reads log files the app writes to a shared volume.
- **Service mesh proxy** (Envoy in Istio) handles mTLS, retries and metrics for all network traffic.
- **Secret agent** (Vault Agent) fetches and refreshes credentials into a file.
- **Cloud SQL proxy** gives the app a secure local connection to a managed database.

**Native sidecars (the modern way):** declare the sidecar as an init container with `restartPolicy: Always`. Kubernetes then starts it **before** your app, keeps it running, and stops it **after** your app. This is stable since Kubernetes v1.33, and it fixed an old annoying bug: Jobs that never finished because the log-shipper sidecar kept running forever.

```yaml
spec:
  initContainers:
    - name: log-shipper
      image: fluent/fluent-bit:3.1
      restartPolicy: Always            # this line makes it a sidecar
      volumeMounts: [{ name: logs, mountPath: /var/log/app }]
  containers:
    - name: app
      image: fooddash/delivery-tracker:2.0
      volumeMounts: [{ name: logs, mountPath: /var/log/app }]
  volumes:
    - name: logs
      emptyDir: {}                     # shared scratch folder for both containers
```

## Two more patterns (good for interviews)

See [Multi-container patterns](#diagram/patterns).

| Pattern | Analogy | Example |
| --- | --- | --- |
| **Sidecar** | An assistant beside the chef | Envoy, Fluent Bit, Vault Agent |
| **Ambassador** | A personal assistant who handles all your outside calls | A local proxy that connects the app to a sharded Redis cluster, so the app just talks to `localhost:6379` |
| **Adapter** | A translator | An old app writes metrics in a custom format; an adapter converts them to Prometheus format |

## Static pods

Pods the kubelet runs directly from files on the node (`/etc/kubernetes/manifests`), without the API server. This is how the control plane itself runs on kubeadm and kind clusters.

## Watch out

> [!WARNING]
> - **Never store data inside a Pod's filesystem** unless you're happy to lose it. A restarted container starts from a clean image. Use volumes.
> - **Never hard-code Pod IPs.** They change on every restart. Use Services.
> - **Don't use `:latest` tags.** You won't know which version is running, and nodes may cache an old "latest". Use explicit versions like `1.4.2` or the image digest.
> - Only use multiple containers in one Pod when they truly must share a lifecycle and machine. `orders-api` and `payments-api` belong in **separate** Pods so they can scale and deploy independently.
> - Init containers re-run if the whole Pod restarts, so make them **idempotent** (running migrations twice must be safe; Flyway handles this).
> - Resource requests for sidecars count toward the Pod. A heavy mesh sidecar on 200 pods adds up to real money.

## Interview questions

**Pod vs container?** A container is one process environment. A Pod is a group of containers that share network and storage and are scheduled as one unit on one node.

**Why not put `orders-api` and its database in one Pod?** They scale differently, deploy on different schedules and have different storage needs. One Pod means one lifecycle: you couldn't add API replicas without adding databases.

**What are native sidecars and why do they matter?** Init containers with `restartPolicy: Always`. They start before the app, run alongside it, and stop after it, which fixed startup races and Jobs that never completed.
