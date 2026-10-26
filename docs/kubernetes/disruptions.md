# PDBs, Node Drains & Cluster Upgrades

> A PodDisruptionBudget (PDB) tells Kubernetes how many of your pods must stay up during planned maintenance, so node drains and upgrades never take your app down.

## The idea in one minute

| Question | Answer |
| --- | --- |
| What does a PDB limit? | **Voluntary** disruptions: drains, upgrades, Karpenter consolidation |
| What doesn't it limit? | Accidents: hardware failure, kernel panic, zone outage, OOM kills |
| How is it enforced? | Through the **Eviction API**, which `kubectl drain` and autoscalers use |
| What does `drain` do? | Cordon (no new pods) + evict every pod politely, respecting PDBs |
| Upgrade order? | Release notes → control plane → add-ons → worker nodes, one minor version at a time |

## Real-life analogy

> [!TIP]
> **A hospital's staff rota.** The rule is "at least 3 doctors on duty in the ER at all times." If two are already on leave, the next leave request waits until someone returns. Emergencies (a doctor suddenly falls ill) still happen; the rule only controls *planned* absences. A PDB is that rule for your pods.

## Voluntary vs involuntary disruptions

See [Voluntary vs involuntary](#diagram/voluntary-involuntary).

| Type | Examples | Does a PDB protect against it? |
| --- | --- | --- |
| **Voluntary** (planned) | `kubectl drain` for node upgrades, Karpenter consolidation, cluster autoscaler removing a node | **Yes** |
| **Involuntary** (accidents) | Hardware failure, kernel panic, a cloud zone outage, OOM kills | **No**: only replicas spread across nodes and zones help |

## FoodDash example

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: payments-api, namespace: payments }
spec:
  minAvailable: 2           # or: maxUnavailable: 1
  selector:
    matchLabels: { app: payments-api }
```

With 3 replicas and `minAvailable: 2`, a node drain can evict only **one** `payments-api` pod at a time. The next eviction waits until the replacement is Ready elsewhere.

## Draining a node: what actually happens

```bash
kubectl cordon ip-10-0-1-23       # mark unschedulable: no NEW pods land here
kubectl drain ip-10-0-1-23 --ignore-daemonsets --delete-emptydir-data
# ...patch / replace the node...
kubectl uncordon ip-10-0-1-23     # allow scheduling again
```

`drain` = cordon + evict every pod through the **Eviction API**, which checks PDBs. Each evicted pod gets its normal graceful shutdown, and its controller recreates it on another node. When a PDB would be violated, the API answers `429 Too Many Requests` and drain retries. Follow it on [Draining a node](#diagram/drain-flow).

## Cluster upgrades

Kubernetes releases a new minor version about every four months, and each version gets roughly a year of patches. Falling behind is a real risk: on EKS, old versions move to paid extended support, then are force-upgraded. See [Cluster upgrades](#diagram/upgrade-order).

1. **Read the release notes** for removed APIs. Tools like `pluto` or `kubent` scan your manifests and Helm charts for deprecated APIs.
2. **Upgrade the control plane**, one minor version at a time: 1.33 → 1.34, never skip.
3. **Upgrade add-ons** (CNI, CoreDNS, kube-proxy, CSI drivers) to compatible versions.
4. **Upgrade worker nodes**: create new nodes with the new version, drain old ones one by one (PDBs keep apps safe), delete the old ones. Managed node groups and Karpenter automate this.
5. **Watch** dashboards and error rates the whole time.

Big companies often go further with **blue/green clusters**: build a brand-new cluster on the new version, shift traffic gradually with DNS or the load balancer, then retire the old cluster.

## Watch out

> [!WARNING]
> - **The PDB deadlock:** 2 replicas with `minAvailable: 2` (or `maxUnavailable: 0`) means no pod may ever be evicted. Node drains hang forever and upgrades stall ([PDB deadlock](#diagram/pdb-deadlock)). Always leave room for at least one disruption.
> - A PDB is useless with **1 replica**. Either run 2+ replicas or accept downtime.
> - PDBs don't spread pods. If all 3 replicas sit on one node, a drain must still move them one by one, and a crash takes all three. Combine PDBs with topology spread.
> - Back up etcd (or rely on your provider's backups) before upgrading a self-managed control plane.

## Interview questions

**How do you upgrade a cluster with zero downtime?** Check deprecated APIs first, upgrade the control plane one minor version at a time, then add-ons, then roll node groups by surging new nodes and draining old ones with PDBs respected. Or use blue/green clusters.

**What's the difference between cordon and drain?** Cordon only marks the node unschedulable. Drain cordons and then evicts every pod through the Eviction API.

**`minAvailable` vs `maxUnavailable`?** Two ways to say the same thing. `maxUnavailable: 1` scales naturally with replica count and avoids the deadlock when someone scales down.
