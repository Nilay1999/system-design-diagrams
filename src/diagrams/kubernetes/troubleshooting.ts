import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function decisionMap() {
  const d = new Diagram("Troubleshooting decision map", "The STATUS column narrows the problem to one family of causes. Then describe and logs tell you which one");
  d.node("status", "kubectl get pods → STATUS", 0, 2.5, "client", { icon: "terminal" });
  const rows: [string, string, string, string, string][] = [
    ["pending", "Pending", "describe pod → Events", "'Insufficient cpu', untolerated taint, unbound PVC / zone, affinity", "lower requests, add nodes, fix tolerations or StorageClass"],
    ["pull", "ImagePullBackOff", "describe pod → Events", "wrong tag, private registry without credentials, rate limit", "fix the image or imagePullSecrets / IAM"],
    ["crash", "CrashLoopBackOff", "logs --previous + exit code", "bad config, missing env or Secret, DB unreachable, liveness killing a slow start", "fix config; add a startupProbe"],
    ["oom", "OOMKilled (137)", "describe → Last State", "limit too low, JVM heap not sized to the container", "raise limit, MaxRAMPercentage, find the leak"],
    ["ready", "Running, 0/1 Ready", "describe → probe failures", "wrong probe path/port, a dependency is down", "curl the endpoint from inside"],
    ["svc", "Running + Ready, but 503s", "get endpointslices", "selector doesn't match labels, wrong targetPort", "align labels and ports"],
  ];
  rows.forEach(([id, status, look, causes, fix], i) => {
    d.node(id, status, 1.4, i, "service", { highlight: i < 4, icon: false })
      .node(`${id}Look`, look, 2.65, i, "worker", { detail: causes, w: 1.25, icon: "search" })
      .panel(undefined, [`Fix: ${fix}`], 4.2, i - 0.05, { width: 300, tone: "good" })
      .edge("status", id)
      .edge(id, `${id}Look`);
  });
  return d.build();
}

function debugLoop() {
  return new Sequence("The four-command method", "get → describe → logs → exec. Like a doctor: vital signs, history, ask the patient, then examine up close")
    .actor("you", "You", "client")
    .actor("api", "kubectl / API server", "control")
    .actor("pod", "orders-api pod", "service")
    .msg("you", "api", "1. kubectl get pods -n fooddash -o wide")
    .msg("api", "you", "orders-api-5c6b2-x2k4q  0/1  CrashLoopBackOff  6 restarts", { reply: true })
    .msg("you", "api", "2. kubectl describe pod orders-api-5c6b2-x2k4q")
    .msg("api", "you", "Last State: Terminated, Exit Code 1 · Events: Back-off restarting failed container", { reply: true })
    .msg("you", "api", "3. kubectl logs orders-api-5c6b2-x2k4q --previous")
    .msg("api", "you", "Could not resolve placeholder 'COUPON_SERVICE_URL'", { reply: true, error: true })
    .msg("you", "pod", "4. kubectl exec -it … -- sh (or kubectl debug --image=nicolaka/netshoot if there's no shell)")
    .msg("you", "you", "cause: the ConfigMap lacks the new key → add it in Git, kubectl rollout restart")
    .note("Why customers were mostly fine: maxUnavailable 0 kept the old pods serving while the new ones crashed. Prevention: config changes ship in the same pull request as the code.", ["you", "pod"], "good")
    .build();
}

function exitCodes() {
  return new Diagram("Exit codes and node problems", "The exit code in describe often names the cause before you read a single log line", { icons: false })
    .node("c0", "Exit 0", 0, 0, "service", { detail: "clean exit; for a web service under restartPolicy Always that's still a bug" })
    .node("c1", "Exit 1", 1.2, 0, "service", { detail: "application error: an exception at startup, bad config" })
    .node("c137", "Exit 137 = 128 + 9", 2.4, 0, "service", { detail: "SIGKILL: OOMKilled, or didn't stop within the grace period", highlight: true })
    .node("c143", "Exit 143 = 128 + 15", 3.6, 0, "service", { detail: "SIGTERM: a normal, graceful stop" })
    .node("notready", "Node NotReady", 0.6, 1.4, "worker", { detail: "kubelet stopped, out of disk, or lost network", highlight: true })
    .node("pressure", "Memory / Disk / PID pressure", 1.8, 1.4, "worker", { detail: "kubectl describe node → Conditions" })
    .node("evicted", "Pods Evicted", 3, 1.4, "service", { detail: "node pressure: set requests, clean old images and logs" })
    .edge("pressure", "evicted")
    .panel("Node first aid", ["kubectl get nodes; kubectl describe node <node>", "cordon and drain it, then fix or replace it", "Stuck Terminating? Check finalizers; force-delete only as a last resort"], 0.6, 2.55, {
      width: 560,
      tone: "info",
    })
    .build();
}

export default [
  { id: "decision-map", name: "Decision map", build: decisionMap },
  { id: "debug-loop", name: "The four commands", build: debugLoop },
  { id: "exit-codes", name: "Exit codes & nodes", build: exitCodes },
] satisfies DiagramSpec[];
