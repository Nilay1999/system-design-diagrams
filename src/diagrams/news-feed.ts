import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("News Feed — architecture", "Hybrid fan-out: push post IDs into followers' timelines, pull celebrity posts at read time")
    .zone("Write path", ["postsvc", "posts", "kafka", "fanout"], "#e8590c")
    .zone("Read path", ["feed", "rank", "celeb", "hydr"], "#1971c2")
    .node("client", "Clients", 0, 1.3, "client", { detail: "app + web" })
    .node("gw", "API gateway", 1, 1.3, "edge", { detail: "auth, rate limit" })
    .node("media", "Media + CDN", 1, -0.1, "storage", { detail: "pre-signed upload" })
    .node("postsvc", "Post service", 2.1, 0, "service", { detail: "validate, store, emit event" })
    .node("posts", "Post store", 3.2, -0.3, "db", { detail: ["sharded by post_id", "Snowflake ids"] })
    .node("kafka", "Kafka: PostCreated", 3.2, 0.8, "queue", { detail: "partitioned by author" })
    .node("fanout", "Fan-out workers", 4.3, 0.8, "worker", { detail: ["batch 1,000 followers", "skip inactive users"] })
    .node("graph", "Social graph", 5.4, 0.8, "db", { detail: ["followee → followers", "follower → followees"] })
    .node("timelines", "Timeline cache", 4.3, 2.1, "cache", { detail: ["Redis: user → 800 post ids", "sharded by user_id"] })
    .node("feed", "Feed service", 2.1, 2.1, "service", { detail: ["merge, rank, hydrate", "cursor pagination"] })
    .node("celeb", "Celebrity posts cache", 3.2, 2.1, "cache", { detail: "recent ids per big author" })
    .node("rank", "Ranking service", 2.1, 3.3, "service", { detail: "scores ~500 candidates" })
    .node("hydr", "Post + user + counter caches", 3.2, 3.3, "cache", { detail: "MGET bodies, authors, likes" })
    .edge("client", "gw")
    .edge("client", "media", "upload photo")
    .edge("gw", "postsvc", "POST /posts")
    .edge("gw", "feed", "GET /feed")
    .edge("postsvc", "posts", "insert")
    .edge("postsvc", "kafka", "event", { async: true })
    .edge("kafka", "fanout", undefined, { async: true })
    .edge("fanout", "graph", "followers")
    .edge("fanout", "timelines", "LPUSH + LTRIM")
    .edge("feed", "celeb", "celebrities I follow")
    .edge("celeb", "timelines", "my timeline ids", { none: true })
    .edge("feed", "rank", "candidates")
    .edge("feed", "hydr", "hydrate page")
    .panel(
      "Scale",
      ["300 M daily users; 1 post / user / day ≈ 3.5k posts/s", "10 feed loads / user / day ≈ 35k reads/s, 100k at peak", "Avg 200 followers → ~700k timeline inserts/s", "800 ids × 8 B × 300 M users ≈ 2 TB of RAM"],
      4.3,
      3.1,
      { width: 420, tone: "info" },
    )
    .build();
}

function publish() {
  return new Sequence("Publishing a post", "The author waits only for the post to be stored; fan-out happens in the background", { gap: 240 })
    .actor("u", "Author", "client")
    .actor("ps", "Post service", "service")
    .actor("db", "Post store", "db")
    .actor("k", "Kafka", "queue")
    .actor("fo", "Fan-out worker", "worker")
    .actor("g", "Social graph", "db")
    .actor("tl", "Timeline cache", "cache")
    .msg("u", "ps", "POST /posts {text, media_ids} + Idempotency-Key")
    .msg("ps", "db", "INSERT post (post_id = Snowflake)")
    .msg("ps", "k", "PostCreated {post_id, author, created_at} (outbox)", { async: true })
    .msg("ps", "u", "201 {post_id}", { reply: true })
    .msg("k", "fo", "PostCreated", { async: true })
    .alt("author has < 10k followers (push)", "fo", "tl")
    .loop("pages of 1,000 followers", "fo", "tl")
    .msg("fo", "g", "followers(author, cursor)")
    .msg("g", "fo", "1,000 ids", { reply: true })
    .msg("fo", "fo", "drop followers inactive for 30+ days")
    .msg("fo", "tl", "pipeline: LPUSH timeline:{f} post_id; LTRIM 0 799")
    .end()
    .else("celebrity (≥ 10k followers) — pull")
    .msg("fo", "tl", "ZADD celeb_posts:{author} post_id (one write, many readers)")
    .end()
    .note("Big fan-outs are split into many small tasks so one popular author doesn't block the partition, and workers can retry a page without redoing everything.", ["fo", "tl"], "info")
    .build();
}

