import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function packetJourney() {
  return new Diagram("A packet's journey", "From a phone to an app server: who forwards the packet, and which headers each hop reads")
    .zone("User's network", ["phone", "router"], "#1971c2")
    .zone("Internet", ["isp", "resolver", "bgp"], "#495057")
    .zone("Cloud region (VPC 10.0.0.0/16)", ["igw", "lb", "app"], "#2f9e44")
    .node("phone", "Phone", 0, 1, "client", { detail: ["192.168.1.23 (private)", "opens TCP :443"] })
    .node("router", "Home router (NAT)", 1, 1, "edge", { detail: ["rewrites src to 81.2.69.5:51234", "L3/L4"] })
    .node("isp", "ISP network", 2, 1, "external", { detail: ["routes by destination IP", "L3"] })
    .node("resolver", "Recursive DNS resolver", 2, 0, "edge", { detail: "api.example.com → 52.1.2.3" })
    .node("bgp", "Internet backbone", 3, 1, "external", { detail: ["BGP picks the path", "between networks"] })
    .node("cdn", "CDN edge PoP (anycast)", 3, 2.3, "edge", { detail: ["terminates TLS near the user", "serves cached responses"] })
    .node("igw", "Internet gateway", 4, 1, "edge", { detail: "public IP → private IP" })
    .node("lb", "L7 load balancer", 5, 1, "edge", { detail: ["public subnet", "decrypts TLS, reads HTTP"] })
    .node("app", "App server", 6, 1, "service", { detail: ["10.0.12.7 (private subnet)", "sees X-Forwarded-For"] })
    .edge("phone", "router", "Wi-Fi frame")
    .edge("phone", "resolver", "1. DNS (UDP :53)", { via: [[0.5, 0]] })
    .edge("router", "isp", "IP packet")
    .edge("isp", "bgp")
    .edge("bgp", "igw", "dst 52.1.2.3")
    .edge("igw", "lb")
    .edge("lb", "app", "new TCP conn")
    .edge("phone", "cdn", "static / cacheable", { async: true, via: [[0.5, 2.3]] })
    .edge("cdn", "lb", "origin fetch (warm conn)", { async: true })
    .panel(
      "Encapsulation (outermost first)",
      [
        "Ethernet / Wi-Fi  [MAC src → MAC dst]",
        " IP               [81.2.69.5 → 52.1.2.3]",
        "  TCP             [:51234 → :443, seq, ack]",
        "   TLS record     [encrypted]",
        "    HTTP          GET /api/feed",
        "                  Host: api.example.com",
      ],
      0,
      2.9,
      { width: 400, mono: true },
    )
    .panel(
      "What each hop can see",
      [
        "Switch / Wi-Fi: MAC addresses (L2), only on this link",
        "Router, NAT, ISP: IP + ports (L3/L4); payload is encrypted",
        "L4 load balancer: IP + port; can't route by URL",
        "L7 load balancer, CDN: whole HTTP request (after TLS termination)",
      ],
      1.35,
      2.9,
      { width: 420, tone: "info" },
    )
    .panel(
      "Sizes to remember",
      ["MTU ~1,500 B → ~1,460 B of TCP data per packet", "100 KB response ≈ 70 packets", "Each tunnel (VPN, VXLAN) shrinks the MTU"],
      4.7,
      2.4,
      { width: 330, tone: "warn" },
    )
    .build();
}

function dnsResolution() {
  return new Sequence("DNS resolution", "A cold lookup of api.example.com walks the hierarchy; every answer is cached for its TTL", { gap: 230 })
    .actor("app", "Browser / app", "client")
    .actor("stub", "OS stub resolver", "service", { icon: "globe" })
    .actor("rec", "Recursive resolver", "edge")
    .actor("root", "Root server", "external", { icon: "globe" })
    .actor("tld", ".com TLD server", "external", { icon: "globe" })
    .actor("auth", "Authoritative (Route 53)", "edge")
    .msg("app", "stub", "getaddrinfo(api.example.com)")
    .alt("cached locally (browser / OS / hosts file)")
    .msg("stub", "app", "IP from cache (~0–1 ms)", { reply: true })
    .else("local miss")
    .msg("stub", "rec", "query A api.example.com (UDP :53, or DoH)")
    .alt("resolver cache hit", "stub", "auth")
    .msg("rec", "stub", "cached answer, remaining TTL (~5–20 ms)", { reply: true })
    .else("resolver cache miss: iterative walk")
    .msg("rec", "root", "where is api.example.com?")
    .msg("root", "rec", "ask .com: a.gtld-servers.net (NS, TTL 2 days)", { reply: true })
    .msg("rec", "tld", "where is api.example.com?")
    .msg("tld", "rec", "ask example.com: ns-1.awsdns-01.org (NS + glue)", { reply: true })
    .msg("rec", "auth", "A api.example.com?")
    .msg("auth", "rec", "52.1.2.3 (TTL 60) — chosen by latency / geo / health policy", { reply: true })
    .msg("rec", "rec", "cache every answer for its TTL (NXDOMAIN too)")
    .msg("rec", "stub", "52.1.2.3", { reply: true })
    .end()
    .msg("stub", "app", "52.1.2.3, then the app opens a TCP connection", { reply: true })
    .end()
    .note("A cold walk costs 50–200 ms. Root and TLD answers are almost always cached, so a typical miss is one trip to the authoritative server.", ["rec", "auth"], "info")
    .note("You don't control client caches: some ignore TTLs. DNS failover is never instant; anycast or a global LB fails over faster.", ["app", "rec"])
    .build();
}

