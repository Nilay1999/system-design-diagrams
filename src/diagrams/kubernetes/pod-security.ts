import { Diagram, type DiagramSpec } from "../dsl";

function admissionChain() {
  return new Diagram("The API request pipeline", "After authentication and RBAC, admission controllers get the final say: first they may change the request, then they may reject it")
    .node("req", "kubectl apply pod.yaml", 0, 0, "client", { w: 0.9, icon: "terminal" })
    .node("authn", "Authentication", 1, 0, "control", { w: 0.9, icon: "fingerprint" })
    .node("authz", "Authorization (RBAC)", 2, 0, "control", { w: 0.9, icon: "lock" })
    .node("mut", "Mutating admission", 3, 0, "control", { w: 0.9, detail: "may change it", icon: "refresh" })
    .node("schema", "Schema validation", 4, 0, "control", { w: 0.9, icon: "list-checks" })
    .node("val", "Validating admission", 5, 0, "control", { w: 0.9, detail: "accept or reject", icon: "shield-check" })
    .node("etcd", "etcd", 6, 0, "db", { w: 0.9 })
    .edge("req", "authn")
    .edge("authn", "authz")
    .edge("authz", "mut")
    .edge("mut", "schema")
    .edge("schema", "val")
    .edge("val", "etcd")
    .panel("Mutating examples", ["Istio injects its sidecar", "LimitRange fills default requests", "Default StorageClass, ServiceAccount"], 2.6, 0.8, { width: 300, tone: "info" })
    .panel(
      "Validating examples",
      ["Pod Security Admission", "ResourceQuota", "Kyverno / OPA Gatekeeper webhooks", "ValidatingAdmissionPolicy (CEL, no webhook)"],
      4.6,
      0.8,
      { width: 300, tone: "warn" },
    )
    .build();
}

function pssLevels() {
  return new Diagram("Pod Security Standards", "Three ready-made levels, enforced per namespace by a label and the built-in Pod Security Admission")
    .node("kube", "ns kube-system", 0, 0, "object", { detail: "enforce=privileged", icon: "tag" })
    .node("legacy", "ns legacy", 1.3, 0, "object", { detail: "enforce=baseline", icon: "tag" })
    .node("fd", "ns fooddash", 3.25, 0, "object", { detail: "enforce=restricted", icon: "tag" })
    .node("cni", "Cilium agent", 0, 1.3, "worker", { detail: "privileged: true → allowed" })
    .node("old", "old nginx image", 1.3, 1.3, "service", { detail: "runs as root → allowed; privileged or hostNetwork → blocked" })
    .node("bad", "pod running as root", 2.6, 1.3, "service", { detail: "rejected: runAsNonRoot must be true", highlight: true })
    .node("good", "restaurant-api 3.2.0", 3.9, 1.3, "service", { detail: "non-root, drop ALL, seccomp → admitted" })
    .edge("kube", "cni")
    .edge("legacy", "old")
    .edge("fd", "bad", "rejected", { color: "#e03131" })
    .edge("fd", "good", "admitted", { color: "#2f9e44" })
    .panel(
      "Roll it out safely",
      ["kubectl label ns fooddash pod-security.kubernetes.io/warn=restricted", "Fix what the warnings show, then switch warn → enforce.", "PodSecurityPolicy was removed in v1.25; this replaced it."],
      0,
      2.55,
      { width: 760, tone: "good" },
    )
    .build();
}

function hardenedPod() {
  return new Diagram("Why harden a pod", "An attacker gets in through a bug. Each securityContext setting removes one step of what they can do next")
    .node("attacker", "Attacker", 0, 1, "external", { detail: "exploits an unsafe file upload", icon: "siren" })
    .node("app", "restaurant-api container", 1.35, 1, "service", { detail: "now running their code" })
    .node("node", "The node and every pod on it", 2.7, 1, "worker", { detail: "the real prize", highlight: true, icon: "server" })
    .edge("attacker", "app", "gets a shell")
    .edge("app", "node", "escape?", { color: "#e03131" })
    .panel(
      "Setting → what it prevents",
      [
        "runAsNonRoot: true → being root inside the container",
        "allowPrivilegeEscalation: false → becoming root via sudo / setuid",
        "readOnlyRootFilesystem: true → downloading and running attack tools",
        "capabilities.drop: [ALL] → low-level powers like changing network settings",
        "seccompProfile: RuntimeDefault → dangerous Linux system calls",
        "never privileged: true → full access to the host",
      ],
      0,
      2.2,
      { width: 760, tone: "good" },
    )
    .panel("Hotel analogy", ["securityContext = one guest's room: no master key, windows that don't open. Pod Security Standards = the hotel's rule packages. Admission = the front desk refusing check-in."], 3.95, 0.45, {
      width: 340,
      tone: "warn",
    })
    .build();
}

function supplyChain() {
  return new Diagram("Supply chain: only images you built can run", "Scan and sign in CI, verify at admission")
    .node("code", "Git push", 0, 0, "client", { w: 0.9, icon: "git-branch" })
    .node("build", "CI build", 1, 0, "worker", { w: 0.9, detail: "small base: distroless, Chainguard" })
    .node("scan", "Scan", 2, 0, "worker", { w: 0.9, detail: "Trivy / Grype: fail on criticals", icon: "search" })
    .node("sign", "Sign", 3, 0, "worker", { w: 0.9, detail: "Cosign / Sigstore", icon: "fingerprint" })
    .node("ecr", "Private registry (ECR)", 4, 0, "storage", { w: 0.9, detail: "pin by digest" })
    .node("verify", "Admission policy", 5, 0, "control", { w: 0.9, detail: "Kyverno verifies signature + registry", icon: "shield-check" })
    .node("run", "Pod runs", 6, 0, "service", { w: 0.9 })
    .edge("code", "build")
    .edge("build", "scan")
    .edge("scan", "sign")
    .edge("sign", "ecr")
    .edge("ecr", "verify")
    .edge("verify", "run")
    .panel(
      "Company rules as code (Kyverno / Gatekeeper)",
      ["Images only from our ECR", "Every Deployment has requests and an owner label", "No :latest tags", "Every Ingress uses TLS"],
      0,
      0.95,
      { width: 420, tone: "info" },
    )
    .panel("At runtime", ["Falco detects odd behaviour (a shell in a container).", "API server audit logs on.", "Keep the cluster upgraded."], 4.6, 0.95, { width: 340, tone: "neutral" })
    .build();
}

export default [
  { id: "admission-chain", name: "Admission pipeline", build: admissionChain },
  { id: "pss-levels", name: "Pod Security Standards", build: pssLevels },
  { id: "hardened-pod", name: "Hardening a pod", build: hardenedPod },
  { id: "supply-chain", name: "Supply chain", build: supplyChain },
] satisfies DiagramSpec[];
