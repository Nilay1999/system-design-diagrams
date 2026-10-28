# Observability: Logs, Metrics, Traces & Events

> Logs tell you what happened, metrics tell you how much and how fast, traces tell you where time was spent across services, and events tell you what Kubernetes itself did.

## The idea in one minute

| Pillar | Common tools | What to set up |
| --- | --- | --- |
| Metrics | Prometheus + Grafana (kube-prometheus-stack), CloudWatch Container Insights | RED metrics per service; USE for nodes; alert on SLOs, not on CPU |
| Logs | Fluent Bit DaemonSet → Loki, OpenSearch or CloudWatch | Log JSON to stdout; include trace IDs |
| Traces | OpenTelemetry Collector → Tempo, Jaeger or X-Ray | Propagate W3C trace context across HTTP and Kafka headers |
| Cluster state | kube-state-metrics, an events exporter | Alert on CrashLoopBackOff, pending pods, PVCs nearly full |

See [The stack](#diagram/stack).

## Real-life analogy

> [!TIP]
> **Running a hospital.** **Metrics** are the vital-signs monitor: heart rate, blood pressure, a number every few seconds. Great for alarms. **Logs** are the doctor's notes: detailed, written, searchable when you need the story. **Traces** are the patient's journey: reception → X-ray → doctor → pharmacy, with the waiting time at each stop. **Events** are the ward's activity board: "bed 4 moved to ICU".

## The problem it solves

With 50 pods that move between machines every day, you can't SSH into a server and `tail` a log file. When a customer says "my order failed at 8:42 PM", you need to find which pod handled it, what it logged, and which downstream call was slow, within minutes.

## Logs

Rule #1: **write logs to stdout/stderr**, not to files. The container runtime saves them on the node, and `kubectl logs` reads them.

```bash
kubectl logs deploy/orders-api                 # one pod of the Deployment
kubectl logs -l app=orders-api --prefix -f     # all pods, live
kubectl logs orders-api-7d9f-x2k4q --previous  # the crashed instance before the restart
```

Node logs vanish when pods are deleted or nodes are replaced. In production, a **log agent DaemonSet** (Fluent Bit, Vector) ships every container's logs to a central store: Loki, Elasticsearch/OpenSearch, or CloudWatch Logs.

Tips: log in **JSON**, include `orderId`, `userId` and `traceId` in every line, and never log card numbers or passwords.

## Metrics

The standard stack is **Prometheus** (collects and stores numbers) + **Grafana** (dashboards) + **Alertmanager** (sends alerts to Slack or PagerDuty). Most teams install it all with the `kube-prometheus-stack` Helm chart. See [Metrics sources](#diagram/metrics-sources).

| Source | Gives you |
| --- | --- |
| Your app (`/actuator/prometheus` in Spring Boot, `prom-client` in Node.js) | Request rate, errors, latency, business numbers like orders per minute |
| kube-state-metrics | Kubernetes object state: desired vs ready replicas, pod restarts, pending pods |
| node-exporter (DaemonSet) | Node CPU, memory, disk, network |
| cAdvisor (inside kubelet) | Per-container CPU, memory, throttling |
| metrics-server | Live CPU/memory for `kubectl top` and the HPA (not for long-term storage) |

**What to watch for each service (the RED method):** **R**ate (requests per second), **E**rrors (failed requests), **D**uration (latency, especially p95/p99). For nodes, use **USE**: Utilization, Saturation, Errors.

Alert on what customers feel ("checkout error rate above 1% for 5 minutes"), not on internal noise ("CPU above 80%"). With the Prometheus Operator, a `ServiceMonitor` object is all it takes to scrape your Spring Boot apps.

## Traces

A single FoodDash order touches `orders-api` → `payments-api` → bank API → Kafka → `notification-worker`. A trace stitches these hops together using a shared **trace ID** passed in HTTP and Kafka headers, so you can see that 1.8 seconds of a 2-second request was spent waiting for the bank ([A trace of one order](#diagram/trace)).

The standard today is **OpenTelemetry**: add its Java agent or Node.js SDK to your app, send data to an OpenTelemetry Collector, and view traces in Jaeger, Grafana Tempo or AWS X-Ray.

## Events

Kubernetes records what it does as **events**: scheduling decisions, image pulls, probe failures, OOM kills, evictions. They're your first clue in any incident, but they're only kept for about an hour by default.

```bash
kubectl get events -n fooddash --sort-by=.lastTimestamp
kubectl describe pod orders-api-7d9f-x2k4q     # events for this pod at the bottom
```

Ship events to your log system (with an event exporter) if you want history.

## Watch out

> [!WARNING]
> - `kubectl top` shows usage right now; it needs metrics-server and is not a monitoring system.
> - High-cardinality labels in metrics (like `userId` or `orderId`) can overload Prometheus. Put those in logs and traces, not metric labels.
> - Logs and metrics cost money at scale. Set retention periods and drop debug logs in production.

## Check your understanding

**How would you find why one order failed at 8:42 PM?** Search logs by `orderId` to get the `traceId`, open the trace to find the failing or slow hop, then check that service's metrics and the pod's events around that time.

**What is the RED method?** Rate, Errors, Duration: the three metrics to dashboard and alert on for every request-driven service.

**metrics-server vs Prometheus?** metrics-server keeps only the latest CPU/memory numbers for the HPA and `kubectl top`. Prometheus stores history, supports queries and alerting, and scrapes app and cluster metrics.