function tcpTls() {
  return new Sequence("TCP + TLS connection setup", "What a new HTTPS connection costs before the first byte of the response, and why reusing connections matters", {
    gap: 520,
  })
    .actor("client", "Client", "client")
    .actor("server", "Server / load balancer", "edge")
    .phase("TCP three-way handshake: 1 RTT")
    .msg("client", "server", "SYN (seq = x, MSS 1460, window scale)")
    .msg("server", "client", "SYN-ACK (seq = y, ack = x + 1)", { reply: true })
    .msg("client", "server", "ACK (ack = y + 1): connection ESTABLISHED")
    .phase("TLS 1.3 handshake: 1 RTT")
    .msg("client", "server", "ClientHello: SNI = api.example.com, ciphers, key share, ALPN = h2")
    .msg("server", "client", "ServerHello + key share, {certificate chain, CertificateVerify, Finished} encrypted", { reply: true })
    .msg("client", "client", "verify chain to a trusted root CA, hostname, expiry; derive session keys")
    .msg("client", "server", "{Finished} + {GET /api/feed} — the request rides with the last handshake message")
    .phase("Data transfer")
    .msg("server", "client", "{200 OK} — first ~14 KB (initial congestion window of 10 segments)", { reply: true })
    .msg("client", "server", "ACKs")
    .msg("server", "client", "next ~28 KB, then ~56 KB … window doubles each RTT (slow start)", { reply: true })
    .note("A cold request costs DNS + TCP + TLS + HTTP ≈ 4 RTT (~320 ms at 80 ms RTT). On a warm keep-alive connection it costs 1 RTT, and the congestion window has already grown.", ["client", "server"], "info")
    .phase("Reconnecting later")
    .alt("TLS session resumption (PSK ticket)")
    .msg("client", "server", "ClientHello + PSK: no certificate exchange, still 1 RTT")
    .else("0-RTT early data")
    .msg("client", "server", "ClientHello + PSK + {GET …} in the first flight")
    .note("0-RTT data can be replayed by an attacker: allow it only for idempotent requests.", ["client", "server"], "bad")
    .end()
    .phase("Close")
    .msg("client", "server", "FIN")
    .msg("server", "client", "ACK, FIN", { reply: true })
    .msg("client", "server", "ACK")
    .note("The side that closes first keeps the socket in TIME_WAIT for ~60 s. Thousands of short connections per second exhaust ephemeral ports: pool and reuse connections.", ["client", "server"])
    .build();
}

function realtime() {
  return new Sequence("Real-time transports", "Four ways to get an event from the server to a client, from simplest to most capable", { gap: 360 })
    .actor("client", "Client", "client")
    .actor("server", "App / gateway server", "service")
    .actor("bus", "Pub/sub (Redis)", "cache")
    .phase("Short polling: simple, wasteful, latency up to the interval")
    .loop("every 5 s")
    .msg("client", "server", "GET /messages?since=42")
    .msg("server", "client", "200 [] (usually empty)", { reply: true })
    .end()
    .phase("Long polling: server holds the request until there's data")
    .msg("client", "server", "GET /messages?since=42 (server holds it for up to 30 s)")
    .msg("bus", "server", "new message for this user", { async: true })
    .msg("server", "client", "200 [msg 43]", { reply: true })
    .msg("client", "server", "GET /messages?since=43 (immediately re-poll)")
    .phase("Server-Sent Events: one long HTTP response, server → client")
    .msg("client", "server", "GET /events  Accept: text/event-stream  Last-Event-ID: 43")
    .msg("bus", "server", "events", { async: true })
    .msg("server", "client", "id: 44 / data: {...}   id: 45 / data: {...} (stream stays open)", { reply: true })
    .note("Browsers reconnect automatically and resume from Last-Event-ID. One direction only, but it's plain HTTP, so it passes most proxies.", ["client", "server"], "info")
    .phase("WebSocket: full-duplex frames over one TCP connection")
    .msg("client", "server", "GET /ws  Upgrade: websocket  Sec-WebSocket-Key: …")
    .msg("server", "client", "101 Switching Protocols", { reply: true })
    .msg("server", "bus", "SUBSCRIBE user:7 (register in the connection registry)")
    .par("both directions at any time")
    .msg("client", "server", "frame: send message / typing indicator")
    .msg("bus", "server", "message for user 7", { async: true })
    .msg("server", "client", "frame: deliver message", { reply: true })
    .end()
    .loop("every 25–30 s, shorter than any LB / NAT idle timeout")
    .msg("server", "client", "ping")
    .msg("client", "server", "pong")
    .end()
    .note("The connection pins the user to one server: route with sticky L4 balancing plus a user → server registry. On deploy, drain and tell clients to reconnect with jitter.", ["client", "bus"])
    .build();
}

