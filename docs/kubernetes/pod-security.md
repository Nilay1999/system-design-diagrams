# Pod Security, Admission & Policy

> A securityContext limits what a container can do on its machine; Pod Security Standards and policy engines make sure every team follows those limits automatically.

## The idea in one minute

| Layer | What it does |
| --- | --- |
| **securityContext** | Hardens one pod: non-root, no privilege escalation, read-only filesystem, dropped capabilities |
| **Pod Security Standards** | Three ready-made levels (Privileged, Baseline, Restricted), enforced per namespace |
| **Admission controllers** | Change (mutating) or reject (validating) every request before it's stored |
| **Policy engines** | Company rules as code: Kyverno, OPA Gatekeeper, ValidatingAdmissionPolicy |
| **Supply chain** | Scan, sign and verify images so only what CI built can run |

## Real-life analogy

> [!TIP]
> **Hotel guests and house rules.** A **securityContext** is how you set up one guest's room: no master key, no access to the electrical room, windows that don't open. **Pod Security Standards** are the hotel's three standard rule packages: "anything goes", "basic" and "strict". **Admission controllers and policy engines** are the front-desk staff who refuse check-in to anyone breaking the rules, before they ever reach a room.

## The problem it solves

By default, many container images run as **root**. If an attacker exploits a bug in FoodDash's `restaurant-api` (say, an unsafe file upload), root inside the container plus a few risky settings can mean **escaping to the node**, and from there reaching every other pod on it. Hardening shrinks what an attacker can do even after they get in. See [Hardening a pod](#diagram/hardened-pod).

## securityContext: hardening one pod

```yaml
spec:
  securityContext:                       # applies to the whole pod
    runAsNonRoot: true                   # refuse to start if the image wants root
    runAsUser: 10001
    fsGroup: 10001                       # files on volumes owned by this group
    seccompProfile: { type: RuntimeDefault }   # block dangerous Linux system calls
  containers:
    - name: app
      image: fooddash/restaurant-api:3.2.0
      securityContext:                   # per container
        allowPrivilegeEscalation: false  # can't gain more privileges (e.g. via sudo)
        readOnlyRootFilesystem: true     # attacker can't drop files into the image
        capabilities: { drop: [ALL] }    # remove all special Linux powers
      volumeMounts: [{ name: tmp, mountPath: /tmp }]   # writable space where the app needs it
  volumes: [{ name: tmp, emptyDir: {} }]
```

| Setting | What it prevents |
| --- | --- |
| `runAsNonRoot` | Running as root inside the container |
| `allowPrivilegeEscalation: false` | Turning a normal process into root |
| `readOnlyRootFilesystem` | Downloading and running attack tools |
| `capabilities.drop: [ALL]` | Low-level powers like changing network settings |
| Never `privileged: true` | Full access to the host. Only special system tools (some CNI agents) need it |

In your Dockerfile, add a non-root user (`USER 10001`) so the image itself is ready for this.

## Pod Security Standards (PSS)

Three ready-made levels, enforced per namespace by the built-in **Pod Security Admission** ([Pod Security Standards](#diagram/pss-levels)):

| Level | Allows | Use for |
| --- | --- | --- |
| **Privileged** | Everything | System namespaces (`kube-system`, CNI) |
| **Baseline** | Most apps; blocks known-dangerous settings (privileged, host networking) | A sensible minimum everywhere |
| **Restricted** | Only hardened pods (non-root, dropped capabilities, seccomp) | All FoodDash app namespaces |

```bash
kubectl label namespace fooddash \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted
```

Now any pod that breaks the rules is rejected with a clear message. Start with `warn` or `audit` mode to see what would break before you `enforce`. (PodSecurityPolicy, the older mechanism, was removed in v1.25.)

## Admission controllers

After a request passes authentication and RBAC, **admission controllers** get a final say ([Admission pipeline](#diagram/admission-chain)). Two kinds:

- **Mutating:** change the request. Examples: inject an Istio sidecar, add default resource requests (LimitRange).
- **Validating:** accept or reject. Examples: Pod Security Admission, ResourceQuota checks.

You can add your own through webhooks, or with built-in **ValidatingAdmissionPolicy** (rules written in a short expression language called CEL, with no webhook server to run).

## Policy engines: company rules as code

For rules Kubernetes doesn't have built in, platform teams use **Kyverno** (policies in YAML) or **OPA Gatekeeper** (policies in Rego). Real FoodDash rules:

- Images may only come from FoodDash's private registry (ECR).
- Every Deployment must have CPU/memory requests and an `owner` label.
- No `:latest` tags.
- Every Ingress must use TLS.

```yaml
# Kyverno example: block :latest
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata: { name: disallow-latest-tag }
spec:
  validationFailureAction: Enforce
  rules:
    - name: require-pinned-image
      match: { any: [{ resources: { kinds: [Pod] } }] }
      validate:
        message: "Use a fixed image tag, not :latest"
        pattern:
          spec:
            containers:
              - image: "!*:latest"
```

## Supply chain basics

See [Supply chain](#diagram/supply-chain).

- Scan images for known vulnerabilities in CI (Trivy, Grype).
- Use small base images (distroless, Alpine, Chainguard): less software, fewer holes.
- Pin images by tag and ideally digest (`image@sha256:...`).
- Sign images (Cosign) and verify signatures at admission, so only images your CI built can run.
- Detect odd runtime behaviour with Falco, and keep API server audit logs on.

## Security checklist

- [ ] Least-privilege RBAC; no `cluster-admin` for apps or CI
- [ ] One ServiceAccount per workload; token automount off where unused
- [ ] Restricted Pod Security on app namespaces
- [ ] Default-deny NetworkPolicies
- [ ] Secrets encrypted at rest and sourced from a secret manager
- [ ] Workload identity instead of static cloud keys
- [ ] Signed, scanned, pinned images from a private registry
- [ ] Private API endpoint or IP allow-list; audit logging on

## Watch out

> [!WARNING]
> - `readOnlyRootFilesystem` breaks apps that write temp files. Mount an `emptyDir` at `/tmp` (Java and Node.js often need it).
> - Many public images (nginx, older databases) expect root. Use their non-root variants (e.g. `nginxinc/nginx-unprivileged`).
> - Security is layered: RBAC + pod hardening + NetworkPolicies + secret management. One layer alone isn't enough.

## Check your understanding

**What does a restricted pod look like?** Runs as non-root, `allowPrivilegeEscalation: false`, all capabilities dropped, `RuntimeDefault` seccomp, no host namespaces or privileged mode; ideally a read-only root filesystem too.

**Mutating vs validating admission?** Mutating webhooks may modify the object (sidecar injection, defaults) and run first; validating webhooks only accept or reject, and run after schema validation.

**How do you enforce "images only from our registry"?** A Kyverno or Gatekeeper policy (or a ValidatingAdmissionPolicy) that rejects pods whose images don't start with the ECR prefix, ideally combined with signature verification.
