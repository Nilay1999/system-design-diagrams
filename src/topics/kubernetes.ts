import type { DiagramSpec } from "../diagrams/dsl";
import type { Topic } from "./types";

import whyKubernetes from "../diagrams/kubernetes/why-kubernetes";
import clusterArchitecture from "../diagrams/kubernetes/cluster-architecture";
import objectsKubectl from "../diagrams/kubernetes/objects-kubectl";
import pods from "../diagrams/kubernetes/pods";
import podLifecycle from "../diagrams/kubernetes/pod-lifecycle";
import resources from "../diagrams/kubernetes/resources";
import deployments from "../diagrams/kubernetes/deployments";
import storage from "../diagrams/kubernetes/storage";
import statefulsets from "../diagrams/kubernetes/statefulsets";
import daemonsetsJobs from "../diagrams/kubernetes/daemonsets-jobs";
import services from "../diagrams/kubernetes/services";
import dnsKubeProxy from "../diagrams/kubernetes/dns-kube-proxy";
import ingressGateway from "../diagrams/kubernetes/ingress-gateway";
import networkPolicies from "../diagrams/kubernetes/network-policies";
import serviceMesh from "../diagrams/kubernetes/service-mesh";
import configSecrets from "../diagrams/kubernetes/config-secrets";
import rbac from "../diagrams/kubernetes/rbac";
import podSecurity from "../diagrams/kubernetes/pod-security";
import scheduling from "../diagrams/kubernetes/scheduling";
import autoscaling from "../diagrams/kubernetes/autoscaling";
import disruptions from "../diagrams/kubernetes/disruptions";
import observability from "../diagrams/kubernetes/observability";
import troubleshooting from "../diagrams/kubernetes/troubleshooting";
import helmKustomize from "../diagrams/kubernetes/helm-kustomize";
import gitops from "../diagrams/kubernetes/gitops";
import operators from "../diagrams/kubernetes/operators";
import eks from "../diagrams/kubernetes/eks";
import cheatSheet from "../diagrams/kubernetes/cheat-sheet";
import labsAndPractice from "../diagrams/kubernetes/labs-and-practice";

// Docs live in docs/kubernetes/ so they are readable on GitHub without running the app.
const docs = import.meta.glob<string>("../../docs/kubernetes/*.md", { query: "?raw", import: "default", eager: true });

function doc(slug: string): string {
  const source = docs[`../../docs/kubernetes/${slug}.md`];
  if (source === undefined) throw new Error(`Missing document docs/kubernetes/${slug}.md`);
  return source;
}

type KubernetesCategory =
  | "Foundations"
  | "Workloads"
  | "Networking"
  | "Config & Security"
  | "Scheduling & Scaling"
  | "Operations & Delivery"
  | "Reference";

type TopicMeta = Omit<Topic, "doc" | "source" | "track" | "category" | "diagrams"> & {
  category: KubernetesCategory;
  diagrams: DiagramSpec[];
};