function vpcNetwork() {
  return new Diagram("VPC network layout", "A three-tier app across two availability zones: only the load balancer is reachable from the internet")
    .zone("Public subnets (route to internet gateway)", ["alb", "nat"], "#6741d9")
    .zone("Private app subnets (10.0.10.0/24, 10.0.11.0/24)", ["appA", "appB"], "#2f9e44")
    .zone("Private data subnets (no internet route)", ["dbA", "dbB", "cache"], "#e67700")
    .node("users", "Internet users", 0, 1.5, "client")
    .node("dns", "Route 53", 1, 0, "edge", { detail: "ALIAS → ALB" })
    .node("igw", "Internet gateway", 1, 1.5, "edge")
    .node("alb", "Application LB", 2, 1, "edge", { detail: ["spans AZ-a + AZ-b", "SG: 443 from 0.0.0.0/0"] })
    .node("nat", "NAT gateway", 2, 2.4, "edge", { detail: ["outbound only", "one per AZ"] })
    .node("appA", "App (AZ-a)", 3, 0.6, "service", { detail: "SG: 8080 from ALB SG" })
    .node("appB", "App (AZ-b)", 3, 1.6, "service", { detail: "SG: 8080 from ALB SG" })
    .node("dbA", "Postgres primary (AZ-a)", 4.2, 0.4, "db", { detail: "SG: 5432 from app SG" })
    .node("dbB", "Postgres standby (AZ-b)", 4.2, 1.5, "db", { detail: "sync replica" })
    .node("cache", "Redis", 4.2, 2.6, "cache", { detail: "SG: 6379 from app SG" })
    .node("s3", "S3 (gateway endpoint)", 3, 3.2, "storage", { detail: "free, no NAT" })
    .node("ext", "Third-party API", 1, 3.2, "external", { detail: "e.g. payment provider" })
    .edge("users", "dns", "resolve")
    .edge("users", "igw", "HTTPS")
    .edge("igw", "alb")
    .edge("alb", "appA")
    .edge("alb", "appB")
    .edge("appA", "dbA")
    .edge("appB", "dbA", "cross-AZ (~1 ms, $/GB)")
    .edge("dbA", "dbB", "replication", { async: true })
    .edge("appB", "cache")
    .edge("appA", "nat", "outbound", { via: [[2.6, 1.9]] })
    .edge("nat", "igw")
    .edge("nat", "ext", "egress from a fixed IP")
    .edge("appB", "s3", "private route")
    .panel(
      "Security group vs network ACL",
      [
        "SG: stateful, per instance, allow-only; reference other SGs",
        "NACL: stateless, per subnet, allow + deny; return traffic must be allowed explicitly",
        "Default: deny everything, open only what each tier needs",
      ],
      5.4,
      0,
      { width: 360 },
    )
    .panel(
      "Design habits",
      [
        "Only LBs and NAT in public subnets",
        "Every tier in 2–3 AZs; one NAT per AZ",
        "Non-overlapping CIDRs across VPCs (for peering)",
        "Use VPC endpoints for S3 / DynamoDB to skip NAT charges",
        "Zone-aware routing to cut cross-AZ cost",
      ],
      5.4,
      1.4,
      { width: 360, tone: "info" },
    )
    .build();
}

export default [
  { id: "packet-journey", name: "A packet's journey", build: packetJourney },
  { id: "dns-resolution", name: "DNS resolution", build: dnsResolution },
  { id: "tcp-tls", name: "TCP + TLS setup", build: tcpTls },
  { id: "realtime", name: "Real-time transports", build: realtime },
  { id: "vpc-network", name: "VPC network layout", build: vpcNetwork },
] satisfies DiagramSpec[];
