# Distributed Rate Limiter

> Enforce "at most N requests per time window" per client across a fleet of stateless gateways, adding under a millisecond to each request.

## The problem in one minute

An API with many clients needs to stop any one of them from using more than its share. Without limits, one buggy script or one attacker can exhaust capacity for everyone. The difficulty is that requests from the same client land on **different gateway instances**, so each gateway can't just count locally: they need a shared, fast, and correct view of each client's usage.

| Decision | Choice | Why |
| --- | --- | --- |
| Where to enforce | Middleware in the API gateway | One place protects every backend service |
| Algorithm | Token bucket (plus sliding-window counter for "per minute/day" rules) | Allows short bursts, cheap to store (two numbers per key) |
| Shared state | Redis Cluster, one hash per `(rule, client)` | Sub-millisecond, atomic scripts, easy to shard |
| Atomicity | A Lua script does read-refill-take-write in one step | No race conditions between gateways |
| When Redis fails | Fail open with a local fallback limit | The limiter must never be the reason the API is down |
| Multi-region | Split the global budget per region | Keeps every check local and fast |

## Requirements

### Functional

- Limit requests by **API key, user ID, IP address, or endpoint**, and combinations of these.
- Support several rules per request, e.g. *100 per second with bursts up to 200* **and** *50,000 per day*.
- Different limits per plan (free, pro, enterprise).
- When a client is over the limit, return `429 Too Many Requests` with `Retry-After`, and always return `X-RateLimit-*` headers so clients can pace themselves.
- Change rules without redeploying gateways.

### Non-functional

| Property | Target |
| --- | --- |
| Added latency | < 1 ms at p99 |
| Throughput | 1 M checks per second across the fleet |
| Keys | Tens of millions of active `(rule, client)` pairs |
| Accuracy | Small over-admission during races is acceptable; letting through 2× the limit is not |
| Availability | The API must keep working if the limiter's storage fails |

## Capacity estimation

- **Traffic:** 1 M requests/s at peak, each matching on average 2 rules → **2 M bucket operations/s**, but pipelined into **1 M Redis round trips/s**.
- **Redis throughput:** one Redis shard handles roughly 100k–200k simple Lua calls per second. 1 M ÷ ~100k = **~10 shards**, plus one replica each.
- **Memory:** each bucket is a small hash (`tokens`, `ts`), about 100 bytes including key and overhead. 20 M active keys × 100 B ≈ **2 GB**. Memory is not the constraint; throughput is.
- **Expiry:** buckets expire when idle (TTL = time to refill completely + margin), so inactive clients cost nothing.
- **Network:** 1 M round trips/s × ~200 bytes ≈ 200 MB/s across the cluster, which is fine within one data centre.

## Where to enforce limits

| Location | Pros | Cons |
| --- | --- | --- |
| Client-side SDK | Free, reduces wasted calls | Untrusted — clients can ignore it |
| Edge / CDN | Stops floods before they reach you | Coarse (IP-based), limited rule logic |
| **API gateway middleware** | One place protects all services; knows API key and route | Needs shared state across instances |
| Inside each service | Business-aware (e.g. "3 password resets per hour") | Duplicated logic, uneven coverage |
| Sidecar / service mesh | Language-agnostic, per-service | Operational complexity |

