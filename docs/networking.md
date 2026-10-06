# Networking Fundamentals

> Every box on a system design diagram talks to the others over a network. Know what one arrow costs: how many round trips, which layer can see what, and what breaks when packets are lost or delayed.

## Why networking matters in system design

Most "magic" in distributed systems is really networking. Some examples:

- A cache hit is fast because one round trip in a data centre takes ~0.5 ms.
- A global app needs multiple regions because light in fibre takes ~70 ms to cross the Atlantic and back.
- WebSockets need sticky routing because a TCP connection belongs to one server.
- An L4 load balancer can't route by URL because it never parses HTTP.

Use this page to put a cost on each arrow in your diagrams. For where each component sits, see Building Blocks.

## Layers and encapsulation

Open [A packet's journey](#diagram/packet-journey) to follow one request from a phone to a server.

| TCP/IP layer | OSI layers | Unit | Addresses | Examples | Devices that work here |
| --- | --- | --- | --- | --- | --- |
| Application | 7 Application, 6 Presentation, 5 Session | Message | Hostnames, URLs | HTTP, gRPC, DNS, TLS*, SMTP | L7 load balancer, API gateway, WAF, CDN |
| Transport | 4 Transport | Segment (TCP) / datagram (UDP) | Ports | TCP, UDP, QUIC | L4 load balancer, NAT, firewall |
| Internet | 3 Network | Packet | IP addresses | IPv4, IPv6, ICMP | Router |
| Link | 2 Data link, 1 Physical | Frame | MAC addresses | Ethernet, Wi-Fi | Switch, access point |

\*TLS sits between TCP and HTTP. People call it "layer 6" or "layer 4.5". It encrypts everything above it.

**Encapsulation:** each layer wraps the one above it in its own header. An HTTP request goes into TCP segments, each segment goes into an IP packet, and each packet goes into an Ethernet frame. Routers along the path look only at the IP header. A device can only make decisions using the headers it unwraps. That's why an L4 load balancer can route by IP and port but not by URL path.

**MTU:** an Ethernet frame carries at most ~1,500 bytes of IP payload. After 20 B of IP header and 20 B of TCP header, about **1,460 bytes** of data fit in one segment (the MSS). A 100 KB response is ~70 packets. Tunnels (VPN, VXLAN, IPsec) add headers and shrink the usable size. If a packet is too big and "don't fragment" is set, it gets dropped. Some networks also block the ICMP messages that report this, which causes connections that hang only on large responses.

## IP addressing, subnets and NAT

### IPv4, IPv6 and CIDR

An IPv4 address is 32 bits (`203.0.113.7`). An IPv6 address is 128 bits (`2001:db8::7`). **CIDR** notation writes a block as address/prefix length: the first *n* bits are the network, the rest are hosts.

| CIDR | Addresses | Typical use |
| --- | --- | --- |
| /32 | 1 | One host (a security-group rule for a single IP) |
| /28 | 16 | Smallest AWS subnet (AWS reserves 5 addresses per subnet) |
| /24 | 256 | A typical subnet |
| /20 | 4,096 | A large subnet for an autoscaling or Kubernetes pod range |
| /16 | 65,536 | A whole VPC |
| /8 | 16.7 M | `10.0.0.0/8`, the largest private range |

**Private ranges (RFC 1918):** `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` aren't routable on the public internet. Plan VPC ranges so they **don't overlap** with each other or with your office networks. You can't peer two VPCs that overlap, and renumbering later is painful.

### NAT

**Network address translation** lets many private hosts share one public IP. The NAT device rewrites the source `(private IP, port)` to `(public IP, new port)` and remembers the mapping so replies can find their way back.

- A NAT allows outbound connections only. Nobody outside can open a connection to a host behind it unless you configure a port forward. Phones and home users are behind NAT, which is why servers can't call clients directly. Push notifications, WebSockets and long polling all work around this.
- **Port exhaustion:** one public IP has ~64k source ports per destination IP and port. A busy service calling a single third-party API through one NAT IP can run out (AWS NAT Gateway allows ~55k concurrent connections per unique destination). Fixes: reuse connections with pools and keep-alive, add more NAT IPs, or use private endpoints.
- **Carrier-grade NAT:** mobile carriers put thousands of users behind one IP. Rate limiting by IP then punishes innocent users. Prefer rate limiting by API key or user ID.

### Routing, BGP and anycast

Inside a network, routers forward packets using routing tables. Between networks (autonomous systems, such as ISPs and cloud providers), **BGP** announces which IP prefixes each network can reach. BGP picks paths by policy, not by speed, so the internet path between two points is often not the shortest one.

**Anycast** announces the same IP prefix from many locations. Routers send each user to the nearest location in BGP terms. CDNs, public DNS resolvers (`1.1.1.1`, `8.8.8.8`) and global load balancers use anycast. Failover is quick: if a location withdraws its route, traffic moves elsewhere within seconds, with no DNS TTL to wait out. Anycast works best with short-lived flows. If routes change in the middle of a TCP connection, packets can land on a different location that doesn't know the connection.

## DNS in depth

See [DNS resolution](#diagram/dns-resolution) for the full lookup.

### How a lookup works

1. The app asks the OS **stub resolver**. It checks its local cache and `/etc/hosts`.
2. The stub asks a **recursive resolver**, usually from the ISP or a public resolver such as 1.1.1.1. On a cache miss, it does the walk:
3. It asks a **root server**, which refers it to the `.com` **TLD servers**.
4. The TLD server refers it to the domain's **authoritative name servers** (for example Route 53 or Cloudflare).
5. The authoritative server returns the answer with a **TTL**. Every resolver along the way caches it for that long.

A cold lookup can take 50–200 ms. A cached one takes about 1 ms on the machine and a few ms from the resolver. Browsers, operating systems and resolvers all cache, so **you don't control how long old answers live**. Some clients ignore TTLs, and Java historically cached DNS answers forever.

### Record types

| Record | Maps | Notes |
| --- | --- | --- |
| A / AAAA | name → IPv4 / IPv6 | Can return several IPs; clients usually try them in order |
| CNAME | name → another name | Not allowed at the zone apex (`example.com`) |
| ALIAS / ANAME | apex → name | Provider-specific; flattened into A records at query time (lets `example.com` point at a load balancer) |
| NS | zone → name servers | Delegation |
| MX | domain → mail servers | Ordered by priority |
| TXT | name → text | SPF, DKIM, domain-ownership checks |
| SRV | service → host:port | Used by some service-discovery systems |
| CAA | domain → allowed certificate authorities | Restricts who may issue certificates |
| PTR | IP → name | Reverse DNS; mail servers check it |

### DNS as a routing tool

- **Round-robin DNS** returns several IPs, which spreads clients around roughly. It has no health checks unless the provider adds them.
- **Weighted** records send 5 % to a canary. **Latency-based / GeoDNS** records send users to the nearest region. **Failover** records switch when a health check fails.
- Pick TTLs on purpose. **30–60 s** for records you might fail over. **Hours** for records that never change, which keeps resolver load low and survives a DNS provider outage.
- **Negative caching:** NXDOMAIN answers are cached too, according to the SOA record. If you look up a name before creating it, clients can keep failing for a while afterwards.
- DNS is a single point of failure people often forget. Large outages have come from DNS providers going down. Critical domains can use two DNS providers.

## TCP

See [TCP + TLS connection setup](#diagram/tcp-tls).

### What TCP gives you

TCP turns unreliable packets into a reliable, ordered **byte stream** between two `(IP, port)` endpoints:

- **Three-way handshake** (SYN → SYN-ACK → ACK) costs **1 RTT** before any data flows.
- **Sequence numbers and ACKs:** every byte is numbered. The receiver acknowledges what it has received, and the sender retransmits what isn't acknowledged in time.
- **Ordering:** data reaches the app in order. If one segment is lost, everything after it waits, even if it already arrived. This is **head-of-line blocking**.
- **Flow control:** the receiver advertises a window (how much it can buffer), so a fast sender can't overwhelm a slow receiver.
- **Congestion control:** the sender limits itself so the network isn't overwhelmed (next section).

There are **no message boundaries**: TCP is a byte stream, so protocols built on it must frame their own messages (HTTP headers + `Content-Length`, gRPC length prefixes, newline-delimited JSON).

### Congestion control and throughput

- **Slow start:** a new connection starts with a small congestion window (typically 10 segments ≈ 14 KB) and doubles it every RTT until it sees loss. So **a new connection is slow at first**. A 1 MB response needs several round trips before the window is big enough. That's the reason to reuse connections.
- **AIMD:** after slow start, the window grows by one segment per RTT and is cut in half on loss. CUBIC (the Linux default) and **BBR** (which models bandwidth and RTT instead of reacting to loss) do better on long, fast or lossy paths.
- **Bandwidth-delay product (BDP):** to fill a link, the amount of unacknowledged data in flight must reach bandwidth × RTT. For 1 Gbps × 100 ms that's 12.5 MB. With smaller windows or buffers, **one TCP connection can't use a fast long-distance link**. That's why bulk transfers use parallel connections (multipart S3 uploads, for example).
- **Packet loss hurts a lot:** throughput falls roughly with 1/√loss. 1 % loss can cut a long-distance flow's throughput by 10× or more.

### Connection lifecycle gotchas

| Issue | What happens | What to do |
| --- | --- | --- |
| TIME_WAIT | The side that closes first keeps the socket for 2×MSL (~60 s on Linux) so stray packets can't reach a new connection | Use pools and keep-alive; let the client close first; don't open a new connection per request |
| Ephemeral port exhaustion | A client opening many short connections to one `(IP, port)` runs out of local ports (~28k by default on Linux) | Pooling, more destination IPs, wider port range, `tcp_tw_reuse` |
| Nagle + delayed ACK | Small writes wait up to ~40 ms for an ACK | Set `TCP_NODELAY` for latency-sensitive RPC (most RPC libraries already do) |
| Half-open connections | One side vanished (crashed, NAT entry expired) and the other doesn't know | Application heartbeats, or TCP keepalive with short intervals; NAT/LB idle timeouts are often 350 s or less |
| SYN floods | The attacker leaves handshakes half-finished to fill the server's queue | SYN cookies, DDoS protection at the edge |
| Idle timeouts | LBs and NATs silently drop idle connections (for example after 60–350 s) | Keep-alive pings shorter than the smallest idle timeout on the path |

## UDP and QUIC

**UDP** is just IP plus ports and a checksum. It has no handshake, ordering, retransmission or congestion control. Use it when **stale data is worthless** (live voice and video, game state, metrics) or when you build your own reliability on top.

- DNS uses UDP because a query fits in one packet and a retry is cheap. It falls back to TCP for large answers.
- **QUIC** (the transport under HTTP/3) runs on UDP but adds reliability, congestion control and built-in TLS 1.3, in user space:
  - **Independent streams:** a lost packet only stalls the stream it belongs to, which fixes TCP's head-of-line blocking.
  - **1-RTT setup** (0-RTT on resumption), because the transport and TLS handshakes are combined.
  - **Connection migration:** a connection ID survives a change of IP, such as a phone moving from Wi-Fi to cellular.
  - On the downside, some corporate networks block UDP (so clients fall back to TCP), and QUIC uses more CPU than kernel TCP.

## TLS

### The TLS 1.3 handshake

1. **ClientHello:** supported ciphers, a key share, and **SNI** (the hostname, so one IP can serve many certificates).
2. **ServerHello + certificate + Finished:** the server picks a cipher, sends its key share, and proves it owns the certificate's private key. Both sides now have the session keys.
3. The client checks the **certificate chain** up to a trusted root CA, the hostname and the expiry, then sends its request.

TLS 1.3 adds **1 RTT** on top of TCP (TLS 1.2 added 2). **Session resumption** skips the certificate exchange on reconnect. **0-RTT** sends data in the first flight, but that data **can be replayed** by an attacker, so allow it only for idempotent requests.

### Where to terminate TLS

| Option | How | Trade-off |
| --- | --- | --- |
| Terminate at the LB / edge | LB decrypts and sends plain HTTP inside the VPC | Simplest; the LB can do L7 routing; the internal network is unencrypted |
| Re-encrypt | LB decrypts, inspects, opens a new TLS connection to the backend | Encrypted end to end, with L7 features; more CPU and certificates to manage |
| Passthrough | L4 LB forwards encrypted bytes untouched | Backend holds the keys; the LB can't see paths or headers |
| mTLS between services | Both sides present certificates, usually via a service mesh | Strong service identity (zero trust); certificate rotation must be automated |

Operational notes:
- Automate certificate renewal (ACME / Let's Encrypt, AWS ACM). Expired certificates are a classic cause of outages.
- Use OCSP stapling so clients don't have to contact the CA during the handshake.
- HSTS tells browsers to use HTTPS only.

## HTTP

### Methods and their guarantees

| Method | Safe (no side effects) | Idempotent | Typical use |
| --- | --- | --- | --- |
| GET / HEAD | Yes | Yes | Read; cacheable |
| PUT | No | Yes | Replace a resource at a known URL |
| DELETE | No | Yes | Remove |
| POST | No | **No** | Create, or trigger an action; make it safe to retry with an `Idempotency-Key` header |
| PATCH | No | Not guaranteed | Partial update |

Idempotent methods can be retried automatically by clients, proxies and load balancers. That's why the Payment System topic relies on idempotency keys for POST.

### Status codes that matter for design

- `200 / 201 / 202 / 204`. Use **202 Accepted** for async work: return a job ID and let the client poll it or get a webhook.
- `301 / 302 / 307 / 308` redirects (the URL shortener chooses between 301 and 302 for cacheability vs analytics). `304 Not Modified` answers conditional GETs.
- `400 / 401 / 403 / 404 / 409 Conflict / 412 Precondition Failed / 429 Too Many Requests`.
- `500 / 502 Bad Gateway` (the upstream sent a bad response) / `503 Service Unavailable` (overloaded; send `Retry-After`) / `504 Gateway Timeout`.

### Caching headers

- `Cache-Control: public, max-age=31536000, immutable` for content-hashed assets. Use `private` or `no-store` for user-specific data.
- `s-maxage` sets the CDN's lifetime separately from the browser's. `stale-while-revalidate` serves stale content while it refreshes in the background.
- **ETag / If-None-Match** and **Last-Modified / If-Modified-Since** let clients revalidate cheaply with a `304`. An ETag with **If-Match** gives optimistic concurrency for writes (`412` if someone else changed the resource).
- **Vary** tells caches which request headers change the response (for example `Accept-Encoding`). Varying on too many headers ruins the CDN hit rate.

### HTTP/1.1 vs HTTP/2 vs HTTP/3

| | HTTP/1.1 | HTTP/2 | HTTP/3 |
| --- | --- | --- | --- |
| Transport | TCP | TCP | QUIC over UDP |
| Format | Text | Binary frames | Binary frames |
| Requests per connection | One at a time (pipelining is broken in practice), so browsers open ~6 connections per host | Many concurrent streams on one connection | Many independent streams |
| Head-of-line blocking | At the HTTP level | Gone at the HTTP level, **still present at the TCP level** (one lost packet stalls every stream) | Gone |
| Header compression | None | HPACK | QPACK |
| Setup cost (new HTTPS) | TCP 1 RTT + TLS 1 RTT | Same | 1 RTT total (0-RTT on resumption) |
| Best for | Simple clients, debugging | Most APIs, gRPC | Mobile and lossy networks |

HTTP/2 multiplexing also affects load balancing. One long-lived connection can carry all of a client's traffic, so an **L4** load balancer that balances connections ends up pinning a busy client to one backend. gRPC needs **L7 (per-request) load balancing** or client-side balancing for an even spread.

### Cookies and CORS

- **Cookies** use `HttpOnly` (JavaScript can't read them), `Secure` (HTTPS only), and `SameSite=Lax/Strict` (CSRF protection). Session cookies make the client stateful towards the server. Keep them small: they're sent on every request.
- **CORS:** browsers block cross-origin requests unless the server allows them. Non-simple requests (custom headers, JSON `PUT`) cost an extra **preflight `OPTIONS`** round trip. Cache it with `Access-Control-Max-Age`, or serve the API from the same origin.

## Real-time communication

Open [Real-time transports](#diagram/realtime) to compare them side by side.

| Technique | Direction | How | Good for | Costs |
| --- | --- | --- | --- | --- |
| Short polling | Client pulls | Ask every N seconds | Rarely changing data, simple clients | Wasted requests; latency up to N |
| Long polling | Server push (emulated) | Server holds the request open until there's data or ~30 s pass, then the client reconnects | Fallback when WebSockets are blocked; low event rates | A request per event; reconnect gaps |
| Server-Sent Events (SSE) | Server → client | One long HTTP response streaming `text/event-stream`; auto-reconnect with `Last-Event-ID` | Feeds, notifications, LLM token streaming, dashboards | One direction only; plain HTTP, so it passes most proxies |
| WebSocket | Both ways | HTTP `Upgrade`, then a full-duplex framed TCP connection | Chat, multiplayer, collaborative editing | Stateful servers, sticky routing, heartbeats, reconnect storms after deploys |
| WebRTC | Peer to peer | ICE/STUN/TURN for NAT traversal; media over UDP (SRTP) | Voice and video calls, low-latency media | Complex; relays (TURN) cost bandwidth |
| Webhooks | Server → server | HTTP POST to a URL the receiver registered | Payment and integration events | Receiver must be reachable; sign payloads; retries mean duplicates, so receivers must be idempotent |

Scaling persistent connections (see the Chat System topic):
- A tuned server can hold **100k–1M idle connections**. Memory per connection and file-descriptor limits (`ulimit -n`) are the real limits.
- Keep a **connection registry** (user → gateway server) so other services can route messages to the right box.
- **Drain gracefully on deploy.** Tell clients to reconnect with jitter, or the whole fleet reconnects at the same moment (a thundering herd).

## Proxies, gateways and service meshes

| Component | Sits | Does |
| --- | --- | --- |
| Forward proxy | In front of **clients** | Egress control, caching, anonymity (corporate proxy, egress filtering) |
| Reverse proxy | In front of **servers** | TLS termination, compression, caching, routing, hides the backends (NGINX, Envoy, HAProxy) |
| Load balancer | A reverse proxy whose job is spreading load | Health checks, algorithms, connection draining |
| API gateway | Reverse proxy + API concerns | AuthN, rate limits, request validation, versioning, aggregation (BFF) |
| Service mesh | A sidecar proxy next to every service instance (Istio, Linkerd) | mTLS, retries, timeouts, circuit breaking, traffic splitting and telemetry, with no app code changes |

### Load-balancing details beyond the algorithm

- **Health checks:** *active* checks probe `/healthz`. *Passive* checks (outlier detection) eject a backend after N errors. Keep **liveness** ("restart me") separate from **readiness** ("don't send me traffic"). Don't let a readiness check depend on a shared database, or one DB blip pulls every instance out at once.
- **Connection draining:** stop sending new requests to an instance, let in-flight requests finish (for example within 30 s), then remove it. Rolling deploys depend on this.
- **Sticky sessions:** route by cookie or hashed client IP. Needed for stateful protocols, but load spreads unevenly and a lost instance loses its sessions.
- **Direct server return (DSR):** the L4 LB handles only inbound packets and backends reply straight to the client. Good for download-heavy traffic.
- **Global load balancing:** DNS-based (GeoDNS) or anycast-based (one global IP, as with Google Cloud LB or AWS Global Accelerator) to pick a region, then a regional LB picks an instance.
- **Client-side load balancing:** the client gets the instance list from service discovery (Consul, Kubernetes endpoints, xDS) and balances itself. It saves a hop and suits gRPC.

## CDNs in more depth

- **PoPs** (points of presence) are reached through anycast or DNS. The edge terminates TCP and TLS **close to the user**, so even uncacheable API calls get faster: the long trip to the origin runs over a warm, reused connection.
- **Cache key:** URL + selected headers/cookies/query parameters. Normalise it (sort query parameters, strip tracking parameters), or near-identical requests miss the cache.
- **Tiered caching / origin shield:** edges ask a regional mid-tier before the origin. That collapses thousands of edge misses into one origin request.
- **Invalidation:** purges by URL or tag take seconds to reach every PoP. Prefer versioned URLs.
- **Edge compute:** auth checks, redirects, A/B bucketing and header rewrites run at the PoP (Cloudflare Workers, Lambda@Edge).
- **DDoS absorption:** a CDN's spread-out capacity soaks up volumetric attacks before they reach you.

## Cloud networking

See [VPC network layout](#diagram/vpc-network).

| Concept | What it is |
| --- | --- |
| VPC / VNet | Your private network in a region, with a CIDR block (e.g. `10.0.0.0/16`) |
| Subnet | A slice of the VPC in **one availability zone**. *Public* subnets have a route to an internet gateway. *Private* subnets don't |
| Internet gateway | Lets public subnets reach the internet in both directions |
| NAT gateway | Lets private subnets make **outbound** connections (to fetch packages or call third-party APIs); nothing can connect in. One per AZ to avoid a cross-AZ dependency |
| Security group | **Stateful** firewall attached to an instance or ENI; allow rules only. Reference other groups ("app SG may reach DB SG on 5432") rather than IP ranges |
| Network ACL | **Stateless** firewall at the subnet boundary; allow and deny rules; return traffic must be allowed explicitly |
| VPC peering / transit gateway | Connect VPCs (peering is point to point; transit gateway is hub and spoke) |
| PrivateLink / VPC endpoints | Reach a cloud service (S3, DynamoDB) or another account's service privately, without NAT or the internet |
| VPN / Direct Connect | Connect on-premises networks |

Design habits:
- Put **only load balancers (and NAT gateways) in public subnets**. App servers and databases go in private subnets.
- Spread every tier across **at least 2–3 AZs**.
- Remember that **cross-AZ traffic costs money** (around $0.01/GB each way on AWS) and adds ~1 ms. Chatty services and replication streams can produce surprising bills. Zone-aware routing keeps traffic local where it's safe.
- NAT gateways charge per GB processed. Send S3 and DynamoDB traffic through **gateway endpoints** (free) instead.

## Latency and bandwidth arithmetic

| Fact | Value |
| --- | --- |
| Speed of light in fibre | ~200,000 km/s → **~1 ms RTT per 100 km** in theory; real paths are 1.5–2× longer |
| Same AZ / cross-AZ round trip | ~0.1–0.5 ms / ~0.5–2 ms |
| London ↔ New York RTT | ~70–80 ms |
| US East ↔ US West RTT | ~60–70 ms |
| Europe ↔ Asia-Pacific RTT | ~150–250 ms |
| Good 4G / 5G first-hop latency | ~30–50 ms / ~10–20 ms |
| 1 Gbps | 125 MB/s; a 1 GB file takes ~8 s at full speed |
| 10 Gbps NIC | ~1.25 GB/s; typical per-instance limit in the cloud |

**Cost of a cold HTTPS request:**

| Step | Round trips |
| --- | --- |
| DNS lookup (uncached) | 1 (more on a full resolver walk) |
| TCP handshake | 1 |
| TLS 1.3 handshake | 1 |
| HTTP request / response | 1 |
| **Total (HTTP/2)** | **≈ 4 RTT**: at 80 ms RTT that's ~320 ms before the first byte |
| **Warm connection** | **1 RTT**: ~80 ms |
| **HTTP/3 resumed (0-RTT)** | ≈ 1 RTT including setup |

That's why the big levers for user-facing latency are:
- **Fewer round trips:** keep-alive, connection pooling, HTTP/2 or 3, batching, fewer sequential calls.
- **Shorter round trips:** CDN edges, multiple regions, TLS terminated at the edge.
- **Less data:** compression (gzip/brotli), smaller payloads, pagination.

**Tail latency compounds with fan-out.** If a page calls 100 backends and each has a 1 % chance of taking more than 1 s, then 1 − 0.99¹⁰⁰ ≈ **63 %** of pages will be slow. Use hedged requests, timeouts and fewer dependencies on the critical path.

## Debugging toolkit

| Tool | Answers |
| --- | --- |
| `dig +trace example.com` | What does DNS return, from where, with what TTL? |
| `curl -w '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}\n'` | Where did the time go: DNS, TCP, TLS or server? |
| `openssl s_client -connect host:443 -servername host` | Which certificate chain is served, and when does it expire? |
| `mtr` / `traceroute` | Which hop adds latency or loses packets? |
| `ss -s` / `ss -tan state time-wait` | How many connections, and in which states? |
| `tcpdump` / Wireshark | What's actually on the wire (retransmissions, resets, window sizes)? |

## Common interview follow-ups

- **What happens when you type a URL and press Enter?** DNS (caches → recursive → root → TLD → authoritative) → TCP handshake → TLS (SNI, certificate check) → HTTP request through the CDN/LB → app → response → browser parses and fetches sub-resources over the same HTTP/2 connection.
- **L4 or L7 load balancer for WebSockets or gRPC?** L4 works for long-lived WebSockets (L7 also supports `Upgrade`). gRPC needs L7 or client-side balancing, because HTTP/2 multiplexes many requests onto one connection.
- **Why can't the server just call the phone?** NAT and firewalls block inbound connections, and mobile IPs change. The client keeps a connection open (WebSocket or long poll), or you use the platform push services (APNs/FCM), which keep one OS-level connection per device.
- **How do you fail over a region?** Health-checked DNS with low TTLs (slow; some clients cache too long), or anycast / a global LB (seconds). The data layer must be ready too (replicated, and promotable).
- **Why is my service slow only for users in Australia?** RTT × round trips. Count the sequential round trips in the request path, then cut them (edge TLS termination, caching at the edge, a regional deployment).
- **TCP vs UDP for a multiplayer game or video call?** UDP: a late packet is useless, and TCP's retransmission adds head-of-line stalls. Add your own sequencing and use forward error correction where needed.
