# News Feed

> Twitter/Facebook/Instagram home timeline: show each user a fresh, ranked list of posts from the people they follow, in under 200 ms.

## The problem in one minute

A feed is a **query over the social graph**: "the newest (or best) posts from everyone I follow". Running that query on every feed load — find 500 followees, fetch their recent posts, merge, sort — is too slow at hundreds of thousands of loads per second. So most of the work is done **ahead of time**: when someone posts, the post's ID is pushed into each follower's precomputed timeline. Reading a feed then becomes "read one list".

That trick breaks for accounts with tens of millions of followers (one post = tens of millions of writes), so large accounts are handled the other way: their posts are **pulled** and merged at read time. This **hybrid fan-out** is the heart of the design.

| Decision | Choice | Why |
| --- | --- | --- |
| Feed construction | Hybrid: push for normal authors, pull for celebrities | Fast reads without 50-million-write posts |
| Timeline storage | Redis list per user, **post IDs only**, capped at ~800 | Small, fast, rebuildable; bodies stay in one place |
| Post IDs | Snowflake (time-sortable 64-bit) | Sorting by ID ≈ sorting by time; no coordination |
| Fan-out | Async workers fed by Kafka, batched per 1,000 followers | Posting stays fast; fan-out retries are cheap |
| Reading | Merge → rank → hydrate one page | Only 20 posts are fully loaded per request |
| Pagination | Cursor-based | Offsets break when new posts arrive |
| Freshness | A few seconds of fan-out lag is acceptable | Eventual consistency is fine for feeds |

## Requirements

### Functional

- Publish a post (text, images, video, links).
- View a home feed of posts from followed accounts, ranked or chronological, with infinite scroll.
- Follow and unfollow; block and mute.
- Like, reply, repost (the counts show in the feed).

### Non-functional

| Property | Target |
| --- | --- |
| Feed latency | p99 < 200 ms for the first page |
| Freshness | New posts appear in followers' feeds within ~5 s (celebrity posts immediately, via pull) |
| Scale | 300 M daily active users; extremely read-heavy |
| Availability | Feeds keep loading even if fan-out is behind or ranking fails |
| Consistency | Eventual; but a user must see their own new post immediately |

## Capacity estimation

- **Posts:** 300 M DAU × 1 post/day ≈ **3,500 posts/s** average, ~10k/s peak.
- **Feed reads:** 300 M × 10 feed loads/day = 3 B/day ≈ **35k reads/s** average, **~100k/s** peak.
- **Fan-out writes:** average 200 followers per author → 3,500 × 200 = **700k timeline inserts/s**. Skipping inactive followers (say 50 %) halves it.
- **Timeline cache:** 800 IDs × 8 bytes × 300 M active users ≈ **2 TB** of RAM (plus Redis overhead, ~3–4 TB). Across ~50–100 Redis shards.
- **Post storage:** 3,500/s × 86,400 × 365 ≈ 110 B posts/year × ~1 KB ≈ **110 TB/year** of post metadata; media (photos/video) is far larger and lives in object storage behind a CDN.
- **Hydration:** 100k feed loads/s × 20 posts = **2 M post lookups/s** from the post cache (plus authors and counters) — batched with `MGET`.

## API

```http
POST /v1/posts
Idempotency-Key: 9c1e…
{ "text": "Launch day!", "media_ids": ["m_41"], "reply_to": null }
→ 201 { "post_id": "1790000000123456789" }

GET /v1/feed?limit=20&cursor=eyJwb3MiOjIwfQ
→ 200 {
    "items": [ { "post_id": "…", "author": { "id": "…", "name": "…", "avatar": "…" },
                 "text": "…", "media": [ … ], "created_at": "…",
                 "counts": { "likes": 120, "replies": 8, "reposts": 3 }, "liked_by_me": false } ],
    "next_cursor": "eyJwb3MiOjQwfQ"
  }

POST   /v1/users/{id}/follow
DELETE /v1/users/{id}/follow
POST   /v1/posts/{id}/like
```

**Why cursors, not offsets?** New posts keep arriving at the top. With `?offset=20`, the second page would repeat items that shifted down. A cursor encodes "continue after this position" (for chronological feeds, the last `post_id`; for ranked feeds, a position in a cached ranked list).

