import { Diagram } from "../diagrams/dsl";
import { stagedParts, type Evolution, type Step } from "./types";

/**
 * The URL shortener, grown from one server to the full design in docs/url-shortener.md.
 * Step numbers used in `diagram` below: 0 start, 1 load balancer, 2 cache, 3 split read and
 * write paths, 4 key-value store, 5 key generation, 6 analytics.
 */

const steps: Step[] = [
  {
    id: "start",
    title: "Start with the simplest thing that works",
    situation:
      "A URL shortener does two things. It **creates** a short link for a long URL, and it **redirects** anyone who opens the short link. " +
      "Before thinking about scale, build the version that fits on one machine.",
    metrics: [
      { label: "Links created", value: "~1 / s" },
      { label: "Redirects", value: "~100 / s" },
    ],
    result:
      "One app server does both jobs, and one PostgreSQL database holds a `urls` table.\n\n" +
      "- **Create:** insert a row, take its auto-increment `id`, and write that number in base62 to get the code (`125` becomes `21`).\n" +
      "- **Redirect:** look the code up and answer `302` with the long URL.\n\n" +
      "This is a good first version. At a few hundred requests a second, nothing here is under strain.",
    tradeoff: "Everything exists exactly once. Any crash, deploy or traffic spike takes the whole product down.",
  },
  {
    id: "scale-out",
    title: "One server is not enough",
    situation:
      "The product is growing. Redirects have climbed to about 1,000 a second and the app server sits at 95 % CPU at peak. " +
      "Last week a deploy restarted it, and every short link on the internet returned an error for two minutes.",
    metrics: [
      { label: "Redirects", value: "1,000 / s" },
      { label: "App server CPU", value: "95 %" },
      { label: "Downtime per deploy", value: "~2 min" },
    ],
    decision: {
      question: "What do you change first?",
      choices: [
        {
          id: "bigger-machine",
          label: "Move to a bigger machine",
          verdict: "poor",
          feedback:
            "A machine with four times the CPU buys time, and it is a reasonable emergency fix. But it is still one machine: a crash or a deploy still takes every link down, and there is a largest machine you can buy. " +
            "It treats the load problem and ignores the availability problem.",
        },
        {
          id: "load-balancer",
          label: "Run several identical app servers behind a load balancer",
          verdict: "best",
          feedback:
            "This fixes both problems at once. Load is shared, so you add servers as traffic grows. When one server dies or restarts, the load balancer stops sending it traffic and the others keep serving. " +
            "It works because the app keeps no state of its own, so any server can answer any request.",
        },
        {
          id: "cache-first",
          label: "Add a cache in front of the database",
          verdict: "ok",
          feedback:
            "A cache will help soon (it is the next step), but it answers a different question. The pain right now is CPU on the app server, and the fact that there is only one of it. " +
            "Caching database reads still leaves a single server that goes down on every deploy.",
        },
      ],
    },
    result:
      "A **load balancer** now spreads requests over several app servers and stops sending traffic to any that fail a health check. " +
      "The servers are **stateless**: they keep nothing between requests, so they are interchangeable and you can add or remove them freely. " +
      "Deploys become rolling, one server at a time, with no downtime.",
    tradeoff: "All of those servers still talk to one database, so the pressure moves there.",
  },
  {
    id: "cache",
    title: "The database is the bottleneck",
    situation:
      "Traffic is now about 4,000 redirects a second, with peaks of 20,000. Every redirect is a database query, and PostgreSQL is at its limit: the slowest 1 % of redirects went from 5 ms to 80 ms. " +
      "Looking at the traffic, a small share of links gets most of the clicks, and a link never changes once it is created.",
    metrics: [
      { label: "Redirects", value: "4,000 / s (20,000 peak)" },
      { label: "Reads : writes", value: "100 : 1" },
      { label: "p99 latency", value: "80 ms" },
    ],
    decision: {
      question: "How do you take read load off the database?",
      choices: [
        {
          id: "read-replicas",
          label: "Add read replicas of the database",
          verdict: "ok",
          feedback:
            "Replicas work, and they are a common answer for read-heavy systems. Here they are the more expensive way to get less: each replica is a full copy of the data answering from disk, where a cache answers the popular links from memory. " +
            "Replicas also lag slightly behind the primary, so a link clicked right after it was created may not be found.",
        },
        {
          id: "cache",
          label: "Put an in-memory cache (Redis) in front of the database",
          verdict: "best",
          feedback:
            "This is the best fit for this workload. Lookups are by a single key, a few links get most of the traffic, and links never change, so a cached entry is never out of date. " +
            "More than 90 % of redirects are answered from memory in under a millisecond and never reach the database.",
        },
        {
          id: "shard",
          label: "Split the database into shards",
          verdict: "poor",
          feedback:
            "Sharding spreads data and **writes** over several databases. But writes are tiny here (about 40 a second) and the data still fits on one machine. " +
            "You would take on routing, rebalancing and cross-shard queries to solve a problem you do not have yet, and every redirect would still be a database query.",
        },
      ],
    },
    result:
      "The app servers now use **cache-aside**: look in Redis first, and only on a miss read PostgreSQL and put the answer in Redis for next time, with a 24-hour expiry. " +
      "Codes that do not exist are cached too, for a short time, so a flood of requests for a bad code cannot hammer the database.",
    tradeoff:
      "There are now two copies of the data, and a restart of Redis sends all traffic to the database until the cache fills again. " +
      "The usually hard part, keeping the cache in sync, mostly goes away because links never change. That product decision is paying off here.",
  },
  {
    id: "split-paths",
    title: "A slow create path hurts every redirect",
    situation:
      "Creating a link has become heavier: the app now validates the URL and checks it against a malware list, which can take a few hundred milliseconds. " +
      "During a marketing campaign, a burst of link creation tied up the app servers, and redirects that should take 5 ms started timing out. " +
      "Visitors far from the data centre also see slow redirects whatever you do, because of the network distance.",
    metrics: [
      { label: "Create", value: "~200 ms, 40 / s" },
      { label: "Redirect", value: "~5 ms, 4,000 / s" },
      { label: "Far-away visitor", value: "+250 ms network" },
    ],
    decision: {
      question: "How do you protect the redirect path?",
      choices: [
        {
          id: "split",
          label: "Split into two services (redirect and shorten) and put a CDN in front of redirects",
          verdict: "best",
          feedback:
            "The two paths have nothing in common. One is rare, slow and must be correct. The other is constant, fast and must always be up. " +
            "As separate services they scale and fail on their own, so a problem on the create side can no longer reach redirects. " +
            "A CDN then answers the most popular links from a location near the visitor, without touching your servers at all.",
        },
        {
          id: "more-servers",
          label: "Add more app servers",
          verdict: "ok",
          feedback:
            "More servers absorb this burst, but the two kinds of work still share the same processes and the same deploys. " +
            "The next slow dependency or bad release on the create side takes redirects down with it again. You would be paying for capacity when the real problem is isolation.",
        },
        {
          id: "permanent-redirect",
          label: "Answer with `301 Moved Permanently` so browsers remember the redirect",
          verdict: "poor",
          feedback:
            "A browser keeps a `301` for good, which does take repeat clicks off your servers. The cost is high: those clicks vanish from your statistics, and you can never disable or expire a link for a browser that has already seen it. " +
            "It also does nothing for the create path. A `302` with a short CDN cache keeps most of the benefit and leaves you in control.",
        },
      ],
    },
    result:
      "The single app is now two services. The **redirect service** is read-only and small, so it scales out easily and rarely changes. " +
      "The **shorten service** sits behind an API gateway that handles login and per-user rate limits. " +
      "In front of redirects, a **CDN** caches popular links for about a minute at locations close to visitors and passes everything else on.",
    tradeoff:
      "Two services mean two deploy pipelines and more to monitor. A link cached at the CDN keeps redirecting for up to a minute after it is disabled, which is why the cache time is kept short.",
  },
  {
    id: "storage",
    title: "The data is outgrowing one database",
    situation:
      "The service now plans for 100 million new links a month, kept for 5 years: 6 billion rows and about 3 TB. " +
      "A single PostgreSQL server is running out of disk, backups take hours, and when the primary fails, link creation stops until someone promotes a replica. " +
      "Meanwhile every important query still has the same shape: get one row by its code.",
    metrics: [
      { label: "Links in 5 years", value: "6 billion" },
      { label: "Size", value: "~3 TB (9 TB with 3 copies)" },
      { label: "Hot query", value: "get by code" },
    ],
    decision: {
      question: "Where should the links live?",
      choices: [
        {
          id: "redis-only",
          label: "Keep everything in Redis, since reads are served from it already",
          verdict: "poor",
          feedback:
            "Redis keeps data in memory, and 3 TB of memory costs far more than 3 TB of disk. More importantly, a created link must never be lost, and Redis can lose the last moments of writes when a node fails. " +
            "It is the right tool for the popular 20 % of links, not for the one copy you cannot afford to lose.",
        },
        {
          id: "sharded-postgres",
          label: "Keep PostgreSQL and shard it by code in the application",
          verdict: "ok",
          feedback:
            "This is a defensible choice, and at 3 TB it works. What you take on is the work a key-value store does for you: sending each query to the right shard, moving data when you add shards, and handling failover for each one. " +
            "Choose it if your team runs PostgreSQL well and wants to keep SQL.",
        },
        {
          id: "key-value",
          label: "Move to a partitioned key-value store (DynamoDB or Cassandra) keyed by code",
          verdict: "best",
          feedback:
            "The workload is exactly what these stores are built for: reads and writes of a single key, with no joins and no range scans. " +
            "Data is split over many machines by code, copied to several zones, and grows by adding partitions. Failover is automatic, so creating a link no longer depends on one primary.",
        },
      ],
    },
    result:
      "PostgreSQL is replaced by a **key-value store partitioned by `code`**. Each link is one item, copied to three availability zones before the write is confirmed. " +
      "Creating a link uses a **conditional write** (insert only if this code does not exist yet), so two links can never end up with the same code.",
    tradeoff:
      "You give up SQL: no joins and no ad-hoc queries, so every way of reading the data has to be planned (listing one user's links needs a secondary index). " +
      "And something quietly broke: codes used to come from the database's auto-increment id, and a partitioned store has no such counter.",
  },
  {
    id: "codes",
    title: "Where do unique codes come from now?",
    situation:
      "With no auto-increment id, the shorten service needs another way to make codes. The old way had a second problem anyway: codes came out in order (`aB3xK8`, `aB3xK9`, …), " +
      "so anyone could walk through every link ever created, private ones included. " +
      "Codes must be unique across many servers, 7 characters long, and impossible to guess from their neighbours.",
    metrics: [
      { label: "Possible codes", value: "62⁷ ≈ 3.5 trillion" },
      { label: "Codes needed", value: "6 billion" },
      { label: "Shorten servers", value: "many, several regions" },
    ],
    decision: {
      question: "How does each server make a code?",
      choices: [
        {
          id: "random",
          label: "Generate 7 random characters and retry if the code is taken",
          verdict: "ok",
          feedback:
            "This works with no coordination at all, and many real systems do it. The conditional write catches a collision, and the server tries again. " +
            "The chance of a collision grows as the table fills (about 1 in 600 at 6 billion links), so every create needs retry logic and a few are slower than the rest.",
        },
        {
          id: "hash",
          label: "Hash the long URL and keep the first 7 characters",
          verdict: "poor",
          feedback:
            "A hash cut down to 7 characters collides about as often as random codes, so you need the same retry logic. It also adds a problem: the same long URL always gives the same code. " +
            "That is wrong when two users shorten the same URL and each wants their own link, expiry date and statistics.",
        },
        {
          id: "leased-ranges",
          label: "Give each server a block of ids to use, and shuffle each id before encoding it",
          verdict: "best",
          feedback:
            "A small key generation service hands each server a block of one million ids. The server then makes codes on its own with no network call, and two servers can never collide because their blocks do not overlap. " +
            "Passing each id through a reversible shuffle before base62-encoding it makes neighbouring ids give unrelated codes.",
        },
      ],
    },
    result:
      "A **key generation service** leases ranges of ids. All it stores is which range comes next, kept in ZooKeeper or etcd. " +
      "Each shorten server takes the next id from its range, runs it through a reversible shuffle, and base62-encodes the result into a 7-character code. " +
      "The service is contacted only once per million links, so it can be down for a while without anyone noticing.",
    tradeoff:
      "It is one more service to run. If a server crashes, the unused ids in its range are lost. With 3.5 trillion codes and 6 billion needed, that waste does not matter.",
  },
  {
    id: "analytics",
    title: "Link owners want click statistics",
    situation:
      "Customers ask for reports: how many clicks each link got, over time, by country and by device. The obvious way is to write a row for every click. " +
      "But redirects run at 4,000 a second with peaks of 20,000, a hundred times the write load the system was built for, and a redirect must still take a few milliseconds.",
    metrics: [
      { label: "Clicks to record", value: "4,000 / s (20,000 peak)" },
      { label: "Links created", value: "40 / s" },
      { label: "Reports may lag by", value: "~1 minute" },
    ],
    decision: {
      question: "How do you record clicks?",
      choices: [
        {
          id: "sync-write",
          label: "Write each click to the database before sending the redirect",
          verdict: "poor",
          feedback:
            "This puts a database write on the busiest path in the system. Every redirect gets slower, the write load on the URL store grows a hundredfold, and an outage in click storage now breaks redirects. " +
            "Statistics are a nice extra. Redirects are the product.",
        },
        {
          id: "event-stream",
          label: "Publish a click event to a queue and build the reports from it in the background",
          verdict: "best",
          feedback:
            "The redirect service drops a small event into Kafka without waiting, then answers the visitor. A stream processor reads the events, adds country and device, and writes per-minute totals to a database built for analytics. " +
            "If any of that is slow or down, redirects are untouched and the reports catch up later.",
        },
        {
          id: "redis-counter",
          label: "Increment a per-link counter in Redis",
          verdict: "ok",
          feedback:
            "A counter is fast and gives a good-enough total, and it is a fine first version. It cannot answer what customers asked for: clicks over time, by country, by device. " +
            "Counts held only in memory are also lost if the node fails before they are saved.",
        },
      ],
    },
    result:
      "Each redirect now sends a **click event** to Kafka and does not wait for a reply. A **stream processor** adds country and device and totals the clicks per link per minute into **ClickHouse**, a database that is fast at this kind of query. " +
      "A separate **stats service** reads those totals for the reports.",
    tradeoff:
      "Reports run about a minute behind. If Kafka cannot be reached, the redirect service drops events instead of waiting, so counts can be slightly low after an incident. " +
      "That is the trade: the numbers are approximate so that redirects never wait.",
  },
];

