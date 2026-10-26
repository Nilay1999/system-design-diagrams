import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function threeGates() {
  return new Sequence("Every API request passes three gates", "Priya from the delivery team runs kubectl delete deployment delivery-tracker -n delivery")
    .actor("user", "Priya (kubectl)", "client", { icon: "user" })
    .actor("api", "API server", "control")
    .actor("sso", "Company SSO (OIDC)", "external", { icon: "fingerprint" })
    .actor("rbac", "RBAC authorizer", "object", { icon: "lock" })
    .actor("adm", "Admission", "control", { icon: "shield-check" })
    .actor("etcd", "etcd", "db")
    .msg("user", "api", "DELETE …/deployments/delivery-tracker (Bearer: OIDC id token)")
    .phase("1 · Authentication: who are you?")
    .msg("api", "sso", "verify the token signature and issuer")
    .msg("sso", "api", "user priya@fooddash.in, groups [delivery-engineers]", { reply: true })
    .phase("2 · Authorization: may you do this?")
    .msg("api", "rbac", "can priya (delivery-engineers) delete deployments in delivery?")
    .alt("a RoleBinding grants it", "api", "rbac")
    .msg("rbac", "api", "allowed", { reply: true })
    .else("nothing grants it (there are no deny rules)")
    .msg("rbac", "api", "denied", { reply: true, error: true })
    .msg("api", "user", "403 Forbidden", { error: true })
    .end()
    .phase("3 · Admission: is the request itself acceptable?")
    .msg("api", "adm", "mutating, then validating checks (policies, quotas)")
    .msg("adm", "api", "admit", { reply: true })
    .msg("api", "etcd", "apply the change")
    .msg("api", "user", "deployment.apps \"delivery-tracker\" deleted", { reply: true })
    .note("Kubernetes has no user database. It trusts certificates, OIDC tokens or cloud IAM to say who you are; RBAC only decides what you may do.", ["user", "etcd"], "info")
    .build();
}

function rbacObjects() {
  return new Diagram("The four RBAC objects", "A Role lists allowed actions; a binding hands it to someone. Namespaced vs cluster-wide")
    .zone("namespace delivery", ["rb", "role"], "#2f9e44")
    .zone("namespace fooddash", ["sa", "rb2", "role2"], "#1971c2")
    .zone("cluster-wide", ["crb", "cr"], "#3b5bdb")
    .node("grp", "Group delivery-engineers", 0, 0, "client", { detail: "from the company SSO", icon: "users" })
    .node("rb", "RoleBinding", 1.3, 0, "object", { detail: "delivery-team-devs", icon: "link" })
    .node("role", "Role app-developer", 2.6, 0, "object", { detail: "deployments: get…patch · pods/log: get · pods/exec: create", icon: "list-checks" })
    .node("sa", "ServiceAccount orders-api", 0, 1.3, "client", { detail: "an identity for a pod", icon: "bot" })
    .node("rb2", "RoleBinding", 1.3, 1.3, "object", { detail: "orders-config-reader", icon: "link" })
    .node("role2", "Role config-reader", 2.6, 1.3, "object", { detail: "configmaps: get, list, watch", icon: "list-checks" })
    .node("sre", "Group sre", 0, 2.65, "client", { icon: "users" })
    .node("crb", "ClusterRoleBinding", 1.3, 2.65, "object", { detail: "sre-view-everything", icon: "link" })
    .node("cr", "ClusterRole view", 2.6, 2.65, "object", { detail: "read-only in every namespace, no Secrets", icon: "list-checks" })
    .edge("grp", "rb", "subject")
    .edge("rb", "role", "roleRef")
    .edge("sa", "rb2", "subject")
    .edge("rb2", "role2", "roleRef")
    .edge("sre", "crb", "subject")
    .edge("crb", "cr", "roleRef")
    .panel(
      "Rules = verbs × resources",
      ["Verbs: get, list, watch, create, update, patch, delete", "Resources: pods, deployments, secrets, pods/exec…", "Additive only: no deny rules. Not granted = denied.", "Built-in ClusterRoles: view, edit, admin, cluster-admin"],
      3.9,
      -0.1,
      { width: 360, tone: "info" },
    )
    .panel("Access card analogy", ["Authentication = the guard checking your ID. RBAC = your card: opens floor 3 and the cafeteria, not the server room. A ServiceAccount = a card issued to a delivery robot."], 3.9, 1.4, {
      width: 360,
      tone: "warn",
    })
    .build();
}

function serviceAccountToken() {
  return new Sequence("ServiceAccounts: identities for pods", "Prometheus discovers pods to scrape by calling the API with its ServiceAccount token")
    .actor("kubelet", "kubelet", "worker")
    .actor("pod", "prometheus pod", "service", { icon: "prometheus" })
    .actor("api", "API server", "control")
    .actor("rbac", "RBAC", "object", { icon: "lock" })
    .msg("kubelet", "api", "TokenRequest for SA prometheus (audience: API server, 1 h)")
    .msg("kubelet", "pod", "mount a projected token at /var/run/secrets/kubernetes.io/serviceaccount")
    .msg("pod", "api", "GET /api/v1/pods (Authorization: Bearer <token>)")
    .msg("api", "api", "verify the token: system:serviceaccount:monitoring:prometheus")
    .msg("api", "rbac", "may it list pods cluster-wide?")
    .msg("rbac", "api", "yes, via a ClusterRoleBinding", { reply: true })
    .msg("api", "pod", "pod list", { reply: true })
    .msg("kubelet", "pod", "refresh the token before it expires (client libraries reload it)")
    .note("Apps that never call the API should set automountServiceAccountToken: false. On EKS, the same ServiceAccount is the bridge to an AWS IAM role (Pod Identity / IRSA).", ["kubelet", "rbac"], "good")
    .build();
}

export default [
  { id: "three-gates", name: "Three gates", build: threeGates },
  { id: "rbac-objects", name: "RBAC objects", build: rbacObjects },
  { id: "serviceaccount-token", name: "ServiceAccount tokens", build: serviceAccountToken },
] satisfies DiagramSpec[];
