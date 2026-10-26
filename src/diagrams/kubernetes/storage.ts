import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function buildingBlocks() {
  return new Diagram("Storage building blocks", "You write a claim; a StorageClass and its CSI driver turn it into a real disk, represented by a PersistentVolume")
    .node("dev", "Developer", 0, 0, "client")
    .node("pvc", "PVC menu-images", 1.15, 0, "object", { detail: "“20Gi, ReadWriteOnce, class gp3”", icon: "file" })
    .node("sc", "StorageClass gp3", 2.3, 0, "object", { detail: "provisioner: ebs.csi.aws.com", icon: "list-checks" })
    .node("csi", "EBS CSI driver", 3.45, 0, "worker", { detail: "creates, attaches, mounts disks", icon: "hard-drive" })
    .node("pod", "restaurant-api pod", 1.15, 1.35, "service", { detail: "volume: claimName menu-images" })
    .node("pv", "PersistentVolume", 2.3, 1.35, "object", { detail: "the real disk, cluster-wide", icon: "hard-drive" })
    .node("disk", "EBS volume", 3.45, 1.35, "storage", { detail: "20 GB, lives in one AZ", icon: "aws-ec2" })
    .edge("dev", "pvc", "creates")
    .edge("pvc", "sc", "storageClassName")
    .edge("sc", "csi", "provision")
    .edge("csi", "disk", "CreateVolume")
    .edge("csi", "pv", "creates")
    .edge("pv", "disk", "backed by", { none: true })
    .edge("pv", "pvc", "bound 1:1", { both: true })
    .edge("pod", "pvc", "mounts")
    .panel(
      "Storage-unit analogy",
      ["PVC = your rental request: “10 GB, ground floor”", "StorageClass = the type of unit on offer: standard, premium", "PV = the actual unit you get the key to", "CSI driver = staff who build a unit on demand"],
      0,
      2.55,
      { width: 420, tone: "warn" },
    )
    .panel("Volume types", ["emptyDir: lives as long as the pod (scratch, shared files)", "configMap / secret: config files", "persistentVolumeClaim: survives the pod", "hostPath: node agents only"], 1.45, 2.55, {
      width: 420,
      tone: "info",
    })
    .build();
}

function dynamicProvisioning() {
  return new Sequence("Dynamic provisioning with WaitForFirstConsumer", "The disk is created only once the pod has a node, so it lands in the same availability zone")
    .actor("dev", "Developer", "client")
    .actor("api", "API server", "control")
    .actor("sched", "Scheduler", "control", { icon: "clock" })
    .actor("csi", "EBS CSI driver", "worker", { icon: "hard-drive" })
    .actor("aws", "AWS EBS", "external", { icon: "aws-ec2" })
    .actor("kubelet", "kubelet (node in 1b)", "worker")
    .msg("dev", "api", "create PVC menu-images (20Gi, gp3)")
    .msg("api", "api", "PVC Pending: waiting for first consumer")
    .msg("dev", "api", "create pod using claimName menu-images")
    .msg("api", "sched", "unscheduled pod", { async: true })
    .msg("sched", "api", "bind to a node in ap-south-1b (zone recorded on the PVC)")
    .msg("api", "csi", "provision for zone 1b", { async: true })
    .msg("csi", "aws", "CreateVolume 20 GB gp3, encrypted, zone 1b")
    .msg("aws", "csi", "vol-0ab12…", { reply: true })
    .msg("csi", "api", "create PV, bind it to the PVC")
    .msg("csi", "aws", "AttachVolume to the node")
    .msg("kubelet", "kubelet", "CSI mount at /var/lib/kubelet/…, start the container")
    .phase("Later: the pod moves to another node in 1b")
    .msg("csi", "aws", "detach from the old node, attach to the new one: same data")
    .build();
}

function accessModes() {
  return new Diagram("Access modes", "Who may mount a volume at the same time")
    .zone("ReadWriteOnce: one node at a time (EBS, GCP PD)", ["nodeA", "nodeB", "ebs"], "#9c36b5")
    .zone("ReadWriteMany: many nodes read-write (EFS, NFS)", ["na", "nb", "nc", "efs"], "#2f9e44")
    .node("nodeA", "Node A: postgres-0", 0, 0, "worker", { icon: "server" })
    .node("nodeB", "Node B", 0, 1.1, "worker", { detail: "can't mount it while A has it", highlight: true, icon: "server" })
    .node("ebs", "EBS disk", 1.15, 0.55, "storage")
    .node("na", "Node A: restaurant-api", 2.45, 0, "worker", { icon: "server" })
    .node("nb", "Node B: restaurant-api", 2.45, 1, "worker", { icon: "server" })
    .node("nc", "Node C: restaurant-api", 2.45, 2, "worker", { icon: "server" })
    .node("efs", "EFS file system", 3.6, 1, "storage")
    .edge("nodeA", "ebs", "read-write")
    .edge("nodeB", "ebs", "✗", { color: "#e03131" })
    .edge("na", "efs")
    .edge("nb", "efs", "all read-write")
    .edge("nc", "efs")
    .panel(
      "All four modes",
      [
        "ReadWriteOnce (RWO): one node read-write. EBS, GCP persistent disk",
        "ReadWriteOncePod (RWOP): exactly one pod. Strict single-writer databases",
        "ReadOnlyMany (ROX): many nodes, read-only. Shared static content",
        "ReadWriteMany (RWX): many nodes read-write. EFS, NFS, CephFS",
      ],
      0,
      2.15,
      { width: 700, tone: "info" },
    )
    .build();
}

function zoneTrap() {
  return new Diagram("The zone trap", "An EBS disk lives in one availability zone. Create it before the pod is scheduled, and the pod may land somewhere it can never attach")
    .zone("AZ ap-south-1a", ["disk", "nodeA"], "#495057")
    .zone("AZ ap-south-1b", ["pod", "nodeB"], "#495057")
    .node("disk", "EBS disk for postgres-0", 0, 0, "storage", { detail: "volumeBindingMode: Immediate → made right away in 1a", highlight: true })
    .node("nodeA", "Node in 1a", 0, 1.2, "worker", { detail: "full: no room for the pod", icon: "server" })
    .node("pod", "postgres-0", 1.45, 0, "service", { detail: "Pending: volume node affinity conflict", highlight: true, icon: "postgres" })
    .node("nodeB", "Node in 1b", 1.45, 1.2, "worker", { detail: "has room, so the scheduler picks it", icon: "server" })
    .edge("pod", "disk", "can't attach across zones", { color: "#e03131" })
    .edge("pod", "nodeB", "scheduled here")
    .panel(
      "The fix",
      [
        "StorageClass volumeBindingMode: WaitForFirstConsumer",
        "The scheduler picks the node first; the disk is then created in that node's zone.",
        "Also: allowVolumeExpansion: true (you can grow a PVC, never shrink it) and reclaimPolicy: Retain for anything important.",
      ],
      2.85,
      -0.1,
      { width: 400, tone: "good" },
    )
    .build();
}

export default [
  { id: "building-blocks", name: "PVC, PV, StorageClass", build: buildingBlocks },
  { id: "dynamic-provisioning", name: "Dynamic provisioning", build: dynamicProvisioning },
  { id: "access-modes", name: "Access modes", build: accessModes },
  { id: "zone-trap", name: "The zone trap", build: zoneTrap },
] satisfies DiagramSpec[];
