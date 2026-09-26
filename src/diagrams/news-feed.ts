import { Diagram } from "./dsl";

export default function newsFeed() {
  return new Diagram("News Feed", "Hybrid fan-out: push to followers' timelines, pull celebrity posts at read time")
    .zone("Write path (publish)", 2, -0.3, 4, 3.1, "#e8590c")
    .zone("Read path (load feed)", 2, 2.9, 2, 2.1, "#1971c2")
    .node("client", "Client", 0, 1.8, "client")
    .node("gw", "API gateway", 1, 1.8, "edge")
    .node("cdn", "CDN (images / video)", 0, 3.3, "edge")
    .node("post", "Post service", 2, 0.5, "service")
    .node("postdb", "Post store (sharded by post_id)", 3, -0.3, "db")
    .node("fanq", "Fan-out queue", 3, 0.8, "queue")
    .node("fanw", "Fan-out workers", 4, 0.8, "worker")
    .node("graph", "Social graph (followers)", 5, -0.3, "db")
    .node("timeline", "Timeline cache (Redis list of post_ids)", 3, 1.8, "cache", { w: 1.1 })
    .node("feed", "Feed service", 2, 2.9, "service")
    .node("hydrate", "Post & user cache", 3, 2.9, "cache")
    .node("celeb", "Celebrity posts (pull on read)", 2, 4, "service")
    .node("rank", "Ranking service", 3, 4, "service")
    .edge("client", "gw")
    .edge("client", "cdn", "media")
    .edge("gw", "post", "POST /posts")
    .edge("gw", "feed", "GET /feed")
    .edge("post", "postdb", "store")
    .edge("post", "fanq", "PostCreated", { async: true })
    .edge("fanq", "fanw", undefined, { async: true })
    .edge("fanw", "graph", "followers")
    .edge("fanw", "timeline", "LPUSH + LTRIM", { async: true })
    .edge("feed", "timeline", "1. post_ids")
    .edge("feed", "celeb", "2. merge")
    .edge("feed", "hydrate", "3. hydrate")
    .edge("feed", "rank", "4. rank")
    .steps(
      "Fan-out rule",
      [
        "author followers < ~10k → push to every timeline",
        "author is a celebrity → skip push",
        "readers merge celebrity posts at read time",
        "inactive users are not fanned out to",
      ],
      6.3,
      -0.3,
    )
    .build();
}