In practice you layer them: coarse IP limits at the edge, per-key and per-endpoint limits in the gateway, and a few business rules inside services. This design focuses on the **gateway** layer. See the [Architecture](#diagram/architecture) diagram.

## API and rule configuration

### Headers returned on every response

```http
X-RateLimit-Limit: 100          # requests allowed in the current window / bucket size
X-RateLimit-Remaining: 57       # what's left right now
X-RateLimit-Reset: 1            # seconds until the bucket is full again (or window resets)
```

### When throttled

```http
429 Too Many Requests
Retry-After: 1
Content-Type: application/json

{ "error": "rate_limited", "rule": "public-api-per-key", "retry_after_ms": 800 }
```

### Rules

```yaml
- id: public-api-per-key
  match: { path_prefix: /v1/, key: api_key }
  limits:
    - { algorithm: token_bucket, rate: 100, per: second, burst: 200 }
    - { algorithm: sliding_window, rate: 50000, per: day }
  plans:
    enterprise: { multiplier: 10 }

- id: login-per-ip
  match: { path: /login, method: POST, key: ip }
  limits:
    - { algorithm: sliding_window, rate: 5, per: minute }
  on_storage_failure: fail_closed     # security-sensitive

- id: expensive-report
  match: { path: /v1/reports, key: api_key }
  cost: 10                            # one call uses 10 tokens
  limits:
    - { algorithm: token_bucket, rate: 20, per: minute, burst: 20 }
```

Rules live in a versioned store (a Git-backed YAML file or a database table). A small config service watches for changes and pushes them to gateways (etcd watch, or Redis pub/sub). Each gateway keeps the rules **in memory**, so matching a request costs microseconds and keeps working if the rules store is down.

## Data model

One Redis hash per bucket:

```text
key:    rl:{public-api-per-key:key_8f2c}:sec     # {…} is a Redis Cluster hash tag
fields: tokens = 57.4                            # float, current tokens
        ts     = 1790000000123                   # ms timestamp of the last update
TTL:    capacity / rate + 1 s                    # idle buckets disappear
```

For a sliding-window counter, two plain integer keys:

```text
rl:{login-per-ip:203.0.113.9}:w:29833320   → 3    (count in minute #29833320)
rl:{login-per-ip:203.0.113.9}:w:29833319   → 4    (previous minute)
```

**The hash tag.** Redis Cluster decides the shard from the part of the key inside `{…}`. Putting `rule:client` there guarantees all keys for one client and rule are on the same shard, so a single Lua script can touch them atomically.

## Algorithms

See the [Algorithms](#diagram/algorithms) diagram for worked examples.

| Algorithm | Idea | Memory per key | Bursts | Accuracy |
| --- | --- | --- | --- | --- |
| **Token bucket** | A bucket of capacity *b* refills at rate *r*; each request takes a token | 2 numbers | Allows bursts up to *b* | Good |
| Leaky bucket | Requests enter a queue that drains at a fixed rate | A queue | Smooths bursts completely | Good, but adds waiting time |
| Fixed window counter | `INCR count:{minute}` | 1 number | Up to 2× the limit at window edges | Poor at edges |
| Sliding window log | Store every request timestamp in a sorted set | One entry per request | None | Exact, but expensive |
| **Sliding window counter** | Weighted mix of current and previous window counts | 2 numbers | Minimal | Very close to exact |

### Token bucket

Picture a bucket that holds at most *b* tokens and gains *r* tokens per second. Each request removes one token (or more, for expensive calls). If there's no token, the request is rejected. This allows short bursts (up to *b* at once) while enforcing an average rate of *r*. AWS, Stripe and most public APIs use it.

We don't need a timer to add tokens. Each time a request arrives, we compute how many tokens *would* have been added since the last update:

```lua
-- KEYS[1] = bucket key
-- ARGV = capacity, refill_per_sec, now_ms, cost
local cap  = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now  = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap        -- new clients start with a full bucket
local ts     = tonumber(b[2]) or now

tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)   -- lazy refill
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)

-- retry_after_ms: how long until `cost` tokens are available
local retry = allowed and 0 or math.ceil((cost - tokens) / rate * 1000)
return { allowed and 1 or 0, tostring(tokens), retry }
```

Redis runs a Lua script **atomically**: no other command runs on that shard in the middle. That removes the race where two gateways both read "1 token left" and both admit a request. Load the script once with `SCRIPT LOAD` and call it by hash with `EVALSHA` to save bandwidth.

### Sliding window counter

A fixed window (`INCR count:12:01`) has an edge problem: a client can send 100 requests at 12:00:59 and 100 more at 12:01:00 — 200 requests in two seconds against a limit of 100 per minute.

The sliding window counter fixes this by estimating how many requests happened in the last 60 seconds:

```text
estimate = current_window_count + previous_window_count × (1 − fraction_of_current_window_elapsed)
```

Example: limit 100/minute. The previous minute had 84 requests. We are 25 % into the current minute, which has 36 so far. Estimate = 36 + 84 × 0.75 = 99. One more request is allowed; the next one is not. The estimate assumes requests in the previous window were evenly spread, which is close enough in practice (Cloudflare measured ~0.003 % error).

## Request flow

See [Checking a request](#diagram/check-flow).

1. The gateway authenticates the request and extracts the identifiers (API key, user, IP, route).
2. It matches rules from its in-memory rule set. Typically 1–3 rules apply.
3. **Local pre-check.** Each gateway keeps a tiny in-memory token bucket per key, sized at roughly `limit ÷ number_of_gateways × 2`. If even this generous local bucket is empty, the client is clearly abusive, and the gateway rejects without calling Redis. This protects Redis from hot keys.
4. The gateway sends one pipelined request to Redis with one `EVALSHA` per matching rule.
5. If Redis doesn't answer within a tight timeout (e.g. 5 ms), the gateway **fails open** for normal rules — it admits the request, applying only the local limit — and records a metric. Rules marked `fail_closed` (login, OTP, password reset) reject instead.
6. If every rule allows, forward the request and add `X-RateLimit-*` headers using the most restrictive rule.
7. If any rule denies, return `429` with `Retry-After` from the script's `retry_after_ms`, and emit a throttle event to Kafka for dashboards and abuse detection.

**A subtle point:** with several rules, a request denied by rule B may already have taken a token from rule A. Either accept this small over-counting (common), or check all rules in one Lua script that only deducts when all of them allow.

## Scaling and reliability

See [Multi-region & failures](#diagram/scaling).

- **Shard by key.** Redis Cluster spreads keys across shards by hash slot. Add shards to add throughput.
- **Keep Redis close.** Place Redis in the same availability zone as the gateways; a cross-zone hop adds ~1 ms. Use persistent connection pools and pipelining.
- **Hot keys.** A single client hammering the API sends all its checks to one shard. The local pre-limiter absorbs most of this. For legitimate very-high-volume clients, split their bucket into several sub-buckets (e.g. `key#0` … `key#7`, each with 1/8 of the limit) chosen at random.
- **Replication.** Each shard has a replica. On failover, a few recent updates may be lost, which only means a client briefly gets a few extra requests. That's acceptable.
- **Multi-region.** A globally consistent counter would add a cross-region round trip (~100 ms) to every request. Instead, give each region a share of the global limit (e.g. 60 % / 40 % by traffic), check locally, and have a background job exchange usage every few seconds and rebalance shares. The global cap becomes approximate, which is fine for fairness limits.

### Alternative: local counting with periodic sync

For very high volumes, gateways can count locally and push increments to Redis every ~100 ms, reading back the global total. This removes Redis from the request path entirely at the cost of up to 100 ms of over-admission. Envoy's global rate limit service and many CDNs use variations of this.

### Failure modes

| Failure | Effect | Handling |
| --- | --- | --- |
| Redis shard down | Checks for its keys fail | Fail open + local limit; replica promotion within seconds |
| Redis slow (p99 spikes) | Adds latency to every request | Tight timeout (5 ms), then fail open |
| Rules store down | Can't change rules | Gateways keep the last good rules in memory |
| Bad rule pushed (limit = 0) | Everyone throttled | Validate rules, canary new rules on a few gateways, instant rollback |
| Clock skew between gateways | Refill amounts slightly off | Use Redis `TIME` inside the script, or rely on NTP; token bucket tolerates small skew |
| Gateway restart | Local pre-limiter state lost | Harmless; Redis holds the real state |

## Security and abuse

- Key by the most trustworthy identifier available: API key or user ID beats IP address. Many users can share one IP (offices, mobile carriers), and attackers can rotate IPs.
- Put login, sign-up, and password-reset limits on **several** keys at once: per IP, per account, and per device fingerprint.
- Feed throttle events into abuse detection. A client repeatedly hitting limits can be blocked at the edge, which is much cheaper than rate-limiting it in the gateway.
- Don't reveal internal details in 429 responses beyond what clients need.

## Observability

| Metric | Why |
| --- | --- |
| Rate-limit check latency (p50/p99) | The limiter's cost to every request |
| Allowed vs throttled per rule | Are limits set right? Sudden spikes indicate abuse or a client bug |
| Top throttled keys | Find abusive or misconfigured clients |
| Fail-open events | How often protection is off |
| Redis CPU and ops/s per shard | Hot shards, capacity planning |

## Trade-offs to discuss

- **Accuracy vs latency.** A Redis call per request is accurate but adds ~0.5 ms. Local counting with periodic sync is faster but over-admits briefly.
- **Fail open vs fail closed.** Fail open keeps the API up during limiter failures but removes protection; fail closed protects backends but turns a Redis outage into an API outage. Decide per rule.
- **Rate limiting vs load shedding.** Rate limiting is about fairness between clients ("you used your quota"). Load shedding protects the server whoever is calling ("we're at 95 % CPU, drop low-priority traffic"). You want both.
- **Token bucket vs sliding window.** Token bucket is better for per-second limits where short bursts are fine. Sliding window matches how people read "1,000 per day" and avoids surprising bursts.

## Interview follow-up questions

- **How would you rate-limit a client across 10 regions exactly?** You can't do it exactly without a cross-region consensus round trip per request. Explain the per-region budget approach and its error bound.
- **How do you handle a request that costs more than others?** Give it a `cost` (e.g. 10 tokens); the script already supports this.
- **How would you implement concurrency limits (at most 5 in-flight requests)?** A counter incremented on start and decremented on finish, with a lease/TTL per request so crashed requests don't leak slots.
- **How do you communicate limits to clients?** Headers on every response, documented per plan, plus a usage dashboard.
- **What if Redis becomes the bottleneck?** Add shards, add the local pre-limiter, or move to local counting with periodic sync.