// Sidebar and learning-path order follow this list.
const META: TopicMeta[] = [
  {
    slug: "why-kubernetes",
    title: "Why Kubernetes & Desired State",
    category: "Foundations",
    summary: "What problem Kubernetes solves, and the reconciliation loop behind every feature.",
    tags: ["desired state", "reconciliation", "self-healing", "containers"],
    diagrams: whyKubernetes,
  },
  {
    slug: "cluster-architecture",
    title: "Cluster Architecture",
    category: "Foundations",
    summary: "Control plane and worker nodes, what each component does, and what happens on kubectl apply.",
    tags: ["control plane", "etcd", "kubelet", "scheduler", "CRI/CNI/CSI"],
    diagrams: clusterArchitecture,
  },
  {
    slug: "objects-kubectl",
    title: "Objects, kubectl, Namespaces & Labels",
    category: "Foundations",
    summary: "YAML anatomy, declarative vs imperative, kubeconfig, namespaces, labels, selectors and annotations.",
    tags: ["YAML", "kubectl", "namespaces", "labels", "selectors"],
    diagrams: objectsKubectl,
  },
  {
    slug: "pods",
    title: "Pods & Multi-Container Patterns",
    category: "Workloads",
    summary: "The smallest unit Kubernetes runs: shared IP and volumes, init containers, native sidecars, ambassadors and adapters.",
    tags: ["pods", "init containers", "sidecars", "ambassador", "adapter"],
    diagrams: pods,
  },
  {
    slug: "pod-lifecycle",
    title: "Pod Lifecycle, Probes & Graceful Shutdown",
    category: "Workloads",
    summary: "Phases and restart policies, startup/readiness/liveness probes, and how a pod says goodbye without dropping requests.",
    tags: ["probes", "readiness", "liveness", "SIGTERM", "CrashLoopBackOff"],
    diagrams: podLifecycle,
  },
  {
    slug: "resources",
    title: "Requests, Limits & QoS",
    category: "Workloads",
    summary: "How requests drive scheduling, why CPU throttles but memory kills, QoS eviction order, LimitRange and ResourceQuota.",
    tags: ["requests", "limits", "OOMKilled", "QoS", "ResourceQuota"],
    diagrams: resources,
  },
  {
    slug: "deployments",
    title: "Deployments & Rolling Updates",
    category: "Workloads",
    summary: "ReplicaSets, rolling updates with maxSurge/maxUnavailable, rollbacks, blue/green and canary, expand and contract.",
    tags: ["Deployment", "ReplicaSet", "rolling update", "canary", "rollback"],
    diagrams: deployments,
  },
  {
    slug: "storage",
    title: "Volumes, PV, PVC & StorageClass",
    category: "Workloads",
    summary: "Storage that outlives a pod: claims, classes, CSI drivers, access modes, reclaim policies and the zone trap.",
    tags: ["PVC", "PV", "StorageClass", "CSI", "EBS"],
    diagrams: storage,
  },
  {
    slug: "statefulsets",
    title: "StatefulSets",
    category: "Workloads",
    summary: "Pods with stable names, per-pod DNS and their own disks; ordered operations; and what a StatefulSet won't do for you.",
    tags: ["StatefulSet", "headless Service", "volumeClaimTemplates", "databases"],
    diagrams: statefulsets,
  },
  {
    slug: "daemonsets-jobs",
    title: "DaemonSets, Jobs & CronJobs",
    category: "Workloads",
    summary: "One pod per node, run-to-completion tasks, schedules, retries, concurrency policies and choosing the right controller.",
    tags: ["DaemonSet", "Job", "CronJob", "batch"],
    diagrams: daemonsetsJobs,
  },
  {
    slug: "services",
    title: "Services",
    category: "Networking",
    summary: "A stable name and IP in front of changing pods: selectors, EndpointSlices, the five Service types and the empty-endpoints bug.",
    tags: ["Service", "ClusterIP", "LoadBalancer", "EndpointSlice", "headless"],
    diagrams: services,
  },
  {
    slug: "dns-kube-proxy",
    title: "DNS, Service Discovery & kube-proxy",
    category: "Networking",
    summary: "How a Service name becomes a pod IP: CoreDNS, kube-proxy modes, the gRPC connection gotcha and ndots:5.",
    tags: ["CoreDNS", "kube-proxy", "iptables", "gRPC", "ndots"],
    diagrams: dnsKubeProxy,
  },
  {
    slug: "ingress-gateway",
    title: "Ingress & Gateway API",
    category: "Networking",
    summary: "One public entry point routing by host and path; Gateway API roles, TLS with cert-manager, and canaries by weight.",
    tags: ["Ingress", "Gateway API", "HTTPRoute", "TLS", "canary"],
    diagrams: ingressGateway,
  },
  {
    slug: "network-policies",
    title: "Pod Networking, CNI & NetworkPolicies",
    category: "Networking",
    summary: "The flat pod network, CNI plugins, default-deny firewalls and the AND vs OR selector trap.",
    tags: ["CNI", "NetworkPolicy", "Calico", "Cilium", "zero trust"],
    diagrams: networkPolicies,
  },
  {
    slug: "service-mesh",
    title: "Service Mesh",
    category: "Networking",
    summary: "mTLS, retries, traffic splitting and golden metrics without code changes; sidecars vs ambient; when you don't need one.",
    tags: ["Istio", "Linkerd", "Envoy", "mTLS", "retries"],
    diagrams: serviceMesh,
  },
  {
    slug: "config-secrets",
    title: "ConfigMaps & Secrets",
    category: "Config & Security",
    summary: "Keep config out of the image: three ways to consume it, what changes at runtime, and how to really protect Secrets.",
    tags: ["ConfigMap", "Secret", "External Secrets", "12-factor", "KMS"],
    diagrams: configSecrets,
  },
  {
    slug: "rbac",
    title: "Authentication, RBAC & ServiceAccounts",
    category: "Config & Security",
    summary: "The three gates of every API request, Roles and bindings, least privilege, and identities for pods.",
    tags: ["RBAC", "Role", "RoleBinding", "ServiceAccount", "OIDC"],
    diagrams: rbac,
  },
  {
    slug: "pod-security",
    title: "Pod Security, Admission & Policy",
    category: "Config & Security",
    summary: "securityContext hardening, Pod Security Standards, admission controllers, Kyverno policies and the image supply chain.",
    tags: ["securityContext", "Pod Security Standards", "admission", "Kyverno", "Cosign"],
    diagrams: podSecurity,
  },
  {
    slug: "scheduling",
    title: "Scheduling: Where Pods Land",
    category: "Scheduling & Scaling",
    summary: "Filter and score, nodeSelector and affinity, taints and tolerations, topology spread, priority and preemption.",
    tags: ["scheduler", "affinity", "taints", "topology spread", "priority"],
    diagrams: scheduling,
  },
  {
    slug: "autoscaling",
    title: "Autoscaling: HPA, VPA, KEDA & Karpenter",
    category: "Scheduling & Scaling",
    summary: "More pods, bigger pods and more nodes: the HPA formula, KEDA on Kafka lag, and how FoodDash survives the dinner rush.",
    tags: ["HPA", "VPA", "KEDA", "Karpenter", "Cluster Autoscaler"],
    diagrams: autoscaling,
  },
  {
    slug: "disruptions",
    title: "PDBs, Node Drains & Cluster Upgrades",
    category: "Scheduling & Scaling",
    summary: "PodDisruptionBudgets, how a drain really works, the upgrade order, and the PDB deadlock.",
    tags: ["PDB", "drain", "eviction", "upgrades"],
    diagrams: disruptions,
  },
  {
    slug: "observability",
    title: "Observability: Logs, Metrics, Traces & Events",
    category: "Operations & Delivery",
    summary: "Prometheus, Grafana, Fluent Bit and OpenTelemetry: what to collect, where it comes from, and how to follow one order end to end.",
    tags: ["Prometheus", "Grafana", "logs", "OpenTelemetry", "RED"],
    diagrams: observability,
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting Playbook",
    category: "Operations & Delivery",
    summary: "get → describe → logs → exec, a status-by-status decision map, exit codes, and five real incidents.",
    tags: ["CrashLoopBackOff", "Pending", "OOMKilled", "debugging", "incidents"],
    diagrams: troubleshooting,
  },
  {
    slug: "helm-kustomize",
    title: "Packaging: Helm & Kustomize",
    category: "Operations & Delivery",
    summary: "Templates with values vs plain YAML with overlays: how each works, release history, and when to use which.",
    tags: ["Helm", "Kustomize", "charts", "overlays"],
    diagrams: helmKustomize,
  },
  {
    slug: "gitops",
    title: "GitOps & CI/CD with Argo CD",
    category: "Operations & Delivery",
    summary: "CI builds, Git decides, Argo CD deploys: pull-based delivery, drift detection, rollback by revert, promotion.",
    tags: ["GitOps", "Argo CD", "Flux", "CI/CD", "drift"],
    diagrams: gitops,
  },
  {
    slug: "operators",
    title: "CRDs, Controllers & Operators",
    category: "Operations & Delivery",
    summary: "Teaching Kubernetes new object types, and Operators that turn a runbook into code: CloudNativePG, Strimzi and friends.",
    tags: ["CRD", "Operator", "controller", "finalizers", "CloudNativePG"],
    diagrams: operators,
  },
  {
    slug: "eks",
    title: "Kubernetes on AWS (EKS)",
    category: "Operations & Delivery",
    summary: "What changes in the cloud: managed control plane, VPC CNI, ALB/NLB, EBS, Karpenter, and Pod Identity instead of keys.",
    tags: ["EKS", "AWS", "Karpenter", "Pod Identity", "VPC CNI"],
    diagrams: eks,
  },
  {
    slug: "cheat-sheet",
    title: "Cheat Sheet: Glossary & kubectl",
    category: "Reference",
    summary: "Every term in one line, how all the objects connect around a Pod, and the kubectl commands you'll type daily.",
    tags: ["glossary", "kubectl", "cheat sheet", "object map"],
    diagrams: cheatSheet,
  },
  {
    slug: "labs-and-practice",
    title: "Labs, Practice & 8-Week Plan",
    category: "Reference",
    summary: "kind labs with break-it exercises, a capstone project, model answers, scenario questions and a CKAD plan.",
    tags: ["practice", "CKAD", "labs", "capstone", "kind"],
    diagrams: labsAndPractice,
  },
];

export const KUBERNETES_TOPICS: Topic[] = META.map((m) => ({ ...m, source: "curated", track: "kubernetes", doc: doc(m.slug) }));