## Data model

```text
posts            (post_id PK, author_id, text, media_refs, reply_to, created_at, deleted)
                 -- sharded by post_id; secondary index / table author_posts(author_id, post_id DESC)

follows          (follower_id, followee_id, created_at)          -- "who do I follow"
followers        (followee_id, follower_id, created_at)          -- reverse index: "who follows me"

timeline:{user}  Redis list of post_ids, newest first, LTRIM to 800
celeb_posts:{author}  Redis sorted set of recent post_ids (score = time) for pull authors

counters         (post_id → likes, replies, reposts)             -- separate, high write rate
user_activity    (user_id → last_active_at)                      -- used to skip inactive users
```

- The social graph is stored **both ways** because fan-out needs "followers of X" and pulling needs "followees of Y". A graph with billions of edges is sharded by the first ID of each table.
- Counters live apart from posts because likes change thousands of times per minute on popular posts; they're aggregated in memory and flushed, and cached with short TTLs.

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Post service | Validate and store posts; emit `PostCreated` through an outbox |
| Media service + CDN | Pre-signed uploads, transcoding, delivery |
| Kafka | Buffers post events; partitioned by author |
| Fan-out workers | Page through followers, push post IDs into active followers' timelines |
| Social graph service | Follows/followers lookups; caches hot adjacency lists |
| Timeline cache | Per-user list of post IDs (Redis, sharded by user) |
| Celebrity posts cache | Recent post IDs of pull authors |
| Feed service | Build a page: merge, filter, rank, hydrate |
| Ranking service | Score candidates with a model |
| Post / user / counter caches | Hydration data |

## Publishing a post

