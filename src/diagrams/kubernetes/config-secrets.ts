import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function consume() {
  return new Diagram("Three ways to give config to your app", "Config lives outside the image, so one image runs in dev, staging and prod")
    .node("cm", "ConfigMap orders-config", 0, 0.4, "object", { detail: "LOG_LEVEL, KAFKA_BOOTSTRAP, application-prod.yaml", icon: "list-checks" })
    .node("sec", "Secret orders-db", 0, 1.8, "object", { detail: "DB_USER, DB_PASSWORD (base64)", icon: "lock" })
    .node("w1", "envFrom", 1.3, 0, "worker", { detail: "every key becomes an env var", icon: "list" })
    .node("w2", "env.valueFrom", 1.3, 1.1, "worker", { detail: "one specific key, e.g. STRIPE_KEY", icon: "key" })
    .node("w3", "volume mount", 1.3, 2.2, "worker", { detail: "files in /config, read-only", icon: "folder" })
    .node("app", "orders-api container", 2.6, 1.1, "service", { detail: "same image everywhere" })
    .edge("cm", "w1")
    .edge("sec", "w1")
    .edge("sec", "w2")
    .edge("cm", "w3")
    .edge("w1", "app")
    .edge("w2", "app")
    .edge("w3", "app")
    .panel("Same chef, different menus", ["The chef (image) is the same in Mumbai and Bengaluru. Each branch hands over its local menu card (ConfigMap) and the key to the safe (Secret)."], 3.85, 0, {
      width: 340,
      tone: "warn",
    })
    .panel("Limits", ["About 1 MiB per object: use a volume or S3 for big files.", "A missing ConfigMap or key → CreateContainerConfigError."], 3.85, 1.25, {
      width: 340,
      tone: "info",
    })
    .build();
}

function updates() {
  return new Sequence("What happens when you change a ConfigMap", "Env vars are fixed at container start; mounted files catch up; subPath mounts never do")
    .actor("you", "You", "client")
    .actor("api", "API server", "control")
    .actor("kubelet", "kubelet", "worker")
    .actor("app", "orders-api pod", "service")
    .msg("you", "api", "edit ConfigMap orders-config: LOG_LEVEL=debug")
    .msg("api", "kubelet", "watch event", { async: true })
    .alt("used as an environment variable", "you", "app")
    .msg("app", "app", "still LOG_LEVEL=info: env is set once at start", { error: true })
    .msg("you", "api", "kubectl rollout restart deploy/orders-api → new pods read the new value")
    .else("mounted as a volume")
    .msg("kubelet", "app", "update /config/LOG_LEVEL on the next sync (up to about a minute)")
    .msg("app", "app", "sees it only if it re-reads the file (fsnotify, Spring Cloud Kubernetes)")
    .else("mounted with subPath")
    .msg("app", "app", "never updated", { error: true })
    .end()
    .note("The Helm / Kustomize trick: put a hash of the ConfigMap in a pod annotation (or use configMapGenerator). Change the config → the hash changes → an automatic rolling restart.", ["you", "app"], "good")
    .build();
}

function secretMaturity() {
  return new Diagram("Protecting Secrets, in order of maturity", "Base64 is encoding, not encryption. Each step removes one way a secret can leak", { icons: false })
    .panel("By default", ["kubectl get secret orders-db -o jsonpath='{.data.DB_PASSWORD}' | base64 -d", "Anyone with get/list on Secrets can read them, and etcd may store them unencrypted."], 0, -0.1, {
      width: 420,
      tone: "bad",
      mono: false,
    })
    .node("s1", "1. RBAC", 0, 3.3, "object", { detail: "very few people and apps may get/list/watch Secrets" })
    .node("s2", "2. Encryption at rest", 1.05, 2.5, "object", { detail: "API server encrypts Secrets in etcd with a KMS key" })
    .node("s3", "3. Nothing plain in Git", 2.1, 1.7, "object", { detail: "Sealed Secrets or SOPS keep only encrypted copies" })
    .node("s4", "4. External secret manager", 3.15, 0.9, "object", { detail: "AWS Secrets Manager / Vault + External Secrets Operator" })
    .node("s5", "5. No static secrets", 4.2, 0.1, "service", { detail: "workload identity: EKS Pod Identity, IRSA" })
    .edge("s1", "s2")
    .edge("s2", "s3")
    .edge("s3", "s4")
    .edge("s4", "s5")
    .build();
}

function externalSecrets() {
  return new Sequence("External Secrets Operator", "The real value lives in AWS Secrets Manager; the operator copies it into a Kubernetes Secret and keeps it fresh")
    .actor("ops", "Platform team", "client")
    .actor("asm", "AWS Secrets Manager", "external", { icon: "aws-kms" })
    .actor("eso", "External Secrets Operator", "control", { icon: "workflow" })
    .actor("api", "API server", "control")
    .actor("app", "orders-api pod", "service")
    .msg("ops", "asm", "store fooddash/orders-db (rotated every 30 days)")
    .msg("ops", "api", "apply ExternalSecret orders-db: refreshInterval 1h, key fooddash/orders-db")
    .msg("api", "eso", "watch event", { async: true })
    .msg("eso", "asm", "GetSecretValue (using its own IAM role, no keys stored)")
    .msg("asm", "eso", "value", { reply: true })
    .msg("eso", "api", "create / update Secret orders-db")
    .msg("app", "app", "mounts Secret orders-db")
    .phase("Rotation")
    .msg("asm", "asm", "rotate the password")
    .msg("eso", "asm", "hourly refresh picks up the new value")
    .msg("eso", "api", "update the Secret; mounted files change, env vars need a restart")
    .build();
}

export default [
  { id: "consume", name: "Three ways to consume", build: consume },
  { id: "updates", name: "Changing a ConfigMap", build: updates },
  { id: "secret-maturity", name: "Securing Secrets", build: secretMaturity },
  { id: "external-secrets", name: "External Secrets", build: externalSecrets },
] satisfies DiagramSpec[];
