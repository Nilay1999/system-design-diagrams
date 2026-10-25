import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function architecture() {
  return new Diagram("FoodDash on EKS", "AWS runs the control plane; Kubernetes objects turn into real AWS resources: load balancers, disks, IAM roles and VPC IPs")
    .zone("VPC · AZ ap-south-1a", ["na", "podA"], "#e8590c")
    .zone("VPC · AZ ap-south-1b", ["nb", "ebs"], "#e8590c")
    .node("cp", "EKS control plane", 2.45, -1.35, "control", { detail: "run by AWS across AZs; you pick the version", w: 1.4, icon: "aws-eks" })
    .node("user", "FoodDash app", 0, 0.7, "client", { icon: "smartphone" })
    .node("alb", "ALB", 1.2, 0.7, "edge", { detail: "made by the AWS Load Balancer Controller from a Gateway/Ingress", icon: "aws-elb" })
    .node("na", "EC2 node", 2.45, 0, "worker", { detail: "launched by Karpenter", icon: "aws-ec2" })
    .node("podA", "orders-api pod", 3.6, 0, "service", { detail: "VPC IP 10.0.1.57 (VPC CNI)" })
    .node("nb", "EC2 node", 2.45, 1.4, "worker", { detail: "Spot, consolidated at night", icon: "aws-ec2" })
    .node("ebs", "EBS gp3 volume", 3.6, 1.4, "storage", { detail: "via the EBS CSI driver, one AZ", icon: "aws-ec2" })
    .node("ecr", "Amazon ECR", 4.95, -0.45, "storage", { icon: "aws" })
    .node("iam", "IAM role orders-api", 4.95, 0.65, "external", { detail: "via EKS Pod Identity", icon: "lock" })
    .node("s3", "S3 fooddash-invoices", 4.95, 1.75, "storage", { icon: "aws-s3" })
    .edge("cp", "na", "kubelet ↔ API", { both: true })
    .edge("user", "alb", "HTTPS")
    .edge("alb", "podA", "IP targets", { via: [[3, 0.7]] })
    .edge("alb", "nb")
    .edge("nb", "ebs", "attached")
    .edge("podA", "ecr", "image")
    .edge("podA", "iam", "temporary creds")
    .edge("podA", "s3", "PutObject, no keys")
    .panel("Serviced-office analogy", ["The landlord (AWS) runs reception, lifts and power (control plane, etcd, master upgrades). You furnish your floor (nodes and apps)."], 0, 2.25, {
      width: 380,
      tone: "warn",
    })
    .build();
}

function podIdentity() {
  return new Sequence("Pod Identity: AWS access with no stored keys", "Let orders-api upload invoices to S3")
    .actor("ops", "Platform team (Terraform)", "client")
    .actor("iam", "AWS IAM", "external", { icon: "lock" })
    .actor("agent", "EKS Pod Identity agent (DaemonSet)", "worker")
    .actor("pod", "orders-api pod (SA orders-api)", "service")
    .actor("s3", "S3", "storage", { icon: "aws-s3" })
    .phase("Once")
    .msg("ops", "iam", "create role with an S3 policy for fooddash-invoices, trusted by Pod Identity")
    .msg("ops", "iam", "create-pod-identity-association: namespace fooddash + SA orders-api → role")
    .phase("Every time the SDK needs credentials")
    .msg("pod", "agent", "AWS SDK default credential chain asks the local agent")
    .msg("agent", "iam", "exchange the pod's ServiceAccount token for role credentials")
    .msg("iam", "pod", "temporary credentials (auto-refreshed)", { reply: true })
    .msg("pod", "s3", "PutObject invoice-42.pdf")
    .note("Nothing to rotate, nothing to leak. IRSA (the older method) does the same with an annotation on the ServiceAccount and OIDC federation.", ["ops", "s3"], "good")
    .build();
}

function conceptMap() {
  const d = new Diagram("Kubernetes concept → what it becomes on EKS", "Learn the concepts once; on GKE and AKS only the integration names change");
  const rows: [string, string, string][] = [
    ["Control plane", "Managed by AWS, multi-AZ", "aws-eks"],
    ["Worker nodes", "Managed node groups, Karpenter or Fargate", "aws-ec2"],
    ["Pod networking (CNI)", "Amazon VPC CNI: pods get VPC IPs", "aws-vpc"],
    ["Service type LoadBalancer", "Network Load Balancer", "aws-elb"],
    ["Gateway / Ingress", "Application Load Balancer", "aws-elb"],
    ["PersistentVolume", "EBS (one AZ, RWO) or EFS (RWX)", "hard-drive"],
    ["Who can use kubectl", "IAM principals via EKS access entries", "lock"],
    ["Pods calling AWS", "EKS Pod Identity or IRSA", "key"],
  ];
  rows.forEach(([k8s, aws, icon], i) => {
    const col = i % 2 === 0 ? 0 : 2.6;
    const row = Math.floor(i / 2) * 1.05;
    d.node(`k${i}`, k8s, col, row, "object", { icon: "kubernetes" }).node(`a${i}`, aws, col + 1.2, row, "external", { icon: icon as never }).edge(`k${i}`, `a${i}`);
  });
  return d
    .panel("Watch the bill", ["Cluster fee, EC2, NAT gateways, load balancers, EBS volumes left by deleted StatefulSets, cross-AZ traffic. Tag everything; check weekly when learning."], 0, 4.2, {
      width: 520,
      tone: "warn",
    })
    .panel("Watch the subnets", ["With the VPC CNI each pod uses a VPC IP. A /24 fills up fast: use bigger subnets or prefix delegation."], 1.75, 4.2, {
      width: 380,
      tone: "bad",
    })
    .build();
}

export default [
  { id: "architecture", name: "FoodDash on EKS", build: architecture },
  { id: "pod-identity", name: "Pod Identity", build: podIdentity },
  { id: "concept-map", name: "Concept map", build: conceptMap },
] satisfies DiagramSpec[];
