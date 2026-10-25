# Service Mesh

> A service mesh adds a smart network layer between your services that handles encryption, retries, timeouts, traffic splitting and detailed metrics, without changing your app code.

## The idea in one minute

| Part | What it does |
| --- | --- |
| **Data plane** | A proxy handles each pod's traffic: an Envoy sidecar per pod (Istio), a tiny Rust proxy (Linkerd), or a per-node proxy (Istio ambient) |
| **Control plane** | Pushes routes, certificates and policies to every proxy (istiod) |
| Your app | Still calls `http://payments-api`; the proxy intercepts, encrypts, retries and records metrics |

## Real-life analogy

> [!TIP]
> **A courier company for internal mail.** Without a mesh, every department in FoodDash's office delivers its own internal letters: some seal envelopes, some don't; some retry when nobody answers, some give up. A service mesh hires **one courier company** for all internal mail. Every letter is sealed and signed (mTLS), tracked (metrics and traces), retried by a standard rule, and routes can be changed centrally.

## The problem it solves

FoodDash has 30 services in Java, Node.js and Go. Each needs encryption between services ("never trust the network"), retries with backoff, timeouts and circuit breaking, per-request load balancing (the gRPC problem), and canary routing with request-level metrics.

In the Spring Cloud world you might use Resilience4j for this, but that only covers Java. Re-implementing it in every language is expensive and inconsistent. A mesh moves it into the infrastructure. See [Sidecar mesh](#diagram/sidecar-mesh).

## What you get

| Feature | FoodDash example |
| --- | --- |
| **Automatic mTLS** | All traffic between services encrypted, and each side proves its identity, with zero code changes |
| **Identity-based authorization** | "Only `orders-api` may call `payments-api` `POST /charge`" (L7, beyond NetworkPolicies) |
| **Retries, timeouts, circuit breaking** | Retry `restaurant-api` twice on 503 with a 2-second timeout |
| **Traffic splitting** | 5% of `payments-api` traffic to v2 |
| **Golden metrics for every service** | Request rate, error rate and latency per service pair, out of the box |
| **Fault injection** | Add 3s delay to 10% of calls in staging to test resilience |

Follow one request on [A call through the mesh](#diagram/mtls-call).

```yaml
# Istio example: retries and timeout for calls to restaurant-api
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: { name: restaurant-api, namespace: fooddash }
spec:
  hosts: [restaurant-api]
  http:
    - timeout: 2s
      retries: { attempts: 2, perTryTimeout: 1s, retryOn: "5xx,connect-failure" }
      route:
        - destination: { host: restaurant-api }
```

## Sidecars vs ambient

The classic design puts an **Envoy sidecar** in every pod. The newer Istio **ambient mode** uses a shared per-node proxy (ztunnel) for mTLS, plus optional "waypoint" proxies for L7 features, with no sidecars at all. That means fewer containers, less memory per pod, and no sidecar startup races. See [Ambient mode](#diagram/ambient).

## Popular meshes

- **Istio:** most features, biggest community, more complex. Sidecar or ambient mode.
- **Linkerd:** simpler, lightweight, focused on mTLS, reliability and metrics.
- **Cilium service mesh:** eBPF-based, built into the Cilium CNI.

## Do you actually need one?

Often **not at first**. A mesh adds moving parts, CPU and memory per pod, and a new thing to debug at 3 AM. Good signs you need one: many services in several languages, a compliance requirement for encryption in transit, or recurring incidents from missing timeouts and retries. With 5 services, good client libraries and NetworkPolicies are usually enough.

> [!IMPORTANT]
> Saying this trade-off out loud is a strong interview answer: a mesh is a tool for a scale of problem, not a default.

## Watch out

> [!WARNING]
> - **Retries multiply.** If 3 layers each retry 3 times, one failing call becomes 27 ([Retries multiply](#diagram/retry-storm)). Configure retries in one place only.
> - Retrying non-idempotent calls (like `POST /charge`) can double-charge customers. Only retry safe operations, or use idempotency keys.
> - Sidecars must be ready before the app and stop after it; native sidecars fixed most of these startup and shutdown races.

## Interview questions

**What does a service mesh give you that Kubernetes doesn't?** mTLS with workload identity, L7 authorization, per-request load balancing, retries/timeouts/circuit breaking, traffic splitting and uniform golden metrics, all outside the application code.

**When would you not use a mesh?** Few services, one language with good resilience libraries, no encryption-in-transit requirement, or a team without capacity to operate it.

**Data plane vs control plane?** The data plane proxies carry the traffic; the control plane configures them and issues certificates.
