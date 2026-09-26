# Distributed Rate Limiter

> Enforce "at most N requests per window" per client across a fleet of stateless gateways, adding under a millisecond to each request.

## Requirements

### Functional
- Limit requests by **user ID, API key, IP, or endpoint**, with multiple rules per request (e.g. 10/s and 1,000/day).
- Return `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers when throttled.
- Rules are configurable without redeploying.

### Non-functional
- **Low latency:** < 1 ms p99 overhead.
- **Accurate enough:** small over-admission under races is fine; large bursts are not.
- **Highly available:** the limiter must not become the reason the API is down — prefer **fail-open**.
- Scales to millions of distinct keys.

## Where to put it

| Location | Pros | Cons |
| --- | --- | --- |
| Client-side | Free | Untrusted; only a courtesy |
| API gateway / middleware | Centralised, protects all services | Needs shared state across gateway instances |
| Inside each service | Fine-grained, business-aware | Duplicated logic |
| Sidecar / service mesh (Envoy) | Language-agnostic | Operational complexity |

The diagram shows limiter **middleware in the gateway**, backed by a shared **Redis cluster**.

## Algorithms

| Algorithm | Idea | Memory | Bursts | Accuracy |
| --- | --- | --- | --- | --- |
| **Token bucket** | Bucket of capacity *b* refills at rate *r*; each request takes a token | 2 numbers/key | Allows bursts up to *b* | Good |
| Leaky bucket | Requests queue and drain at a fixed rate | Queue/key | Smooths bursts | Good; adds latency |
| Fixed window counter | `INCR key:{minute}` | 1 number/key | 2× burst at window edges | Poor at edges |
| Sliding window log | Store every timestamp in a sorted set | O(requests) | None | Exact; expensive |
| **Sliding window counter** | Weighted mix of current and previous window counts | 2 numbers/key | Minimal | ~Exact in practice |

**Token bucket** is the common default (used by AWS and Stripe); **sliding window counter** is a great alternative when you think in "N per minute".

### Token bucket in Redis (atomic with Lua)

```lua
-- KEYS[1] = bucket key, ARGV = capacity, refill_per_sec, now_ms, cost
local cap, rate, now, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return { allowed and 1 or 0, tokens }
```

Running the read-modify-write inside one Lua script makes it **atomic** — no race between concurrent gateways. Load it once and call it with `EVALSHA`.

### Sliding window counter

```text
estimate = count(current_window) + count(previous_window) × (1 − elapsed_fraction_of_current_window)
```

Two `INCR`s with TTLs; very cheap and smooth.

## Rules configuration

```yaml
- id: public-api-per-key
  match: { path_prefix: /v1/, key: api_key }
  limits:
    - { rate: 100, per: second, burst: 200 }
    - { rate: 50000, per: day }
- id: login-per-ip
  match: { path: /login, key: ip }
  limits:
    - { rate: 5, per: minute }
```

Rules live in a config store (Git-backed YAML or a DB) and are **cached in memory** in every gateway, hot-reloaded on change.

## Request flow

1. Gateway derives the key(s): `rule_id:api_key` etc.
2. For each matching rule, run the Lua script (pipeline them in one round trip).
3. If any rule denies → `429` with `Retry-After = ceil((cost - tokens) / rate)`.
4. Otherwise forward, attaching `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
5. Publish throttle events asynchronously for dashboards and abuse detection.

## Scaling & reliability

- **Shard Redis by key** (Redis Cluster). All data for a key lives on one shard, so the script stays atomic.
- **Hot keys:** a single abusive key can overload its shard — add a small **local pre-limiter** in each gateway (e.g. allow at most `limit / gateways × 2` locally) before touching Redis.
- **Latency:** co-locate Redis with gateways (same AZ). Use connection pooling and pipelining.
- **Redis failure:** fail open (let traffic through) with a conservative in-memory local limit as a backstop. Fail closed only for security-sensitive endpoints like login.
- **Multi-region:** per-region limits (divide the global budget) are simpler and faster than a globally consistent counter. Sync usage asynchronously if you need an approximate global cap.

## Trade-offs

- **Accuracy vs. latency:** a batched/local approach (gateways sync counts every 100 ms) removes Redis from the hot path at the cost of brief over-admission.
- **Clock skew:** use Redis `TIME` inside the script, or gateway time with NTP; token bucket tolerates small skew.
- **Throttle vs. shed:** rate limiting is per-client fairness; **load shedding** protects the server regardless of who is calling (e.g. drop low-priority traffic when CPU > 90 %). You usually want both.
