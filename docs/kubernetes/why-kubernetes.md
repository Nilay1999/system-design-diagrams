# Why Kubernetes & Desired State

> Kubernetes runs your containers across many machines and keeps them healthy without you babysitting them. You tell it what you want, and it keeps working until reality matches.

## The idea in one minute

| Question | Short answer |
| --- | --- |
| What is it? | A system that runs containers on a group of machines (a **cluster**) and keeps them running |
| What do you give it? | A description of what you want, in YAML: "3 copies of `orders-api` v1.4, 1 CPU each" |
| What does it do with that? | Stores the wish, then compares it with reality **forever** and fixes any difference |
| What is that loop called? | **Reconciliation**. It is behind self-healing, rollouts, autoscaling and GitOps |
| When is it the wrong tool? | Two services and five users. A simpler platform (ECS, Render, a single VM) may be happier |

Every topic in this guide uses one made-up food-delivery app, **FoodDash**, so each new idea lands on something you already picture:

| Service | What it does | Tech |
| --- | --- | --- |
| `orders-api` | Takes orders from the mobile app | Spring Boot, PostgreSQL |
| `payments-api` | Charges cards and UPI | Spring Boot |
| `restaurant-api` | Menus, opening hours | Node.js, MongoDB |
| `delivery-tracker` | Live rider location | Go, Redis |
| `notification-worker` | Sends SMS and push alerts; reads from Kafka | Node.js |
| `report-job` | Builds daily sales reports for restaurants | Java batch job |

## A 60-second container recap

A **container** packages your app with everything it needs: the JVM, libraries, config files. It runs the same on your laptop, a test server and production. A **container image** is the frozen package (like a `.jar`, but for the whole environment). A running container is that image brought to life.

Docker solved "it works on my machine". But Docker on one server doesn't answer the questions that matter in production: what happens when that server dies, when traffic jumps 5×, or when you need to ship a fix without dropping requests?

## The problem: FoodDash on Friday night

