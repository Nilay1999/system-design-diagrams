# Volumes, PV, PVC & StorageClass

> Volumes give containers storage that outlives a container restart; PersistentVolumes give storage that outlives the Pod itself. You write a claim; Kubernetes finds or creates a real disk for it.

## The idea in one minute

| Object | Who creates it | What it is |
| --- | --- | --- |
| **StorageClass** | Platform team | A "type" of storage plus its provisioner (`ebs.csi.aws.com`, gp3, encrypted). Enables **dynamic provisioning** |
| **PersistentVolumeClaim (PVC)** | Developer | A request: "20Gi, ReadWriteOnce, class gp3" |
| **PersistentVolume (PV)** | The provisioner (or an admin, statically) | The actual disk, bound 1:1 to a PVC |
| **CSI driver** | Installed add-on | Creates, attaches and mounts disks for a storage system |

See [PVC, PV, StorageClass](#diagram/building-blocks).

## Real-life analogy

> [!TIP]
> **Renting a storage unit.** A **PVC** is your rental request: "I need a 10 GB storage unit, ground floor." A **StorageClass** is the type of unit the company offers: standard, climate-controlled, premium fast-access. A **PV** is the actual unit you're handed the key to. The **CSI driver** is the staff who build a new unit on demand. You, the developer, only write the request; you don't care which physical shelf it's on.

## The problem it solves

A container's filesystem is wiped on every restart. If FoodDash's PostgreSQL stored data inside the container, one crash would delete every order. You need storage that lives **outside** the pod and can be re-attached when the pod moves.

## Volume types at a glance

| Volume | Lives as long as | Use it for |
| --- | --- | --- |
| `emptyDir` | The Pod | Scratch space, cache, files shared between containers in a pod (`medium: Memory` for tmpfs) |
| `configMap` / `secret` | The Pod (content comes from the object) | Config files and credentials |
| `persistentVolumeClaim` | Until you delete the PVC (or beyond, with `Retain`) | Databases, uploads, anything that must survive |
| `hostPath` | The node | Node agents only (log collectors). Avoid in apps: risky and ties the pod to one node |
| Projected | The Pod | Combine ConfigMap, Secret and service-account token in one folder |

## How dynamic provisioning works

1. The platform team creates a **StorageClass**, e.g. `gp3` on AWS with the EBS CSI driver.
2. You create a **PVC** asking for 20Gi of class `gp3`.
3. The CSI driver automatically creates a real 20 GB EBS disk and a **PV** for it.
4. The PV is **bound** to your PVC, one-to-one.
5. Your pod mounts the PVC. If the pod moves to another node, the disk is detached and re-attached there.

Follow it on [Dynamic provisioning](#diagram/dynamic-provisioning).

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: { name: gp3 }
provisioner: ebs.csi.aws.com
parameters: { type: gp3, encrypted: "true" }
reclaimPolicy: Retain                       # keep the disk if the PVC is deleted
volumeBindingMode: WaitForFirstConsumer     # create the disk in the pod's zone
allowVolumeExpansion: true
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: menu-images, namespace: fooddash }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3
  resources: { requests: { storage: 20Gi } }
---
# in the pod spec:
#   volumes:
#     - name: images
#       persistentVolumeClaim: { claimName: menu-images }
```

## Access modes

See [Access modes](#diagram/access-modes).

| Mode | Meaning | Example storage |
| --- | --- | --- |
| ReadWriteOnce (RWO) | Mounted read-write by **one node** at a time | AWS EBS, GCP persistent disk |
| ReadWriteOncePod (RWOP) | Only **one pod** at a time | Strict single-writer databases |
| ReadOnlyMany (ROX) | Many nodes, read-only | Shared static content |
| ReadWriteMany (RWX) | Many nodes read-write | AWS EFS, NFS, CephFS |

FoodDash example: restaurant menu images uploaded by 5 `restaurant-api` pods on different nodes need **RWX** (EFS). Better still, store them in **S3**, the usual cloud-native answer for files.

## Reclaim policies

- `Delete`: delete the PVC and the disk is destroyed. Fine for dev.
- `Retain`: the disk survives for manual recovery. Use for anything important.

## The zone trap

An EBS disk lives in **one availability zone**. With the default `Immediate` binding, the disk is created as soon as the PVC exists, in whatever zone the provisioner picks. If the pod is later scheduled in another zone, it's stuck `Pending` forever with a "volume node affinity conflict". See [The zone trap](#diagram/zone-trap).

> [!IMPORTANT]
> `volumeBindingMode: WaitForFirstConsumer` fixes it: the scheduler picks the node first, and the disk is then created in that node's zone.

## Watch out

> [!WARNING]
> - You can **grow** a PVC (if `allowVolumeExpansion` is true) but never shrink it.
> - Storage is not backup. Use **VolumeSnapshots** or tools like **Velero** to back up PVs, and test restores.
> - In the cloud, prefer managed databases (RDS, Aurora) over running databases on PVCs, unless you have strong reasons and an Operator.
> - Deleting a pod doesn't delete its PVC, and a PVC in use is protected by a finalizer until the pod is gone.

## Check your understanding

**PV vs PVC?** A PVC is a namespaced request for storage written by the developer; a PV is the cluster-wide object representing the actual disk. They bind 1:1. With a StorageClass, PVs are created on demand.

**Why would a pod with a PVC be stuck Pending?** No StorageClass or provisioner, the requested access mode isn't supported, quota exceeded, or the disk exists in a different zone from any node that fits the pod.

**How do you share files between pods on different nodes?** An RWX volume (EFS, NFS), or, better, object storage like S3 accessed through the app.
