# News Feed

> Twitter/Facebook/Instagram home timeline: show each user a fresh, ranked list of posts from the people they follow, in under 200 ms.

## Requirements

### Functional
- Publish a post (text, media).
- View a home feed of posts from followed accounts, newest or ranked, with pagination.
- Follow / unfollow.

### Non-functional
- Feed load p99 < 200 ms.
- New posts appear in followers' feeds within a few seconds (eventual consistency is fine).
- Extremely read-heavy: feed reads ≫ posts.
- 300 M DAU.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Posts | 300 M DAU × 1 post/day | ~3,500 posts/s avg |
| Feed reads | 300 M × 10 loads/day | ~35,000 reads/s avg, ~100k peak |
| Fan-out | avg 200 followers | ~700k timeline inserts/s |
| Timeline cache | 800 post IDs × 8 B × 300 M users | ~2 TB of RAM (IDs only) |

## API

```http
POST /v1/posts            { "text": "…", "media_ids": ["m1"] }
GET  /v1/feed?cursor=…&limit=20
POST /v1/users/{id}/follow
```

Use **cursor-based pagination** (`cursor = last seen post_id/score`), not offsets — feeds shift constantly.

## Data model

```text
posts         (post_id PK, author_id, body, media_refs, created_at)   -- sharded by post_id
follows       (follower_id, followee_id)  + reverse index (followee_id → followers)
timeline:{user_id}   Redis list / sorted set of post_ids (capped at ~800)
```

Post IDs are Snowflake-style (time-sortable), so sorting by ID ≈ sorting by time.

## Fan-out strategies

| Strategy | How | Pros | Cons |
| --- | --- | --- | --- |
| **Fan-out on write (push)** | On publish, insert `post_id` into every follower's timeline cache | Reads are O(1) — just read the list | Celebrities with 100 M followers → 100 M writes per post; wasted work for inactive users |
| **Fan-out on read (pull)** | On feed load, query recent posts from each followee and merge | No write amplification | Slow reads for users following thousands |
| **Hybrid** | Push for normal authors; pull for celebrities at read time | Fast reads, bounded write cost | More complex merge logic |

Most large networks use the **hybrid** approach shown in the diagram.

## High-level design

### Write path
1. `POST /posts` → Post service stores the post (and media via pre-signed upload to object storage/CDN).
2. Emits `PostCreated` to the fan-out queue.
3. Fan-out workers look up the author's followers (in batches) from the social graph.
4. For non-celebrity authors, `LPUSH` + `LTRIM` the `post_id` into each **active** follower's timeline.

### Read path
1. Feed service reads the user's precomputed timeline IDs.
2. Merges in recent posts from followed **celebrities** (pulled and cached per celebrity).
3. **Hydrates** IDs into full posts + author info from a post/user cache (multi-get).
4. Optional **ranking** step, then returns a page + cursor.

## Deep dives

### The celebrity problem
- Mark accounts above a follower threshold (e.g. 10k–1M) as "pull" authors.
- Cache each celebrity's recent posts in one place; every reader merges from the same cached list — one write, many reads.

### Ranking
- Candidate generation: timeline IDs + celebrity posts + (optionally) recommended posts.
- Feature fetch: author affinity, engagement velocity, recency, media type.
- A model scores candidates; results are cached briefly per user.
- Always keep a chronological fallback if ranking times out.

### Hydration and caching
- Timeline cache stores **IDs only**; post bodies live in a separate post cache so edits/deletes happen in one place.
- Multi-get (`MGET`) posts and authors in parallel; cache counts (likes, replies) separately with short TTLs because they change constantly.

### Inactive users
Skip fan-out for users who haven't logged in for N days; rebuild their timeline on next login via pull.

### Deletes and privacy
- Deleting a post: mark deleted in the post store; hydration filters it out. Lazily remove IDs from timelines.
- Blocks/mutes are applied at read time as a filter.

## Scaling & reliability

- Shard timeline caches by `user_id`; replicate for availability. They are a cache — rebuildable from the post store and graph.
- Fan-out workers scale horizontally; use Kafka partitioning by author so a single post's fan-out isn't duplicated.
- Back-pressure: if fan-out lags, reads still work because pull-merge covers recent posts.
- Media always served through the CDN.

## Trade-offs

- **Push vs pull** is the central trade-off — say it explicitly and pick a threshold.
- **Freshness vs cost:** fan-out lag of a few seconds is acceptable; synchronous fan-out is not.
- **Chronological vs ranked:** ranking raises engagement but costs compute and adds latency; cache ranked pages briefly.