Imagine FoodDash runs on 10 servers with Docker, and you manage them by hand. See the left half of [Before vs after](#diagram/before-after).

- **8 PM, dinner rush:** orders jump 5×. Someone has to SSH into servers and start more `orders-api` containers. By the time they do, customers have already seen errors.
- **8:30 PM:** one server's disk dies. Four containers vanish. Nobody notices until Twitter does.
- **9 PM:** you need to ship a bug fix. You stop the old containers and start new ones, one server at a time, praying no requests drop.
- **Every day:** which container is on which server? Which port? How does `orders-api` find `payments-api` when its IP keeps changing?

Each of these is a job a human is doing badly at 9 PM on a Friday.

## What Kubernetes gives you

> [!TIP]
> **Real-life analogy: a restaurant manager.** A small dhaba can run with the owner doing everything. A restaurant chain with 50 kitchens cannot. It needs a **manager** who knows how many cooks each kitchen should have and hires a replacement the moment one leaves, calls in extra cooks during the rush, decides which kitchen has room, changes the menu one kitchen at a time, and keeps one phone number for "orders" no matter which cook picks up. Kubernetes is that manager for your containers. See [The manager analogy](#diagram/manager).

| Problem | What Kubernetes does | Feature name |
| --- | --- | --- |
| A container crashes | Restarts it automatically | Self-healing |
| A whole server dies | Recreates its containers on healthy servers | Self-healing + scheduling |
| Traffic spikes | Adds more copies (and even more servers) | Autoscaling |
| Shipping a new version | Replaces copies gradually; rolls back if it goes wrong | Rolling updates |
| Services finding each other | Gives each service a stable name and IP | Service discovery |
| Config and passwords | Stores them separately from the image | ConfigMaps, Secrets |
| Wasted servers | Packs containers onto machines efficiently | Bin-packing scheduler |

## The key idea: desired state

You don't give Kubernetes step-by-step orders. You describe the result you want:

> "I want 3 copies of `orders-api` version 1.4, each with 1 CPU and 1 GB memory, reachable at the name `orders-api`."

Kubernetes stores that wish, then constantly compares it with reality. If only 2 copies are running, it starts one more. If someone deletes one by mistake, it comes back. This never-ending "compare and fix" loop is called **reconciliation**. Open the [Reconciliation loop](#diagram/reconciliation) diagram and keep it in mind: every later topic is a variation of it.

```text
for {
    desired := apiServer.get(object.spec)
    actual  := observe(world)            // via watches, not polling
    if diff(desired, actual) != nil {
        act(diff)                         // create/delete pods, update iptables, attach volume...
    }
    object.status = actual                // report back
}
```

> [!IMPORTANT]
> The loop is **level-triggered, not edge-triggered**. A controller does not care *which event* happened, only *what the difference is now*. That is why Kubernetes heals itself after missed events, crashes and network partitions: the next pass simply sees the gap and closes it.

Think of a thermostat. You set 24°C. You don't switch the AC on and off yourself; the thermostat keeps checking and correcting. Kubernetes is a thermostat for your servers.

## Map what you already know

If you've built backend systems, most of Kubernetes' internals are ideas you already use. These comparisons make for strong interview answers because they show understanding rather than memorisation.

| You already know | Kubernetes equivalent | Why it matters |
| --- | --- | --- |
| Event sourcing / CDC stream | API server **watch** streams (`resourceVersion`) | Controllers consume a change stream from etcd, like a Debezium consumer |
| Optimistic locking (version column) | `resourceVersion` on every object | Concurrent updates fail with 409 Conflict; clients retry |
| Eventual consistency | Reconciliation loops | The system converges; there is no global transaction |
| Saga / compensating actions | Controllers + finalizers | Multi-step cleanup without 2PC; finalizers block deletion until cleanup is done |
| Service registry (Eureka, Consul) | Service + EndpointSlice + CoreDNS | Discovery is built in; no client-side registry library |
| Client-side load balancing (Ribbon) | kube-proxy / Service virtual IP | L4 balancing is done by the node, not the app |
| Health checks in a load balancer | Readiness and liveness probes | Readiness removes from traffic; liveness restarts |
| Leader election (ZooKeeper) | Lease objects in `coordination.k8s.io` | The scheduler and controller manager use it for HA |
| Spring profiles / `.env` files | ConfigMaps and Secrets | Config is decoupled from the image |
| Circuit breaker, retries, mTLS | Service mesh (Istio, Linkerd) | Not core Kubernetes, but a frequent follow-up |

## How to study each topic

Every topic in this guide follows the same pattern, so you always know where to look: the idea in one line, a **real-life analogy**, **the problem it solves**, **how it works**, a **FoodDash example** with the YAML you'd write, and a **watch out** list of common mistakes and interview traps.

For every topic, aim to be able to:

1. **Draw it.** Each topic's diagram tabs are the drawings to practise.
2. **Write its YAML from memory.**
3. **Break it on purpose and fix it with `kubectl`.** Interviewers test all three.

## Watch out

> [!WARNING]
> - Kubernetes is not a replacement for Docker images. You still build images; Kubernetes runs them.
> - Kubernetes is not always the right answer. For a small team with a few services, ECS or a PaaS can be the better call. Saying this trade-off out loud in an interview shows maturity.
> - "K8s" is just short for Kubernetes: K, then 8 letters, then s.

## Interview questions

**Why Kubernetes over plain Docker or ECS?** It gives declarative desired state with self-healing, built-in service discovery and load balancing, rolling deploys and rollbacks, autoscaling, and a huge extension ecosystem (CRDs, operators) that is portable across clouds. The cost is operational complexity; for a small team with a few services, ECS or a PaaS can be the better call.

**What does "declarative" mean in Kubernetes?** You describe the end state, not the steps. Kubernetes stores it and controllers keep driving the actual state towards it, so the same file can be applied again and again with the same result.

**Why does Kubernetes recover from crashes so well?** Every component is a level-triggered control loop that reads the latest state from the API server. After a restart it doesn't need to replay what it missed; it compares desired with actual and fixes the gap.
