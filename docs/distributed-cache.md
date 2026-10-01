# Distributed Cache

> Design a Redis/Memcached-style cache cluster that serves millions of reads per second at sub-millisecond latency and shields the database from load.

## The problem in one minute

Databases are durable and flexible, but a single query costs milliseconds and a database can serve only so many per second. Most applications read the same data over and over: the same profiles, products, and settings. A cache keeps copies of that hot data **in memory**, spread over many machines, so most reads never reach the database.

A cache is **not the source of truth.** Losing cached data is acceptable; serving wrong data for too long, or losing so much at once that the database collapses, is not. Most of the design is about those two failure modes.

| Decision | Choice | Why |
| --- | --- | --- |
| Partitioning | 16,384 hash slots mapped to shards (Redis Cluster) or a consistent-hash ring | Adding a shard moves only a slice of keys |
| Routing | Client library talks straight to the owning shard | No proxy hop on the hot path |
| Availability | One async replica per shard, in another AZ | Failover in seconds; losing a few writes is OK for a cache |
| Read pattern | Cache-aside with TTL + jitter | Simple, works with any database |
| Write pattern | Update DB, then **delete** the key; plus CDC-driven invalidation | Deleting avoids ordering races; CDC catches every write path |
| Hot keys | L1 in-process cache + key copies | One shard can't serve 500k reads/s for one key |
| Stampedes | Single-flight lock, stale-while-revalidate, jittered TTLs | One recompute per key instead of thousands |

## Requirements

### Functional

- `get(key)`, `set(key, value, ttl)`, `delete(key)`, batched `mget`/`mset`.
- Values up to ~1 MB; strings plus richer structures (hashes, sorted sets, counters) are a bonus.
- Per-key TTL expiry; eviction when memory is full.

### Non-functional

| Property | Target |
| --- | --- |
| Latency | p99 < 1 ms inside a data centre |
| Throughput | Millions of operations per second; scale by adding shards |
| Availability | A node failure costs at most a brief dip in hit rate, never an outage |
| Consistency | Bounded staleness (seconds to minutes, by use case) |
| Protection | A mass cache loss must not overload the database |

## Capacity estimation

- **Working set:** 1 billion keys × ~1 KB average (key + value + ~50–100 B of per-key overhead) ≈ **1 TB of RAM**.
- **Per node:** a 128 GB machine, keeping `maxmemory` at ~64 GB so there is room for fragmentation, replication buffers, and the copy-on-write memory used by snapshots. 1 TB ÷ 64 GB ≈ **16 primaries**, plus 16 replicas.
- **Traffic:** 5 M reads/s and 0.5 M writes/s → ~350k ops/s per primary. Redis serves ~100k–200k ops/s per core without pipelining, so use pipelining/multiplexing and Redis 6+ I/O threads, or more shards.
- **Database relief:** with a 95 % hit rate the database sees 5 % of 5 M = 250k reads/s instead of 5 M. Raising the hit rate from 95 % to 99 % cuts database reads by **5×** — which is why hit rate is the most important cache metric.
- **Network:** 5 M × 1 KB = 5 GB/s total, ~300 MB/s per shard. Watch NIC limits for large values; compress values over a few KB.

## API

```text
GET key                          → value | nil
SET key value EX 300 [NX|XX]     → OK | nil          (NX: only if absent — used for locks)
DEL key / UNLINK key             → count             (UNLINK frees memory in the background)
MGET k1 k2 k3                    → [v1, nil, v3]     (one round trip; keys on one shard)
INCRBY key n, EXPIRE key s       → counters, TTLs
```

In application code this is usually wrapped in a helper:

```python
def get_user(user_id):
    key = f"user:{user_id}:v3"               # version suffix: bump on schema change
    if (hit := l1.get(key)) is not None:      # in-process, 2 s TTL
        return hit
    value = cache.get(key)
    if value is None:
        value = single_flight(key, lambda: db.fetch_user(user_id))
        cache.set(key, value, ex=300 + random.randint(0, 30))   # TTL with jitter
    l1.set(key, value, ttl=2)
    return value
```

## Architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Role |
| --- | --- |
| Client library | Knows the slot → shard map, computes `CRC16(key) mod 16384`, connects directly to the owning shard, pools connections, pipelines requests, follows redirects |
| L1 in-process cache | Tiny per-server cache (thousands of entries, 1–5 s TTL) for the hottest keys |
| Shard primary | Holds a slice of the key space in memory; single-threaded command execution |
| Shard replica | Async copy in another AZ; takes over on failure; can serve reads that tolerate staleness |
| Cluster config | Redis Cluster uses a gossip bus between nodes; with Memcached, etcd/ZooKeeper or a proxy (mcrouter, Twemproxy, Envoy) holds the map |
| CDC invalidator | Reads the database's change log and deletes affected cache keys, so no write path can forget to invalidate |

### Client-side routing vs a proxy

