# DNS, Service Discovery & kube-proxy

> CoreDNS turns a Service name into its IP; kube-proxy makes sure traffic sent to that IP lands on a real pod. Discovery is built into the platform: your app just calls a hostname.

## The idea in one minute

| Step | Who does it | What happens |
| --- | --- | --- |
| 1 | Your app | Calls `http://payments-api/charge` |
| 2 | CoreDNS | Resolves `payments-api.fooddash.svc.cluster.local` to the ClusterIP |
| 3 | Kernel rules written by kube-proxy | Rewrite the ClusterIP to one Ready pod IP, **on the caller's own node** |
| 4 | The pod | Receives the packet with the caller's real pod IP as source |

Follow it on [A call, end to end](#diagram/call-path).

## Real-life analogy

> [!TIP]
> **The phonebook and the switchboard.** **CoreDNS** is the phonebook: you look up "payments-api" and get a number. **kube-proxy** is the switchboard: when you dial that number, it connects you to an actual agent's desk.

## The problem it solves

In the Spring Cloud world you may have used Eureka or Consul: every service registers itself, and clients use a library to look others up. Kubernetes builds discovery **into the platform**. Your app just calls a hostname. No registry library, no client-side load balancer, in any language.

## How DNS names work

Every Service gets a DNS name in this shape:

```text
<service>.<namespace>.svc.cluster.local
payments-api.fooddash.svc.cluster.local
```

| Calling from | You can use |
| --- | --- |
| Same namespace (`fooddash`) | `payments-api` |
| Another namespace (`delivery`) | `payments-api.fooddash` |
| Anywhere, fully qualified | `payments-api.fooddash.svc.cluster.local` |
| A StatefulSet pod via headless Service | `postgres-0.postgres.fooddash.svc.cluster.local` |

CoreDNS itself runs as normal pods in `kube-system`. Each pod's `/etc/resolv.conf` points at it.

```bash
kubectl run tmp --rm -it --image=nicolaka/netshoot -- bash
nslookup payments-api
cat /etc/resolv.conf     # see the search domains and "options ndots:5"
```

## How kube-proxy routes traffic

The ClusterIP isn't a real machine; nothing "owns" it. kube-proxy runs on **every node** and writes rules in the Linux kernel that say: "packets going to 10.96.12.34:80, rewrite them to go to one of these pod IPs on port 8080." So the load balancing happens right on the caller's own node, with no central proxy to become a bottleneck. See [kube-proxy modes](#diagram/kube-proxy-modes).

| Mode | How | Notes |
| --- | --- | --- |
| iptables | Kernel firewall rules, random pick per connection | The long-time default; slows down with thousands of Services |
| IPVS | Kernel load balancer with hash tables | Faster at large scale; round-robin, least-connections |
| nftables | Modern successor of iptables mode | Available in recent Kubernetes versions |
| eBPF (Cilium) | Replaces kube-proxy completely | Fastest; adds deep network visibility |

## The gRPC / HTTP/2 gotcha (a senior-level favourite)

kube-proxy balances **connections**, not requests. FoodDash's `delivery-tracker` calls `eta-service` over gRPC. gRPC opens **one** long-lived connection and sends thousands of requests over it. Result: all traffic goes to one `eta-service` pod while the others sit idle. See [The gRPC gotcha](#diagram/grpc-gotcha).

Fixes:

1. Use a **headless Service** so DNS returns all pod IPs, and let the gRPC client balance across them itself (`round_robin` policy).
2. Use a **service mesh** or L7 proxy (Envoy, Linkerd), which balances per request.

## The `ndots:5` slowness

For a name with fewer than 5 dots, like `api.razorpay.com`, the pod first tries `api.razorpay.com.fooddash.svc.cluster.local`, then the other search suffixes, before the real name. That's several wasted lookups per external call ([ndots:5 lookups](#diagram/ndots)).

```yaml
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"        # or call api.razorpay.com. with a trailing dot
```

## Watch out

> [!WARNING]
> - Some apps (old JVM settings, some HTTP clients) cache DNS forever. That's usually fine for ClusterIPs (they're stable) but breaks with headless Services, where pod IPs change.
> - If a NetworkPolicy blocks egress to port 53, **every** DNS lookup fails, and errors look like "unknown host" everywhere.
> - CoreDNS is a single point of pain: give it enough replicas and consider NodeLocal DNSCache on large clusters.

## Check your understanding

**How does service discovery work in Kubernetes?** CoreDNS maps Service names to ClusterIPs; the EndpointSlice controller tracks Ready pods; kube-proxy programs every node so connections to the ClusterIP are DNATed to a Ready pod.

**One gRPC backend pod gets all the traffic. Why, and how do you fix it?** Balancing is per connection, and gRPC holds one long connection. Use a headless Service with client-side round-robin, or a mesh/L7 proxy that balances per request.

**Is there a central load balancer for ClusterIP traffic?** No. The rewrite happens in the kernel of the caller's node, so there's no extra hop and no bottleneck.
