# Ingress & Gateway API

> Ingress and Gateway API let one public entry point route web traffic to many internal Services based on the hostname and URL path. Gateway API is the modern, role-based successor to Ingress.

## The idea in one minute

| Concept | One line |
| --- | --- |
| North-south traffic | Requests coming from outside the cluster |
| Ingress | A list of HTTP routing rules; needs an **Ingress controller** to do anything |
| Gateway API | The successor: `GatewayClass` → `Gateway` → `HTTPRoute` / `GRPCRoute`, owned by different teams |
| TLS | Usually terminated at the entry point; **cert-manager** issues and renews certificates |
| Canary | Gateway API route **weights** split traffic with no extra tools |

## Real-life analogy

> [!TIP]
> **A mall's reception desk.** A shopping mall has one main entrance and a reception desk: "Food court? Second floor, left. Electronics? Ground floor, right." Shops don't each need their own entrance from the street. The reception desk is the Gateway; the shops are your Services.

## The problem it solves

FoodDash has dozens of services but wants one domain, one TLS setup, and one cloud load balancer bill. Without a router, every public service would need its own `LoadBalancer` Service and its own public IP. With one, only the Gateway is exposed; everything behind it stays a private ClusterIP Service. See [North-south traffic](#diagram/north-south).

## Ingress: the original way

An **Ingress** is a list of routing rules. It does nothing by itself: you also install an **Ingress controller** (Traefik, HAProxy, the AWS Load Balancer Controller, and others) that reads the rules and proxies traffic.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: fooddash
spec:
  ingressClassName: traefik
  tls:
    - hosts: [api.fooddash.in]
      secretName: fooddash-tls          # cert-manager can create and renew this from Let's Encrypt
  rules:
    - host: api.fooddash.in
      http:
        paths:
          - path: /orders
            pathType: Prefix
            backend: { service: { name: orders-api, port: { number: 80 } } }
          - path: /menus
            pathType: Prefix
            backend: { service: { name: restaurant-api, port: { number: 80 } } }
```

Ingress works, but it only covers basic HTTP routing. Anything fancier (rewrites, canary weights, timeouts) needs controller-specific **annotations**, which differ between vendors and lock you in.

## Gateway API: the modern way

Gateway API is the official successor to Ingress. It's richer, and it splits the job by **role**, the way real companies work ([Gateway API roles](#diagram/gateway-roles)):

| Object | Who owns it | Analogy |
| --- | --- | --- |
| `GatewayClass` | Cloud or platform vendor | The brand of reception desk you installed |
| `Gateway` | Platform team | The mall entrance: which ports, hostnames and TLS certificates are open |
| `HTTPRoute` / `GRPCRoute` | Each app team | Each shop's sign: "send `/orders` to me" |

The orders team can change its own routes without touching the shared entrance, and without platform-team tickets.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: orders
  namespace: fooddash
spec:
  parentRefs: [{ name: public-gateway, namespace: infra }]
  hostnames: [api.fooddash.in]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /orders } }]
      backendRefs:
        - { name: orders-api,        port: 80, weight: 95 }   # stable
        - { name: orders-api-canary, port: 80, weight: 5 }    # canary gets 5%
```

Follow one request through it on [Request flow](#diagram/request-flow). That `weight` field gives you **canary releases** with no extra tools; Argo Rollouts or Flagger can move the weights automatically based on metrics ([Canary by weight](#diagram/canary-weights)). Gateway API also supports matching on headers ("send beta testers with `x-beta: true` to the new version"), redirects and request mirroring.

Popular implementations: Envoy Gateway, Istio, Cilium, NGINX Gateway Fabric, Traefik, and cloud-native ones from AWS, GKE and Azure.

## Which should you learn?

Both. Many existing clusters run Ingress, so you'll meet it at work. For new setups, Gateway API is the recommended direction. The popular community `ingress-nginx` controller has been retired, which is pushing many teams to migrate, so knowing both is a real advantage in interviews.

## Watch out

> [!WARNING]
> - TLS is usually terminated at the Gateway. Use **cert-manager** to issue and auto-renew certificates; expired certificates are a classic outage.
> - A path like `/orders` with `Prefix` also matches `/orders/123` but **not** `/ordersummary`. Path rules are a common source of 404s.
> - The Gateway is a single entry point: run it with several replicas and a PodDisruptionBudget.
> - On kind or bare metal, `type: LoadBalancer` gets no external IP unless something provides one (cloud-provider-kind, MetalLB).

## Interview questions

**Ingress vs Gateway API?** Ingress is a single object with basic host/path rules and vendor annotations for everything else. Gateway API separates infrastructure (GatewayClass, Gateway) from routing (HTTPRoute), supports header matching and weighted splits natively, and lets app teams own their routes.

**How would you do a canary without a service mesh?** Two Deployments behind two Services, and an HTTPRoute with `backendRefs` weights (95/5), shifted gradually by a tool like Argo Rollouts while watching error rates.

**Why one load balancer for many services?** Cost and simplicity: one public IP and certificate setup, with L7 routing inside the cluster.
