# Distributed Cache

> Design a Redis/Memcached-style cache cluster that serves millions of reads per second at sub-millisecond latency and shields the database from load.

## Requirements

### Functional
- `get(key)`, `set(key, value, ttl)`, `delete(key)`.
- Values up to ~1 MB; TTL-based expiry.
- Eviction when memory is full.

### Non-functional
- **Latency:** p99 < 1 ms within a datacenter.
- **Throughput:** millions of ops/s; scale horizontally by adding nodes.
- **High availability:** a node failure should cost at most a brief hit-rate dip, never an outage.
- Cache data is **not** the source of truth. Losing it is acceptable, but a mass loss must not overload the DB.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Working set | 1 B keys × ~1 KB | ~1 TB of RAM |
| Nodes | 64 GB usable per node | ~16 primaries (+ replicas) |
| Traffic | 5 M reads/s, 500k writes/s | ~300k ops/s per primary, fine for Redis with pipelining |

## API

```text
GET key                 → value | nil
SET key value EX 300    → OK
DEL key                 → 1
MGET k1 k2 k3           → batched reads (one round trip)
```

## High-level design

- **Client library** (or a proxy such as Twemproxy/Envoy) hashes each key onto a **consistent-hash ring** and talks straight to the owning shard. No central router sits on the hot path.
- Each shard is a **primary with one or more replicas** in other availability zones.
- A **cluster config service** (etcd/ZooKeeper, or Redis Cluster's gossip) holds the shard map and pushes topology changes to clients.
- The application uses **cache-aside**: on a miss it reads the DB and populates the cache.

## Deep dives

### Partitioning
- **Consistent hashing with virtual nodes**: adding a node moves only ~1/N of keys.
- **Redis Cluster** uses 16,384 fixed **hash slots** (`CRC16(key) mod 16384`) assigned to nodes. Resharding moves slots, and clients follow `MOVED`/`ASK` redirects.
- Hash tags (`{user:42}:profile`) keep related keys on one shard for multi-key operations.

### Replication & failover
- Asynchronous primary → replica replication, so a failover can lose the last few writes (acceptable for a cache).
- Sentinel/cluster failure detection promotes a replica. Clients refresh the shard map.
- Replicas can serve reads to scale read-heavy keys, at the cost of possible staleness.

### Eviction
| Policy | When |
| --- | --- |
| LRU (approximate, sampled) | Default; recency predicts reuse |
| LFU | Skewed popularity; protects consistently hot keys |
| TTL-only (`volatile-*`) | Only keys with a TTL are eligible |
| Random | Cheapest, surprisingly okay |

Memory fragmentation matters. Memcached uses a **slab allocator** (size classes). Redis relies on jemalloc and active defrag.

### Cache patterns
- **Cache-aside** (most common): read from the cache, on a miss load from the DB and SET. On write, update the DB and then **DELETE** the cache key. Delete instead of update, because concurrent updates can leave a stale value behind.
- **Write-through**: writes go through the cache to the DB, so the cache is always warm.
- **Write-behind**: write to the cache and flush to the DB asynchronously. Fast, but writes are lost if the cache node dies before flushing.

### Consistency between cache and DB
The race: reader misses and reads the old value from the DB → writer updates the DB and deletes the key → reader SETs the stale value.
- Keep **short TTLs** so staleness is bounded.
- Use **delayed double delete**: delete, then delete again after ~1 s.
- Drive invalidation from **CDC** (Debezium reading the DB binlog → delete keys), so every write path invalidates.
- Use a **version or lease token** (Facebook's memcache leases): only the holder of the lease can SET after a miss.

### Thundering herd / cache stampede
When a hot key expires, thousands of requests hit the DB at once.
- **Request coalescing**: one request recomputes while the others wait, via a lock key (`SET lock NX EX 5`) or in-process single-flight.
- **Stale-while-revalidate**: serve the stale value while one worker refreshes it.
- **Jittered TTLs** avoid synchronized mass expiry.
- **Probabilistic early refresh (XFetch)**: refresh the key before it expires, with a probability that rises as expiry approaches.

### Hot keys
A single key (a celebrity profile, a flash-sale item) can saturate one shard.
- A **local L1 cache** in each app server with a tiny TTL (1–5 s).
- **Key replication**: store `key#1…key#N` copies and read a random one.
- Read from replicas.

### Big keys
Large values or huge collections block the single-threaded event loop. Split them (`user:42:friends:page:3`), compress, and use `UNLINK` (async delete) instead of `DEL`.

### Cold start / mass failure
If the cache is wiped, the DB takes 100% of the traffic. Warm the cache before shifting traffic, rate-limit DB reads on miss, and fail over region by region.

## Trade-offs

- **Client-side sharding vs proxy:** the client library is fastest; a proxy centralizes topology and supports many languages.
- **Memcached vs Redis:** Memcached is simple and multi-threaded with only strings. Redis has rich data structures, persistence and replication, and is mostly single-threaded per shard.
- **Consistency vs hit rate:** shorter TTLs mean less staleness but more DB load.