const SUBTITLES = [
  "Step 1: one server, one database",
  "Step 2: several stateless servers behind a load balancer",
  "Step 3: a cache in front of the database",
  "Step 4: separate redirect and create paths, with a CDN",
  "Step 5: a partitioned key-value store",
  "Step 6: codes from leased id ranges",
  "Step 7: click statistics, off the redirect path",
];

function diagram(level: number, markAdded: boolean) {
  const p = stagedParts(level, markAdded);
  const d = new Diagram("URL Shortener, step by step", SUBTITLES[level]);

  // Clients
  if (p.from(3)) d.node("visitor", "Visitor's browser", 0, 0, "client", { detail: "clicks sho.rt/aB3xK9" });
  else d.node("visitor", "Users", 0, 0, "client", { detail: "create links, click links" });
  if (p.from(3)) d.node("creator", "Link creator", 0, 2, "client", { detail: "web app or REST API", ...p.added(3) });

  // Edge
  if (p.from(3)) d.node("front", "CDN + load balancer", 1, 0, "edge", { detail: ["caches hot redirects ~60 s", "spreads the rest"], ...p.added(3) });
  else if (p.from(1)) d.node("front", "Load balancer", 1, 0, "edge", { detail: ["spreads requests", "health checks"], ...p.added(1) });
  if (p.from(3)) d.node("gw", "API gateway", 1, 2, "edge", { detail: ["login", "rate limit per user"], ...p.added(3) });

  // Services
  if (p.from(3)) d.node("app", "Redirect service", 2, 0, "service", { detail: ["read-only, autoscaled", "checks expiry + status"], ...p.added(3) });
  else if (p.from(1)) d.node("app", "App servers × 4", 2, 0, "service", { detail: ["stateless, interchangeable", "create + redirect"], ...p.added(1) });
  else d.node("app", "App server", 2, 0, "service", { detail: ["one machine", "create + redirect"] });
  if (p.from(3)) {
    const how = p.from(5) ? "code = base62(shuffle(id))" : p.from(4) ? "needs a new source of ids" : "code = base62(row id)";
    d.node("shorten", "Shorten service", 2, 2, "service", { detail: ["validate + safety check", how], ...p.added(3) });
  }
  if (p.from(6)) d.node("stats", "Stats service", 2, 3.3, "service", { detail: "per-link click reports", ...p.added(6) });

  // Data
  if (p.from(2)) d.node("redis", "Redis cache", 3, -1, "cache", { detail: ["code → long URL", "expires after 24 h"], ...p.added(2) });
  if (p.from(4)) d.node("urls", "URL store", 3, 1, "db", { detail: ["DynamoDB / Cassandra", "partition key = code"], ...p.added(4) });
  else d.node("urls", "PostgreSQL", 3, 1, "db", { detail: ["urls table", "one primary"] });
  if (p.from(5)) d.node("kgs", "Key generation service", 3, 2.3, "service", { detail: ["leases ranges of 1 M ids", "state in ZooKeeper / etcd"], ...p.added(5) });

  // Analytics
  if (p.from(6)) {
    d.node("kafka", "Kafka: clicks", 4, 0, "queue", { detail: "partitioned by code", ...p.added(6) })
      .node("flink", "Stream processor", 4, 1.65, "worker", { detail: ["Flink: country, device", "1-minute totals"], ...p.added(6) })
      .node("clickhouse", "ClickHouse", 4, 3.3, "db", { detail: "clicks per code per minute", ...p.added(6) })
      .zone("Statistics (background)", ["kafka", "flink", "clickhouse"], "#e8590c");
  }

  // Request path
  if (!p.from(1)) d.edge("visitor", "app", "create + redirect");
  else {
    d.edge("visitor", "front", p.from(3) ? "GET /aB3xK9" : "create + redirect", p.between(1, 3) ? p.added(1) : p.added(3));
    d.edge("front", "app", p.from(3) ? "miss" : undefined, p.between(1, 3) ? p.added(1) : p.added(3));
  }
  if (p.from(2)) {
    d.edge("app", "redis", "1. get", p.added(2));
    d.edge("app", "urls", "2. on miss");
  } else d.edge("app", "urls", "read / write");

  // Create path
  if (p.from(3)) {
    d.edge("creator", "gw", "POST /urls", p.added(3));
    d.edge("gw", "shorten", undefined, p.added(3));
    d.edge("shorten", "urls", p.from(4) ? "insert if absent" : "insert", p.from(4) ? p.added(4) : p.added(3));
  }
  if (p.from(5)) d.edge("shorten", "kgs", "next range", p.added(5));

  // Statistics
  if (p.from(6)) {
    d.edge("app", "kafka", "click event", { async: true, ...p.added(6) })
      .edge("kafka", "flink", undefined, { async: true, ...p.added(6) })
      .edge("flink", "clickhouse", "save totals", p.added(6))
      .edge("gw", "stats", "GET /stats", p.added(6))
      .edge("stats", "clickhouse", "read totals", p.added(6));
  }
  return d.build();
}

const urlShortener: Evolution = {
  intro: "Build a URL shortener the way one really grows: start small, hit a problem, choose a fix, and see what the fix costs.",
  steps,
  diagram,
  wrapUp:
    "You have rebuilt the full design from a single server. Every box in the final diagram is there because of one specific problem, and each one came with a cost. " +
    "That is the habit to keep: name the problem first, then pick the smallest change that fixes it.\n\n" +
    "The full write-up goes further: the API, the data model, failure modes, security and running in several regions.",
};

export default urlShortener;
