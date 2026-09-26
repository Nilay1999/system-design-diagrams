import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

import fundamentals from "./diagrams/fundamentals";
import urlShortener from "./diagrams/url-shortener";
import rateLimiter from "./diagrams/rate-limiter";
import keyValueStore from "./diagrams/key-value-store";
import chatSystem from "./diagrams/chat-system";
import newsFeed from "./diagrams/news-feed";
import notificationSystem from "./diagrams/notification-system";
import webCrawler from "./diagrams/web-crawler";
import typeahead from "./diagrams/typeahead";
import videoStreaming from "./diagrams/video-streaming";
import rideSharing from "./diagrams/ride-sharing";
import paymentSystem from "./diagrams/payment-system";

export interface Topic {
  slug: string;
  title: string;
  category: "Foundations" | "Infrastructure" | "Social & Messaging" | "Media & Search" | "Marketplace & Fintech";
  summary: string;
  tags: string[];
  diagram: () => ExcalidrawElementSkeleton[];
  /** Markdown source, loaded from /docs/<slug>.md */
  doc: string;
}

// Docs live at the repo root so they are readable on GitHub without running the app.
const docs = import.meta.glob<string>("../docs/*.md", { query: "?raw", import: "default", eager: true });

function doc(slug: string): string {
  const source = docs[`../docs/${slug}.md`];
  if (source === undefined) throw new Error(`Missing document docs/${slug}.md`);
  return source;
}

type TopicMeta = Omit<Topic, "doc">;

const META: TopicMeta[] = [
  {
    slug: "fundamentals",
    title: "Building Blocks & Interview Framework",
    category: "Foundations",
    summary: "The recurring components of scalable systems and a repeatable way to approach any design.",
    tags: ["load balancing", "caching", "sharding", "replication", "CAP"],
    diagram: fundamentals,
  },
  {
    slug: "url-shortener",
    title: "URL Shortener",
    category: "Infrastructure",
    summary: "Generate short aliases for long URLs and redirect billions of reads with low latency.",
    tags: ["base62", "key generation", "read-heavy", "caching"],
    diagram: urlShortener,
  },
  {
    slug: "rate-limiter",
    title: "Distributed Rate Limiter",
    category: "Infrastructure",
    summary: "Throttle clients across a fleet of API servers with token buckets in Redis.",
    tags: ["token bucket", "sliding window", "redis", "lua"],
    diagram: rateLimiter,
  },
  {
    slug: "key-value-store",
    title: "Distributed Key-Value Store",
    category: "Infrastructure",
    summary: "A Dynamo-style, leaderless, highly available store with tunable consistency.",
    tags: ["consistent hashing", "quorum", "gossip", "vector clocks"],
    diagram: keyValueStore,
  },
  {
    slug: "chat-system",
    title: "Chat System",
    category: "Social & Messaging",
    summary: "1:1 and group messaging with presence, delivery receipts and offline sync.",
    tags: ["websockets", "fan-out", "presence", "wide-column"],
    diagram: chatSystem,
  },
  {
    slug: "news-feed",
    title: "News Feed",
    category: "Social & Messaging",
    summary: "Build personalised timelines using hybrid push/pull fan-out.",
    tags: ["fan-out on write", "celebrity problem", "ranking", "timeline cache"],
    diagram: newsFeed,
  },
  {
    slug: "notification-system",
    title: "Notification System",
    category: "Social & Messaging",
    summary: "Reliable multi-channel delivery (push, SMS, email) with preferences and retries.",
    tags: ["queues", "idempotency", "retries", "third-party providers"],
    diagram: notificationSystem,
  },
  {
    slug: "web-crawler",
    title: "Web Crawler",
    category: "Media & Search",
    summary: "Crawl billions of pages politely, deduplicate content, and feed an index.",
    tags: ["URL frontier", "politeness", "bloom filter", "simhash"],
    diagram: webCrawler,
  },
  {
    slug: "typeahead",
    title: "Search Autocomplete",
    category: "Media & Search",
    summary: "Return the top suggestions for a prefix in under 100 ms.",
    tags: ["trie", "top-k", "offline aggregation", "edge caching"],
    diagram: typeahead,
  },
  {
    slug: "video-streaming",
    title: "Video Streaming Platform",
    category: "Media & Search",
    summary: "Upload, transcode and stream video with adaptive bitrate over a CDN.",
    tags: ["transcoding DAG", "HLS/DASH", "CDN", "pre-signed URLs"],
    diagram: videoStreaming,
  },
  {
    slug: "ride-sharing",
    title: "Ride Sharing",
    category: "Marketplace & Fintech",
    summary: "Match riders with nearby drivers using real-time location and geospatial indexes.",
    tags: ["geohash", "H3", "matching", "location stream"],
    diagram: rideSharing,
  },
  {
    slug: "payment-system",
    title: "Payment System",
    category: "Marketplace & Fintech",
    summary: "Move money exactly once with idempotency, a double-entry ledger and reconciliation.",
    tags: ["idempotency", "ledger", "PSP", "reconciliation", "saga"],
    diagram: paymentSystem,
  },
];

export const TOPICS: Topic[] = META.map((m) => ({ ...m, doc: doc(m.slug) }));

export const CATEGORIES = [...new Set(TOPICS.map((t) => t.category))];
