# Kubernetes on AWS (EKS)

> On EKS, AWS runs the control plane for you, and Kubernetes objects connect to real AWS services: load balancers, EBS disks, IAM roles and VPC networking.

## The idea in one minute

| Kubernetes concept | On EKS it becomes | Notes |
| --- | --- | --- |
| Control plane | Managed by AWS across multiple AZs | You pay per cluster-hour; you choose the version |
| Worker nodes | EC2 managed node groups, **Karpenter**, or **Fargate** (serverless pods) | Karpenter is the popular choice for cost and speed |
| Pod networking (CNI) | **Amazon VPC CNI**: pods get real VPC IP addresses | Plan subnet sizes; IPs can run out (prefix delegation helps) |
| Service `type: LoadBalancer` | Network Load Balancer (via the AWS Load Balancer Controller) |  |
| Ingress / Gateway | Application Load Balancer (via the same controller) | One ALB can serve many services |
| PersistentVolume | **EBS** (one AZ, RWO) or **EFS** (multi-AZ, RWX) via CSI drivers | Remember the zone trap |
| Who can use kubectl | **IAM** principals mapped to Kubernetes groups via EKS access entries | Then normal RBAC applies |
| Pods calling AWS APIs | **EKS Pod Identity** or **IRSA** | Temporary credentials, no keys stored anywhere |
| Secrets | AWS Secrets Manager + External Secrets Operator; KMS encryption of etcd |  |
| Logs and metrics | CloudWatch Container Insights, or Amazon Managed Prometheus + Grafana |  |
| Images | Amazon ECR | Nodes pull with their IAM role |

See [FoodDash on EKS](#diagram/architecture) and the [Concept map](#diagram/concept-map).

## Real-life analogy

> [!TIP]
> **Renting a fully serviced office.** With your own cluster (kubeadm), you own the building: wiring, security guards, generator. With **EKS**, the landlord (AWS) runs the reception, lifts and power (the control plane, etcd, master upgrades). You furnish your floor (nodes and apps), and you still decide what happens on it.

## The problem it solves

Running a highly available control plane and etcd yourself (backups, certificates, upgrades, 3 availability zones) is a full-time job. EKS does it for a flat hourly fee per cluster, and integrates Kubernetes with the AWS services FoodDash already uses.

## FoodDash example: upload invoices to S3 with no keys

With EKS Pod Identity ([Pod Identity](#diagram/pod-identity)):

1. Create an IAM role with an S3 policy for the `fooddash-invoices` bucket, trusted by the EKS Pod Identity service.
2. Associate it with the `orders-api` ServiceAccount in the `fooddash` namespace (one `aws eks create-pod-identity-association` command, or Terraform).
3. Set `serviceAccountName: orders-api` in the Deployment.

The AWS SDK for Java or JavaScript inside the pod finds temporary credentials automatically. Nothing to rotate, nothing to leak. IRSA (the older method) achieves the same using an annotation on the ServiceAccount and OIDC federation.

## Creating a cluster

```bash
# quickest way for learning
eksctl create cluster --name fooddash-dev --region ap-south-1 --nodes 2 --node-type t3.medium
aws eks update-kubeconfig --name fooddash-dev --region ap-south-1
kubectl get nodes
eksctl delete cluster --name fooddash-dev --region ap-south-1   # don't forget, it costs money!
```

In real companies, clusters are created with **Terraform** (often the `terraform-aws-modules/eks` module) or AWS CDK, so they're reproducible and reviewed like code.

## Other clouds, same ideas

Google **GKE** (with Autopilot mode, where Google manages nodes too) and Azure **AKS** follow the same pattern: managed control plane, cloud load balancers, cloud disks, and workload identity. Learn the concepts once; only the integration names change.

## Watch out

> [!WARNING]
> - **Costs add up quietly:** the cluster fee, EC2 nodes, NAT gateways, load balancers, EBS volumes left behind by deleted StatefulSets, cross-AZ traffic. Tag everything and check the bill weekly when learning.
> - **IP exhaustion:** with the VPC CNI, each pod uses a VPC IP. Small subnets (/24) fill up fast; use larger subnets or prefix delegation.
> - **Version support:** EKS versions get standard support for a limited time, then cost extra in extended support. Plan an upgrade every few months.
> - **Spot instances** can cut node costs a lot for stateless services, but can be reclaimed with 2 minutes' notice. Use them with PDBs, multiple replicas, and Karpenter's interruption handling.

## Interview questions

**How do pods get AWS permissions on EKS?** EKS Pod Identity (or IRSA): a ServiceAccount is associated with an IAM role, and the SDK receives short-lived credentials automatically. Never put access keys in Secrets.

**Design a payments service with 99.95% availability on EKS.** 3 AZs with topology spread, PDBs, `maxUnavailable: 0`, HPA plus Karpenter headroom, a priority class, idempotency keys, an outbox for events, RDS Multi-AZ instead of an in-cluster database, and SLO-based alerts.

**What does the AWS Load Balancer Controller do?** It watches Services, Ingresses and Gateways and creates NLBs/ALBs whose targets are pod IPs (thanks to the VPC CNI).
