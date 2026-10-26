# Cheat Sheet: Glossary & Daily kubectl

> One-line definitions of every term in this guide, how the objects connect, and the commands you'll type every day.

## How the objects connect

The [Object map](#diagram/object-map) puts every core object around one Pod. Almost every arrow is a label selector or a name reference, which is why a single wrong label breaks so much.

## Glossary

| Term | In one line | Topic |
| --- | --- | --- |
| Cluster | Control plane + worker nodes, managed as one system | Cluster Architecture |
| Control plane | API server, etcd, scheduler, controllers: the brain | Cluster Architecture |
| Node | A machine (VM or physical) that runs pods | Cluster Architecture |
| kubelet | Agent on each node that runs and checks pods | Cluster Architecture |
| etcd | The database holding all cluster state | Cluster Architecture |
| Reconciliation | The endless loop making actual state match desired state | Why Kubernetes |
| Manifest | A YAML file describing an object | Objects & kubectl |
| Namespace | A named room inside a cluster for grouping and permissions | Objects & kubectl |
| Label / selector | Sticky notes on objects / queries that find them | Objects & kubectl |
| Pod | One or more containers sharing an IP, scheduled together | Pods |
| Probe | Health check: startup, readiness (traffic), liveness (restart) | Pod Lifecycle |
| Init container | Setup step that must finish before the app starts | Pods |
| Sidecar | Helper container running beside the app all the time | Pods |
| Requests / limits | Reserved resources / hard caps | Requests, Limits & QoS |
| QoS class | Guaranteed, Burstable, BestEffort: eviction order | Requests, Limits & QoS |
| ReplicaSet | Keeps N identical pods running | Deployments |
| Deployment | Manages ReplicaSets; rolling updates and rollbacks | Deployments |
| Service | Stable name + IP load-balancing to Ready pods | Services |
| EndpointSlice | The live list of pod IPs behind a Service | Services |
| CoreDNS | Cluster DNS: service names to IPs | DNS & kube-proxy |
| kube-proxy | Node-level rules routing Service IPs to pods | DNS & kube-proxy |
| Ingress / Gateway API | HTTP routing from outside into Services | Ingress & Gateway API |
| CNI | Plugin that gives pods IPs and connects them | Networking & NetworkPolicies |
| NetworkPolicy | Pod-level firewall rules | Networking & NetworkPolicies |
| ConfigMap / Secret | Settings / sensitive values kept out of the image | ConfigMaps & Secrets |
| PV / PVC / StorageClass | A disk / a request for one / a type of disk | Storage |
| StatefulSet | Pods with stable names and their own disks | StatefulSets |
| DaemonSet | One pod per node | DaemonSets & Jobs |
| Job / CronJob | Run to completion / on a schedule | DaemonSets & Jobs |
| Affinity / taint / toleration | Attract pods / repel pods / permit despite repelling | Scheduling |
| HPA / VPA / KEDA | Scale pod count / pod size / on event backlog | Autoscaling |
| Karpenter / Cluster Autoscaler | Add and remove nodes | Autoscaling |
| PDB | Minimum pods that must stay up during planned maintenance | PDBs & Upgrades |
| RBAC | Who may do which actions on which resources | RBAC |
| ServiceAccount | Identity for a pod | RBAC |
| Pod Security Standards | Privileged / Baseline / Restricted rule sets | Pod Security |
| Admission controller | Final check (or change) on every API request | Pod Security |
| Helm / Kustomize | Templated packages / patch-based overlays | Helm & Kustomize |
| GitOps | Git is the source of truth; the cluster pulls from it | GitOps |
| CRD / Operator | New object type / controller that runs it expertly | Operators |
| Service mesh | Proxy layer adding mTLS, retries, routing, metrics | Service Mesh |
| IRSA / Pod Identity | AWS permissions for pods without stored keys | EKS |

## Daily kubectl

Grouped by the question you're asking: see [kubectl by question](#diagram/kubectl-map).

```bash
# context and namespace
kubectl config get-contexts
kubectl config use-context <ctx>
kubectl config set-context --current --namespace=fooddash

# look
kubectl get pods -o wide
kubectl get all -n fooddash
kubectl get pods -l app=orders-api --show-labels
kubectl get pods -A --field-selector status.phase!=Running
kubectl describe pod <pod>
kubectl get events --sort-by=.lastTimestamp
kubectl top pods
kubectl top nodes

# logs and debugging
kubectl logs <pod> -f
kubectl logs <pod> --previous
kubectl logs -l app=orders-api --prefix --tail=100
kubectl exec -it <pod> -- sh
kubectl debug -it <pod> --image=nicolaka/netshoot --target=app
kubectl port-forward svc/orders-api 8080:80

# create and change
kubectl apply -f file.yaml        # or -f folder/  or -k overlay/
kubectl diff -f file.yaml
kubectl delete -f file.yaml
kubectl create deploy web --image=nginx:1.27 --dry-run=client -o yaml > web.yaml
kubectl scale deploy orders-api --replicas=5
kubectl set image deploy/orders-api app=fooddash/orders-api:1.5.1

# rollouts
kubectl rollout status deploy/orders-api
kubectl rollout history deploy/orders-api
kubectl rollout undo deploy/orders-api
kubectl rollout restart deploy/orders-api

# nodes
kubectl cordon <node>
kubectl uncordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
kubectl taint nodes <node> key=value:NoSchedule

# permissions and docs
kubectl auth can-i create deployments -n fooddash
kubectl api-resources
kubectl explain deployment.spec.strategy --recursive
```

> [!TIP]
> Speed tricks (also for the CKAD exam): `alias k=kubectl`, `export do="--dry-run=client -o yaml"`, `export now="--force --grace-period=0"`, and `source <(kubectl completion zsh)`.

## Watch out

> [!WARNING]
> - Check `kubectl config current-context` before anything destructive. Wrong cluster = wrong day.
> - Every emergency `kubectl` change must also land in Git, or the next apply or GitOps sync undoes it.
