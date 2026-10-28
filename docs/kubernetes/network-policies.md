# Pod Networking, CNI & NetworkPolicies

> Every pod gets its own IP and can reach every other pod by default. A CNI plugin builds that network, and NetworkPolicies act as firewalls to restrict it.

## The idea in one minute

| Concept | One line |
| --- | --- |
| Flat network | Every pod has a unique IP and reaches every other pod without NAT |
| CNI plugin | The add-on that assigns pod IPs and routes traffic between nodes |
| NetworkPolicy | Selects pods by label and lists the traffic **allowed** in and/or out |
| Default deny | Once any policy selects a pod for a direction, everything not allowed is denied |
| Enforcement | Only if your CNI supports it (Calico, Cilium do; plain Flannel doesn't) |

## Real-life analogy

> [!TIP]
> **A gated housing society.** Every flat (pod) has its own address. By default there are **no internal gates**: anyone can walk to any flat. The **CNI plugin** is the civil engineer who laid the roads between buildings. **NetworkPolicies** are security guards you post at specific buildings: "only residents of Block A may enter Block C."

## The Kubernetes network rules

Kubernetes makes three promises, and every network setup must keep them ([The flat network](#diagram/flat-network)):

1. Every pod gets its own unique IP.
2. Any pod can talk to any other pod, even on another node, **without NAT** (the receiver sees the sender's real pod IP).
3. Node agents (like the kubelet) can reach every pod on their node.

This "flat network" makes life simple: pods behave like VMs on one big LAN.

## CNI: who builds the network

Kubernetes doesn't ship a network. A **CNI plugin** is installed to assign pod IPs and route traffic between nodes.

| CNI | How it works | Known for |
| --- | --- | --- |
| **AWS VPC CNI** | Pods get real IPs from your VPC subnets | Default on EKS; pods directly reachable in the VPC; can run out of IPs in small subnets |
| **Calico** | BGP routing or overlay | Strong NetworkPolicy support; very common |
| **Cilium** | eBPF in the Linux kernel | Fast; can replace kube-proxy; deep visibility (Hubble) |
| **Flannel** | Simple VXLAN overlay | Easy to set up; **does not enforce** NetworkPolicies |

## The problem NetworkPolicies solve

Open-by-default is dangerous. If an attacker breaks into FoodDash's public-facing `restaurant-api` through a bug, they can directly connect to the `payments` database, because nothing stops pod-to-pod traffic. NetworkPolicies give you **zero-trust**, least-privilege networking: each service may only talk to what it actually needs.

## How NetworkPolicies work

- A policy **selects pods** (by label) and lists what traffic is **allowed** in (ingress) and/or out (egress).
- Once any policy selects a pod for a direction, **everything not explicitly allowed is denied** for that direction.
- Policies are additive allow lists. There's no "deny" rule; you deny by not allowing.
- They only work if your CNI enforces them.

## FoodDash example: lock down the payments database

The whole picture is on [Payments lockdown](#diagram/lockdown).

Step 1, default deny for the whole namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: payments }
spec:
  podSelector: {}               # empty = every pod in the namespace
  policyTypes: [Ingress, Egress]
```

Step 2, allow only `payments-api` to reach PostgreSQL:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: postgres-from-payments-api, namespace: payments }
spec:
  podSelector: { matchLabels: { app: payments-postgres } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: payments-api } }
      ports: [{ protocol: TCP, port: 5432 }]
```

Step 3, let pods still use DNS (otherwise nothing resolves):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns, namespace: payments }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } }
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
```

You'd add more rules like "allow `orders-api` from the `fooddash` namespace to reach `payments-api` on 8080" and "allow `payments-api` egress to the bank's API."

## The AND vs OR trap

`from` with a `namespaceSelector` and `podSelector` **in the same list item** means AND (that pod, in that namespace). As **two separate items**, it means OR. A single dash in YAML changes the meaning, and this trips up experienced engineers. See [AND vs OR selectors](#diagram/and-vs-or).

## Watch out

> [!WARNING]
> - Default-deny egress without the DNS rule breaks everything with confusing "unknown host" errors.
> - Standard NetworkPolicies work on IPs and ports (L3/L4). For rules like "allow only `GET /menus`" or "allow egress to `api.razorpay.com` by name", you need Cilium policies or a service mesh.
> - Test policies: `kubectl exec` into an allowed and a denied pod and run `nc -zv payments-postgres 5432`.
> - Namespaces are not a network boundary on their own. Without policies, every namespace can reach every other.

## Check your understanding

**By default, can a pod in namespace A reach a pod in namespace B?** Yes. Pod networking is flat; only NetworkPolicies (enforced by the CNI) restrict it.

**How do you build a zero-trust network in Kubernetes?** A default-deny policy per namespace for ingress and egress, explicit allow rules per dependency, an allow rule for DNS, and a CNI that enforces policies. Add a mesh for identity-based L7 rules and mTLS.

**Why might a NetworkPolicy have no effect?** The CNI doesn't enforce policies (e.g. plain Flannel), or the `podSelector` doesn't match the pods you think it does.
