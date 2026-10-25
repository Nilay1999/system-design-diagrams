import { K8S_LEGEND, LEGEND } from "../diagrams/dsl";
import { SOURCES, TopicCatalog } from "../topics/catalog";
import { CURATED_TOPICS } from "../topics/curated";
import { KUBERNETES_TOPICS } from "../topics/kubernetes";
import type { Track } from "./types";

export * from "./types";
export { useTrack } from "./context";
export { TrackRoute } from "./TrackRoute";

export const SYSTEM_DESIGN: Track = {
  id: "system-design",
  name: "System Design",
  logo: "/favicon.svg",
  home: "/",
  catalog: new TopicCatalog(CURATED_TOPICS),
  sources: SOURCES,
  legend: LEGEND,
  searchPlaceholder: "Search topics, e.g. cache",
};

export const KUBERNETES: Track = {
  id: "kubernetes",
  name: "Kubernetes",
  logo: "/kubernetes.svg",
  home: "/kubernetes",
  catalog: new TopicCatalog(KUBERNETES_TOPICS),
  sources: [{ source: "curated", label: "Guide" }],
  legend: K8S_LEGEND,
  searchPlaceholder: "Search, e.g. probes, HPA",
  overview: {
    title: "Kubernetes, explained with diagrams",
    lead:
      "Every topic is a plain-language write-up next to editable diagrams: the architecture, step-by-step flows, and the YAML you would actually write. " +
      "One made-up food-delivery app, FoodDash, runs through all of it, so each new idea lands on something you already picture.",
    points: [
      {
        title: "One idea runs through everything",
        text: "You declare what you want (spec). Controllers keep comparing it with what exists (status) and fix the difference, forever. That loop explains self-healing, rollouts, autoscaling and GitOps.",
      },
      {
        title: "FoodDash, the running example",
        text: "orders-api, payments-api, restaurant-api, delivery-tracker, notification-worker (Kafka) and a nightly report-job. Every YAML snippet deploys a piece of it.",
      },
      {
        title: "How to study a topic",
        text: "Read the analogy, then open each diagram tab. Be able to draw it, write its YAML from memory, and break it on purpose and fix it with kubectl.",
      },
    ],
  },
};

export const TRACKS: readonly Track[] = [SYSTEM_DESIGN, KUBERNETES];