function readFeed() {
  return new Sequence("Loading the feed", "Merge pushed ids with pulled celebrity posts, rank, then hydrate only one page", { gap: 230 })
    .actor("u", "Reader", "client")
    .actor("f", "Feed service", "service")
    .actor("tl", "Timeline cache", "cache")
    .actor("g", "Social graph", "db")
    .actor("cc", "Celebrity cache", "cache")
    .actor("r", "Ranking", "service")
    .actor("h", "Post / user caches", "cache")
    .msg("u", "f", "GET /feed?cursor=…&limit=20")
    .par("fetch candidates in parallel", "f", "cc")
    .msg("f", "tl", "LRANGE timeline:{me} 0 499")
    .msg("f", "g", "celebrities I follow (cached)")
    .msg("f", "cc", "recent posts of those ~30 celebrities")
    .end()
    .msg("f", "f", "merge + dedupe → ~500 candidates; drop blocked / muted authors")
    .alt("ranked feed", "f", "r")
    .msg("f", "r", "score(candidates, my features) — 50 ms budget")
    .msg("r", "f", "ordered ids", { reply: true })
    .else("ranking timed out or chronological mode")
    .msg("f", "f", "sort by post_id (time)")
    .end()
    .msg("f", "h", "MGET 20 posts + authors + like/reply counts")
    .msg("h", "f", "hydrated items (deleted posts filtered out)", { reply: true })
    .msg("f", "u", "items + next cursor (cache the ranked list for a few minutes)", { reply: true })
    .note("Cold user (timeline empty after inactivity): build the timeline on the fly by pulling recent posts from all followees, then store it.", ["f", "g"], "warn")
    .build();
}

function hybrid() {
  return new Diagram("Deep dive — push, pull & hybrid", "Push is fast to read but expensive for big authors; pull is cheap to write but slow to read")
    .zone("Push (fan-out on write)", ["alice", "t1", "t2", "t3"], "#e8590c")
    .zone("Pull (fan-out on read)", ["celeb", "cc"], "#1971c2")
    .node("alice", "Alice", 0, 0.9, "client", { detail: "300 followers → 300 writes" })
    .node("t1", "timeline:bob", 1.2, 0, "cache", { detail: "[…, alice#91]" })
    .node("t2", "timeline:carol", 1.2, 0.9, "cache", { detail: "[…, alice#91]" })
    .node("t3", "timeline:dan", 1.2, 1.8, "cache", { detail: "[…, alice#91]" })
    .node("celeb", "Celebrity", 0, 3.1, "client", { highlight: true, detail: "50 M followers → 1 write" })
    .node("cc", "celeb_posts:star", 1.2, 3.1, "cache", { detail: "latest 200 post ids" })
    .node("feed", "Carol's feed", 2.6, 1.9, "service", { detail: "timeline:carol ∪ celeb_posts of stars she follows" })
    .edge("alice", "t1")
    .edge("alice", "t2", "LPUSH")
    .edge("alice", "t3")
    .edge("celeb", "cc", "ZADD")
    .edge("t2", "feed", "read")
    .edge("cc", "feed", "merge")
    .panel(
      "Trade-offs",
      [
        "Push: O(1) reads; writes = followers; wasted on inactive users; a 50 M-follower post = 50 M writes and minutes of lag",
        "Pull: 1 write; reads = followees (slow if you follow 2,000 people)",
        "Hybrid: push for normal authors, pull for the few thousand biggest accounts",
        "Threshold is tunable (e.g. 10k followers), and can also depend on how active the followers are",
      ],
      3.6,
      0,
      { width: 460, tone: "info" },
    )
    .panel(
      "Keeping it correct",
      ["Timelines hold ids only; bodies are hydrated, so edits and deletes happen in one place", "Unfollow: filter at read time, trim lazily", "Timeline cache is rebuildable from posts + graph"],
      3.6,
      2.2,
      { width: 460 },
    )
    .build();
}

function ranking() {
  return new Diagram("Deep dive — ranking pipeline", "Retrieve many candidates cheaply, score them with a model, then apply rules for a healthy feed")
    .node("cand", "1. Candidates", 0, 0, "service", { detail: ["pushed timeline ids", "celebrity posts", "recommended (out-of-network)"] })
    .node("filter", "2. Filter", 1.1, 0, "service", { detail: ["seen, blocked, muted", "deleted, policy violations"] })
    .node("feat", "3. Features", 2.2, 0, "service", { detail: ["author affinity", "engagement velocity", "recency, media type"] })
    .node("model", "4. Score", 3.3, 0, "worker", { detail: ["model predicts P(like), P(reply), P(hide)", "weighted sum = score"] })
    .node("rules", "5. Re-rank rules", 4.4, 0, "service", { detail: ["author diversity", "freshness boost, ad slots"] })
    .node("page", "6. Page cache", 4.4, 1.4, "cache", { detail: ["ranked ids for ~5 min", "cursor = position"] })
    .node("fs", "Feature store", 2.2, 1.4, "db", { detail: ["online: Redis / Cassandra", "offline: warehouse"] })
    .node("logs", "Engagement logs", 3.3, 2.6, "queue", { detail: "impressions, likes, hides" })
    .node("train", "Training pipeline", 2.2, 2.6, "worker", { detail: "daily / hourly retrain" })
    .edge("cand", "filter", "~1,500")
    .edge("filter", "feat", "~500")
    .edge("feat", "model")
    .edge("model", "rules")
    .edge("rules", "page", "top 200")
    .edge("feat", "fs", "lookup")
    .edge("page", "logs", "what users did", { async: true })
    .edge("logs", "train", undefined, { async: true })
    .edge("train", "fs", "features")
    .panel("Budget", ["Whole pipeline ≤ 100 ms", "Fallback: chronological order if any step times out"], 0, 1.4, { width: 330, tone: "warn" })
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "publish", name: "Publish & fan-out", build: publish },
  { id: "read-feed", name: "Load the feed", build: readFeed },
  { id: "hybrid", name: "Push vs pull", build: hybrid },
  { id: "ranking", name: "Ranking pipeline", build: ranking },
] satisfies DiagramSpec[];
