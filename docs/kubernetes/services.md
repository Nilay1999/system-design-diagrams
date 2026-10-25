# Services

> A Service gives a group of Pods one stable name and IP address, and spreads traffic across whichever of them are healthy right now. It's service discovery and L4 load balancing built into the platform.

## The idea in one minute

| Piece | What it is |
| --- | --- |
| **Selector** | A label query, e.g. `app: payments-api`, that picks the pods behind the Service |
| **EndpointSlice** | The live list of **Ready** pod IPs matching the selector, kept up to date by a controller |
| **ClusterIP** | A fixed virtual IP for the Service; nothing "owns" it |
| **DNS name** | `payments-api` (same namespace) → the ClusterIP |
| **port / targetPort** | What callers use / what the container listens on |

See [How a Service works](#diagram/service-basics).

## Real-life analogy

> [!TIP]
> **A customer-care number.** FoodDash's customer-care number never changes, even though the agents behind it change every shift. You call one number; the phone system connects you to any free agent. If an agent leaves, calls simply go to others. A Service is that phone number; the Pods are the agents.

## The problem it solves

`orders-api` needs to call `payments-api`. But `payments-api` has 3 pods, their IPs change every deploy, and one may be unhealthy at any moment. Hard-coding IPs is impossible. You need a **stable address with built-in load balancing** that always points only at healthy pods.

## How it works

1. The Service has a **selector**, like `app: payments-api`.
2. Kubernetes continuously keeps a list of matching pods that are **Ready**, stored in **EndpointSlices**.
3. The Service gets a fixed virtual IP (the **ClusterIP**) and a DNS name (`payments-api`).
4. Traffic to that IP is forwarded to one of the Ready pods by kube-proxy rules on the caller's node (see *DNS, Service Discovery & kube-proxy*).

A pod failing its readiness probe is quietly dropped from the list, and added back when it recovers. That's how readiness and Services work together: [Readiness & endpoints](#diagram/readiness-endpoints).

## FoodDash example

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: fooddash
spec:
  selector:
    app: payments-api        # send traffic to pods with this label
  ports:
    - name: http
      port: 80               # the port callers use: http://payments-api:80
      targetPort: 8080       # the port the container listens on (or a named port)
```

`orders-api` now calls `http://payments-api/charge`. No IPs anywhere in its config.

## The five Service types

See [Service types](#diagram/service-types).

| Type | Analogy | Who can reach it | FoodDash use |
| --- | --- | --- | --- |
| **ClusterIP** (default) | An internal office extension | Only inside the cluster | `orders-api` → `payments-api` |
| **NodePort** | A side door with a number on every building | Anyone who can reach a node, at port 30000–32767 | Quick testing, or bare-metal setups behind your own load balancer |
| **LoadBalancer** | A public phone number with a receptionist | The internet (or your VPC) via a cloud load balancer | Exposing the Gateway/Ingress controller to the world |
| **ExternalName** | A call-forwarding rule | Inside the cluster; it's just a DNS alias | `db` → `fooddash.abc123.ap-south-1.rds.amazonaws.com` |
| **Headless** (`clusterIP: None`) | A staff directory with everyone's direct number | Inside; DNS returns every pod's IP | StatefulSets like Kafka or PostgreSQL replicas |

They build on each other: a LoadBalancer Service also gets a NodePort and a ClusterIP.

### Why not a LoadBalancer for every service?

Each `type: LoadBalancer` creates a **separate** cloud load balancer, which costs money every hour (roughly $16 to $20 a month each on AWS, before traffic). With 30 microservices, that's waste. Instead, create **one** load balancer in front of a Gateway or Ingress controller, which routes by URL to many ClusterIP Services.

## Debugging a Service

The most common Service bug is **empty endpoints**. In one real incident, someone renamed the Deployment's label to `app: order-service` while the Service still selected `app: orders-api`. The pods were Running and Ready, but every request got a 503. Walk through it on [Empty endpoints bug](#diagram/empty-endpoints).

```bash
kubectl get svc payments-api
kubectl get endpointslices -l kubernetes.io/service-name=payments-api   # empty = no matching Ready pods
kubectl get pods -l app=payments-api --show-labels
kubectl run tmp --rm -it --image=nicolaka/netshoot -- curl http://payments-api/actuator/health
kubectl port-forward svc/payments-api 8080:80      # reach it from your laptop
```

## Watch out

> [!WARNING]
> - **Empty endpoints** is the #1 Service bug. Cause: the selector doesn't match the pod labels, or no pod is Ready.
> - `port` is what callers use; `targetPort` is what the container listens on. Mixing them up gives "connection refused".
> - Services balance **connections**, not individual requests. With HTTP/2 or gRPC, one client may send everything to one pod.
> - `sessionAffinity: ClientIP` exists for sticky sessions, but storing sessions in Redis is the better design.
> - Keep the Service and Deployment in the same Helm chart, sharing one label value, so they can't drift apart.

## Interview questions

**How does a Service find pods?** Through a label selector. The EndpointSlice controller tracks Ready pods matching it; kube-proxy on every node programs rules that DNAT the ClusterIP to one of those pod IPs; CoreDNS maps the name to the ClusterIP.

**ClusterIP vs NodePort vs LoadBalancer?** Internal virtual IP / a port on every node / a cloud load balancer in front of those node ports. Each builds on the one before.

**When would you use a headless Service?** When clients need individual pod addresses: StatefulSet members (`postgres-0.postgres`), peer discovery in Kafka or Cassandra, or client-side gRPC load balancing.
