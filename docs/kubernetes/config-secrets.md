# ConfigMaps & Secrets

> ConfigMaps hold settings, Secrets hold passwords and keys. Both keep configuration out of your container image, so one image works in every environment.

## The idea in one minute

| Question | Answer |
| --- | --- |
| Why separate config from the image? | **Build once, deploy everywhere**, and keep passwords out of your registry and Git history |
| ConfigMap vs Secret? | Non-sensitive settings vs credentials. Both are capped at about 1 MiB |
| How does the app read them? | As env vars (`envFrom`, `env.valueFrom`) or as files from a volume |
| Does a change reach a running pod? | Mounted files: yes, after a short delay. Env vars: **no**, restart needed |
| Are Secrets encrypted? | **Not by default.** Base64 is encoding, not encryption |

## Real-life analogy

> [!TIP]
> **The same chef, different menus.** A chef (your image) doesn't change between the Mumbai and Bengaluru branches. Each branch hands the chef its **local menu card** (ConfigMap) and the **key to the safe** (Secret). Same chef, different instructions.

## The problem it solves

If FoodDash bakes `DB_URL=prod-db` into the image, you need a different image for dev, staging and prod, and the production password ends up in your Docker registry and Git history. Separating config from code (the 12-factor rule) fixes both.

## ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: orders-config, namespace: fooddash }
data:
  LOG_LEVEL: info
  KAFKA_BOOTSTRAP: kafka.fooddash:9092
  MAX_ITEMS_PER_ORDER: "25"           # values are always strings
  application-prod.yaml: |            # a whole file is fine too
    coupons:
      max-discount-percent: 40
```

## Secret

```yaml
apiVersion: v1
kind: Secret
metadata: { name: orders-db, namespace: fooddash }
type: Opaque
stringData:                    # you write plain text...
  DB_USER: orders
  DB_PASSWORD: s3cr3t-change-me
# ...Kubernetes stores it base64-encoded under .data
```

Or imperatively: `kubectl create secret generic orders-db --from-literal=DB_PASSWORD=...`

Other Secret types to know: `kubernetes.io/tls` (certificate + key for a Gateway or Ingress), `kubernetes.io/dockerconfigjson` (for `imagePullSecrets`), and service-account tokens.

## Three ways to give them to your app

See [Three ways to consume](#diagram/consume).

```yaml
containers:
  - name: app
    image: fooddash/orders-api:1.4.2
    envFrom:                                   # 1. every key becomes an env var
      - configMapRef: { name: orders-config }
      - secretRef:    { name: orders-db }
    env:                                       # 2. one specific key
      - name: STRIPE_KEY
        valueFrom: { secretKeyRef: { name: payment-keys, key: stripe } }
    volumeMounts:                              # 3. as files in a folder
      - { name: config, mountPath: /config, readOnly: true }
volumes:
  - name: config
    configMap: { name: orders-config }
```

With option 3, `/config/application-prod.yaml` appears as a real file. Spring Boot can load it with `spring.config.import=optional:file:/config/`.

## What happens when you change a ConfigMap?

See [Changing a ConfigMap](#diagram/updates).

| Used as | Does the running app see the change? | What to do |
| --- | --- | --- |
| Environment variable | **No.** Env vars are set once at container start | `kubectl rollout restart`, or a config hash in a pod annotation |
| Mounted file | **Yes, after a short delay** (up to about a minute) | The app must re-read the file (`fsnotify`, Spring Cloud Kubernetes) |
| Mounted with `subPath` | **No** | Avoid `subPath` for config you need to hot-reload |

> [!NOTE]
> A neat trick used by Helm charts: put a hash of the ConfigMap in a pod annotation. Change the config, the hash changes, the pod template changes, and Kubernetes automatically does a rolling restart. Kustomize's `configMapGenerator` does the same by adding a hash to the ConfigMap's name.

## Secrets are not actually secret (by default)

This surprises everyone. Base64 is **encoding**, not encryption. Anyone with read access can decode it:

```bash
kubectl get secret orders-db -o jsonpath='{.data.DB_PASSWORD}' | base64 -d
```

How real companies protect secrets, in order of maturity ([Securing Secrets](#diagram/secret-maturity)):

1. **RBAC:** very few people and apps may read Secrets. `list` alone leaks every value in the namespace.
2. **Encryption at rest:** etcd stores Secrets encrypted with a cloud key (AWS KMS on EKS).
3. **Never in Git as plain YAML:** use Sealed Secrets or SOPS to keep encrypted versions in Git.
4. **External secret managers:** store the real values in AWS Secrets Manager or HashiCorp Vault. The **External Secrets Operator** copies them into Kubernetes and refreshes them on rotation ([External Secrets](#diagram/external-secrets)). The Secrets Store CSI Driver can mount them as files without creating a Secret object at all.
5. **No passwords at all where possible:** for AWS access, use EKS Pod Identity or IRSA, which give pods short-lived credentials.

## Watch out

> [!WARNING]
> - Both objects are limited to about 1 MiB. Don't store large files; use a volume or S3.
> - A pod referencing a missing ConfigMap or key won't start: status `CreateContainerConfigError`.
> - Mark static configs `immutable: true`: it prevents accidental edits and reduces watch load on the API server.
> - Environment variables can leak into logs, crash dumps and `kubectl describe`. Mounted files are slightly safer for secrets.
> - Never put real secrets in a Helm `values.yaml` committed to Git.

## Check your understanding

**How do you manage secrets securely?** Explain that base64 is not encryption, then the maturity ladder: least-privilege RBAC, encryption at rest with KMS, External Secrets Operator with AWS Secrets Manager, and workload identity instead of static keys.

**You changed a ConfigMap but the app didn't pick it up. Why?** It's consumed as env vars (fixed at start), mounted with `subPath`, or the app doesn't re-read the file. Restart the rollout or use a config-hash annotation.

**Why keep config out of the image?** So one tested artifact moves through every environment unchanged, and credentials never land in the registry.
