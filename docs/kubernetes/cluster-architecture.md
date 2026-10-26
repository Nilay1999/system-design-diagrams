# Cluster Architecture

> A cluster is a **control plane** (the brain that decides) plus **worker nodes** (the machines that do the work). Every component, including the control plane's own scheduler and controllers, is just a client of the API server.

## The idea in one minute

| Part | Where it runs | Job in one line |
| --- | --- | --- |
| kube-apiserver | Control plane | The only front door; checks who you are, then saves your request |
| etcd | Control plane | The database holding the entire cluster state |
| kube-scheduler | Control plane | Picks a node for every new pod |
| kube-controller-manager | Control plane | Runs the controllers that close gaps ("want 3, have 2") |
| cloud-controller-manager | Control plane | Talks to AWS/GCP/Azure: load balancers, deleted VMs |
| kubelet | Every node | Runs the pods assigned to its node and reports their health |
| kube-proxy | Every node | Writes network rules so Service IPs reach pods |
| Container runtime | Every node | Pulls images and runs containers (containerd, CRI-O) |

See the [Architecture](#diagram/architecture) diagram.

## Real-life analogy

> [!TIP]
> **A restaurant chain.** **Head office** (the control plane) takes orders, writes them in the order book, and decides which kitchen cooks what. **Kitchens** (worker nodes) have chefs and stoves that actually cook. Each dish being cooked is a **Pod**. Nobody walks into a kitchen and shouts orders: head office writes everything at the front desk, and the chefs keep checking the front desk for new work.

That one rule, "write it down at the front desk and let everyone watch", is why Kubernetes survives crashes so well: any part can restart and simply read the latest state again.

## Who's who

| Component | Restaurant role | What it really does | Interview detail |
| --- | --- | --- | --- |
| **kube-apiserver** | Front desk | The only entry point. `kubectl`, dashboards, CI and every other component talk to it. It authenticates, authorises, runs admission checks, then saves the object | Stateless and horizontally scalable behind a load balancer |
| **etcd** | The order book | A small, very reliable key-value store holding every Deployment, Pod and Secret | Raft consensus; needs a quorum of (n/2)+1, so run 3 or 5 members |
| **kube-scheduler** | Host who assigns kitchens | Looks at pods with no node yet and picks the best one | Two phases: **filter** (nodes that fit) then **score** (best node) |
| **kube-controller-manager** | Floor managers | Runs many small controllers: ReplicaSet, Deployment, Node, Job, EndpointSlice, ServiceAccount | Active-passive HA using a Lease lock |
| **cloud-controller-manager** | Talks to the landlord | Creates cloud load balancers, labels nodes with zones, removes deleted VMs | Why `type: LoadBalancer` works on EKS but not on a bare laptop cluster |
| **kubelet** | Station chef | Sees "this pod is assigned to me", starts its containers, runs probes, reports back | Not a pod itself (a systemd service); also runs static pods |
| **kube-proxy** | Waiter who routes orders | Programs iptables/IPVS/nftables rules so Service IPs route to pod IPs | Replaced entirely by eBPF in Cilium's kube-proxy-free mode |
| **Container runtime** | Stoves and tools | Pulls images, creates containers | Docker shim removed in v1.24; Docker-built images still run |
| **CoreDNS** | The phonebook | Cluster DNS: `orders-api.fooddash.svc.cluster.local` | An add-on running as pods in `kube-system`, not a core binary |

## What happens when you run `kubectl apply`

This is the single most-asked architecture question. Follow it on [kubectl apply, step by step](#diagram/apply-flow).

1. `kubectl` reads your kubeconfig and sends an HTTPS request to the **API server**.
2. The API server **authenticates** you (certificate, token, OIDC), **authorises** the request (RBAC), runs **mutating** admission (for example sidecar injection), validates the schema, then runs **validating** admission (policy checks).
3. The Deployment is written to **etcd**. The API server returns `201 Created`.
4. The **Deployment controller** sees the new object on its watch and creates a **ReplicaSet**.
5. The **ReplicaSet controller** sees it and creates 3 **Pod** objects with an empty `spec.nodeName`.
6. The **scheduler** sees pods with no node, filters and scores nodes, and writes a **Binding** (sets `nodeName`).
7. The **kubelet** on that node sees a pod bound to it. It asks the runtime (CRI) to pull the image and create the pod sandbox; the network plugin (CNI) gives the pod an IP; the storage driver (CSI) mounts any volumes.
8. The kubelet starts the containers, runs startup and readiness probes, and reports `Running` and `Ready` in `pod.status`.
9. Once the pod is Ready, the **EndpointSlice controller** adds its IP to matching Services, and **kube-proxy** on every node updates its rules. Traffic flows.

> [!IMPORTANT]
> No component orders another around. The scheduler doesn't tell the kubelet to start a pod: it writes `spec.nodeName` to the API server, and the kubelet sees that change on its watch. Every step is someone *noticing* a change and reacting.

## The three plugin interfaces

The kubelet doesn't do the low-level work itself. It calls a plugin for each job (see [CRI, CNI, CSI](#diagram/plugin-interfaces)):

- **CRI (Container Runtime Interface):** kubelet to runtime (containerd, CRI-O). Pulls images, creates containers.
- **CNI (Container Network Interface):** gives each pod an IP and connects pods across nodes (Calico, Cilium, Flannel, AWS VPC CNI).
- **CSI (Container Storage Interface):** attaches and mounts volumes (EBS CSI driver, EFS, Longhorn).

Kubernetes defines the contract; vendors implement it. That's why you can swap the network plugin without changing Kubernetes itself.

## Static pods

A special case: pods the kubelet runs directly from files on the node (`/etc/kubernetes/manifests`), without the API server. This is how the control plane itself (API server, etcd, scheduler) runs on clusters built with kubeadm or kind. Chicken-and-egg solved.

## High availability and failure modes

A production control plane runs 3 API servers behind a load balancer, 3 or 5 etcd members, and a scheduler and controller manager with leader election (only one is active; the others wait on a Lease lock). Managed services (EKS, GKE, AKS) run all of this for you. See [HA & failure modes](#diagram/ha-failures).

| If this fails | What happens to FoodDash |
| --- | --- |
| One worker node | Its pods are recreated on other nodes within a few minutes |
| API server | Running apps keep serving customers, but you can't deploy, scale or fix anything |
| etcd (no quorum) | Same as above; a lost etcd without backups means rebuilding the cluster |
| Scheduler | Existing pods are fine; new pods stay `Pending` |
| kubelet on a node | That node is marked `NotReady`; its pods are moved elsewhere |

How a dead node is handled: the node controller marks it `NotReady` after it misses heartbeats (node Lease objects in `kube-node-lease`). Pods are evicted after a default toleration of about 5 minutes and recreated elsewhere by their controllers.

> [!NOTE]
> Running pods keep working when the control plane is down because the kubelet and kube-proxy act on their last known state. What stops is *change*: no scheduling, scaling, self-healing or config updates until it's back.

## Watch out

> [!WARNING]
> - In managed Kubernetes (EKS, GKE, AKS) the cloud provider runs the control plane. You manage only worker nodes, or not even those with serverless options like Fargate or GKE Autopilot.
> - etcd uses a voting system (Raft). With 3 members, 2 must agree; with 5, 3 must agree. Always run an **odd** number.
> - Back up etcd (`etcdctl snapshot save`) before upgrades. It's a CKA exam task too.

## Interview questions

**Walk me through `kubectl apply` to a running pod.** The 9 steps above: authn, authz, admission, etcd, Deployment controller, ReplicaSet controller, scheduler binding, kubelet with CRI/CNI/CSI, probes, then endpoints and kube-proxy.

**What happens if the control plane goes down?** Existing pods keep running and serving; no scheduling, scaling, self-healing or config changes happen until it's back.

**Why is the API server the only component that talks to etcd?** It's the single place that enforces authentication, authorisation, admission and validation, and it turns etcd's change stream into watches that every other component consumes.
