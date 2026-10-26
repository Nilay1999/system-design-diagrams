import { Diagram, Sequence, type DiagramSpec } from "../dsl";

function stack() {
  return new Diagram("The observability stack", "Logs tell you what happened, metrics how much and how fast, traces where the time went")
    .node("app", "orders-api pod", 0, 1, "service", { detail: ["JSON logs to stdout", "/actuator/prometheus", "OpenTelemetry agent"] })
    .node("fb", "Fluent Bit (DaemonSet)", 1.35, 0, "worker", { detail: "tails every container's log on the node", icon: "files" })
    .node("loki", "Loki / OpenSearch / CloudWatch", 2.7, 0, "storage", { detail: "searchable logs, with retention" })
    .node("prom", "Prometheus", 1.35, 1, "worker", { detail: "scrapes every 30s, stores time series", icon: "prometheus" })
    .node("otel", "OpenTelemetry Collector", 1.35, 2, "worker", { detail: "receives spans", icon: "opentelemetry" })
    .node("tempo", "Tempo / Jaeger / X-Ray", 2.7, 2, "storage", { detail: "traces by trace ID", icon: "jaeger" })
    .node("grafana", "Grafana", 4.05, 1, "client", { detail: "dashboards + one place to jump between all three", icon: "grafana" })
    .edge("app", "fb", "stdout")
    .edge("prom", "app", "scrape")
    .edge("app", "otel", "spans")
    .edge("fb", "loki")
    .edge("otel", "tempo")
    .edge("loki", "grafana")
    .edge("prom", "grafana")
    .edge("tempo", "grafana")
    .panel("Alerts", ["Prometheus rules → Alertmanager → Slack / PagerDuty.", "Alert on what customers feel ('checkout errors > 1% for 5 min'), not 'CPU > 80%'."], 2.7, 2.9, {
      width: 400,
      tone: "warn",
    })
    .panel("Hospital analogy", ["Metrics = the vital-signs monitor. Logs = the doctor's notes. Traces = the patient's journey with waiting times. Events = the ward's activity board."], 0, 2.9, {
      width: 400,
      tone: "info",
    })
    .build();
}

function metricsSources() {
  return new Diagram("Where metrics come from", "Five sources, two consumers. metrics-server is for live autoscaling, not for history")
    .node("appm", "Your app", 0, 0, "service", { detail: "request rate, errors, latency, orders per minute" })
    .node("ksm", "kube-state-metrics", 0, 1, "worker", { detail: "desired vs ready replicas, restarts, pending pods" })
    .node("ne", "node-exporter (DaemonSet)", 0, 2, "worker", { detail: "node CPU, memory, disk, network", icon: "server" })
    .node("cad", "cAdvisor (in the kubelet)", 0, 3, "worker", { detail: "per-container CPU, memory, throttling", icon: "cpu" })
    .node("prom", "Prometheus", 1.4, 1.5, "worker", { detail: "long-term time series, PromQL, alerts", icon: "prometheus" })
    .node("msrv", "metrics-server", 1.4, 3, "worker", { detail: "live CPU / memory only", icon: "gauge" })
    .node("hpa", "HPA, kubectl top", 2.8, 3, "control", { icon: "scale" })
    .node("graf", "Grafana dashboards", 2.8, 1.5, "client", { icon: "grafana" })
    .edge("prom", "appm", "scrape")
    .edge("prom", "ksm")
    .edge("prom", "ne")
    .edge("prom", "cad")
    .edge("cad", "msrv")
    .edge("msrv", "hpa")
    .edge("prom", "graf")
    .panel("What to watch", ["Services: RED = Rate, Errors, Duration (p95/p99)", "Nodes: USE = Utilization, Saturation, Errors", "Never use userId or orderId as metric labels: put them in logs and traces"], 2.8, -0.1, {
      width: 380,
      tone: "good",
    })
    .build();
}

function trace() {
  return new Sequence("A trace of one order", "One trace ID in HTTP and Kafka headers stitches every hop together, so you can see 1.8 s of a 2 s request was the bank")
    .actor("app", "Mobile app", "client", { icon: "smartphone" })
    .actor("orders", "orders-api", "service")
    .actor("pay", "payments-api", "service")
    .actor("bank", "Bank API", "external", { icon: "landmark" })
    .actor("kafka", "Kafka", "queue")
    .actor("notif", "notification-worker", "worker")
    .msg("app", "orders", "POST /orders (traceparent: 00-4bf9…-01)  span 0–2000 ms")
    .msg("orders", "pay", "POST /charge (same trace ID)  span 40–1950 ms")
    .msg("pay", "bank", "authorize card  span 90–1890 ms ← the slow part", { error: true })
    .msg("bank", "pay", "approved", { reply: true })
    .msg("pay", "orders", "200", { reply: true })
    .msg("orders", "kafka", "OrderCreated (trace ID in message headers)", { async: true })
    .msg("orders", "app", "201 Created", { reply: true })
    .msg("kafka", "notif", "consume → send SMS, a child span of the same trace", { async: true })
    .note("Standard today: OpenTelemetry (Java agent, Node.js SDK) → Collector → Tempo, Jaeger or X-Ray. Put the trace ID in every log line too.", ["app", "notif"], "info")
    .build();
}

export default [
  { id: "stack", name: "The stack", build: stack },
  { id: "metrics-sources", name: "Metrics sources", build: metricsSources },
  { id: "trace", name: "A trace of one order", build: trace },
] satisfies DiagramSpec[];