| | Client library | Proxy (mcrouter, Envoy, Twemproxy) |
| --- | --- | --- |
| Latency | Lowest: one hop | One extra hop (~0.1–0.3 ms) |
| Topology changes | Every client must learn them | Only the proxy fleet |
| Languages | A library per language | Any client that speaks the protocol |
| Extras | — | Connection pooling across clients, replicated pools, shadowing |

Large fleets often use a proxy for operational simplicity; latency-critical services use smart clients.

## Partitioning

- **Hash slots (Redis Cluster):** 16,384 fixed slots; each key maps to `CRC16(key) mod 16384`; each shard owns a set of slots. Moving a slot moves only its keys. With 16 shards, each owns ~1,000 slots.
- **Consistent hashing (Memcached clients, Dynamo):** keys and nodes on a ring with virtual nodes. Same property: adding a node moves ~1/N of keys.
- **Hash tags:** only the part of the key inside `{…}` is hashed, so `{user:42}:profile` and `{user:42}:settings` land on the same shard and can be used together in `MGET` or a Lua script. Use sparingly: too many keys under one tag creates a hot shard.

### Resharding

See [Resharding & failover](#diagram/resharding).

1. Mark the slot `MIGRATING` on the source and `IMPORTING` on the target.
2. Move its keys in batches with `MIGRATE`.
3. During the move, a client asking the source for a key that has already moved gets `-ASK target`; it sends `ASKING` + the command to the target, without updating its map.
4. When the slot is fully moved, the cluster records the new owner. Clients that still ask the old owner get `-MOVED slot target` and update their slot map permanently.

## Replication and failover

- Replication is **asynchronous**: the primary acknowledges a write before the replica has it. After a failover, the last few hundred milliseconds of writes can be lost. For a cache, that just means a few extra misses.
- **Failure detection:** nodes ping each other on the cluster bus. If a primary misses heartbeats for `node_timeout` and a majority of primaries agree, its replica is promoted. Clients discover the change via `MOVED` errors or a map refresh.
- **Reads from replicas** add read capacity for hot shards but may return slightly stale data. Enable per client (`READONLY` in Redis Cluster).
- **Persistence:** usually off, or RDB snapshots only, so a restarted node warms faster. The database remains the source of truth.

## Cache patterns

| Pattern | Read | Write | Good for | Risk |
| --- | --- | --- | --- | --- |
| **Cache-aside** | App checks cache, loads DB on miss, sets cache | App writes DB, deletes key | General purpose; the default | Stale-set race (below) |
| Read-through | Cache library loads from DB on miss | — | Less app code | Same as cache-aside |
| Write-through | — | Write cache and DB together | Data read right after writing | Slower writes; caches unread data |
| Write-behind | — | Write cache; flush to DB later | Very high write rates (counters) | Data loss if the cache dies first |
| Refresh-ahead | Refresh keys before they expire | — | Predictable hot keys | Wasted refreshes |

## Keeping the cache consistent with the database

See [Cache-aside & races](#diagram/cache-aside).

**Why delete instead of update?** If two writers update the DB in order A then B, but their cache `SET`s arrive in order B then A, the cache ends up holding A — stale, possibly forever. Deleting has no ordering problem: the next reader loads the current value.

**The remaining race:**

1. Reader misses and reads version 8 from the DB.
2. Writer updates the DB to version 9 and deletes the key (nothing to delete yet).
3. Reader sets the key to version 8. The cache is now stale until the TTL expires.

**Fixes, from simplest to strongest:**

- **Short TTLs** bound how long staleness can last. Always set a TTL.
- **Delayed double delete:** delete again ~1 second after the write.
- **Leases (Facebook memcache):** a miss returns a lease token; a delete invalidates outstanding leases; a `SET` with an invalidated lease is rejected. Leases also throttle stampedes: only one lease per key is issued every few seconds.
- **Versioned values:** store `{version, data}` and only overwrite if the new version is higher (a small Lua script).
- **CDC-driven invalidation:** a Debezium connector reads the database's binlog and deletes keys for every changed row. This catches writes from batch jobs, admin tools and other services that bypass application code.

## Stampedes and hot keys

See [Stampedes & hot keys](#diagram/hot-keys).

### Cache stampede (thundering herd)

When a popular key expires, every request misses at once and they all query the database.

- **Request coalescing / single-flight:** the first request takes a lock (`SET lock:key NX EX 5`) and recomputes; the others wait briefly and retry, or serve a stale copy. In-process single-flight collapses duplicates inside one server for free.
- **Stale-while-revalidate:** store the value with a *soft* expiry inside it and a longer *hard* TTL. After the soft expiry, one request refreshes it in the background while everyone else keeps getting the old value.
- **Jittered TTLs:** `300 s ± 10 %` stops keys created together (e.g. after a deploy) from all expiring together.
- **Probabilistic early refresh (XFetch):** each read recomputes early with a probability that rises as expiry approaches, so exactly one request usually refreshes just before expiry.

### Hot keys

One key (a celebrity profile, a flash-sale product, a global config) can receive more traffic than one shard can serve, and adding shards doesn't help because the key lives on one shard.

- **L1 in-process cache** with a 1–5 s TTL: with 200 app servers, the shard sees at most ~200 requests per TTL period for that key.
- **Key copies:** write `key#0` … `key#N-1` to different shards and read a random one. Writes must update or delete all copies.
- **Read from replicas** for that shard.
- **Detection:** `redis-cli --hotkeys` (with LFU eviction), client-side sampling, or alarms on per-shard CPU skew.

### Big keys

A 50 MB hash or a million-element sorted set blocks Redis's single thread when read or deleted, stalling every other request on that shard. Split big collections (`user:42:followers:page:3`), cap value sizes, compress large values, and delete with `UNLINK` (background freeing).

## Eviction and memory

| Policy | Evicts | Use when |
| --- | --- | --- |
| `allkeys-lru` | Least recently used (approximate, sampled) | Default for caches |
| `allkeys-lfu` | Least frequently used (with decay) | Very skewed popularity; protects steadily hot keys |
| `volatile-lru` / `volatile-ttl` | Only keys with a TTL | Mixing cache data with keys that must not be evicted |
| `allkeys-random` | Random keys | Cheapest; surprisingly decent |
| `noeviction` | Nothing; writes fail | Redis used as a primary store, not a cache |

Redis approximates LRU by sampling a few keys (default 5) and evicting the oldest among them — nearly as good as exact LRU without the memory cost of a linked list. Memcached uses a **slab allocator**: memory is divided into size classes, which avoids fragmentation but can waste memory when value sizes shift ("slab calcification"; fixed by the slab rebalancer).

## Failure modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| One primary dies | Its slots unavailable for a few seconds | Replica promotion; clients retry with backoff |
| Whole cache cluster lost / cold after a deploy | Database sees 100 % of reads and may fall over | Warm the cache before shifting traffic; rate-limit DB loads on miss; restart shards one at a time |
| Network partition | Minority side stops accepting writes (Redis Cluster) | Accept misses; the app falls back to the DB with limits |
| Hot key saturates a shard | High latency for every key on that shard | L1 cache, key copies, replica reads |
| Memory full with `noeviction` | Writes fail | Use an eviction policy for caches; alert at 80 % |
| Stampede on expiry | DB spike | Single-flight, stale-while-revalidate, jitter |
| Stale data after a missed invalidation | Users see old values | TTLs everywhere; CDC invalidation |

**Protect the database from the cache:** if the cache is down, don't send every request to the database. Put a concurrency limit or circuit breaker on the "miss → DB" path and serve degraded responses instead.

## Observability

| Metric | Why |
| --- | --- |
| Hit rate (overall and per key prefix) | The main value of the cache; a drop means more DB load |
| p99 latency per shard | Hot shards, big keys, slow commands |
| Memory used / fragmentation ratio | Eviction pressure; fragmentation over ~1.5 needs defragmentation |
| Evictions/s | Cache too small for the working set |
| Keys expired vs evicted | Healthy caches expire more than they evict |
| Ops/s and CPU per shard | Skew reveals hot keys |
| Replication lag / link status | Data loss risk on failover |

## Trade-offs to discuss

- **Memcached vs Redis:** Memcached is simple, multi-threaded, strings only, no replication. Redis has rich data structures, replication, persistence, scripting, clustering, and is mostly single-threaded per shard. Most new systems choose Redis (or a compatible engine such as Valkey or KeyDB); Memcached still wins for very simple, very large, multi-core key-value caching.
- **Consistency vs hit rate:** shorter TTLs mean less staleness but more misses. Choose TTLs per data type: seconds for inventory, hours for product descriptions.
- **Local vs distributed cache:** a local cache is ~1,000× faster but duplicates memory in every server and is hard to invalidate. Use it only for small, hot, staleness-tolerant data.
- **Cache vs faster database:** sometimes a read replica, a better index, or a materialised view removes the need for a cache and its consistency problems.

## Interview follow-up questions

- **How do you invalidate a list that contains an updated item (e.g. "top 10 products")?** Cache the list as IDs only and fetch items separately, so updating an item doesn't touch the list; or tag cache entries with dependencies and delete by tag.
- **How would you cache across regions?** Each region has its own cache; invalidation events are replicated to every region (via the CDC stream), accepting a short window of cross-region staleness.
- **How do you do a zero-downtime schema change for cached objects?** Put a version in the key (`user:42:v3`); new code reads new keys and old keys expire naturally.
- **How would you build a distributed lock with Redis?** `SET lock NX PX 30000` with a random value, release only if the value matches (Lua). For correctness-critical locks, add fencing tokens or use a consensus system (etcd, ZooKeeper) — see the Job Scheduler topic.
- **What if Redis latency spikes every few minutes?** Look for big keys, `KEYS *` or other O(N) commands, fork pauses from snapshots, and swapping.