See [Publish & fan-out](#diagram/publish).

1. The client uploads media first (pre-signed URL), then calls `POST /posts` with an idempotency key.
2. The post service writes the post (and an outbox row) and returns `201`. The author sees their post immediately because the client inserts it at the top of their own feed; the feed service also always merges the user's own latest posts.
3. The outbox relay publishes `PostCreated` to Kafka.
4. A fan-out worker checks the author's follower count:
   - **Normal author:** page through followers 1,000 at a time; drop followers inactive for 30+ days; pipeline `LPUSH timeline:{f} post_id` + `LTRIM 0 799` to Redis.
   - **Celebrity:** add the post to `celeb_posts:{author}` — one write.
5. Large fan-outs are split into many independent tasks (one per follower page) so they can run in parallel and retry individually.

## Loading the feed

See [Load the feed](#diagram/read-feed).

1. In parallel: read the user's timeline IDs (up to ~500), the list of celebrities they follow (cached), and those celebrities' recent posts.
2. Merge and deduplicate into ~500 candidates; remove blocked and muted authors and posts the user has hidden.
3. Rank (see below). If ranking times out, fall back to chronological order.
4. Take the page (20 items) and **hydrate** with batched `MGET`s: post bodies, author profiles, counters, "liked by me".
5. Filter out posts deleted since they were fanned out.
6. Return items and a cursor; cache the ranked candidate list for a few minutes so the next pages are consistent and cheap.

**Cold users:** a user returning after months has an empty or stale timeline (we skipped them during fan-out). Build it on demand: pull recent posts from their followees, rank, and store the result as their timeline.

## Deep dives

### 1. Push vs pull vs hybrid

See [Push vs pull](#diagram/hybrid).

| Strategy | Write cost per post | Read cost per feed load | Problem |
| --- | --- | --- | --- |
| Push (fan-out on write) | O(followers) | O(1): read one list | A celebrity post = tens of millions of writes and minutes of lag; wasted work for inactive followers |
| Pull (fan-out on read) | O(1) | O(followees): query and merge many authors | Slow for users who follow thousands |
| **Hybrid** | O(followers) for normal authors, O(1) for celebrities | One list + a few dozen celebrity lists | More moving parts |

The threshold (e.g. 10k followers) is a tuning knob. Some systems decide per author-follower pair: push to followers who are active, let the rest pull.

### 2. The celebrity problem, quantified

A post by an account with 50 M followers, pushed at 1 M inserts/s, takes **50 seconds** to fan out and uses the whole fan-out budget of the system. With pull, it's one write, and each of the (say) 5 M followers who load their feed in the next hour reads the same cached list — cheap, because it's served from one hot, replicated cache key.

### 3. Ranking

See [Ranking pipeline](#diagram/ranking).

1. **Candidate generation:** in-network posts (timeline + celebrity posts), plus optionally out-of-network recommendations. ~1,500 candidates.
2. **Filtering:** already seen, blocked, muted, deleted, policy violations. ~500 left.
3. **Feature lookup** from a feature store: author affinity (how often I interact with this author), post engagement velocity, recency, media type, my historical preferences.
4. **Scoring:** a model predicts probabilities (like, reply, share, hide) and combines them into a score.
5. **Re-ranking rules:** author diversity (not five posts from one author in a row), freshness boosts, ad slots.
6. Cache the ranked list per user for a few minutes.

The whole pipeline has a ~100 ms budget. Engagement logs feed back into model training.

### 4. Hydration and caching layers

- Timelines hold **IDs only**. If timelines held full posts, every edit, delete, or profile-picture change would require updating millions of copies.
- Hydrate with batched lookups against the post cache, user cache, and counter cache — in parallel.
- Counters are the hottest data: cache with very short TTLs, or push updates to clients periodically.

### 5. Deletes, edits, blocks and privacy

- **Delete:** mark the post deleted; hydration filters it out. Timeline entries are removed lazily (or by a background job if needed for privacy).
- **Edit:** only the post body changes; timelines are unaffected.
- **Unfollow:** filter the author out at read time; trim their IDs from the timeline in the background.
- **Block / private accounts:** always enforced at read time, never trusted to the precomputed timeline.

### 6. Inactive users and storage

Pushing to users who never log in is wasted work. Track `last_active_at`; skip fan-out for users inactive for N days, and let their timeline expire from Redis. They get a pull-built timeline when they return.

## Scaling and reliability

- **Timeline cache:** shard by `user_id`; replicate each shard. It's a cache: if a shard is lost, affected users get pull-built feeds while it refills.
- **Fan-out workers:** scale on Kafka lag. Partition by author so each post is processed once, but split big fan-outs into sub-tasks.
- **Backpressure:** if fan-out falls behind (a traffic spike), feeds still work — the feed service can also pull the latest few minutes of posts from followees to cover the gap.
- **Hot keys:** celebrity post lists and viral post bodies are read extremely often; replicate them across cache shards and use in-process caches.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Fan-out lag grows | New posts appear late | Autoscale workers; feed service pulls recent posts to fill gaps |
| Timeline shard lost | Some users' timelines empty | Rebuild on demand via pull |
| Ranking service down/slow | No ranked order | Chronological fallback within the time budget |
| Post cache miss storm | Load on post DB | Request coalescing; keep replicas warm |
| Graph service slow | Fan-out and pull slow | Cache adjacency lists; serve stale follow lists briefly |

## Observability

- Feed latency p50/p99 per step (candidates, ranking, hydration).
- Fan-out lag: time from post creation to insertion in the last follower's timeline.
- Timeline cache hit rate; rebuilds per minute.
- Ranking timeout rate (how often we fall back).
- Engagement metrics per ranking model version (A/B tests).

## Trade-offs to discuss

- **Push vs pull** is the central trade-off — name it and pick a threshold.
- **Freshness vs cost:** synchronous fan-out would make posts appear instantly but would make posting slow and fragile.
- **Chronological vs ranked:** ranking increases engagement but costs compute, adds latency, and needs a fallback.
- **IDs vs full objects in timelines:** IDs mean an extra hydration step but keep edits, deletes, and privacy correct.

## Interview follow-up questions

- **How do you make sure I see my own post immediately?** The client inserts it locally, and the feed service always merges the viewer's own recent posts.
- **How do you handle a user following 5,000 accounts?** Push covers most of them; limit the number of celebrities merged per request, and cache the merged result.
- **How would you add ads?** Insert ad candidates in the re-ranking step at fixed slots, with their own auction service.
- **How do you backfill a new follow?** On follow, pull the followee's latest few posts into the follower's timeline.
- **How do you handle a post that goes viral?** Its body and counters become hot keys: replicate them in cache, batch counter updates, and serve media from the CDN.
