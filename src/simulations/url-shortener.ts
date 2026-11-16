import { count, duration, healthOf, percent, perSecond, waitMs } from "./format";
import { edgeId, type EdgeState, type NodeState, type Reading, type Remark, type SimInputs, type Simulation, type Snapshot } from "./types";

/**
 * The URL shortener from docs/url-shortener.md, running.
 *
 * Redirect path: visitor → CDN → redirect servers → Redis → URL store.
 * Create path:   link creator → API gateway → shorten service → URL store (+ key generation).
 * Statistics:    redirect servers → Kafka → stream processor → ClickHouse.
 */

// What one unit of each part can handle. Round numbers, chosen to match the write-up's scale.
const PER_SERVER = 2_500; // redirects a second per redirect server
const PER_STORE_NODE = 1_500; // reads or writes a second per URL store node
const PER_WORKER = 3_000; // click events a second per stream worker
const READS_PER_WRITE = 100; // 100 redirects for every link created
const ID_RANGE = 1_000_000; // ids a shorten server holds before it needs the key generation service
const TIMEOUT_MS = 1_000;
const WARM_UP_S = 8; // how fast an empty Redis fills again (sped up so it can be watched)

// Illustrative monthly prices, only so that "add more of everything" has a visible cost.
const PRICE = { server: 120, redisGb: 15, storeNode: 400, worker: 200, fixed: 1_500 };

/** Share of redirects the CDN answers by itself, for a given cache time. No cache time, no hits. */
const cdnHitRate = (ttlSeconds: number) => 0.6 * (1 - Math.exp(-ttlSeconds / 30));

/** Share of lookups a warm Redis answers, for a given memory size. A few links get most of the clicks. */
const redisHitRate = (gb: number) => 0.99 * (1 - Math.exp(-gb / 4));

function step(previous: Snapshot | undefined, { values, down }: SimInputs, dt: number): Snapshot {
  const up = (id: string) => !down.includes(id);
  const traffic = values.traffic;
  const servers = values.servers;
  const storeNodes = values.storeNodes;
  const workers = values.workers;

  // --- Redirect path -------------------------------------------------------
  const cdnHit = up("cdn") ? cdnHitRate(values.cdnTtl) : 0;
  const fromEdge = traffic * cdnHit;
  const toServers = traffic - fromEdge;

  const serverCapacity = servers * PER_SERVER;
  const accepted = Math.min(toServers, serverCapacity);
  const turnedAway = toServers - accepted;
  const serverLoad = toServers / serverCapacity;

  // Redis starts empty after a restart and fills as links are read again.
  const warmBefore = previous?.memory.warmth ?? 1;
  const warmth = up("redis") ? warmBefore + (1 - warmBefore) * (1 - Math.exp(-dt / WARM_UP_S)) : 0;
  const redisHit = up("redis") ? redisHitRate(values.redisGb) * warmth : 0;
  const fromRedis = accepted * redisHit;
  const misses = accepted - fromRedis;

  // --- Create path ---------------------------------------------------------
  const creates = traffic / READS_PER_WRITE;
  const idsBefore = previous?.memory.idsLeft ?? ID_RANGE;
  const canMakeCodes = up("kgs") || idsBefore > 0;

  // --- URL store: redirect misses and creates share its capacity ------------
  const storeCapacity = storeNodes * PER_STORE_NODE;
  const storeDemand = misses + (canMakeCodes ? creates : 0);
  const storeLoad = storeDemand / storeCapacity;
  const storeServes = up("urls") ? Math.min(1, storeCapacity / Math.max(storeDemand, 1)) : 0;
  const missesServed = misses * storeServes;
  const missesFailed = misses - missesServed;
  const createsDone = canMakeCodes ? creates * storeServes : 0;
  const idsLeft = up("kgs") ? ID_RANGE : Math.max(0, idsBefore - createsDone * dt);

  const redirected = fromEdge + fromRedis + missesServed;
  const success = redirected / traffic;

  // Slowest 1 % of redirects: waiting at the servers, plus a store read when misses are common enough.
  const serverWait = waitMs(2, serverLoad, 200);
  const storeWait = up("urls") ? waitMs(12, storeLoad, TIMEOUT_MS) : TIMEOUT_MS;
  const p99 =
    1 - success > 0.01 ? TIMEOUT_MS : toServers / traffic < 0.01 ? 2 : misses / traffic > 0.01 ? serverWait + storeWait : serverWait + 1;

  // --- Statistics ----------------------------------------------------------
  const clicks = fromRedis + missesServed; // redirects the servers answered; CDN hits are counted later from its logs
  const intoKafka = up("kafka") ? clicks : 0;
  const dropped = clicks - intoKafka;
  const workerCapacity = workers * PER_WORKER;
  const backlogBefore = previous?.memory.backlog ?? 0;
  const canProcess = up("kafka") && up("processor");
  const processed = canProcess ? Math.min(workerCapacity, intoKafka + (dt > 0 ? backlogBefore / dt : 0)) : 0;
  const backlog = Math.max(0, backlogBefore + (intoKafka - processed) * dt);
  const reportDelay = 60 + backlog / workerCapacity; // totals are per minute, plus whatever is waiting

  const cost = PRICE.fixed + servers * PRICE.server + values.redisGb * PRICE.redisGb + storeNodes * PRICE.storeNode + workers * PRICE.worker;

  // --- What each part shows ------------------------------------------------
  const stopped: NodeState = { health: "down", value: "stopped" };
  const nodes: Record<string, NodeState> = {
    visitor: { health: "ok", value: `${perSecond(traffic)} redirects` },
    cdn: up("cdn")
      ? { health: "ok", value: `answers ${percent(cdnHit)} itself`, note: `passes on ${perSecond(toServers)}` }
      : { health: "down", value: "bypassed", note: "all traffic goes to the servers" },
    redirect: {
      health: healthOf(serverLoad),
      value: `${count(toServers)} of ${perSecond(serverCapacity)}`,
      note: `${servers} server${servers === 1 ? "" : "s"}`,
      load: serverLoad,
    },
    redis: up("redis")
      ? { health: warmth < 0.95 ? "busy" : "ok", value: `hit rate ${percent(redisHit)}`, note: warmth < 0.95 ? "filling up again" : `${values.redisGb} GB` }
      : stopped,
    urls: up("urls")
      ? { health: healthOf(storeLoad), value: `${count(storeDemand)} of ${perSecond(storeCapacity)}`, note: `${storeNodes} nodes`, load: storeLoad }
      : stopped,
    kafka: up("kafka") ? { health: "ok", value: `${perSecond(intoKafka)} in`, note: `${count(backlog)} waiting` } : stopped,
    processor: up("processor")
      ? {
          health: !up("kafka") ? "idle" : intoKafka > workerCapacity ? "bad" : backlog > workerCapacity ? "busy" : "ok",
          value: `${count(processed)} of ${perSecond(workerCapacity)}`,
          note: `${workers} worker${workers === 1 ? "" : "s"}`,
          load: processed / workerCapacity,
        }
      : stopped,
    clickhouse: { health: canProcess ? "ok" : "idle", value: canProcess ? `reports ${duration(reportDelay)} behind` : "no new data" },
    creator: { health: "ok", value: `${perSecond(creates)} new links` },
    gateway: { health: "ok", value: perSecond(creates) },
    shorten: {
      health: createsDone < creates * 0.99 ? "bad" : "ok",
      value: `${perSecond(createsDone)} created`,
      note: createsDone < creates * 0.99 ? `${percent(1 - createsDone / creates)} fail` : undefined,
    },
    kgs: up("kgs") ? { health: "ok", value: "leases id ranges", note: "1 call per 1 M links" } : stopped,
  };

  const edge = (rate: number, bad = false, text?: string): EdgeState => ({ rate, health: bad ? "bad" : rate > 0 ? "ok" : "idle", text });
  const edges: Record<string, EdgeState> = {
    [edgeId({ from: "visitor", to: "cdn" })]: edge(traffic),
    [edgeId({ from: "cdn", to: "redirect" })]: edge(toServers, turnedAway > 0),
    [edgeId({ from: "redirect", to: "redis" })]: up("redis") ? edge(accepted) : edge(0, true, "no answer"),
    [edgeId({ from: "redirect", to: "urls" })]: edge(misses, missesFailed > 0.5),
    [edgeId({ from: "redirect", to: "kafka" })]: up("kafka") ? edge(clicks) : edge(0, true, `${perSecond(dropped)} dropped`),
    [edgeId({ from: "kafka", to: "processor" })]: edge(processed),
    [edgeId({ from: "processor", to: "clickhouse" })]: edge(processed),
    [edgeId({ from: "creator", to: "gateway" })]: edge(creates),
    [edgeId({ from: "gateway", to: "shorten" })]: edge(creates),
    [edgeId({ from: "shorten", to: "urls" })]: edge(canMakeCodes ? creates : 0, createsDone < creates * 0.99),
    [edgeId({ from: "shorten", to: "kgs" })]: up("kgs") ? edge(0, false, "rarely") : edge(0, true, "no answer"),
  };

  const readings: Reading[] = [
    { id: "success", label: "Redirects that work", value: percent(success), health: success > 0.999 ? "ok" : success > 0.99 ? "busy" : "bad" },
    { id: "p99", label: "Slowest 1 % (p99)", value: p99 >= TIMEOUT_MS ? "time out" : `${Math.round(p99)} ms`, health: p99 >= TIMEOUT_MS ? "bad" : p99 > 20 ? "busy" : "ok" },
    { id: "store", label: "URL store load", value: up("urls") ? `${Math.round(storeLoad * 100)} %` : "down", health: !up("urls") || storeLoad > 1 ? "bad" : storeLoad > 0.8 ? "busy" : "ok" },
    { id: "creates", label: "Links created", value: percent(createsDone / creates), health: createsDone < creates * 0.99 ? "bad" : "ok" },
    {
      id: "reports",
      label: "Click reports",
      value: dropped > 0 ? "losing clicks" : canProcess ? `${duration(reportDelay)} behind` : "paused",
      health: dropped > 0 ? "bad" : !canProcess || backlog > workerCapacity * 5 ? "busy" : "ok",
    },
    { id: "cost", label: "Rough monthly cost", value: `$${count(cost)}`, health: "ok" },
  ];

  // --- Why -----------------------------------------------------------------
  const remarks: Remark[] = [];
  const say = (level: Remark["level"], text: string) => remarks.push({ level, text });

  if (!up("urls")) {
    say(
      "bad",
      `The URL store is down. Links already held by the CDN or Redis still redirect (${percent(success)} of traffic). Every other redirect fails, and no new links can be created.`,
    );
  } else if (storeLoad > 1) {
    say(
      "bad",
      up("redis") && warmth >= 0.95
        ? `The URL store is overloaded: ${perSecond(storeDemand)} is asked of it and it can do ${perSecond(storeCapacity)}. Give Redis more memory so fewer lookups miss, or add store nodes.`
        : `With Redis ${up("redis") ? "still nearly empty" : "down"}, lookups that it used to answer now read the URL store: ${perSecond(storeDemand)} against a capacity of ${perSecond(storeCapacity)}. The store is overloaded and ${percent(1 - success)} of redirects fail.`,
    );
  }
  if (!up("redis") && up("urls") && storeLoad <= 1) {
    say(
      "warn",
      `Redis is down, so every redirect that reaches the servers reads the URL store. The store is coping at ${Math.round(storeLoad * 100)} % load, but the slowest redirects got slower. Raise the traffic and it will not hold.`,
    );
  }
  if (up("redis") && warmth < 0.95) {
    say("warn", `Redis is back but started empty. Its hit rate climbs as links are read again (now ${percent(redisHit)}). Until then the URL store carries the extra reads.`);
  }
  if (turnedAway > 0) {
    say(
      "bad",
      `The redirect servers can take ${perSecond(serverCapacity)} and ${perSecond(toServers)} is arriving, so ${percent(turnedAway / traffic)} of redirects are turned away. Add servers, or let the CDN answer more.`,
    );
  } else if (serverLoad > 0.8) {
    say("warn", `The redirect servers are ${Math.round(serverLoad * 100)} % busy. Waiting time rises steeply as a server gets close to full, which is why the slowest redirects are slowing down.`);
  }
  if (!up("cdn")) {
    say("warn", `The CDN is bypassed, so all ${perSecond(traffic)} reaches your own servers, and far-away visitors lose the nearby copy.`);
  } else if (values.cdnTtl === 0) {
    say("info", "The CDN is not caching anything (cache time 0), so it only forwards traffic. Even a few seconds of caching takes popular links off your servers.");
  }
  if (!up("kafka")) {
    say(
      "warn",
      `Kafka cannot be reached. The redirect servers drop ${perSecond(dropped)} click events instead of waiting for it, so redirects are untouched. The click counts for this period will be too low.`,
    );
  } else if (!up("processor")) {
    say("warn", `The stream processor is stopped. Clicks pile up in Kafka (${count(backlog)} waiting) and reports stop moving. Nothing is lost: restart it and it works through the pile.`);
  } else if (intoKafka > workerCapacity) {
    say("warn", `Clicks arrive at ${perSecond(intoKafka)} and the stream workers handle ${perSecond(workerCapacity)}. The pile in Kafka keeps growing and reports fall further behind. Add workers.`);
  } else if (backlog > workerCapacity) {
    say("info", `The stream processor is catching up: ${count(backlog)} clicks are waiting, about ${duration(backlog / Math.max(workerCapacity - intoKafka, 1))} to go.`);
  }
  if (!up("kgs")) {
    say(
      idsLeft > 0 ? "info" : "bad",
      idsLeft > 0
        ? `The key generation service is down and nothing has changed. The shorten servers still hold ${count(idsLeft)} unused ids, enough for about ${duration(idsLeft / Math.max(createsDone, 1))} at this rate.`
        : "The shorten servers have used up their ids and the key generation service is still down, so no new links can be created.",
    );
  }
  if (remarks.every((r) => r.level === "info")) {
    say(
      "good",
      `Everything is healthy. The CDN answers ${percent(cdnHit)} of redirects, and Redis answers ${percent(redisHit)} of the rest, so the URL store sees only ${perSecond(storeDemand)} out of ${perSecond(traffic)}.`,
    );
  }

  return { nodes, edges, readings, remarks, memory: { warmth, backlog, idsLeft } };
}

const urlShortener: Simulation = {
  intro: "This is the finished design, running. Change the traffic, resize the parts, or stop one, and watch where the load goes.",
  nodes: [
    { id: "visitor", label: "Visitors", kind: "client", col: 0, row: 0 },
    { id: "cdn", label: "CDN", kind: "edge", col: 1, row: 0, stoppable: true },
    { id: "redirect", label: "Redirect servers", kind: "service", col: 2, row: 0 },
    { id: "redis", label: "Redis cache", kind: "cache", col: 3, row: -1, stoppable: true },
    { id: "urls", label: "URL store", kind: "db", col: 3, row: 1, stoppable: true },
    { id: "kafka", label: "Kafka: clicks", kind: "queue", col: 4, row: 0, stoppable: true },
    { id: "processor", label: "Stream processor", kind: "worker", col: 5, row: 0, stoppable: true },
    { id: "clickhouse", label: "ClickHouse", kind: "db", col: 5, row: 1.2 },
    { id: "creator", label: "Link creators", kind: "client", col: 0, row: 2 },
    { id: "gateway", label: "API gateway", kind: "edge", col: 1, row: 2 },
    { id: "shorten", label: "Shorten service", kind: "service", col: 2, row: 2 },
    { id: "kgs", label: "Key generation", kind: "service", col: 3, row: 2.2, stoppable: true },
  ],
  edges: [
    { from: "visitor", to: "cdn" },
    { from: "cdn", to: "redirect", label: "miss" },
    { from: "redirect", to: "redis", label: "1. get" },
    { from: "redirect", to: "urls", label: "2. on miss" },
    { from: "redirect", to: "kafka", label: "clicks", async: true },
    { from: "kafka", to: "processor", async: true },
    { from: "processor", to: "clickhouse" },
    { from: "creator", to: "gateway" },
    { from: "gateway", to: "shorten" },
    { from: "shorten", to: "urls", label: "insert" },
    { from: "shorten", to: "kgs", label: "ids" },
  ],
  controls: [
    { id: "traffic", label: "Traffic", min: 500, max: 40_000, step: 500, initial: 4_000, format: (v) => `${perSecond(v)} redirects`, help: "Clicks on short links. New links arrive at 1 % of this." },
    { id: "servers", label: "Redirect servers", min: 1, max: 16, step: 1, initial: 4, format: (v) => `${v} (${perSecond(v * PER_SERVER)})`, help: `Each one handles ${perSecond(PER_SERVER)}.` },
    { id: "cdnTtl", label: "CDN cache time", min: 0, max: 300, step: 10, initial: 60, format: (v) => `${v} s`, help: "How long the CDN may answer a popular link without asking you." },
    { id: "redisGb", label: "Redis memory", min: 1, max: 40, step: 1, initial: 10, format: (v) => `${v} GB`, help: "More memory holds more links, so fewer lookups reach the URL store." },
    { id: "storeNodes", label: "URL store nodes", min: 3, max: 15, step: 1, initial: 3, format: (v) => `${v} (${perSecond(v * PER_STORE_NODE)})`, help: `Each one handles ${perSecond(PER_STORE_NODE)}.` },
    { id: "workers", label: "Stream workers", min: 1, max: 8, step: 1, initial: 2, format: (v) => `${v} (${perSecond(v * PER_WORKER)})`, help: `Each one turns ${perSecond(PER_WORKER)} clicks into report totals.` },
  ],
  scenarios: [
    {
      id: "normal",
      title: "A normal day",
      notice: "Follow the numbers on the arrows from left to right. Of 4,000 redirects a second, only a small fraction ever reaches the URL store. Each layer exists to protect the one behind it.",
    },
    {
      id: "viral",
      title: "A link goes viral",
      values: { traffic: 20_000 },
      notice: "Traffic is five times higher. Look at which part is closest to its limit, then try to bring it back to a comfortable load for the least money.",
    },
    {
      id: "redis-normal",
      title: "Redis crashes on a normal day",
      down: ["redis"],
      notice: "The URL store now answers every lookup, and it copes. A cache that can fail without an outage is one the system only relies on for speed. Now restart Redis and watch it fill.",
    },
    {
      id: "redis-peak",
      title: "Redis crashes at peak",
      values: { traffic: 20_000 },
      down: ["redis"],
      notice: "The same failure at five times the traffic. The store was sized for the trickle that gets past the cache, and it cannot carry the full load. Restart Redis and notice that recovery takes time: it comes back empty.",
    },
    {
      id: "store-down",
      title: "The URL store goes down",
      down: ["urls"],
      notice: "Most redirects still work, because the CDN and Redis already hold the popular links. What fails is the long tail of rarely clicked links, and all link creation.",
    },
    {
      id: "kafka-down",
      title: "Kafka is unreachable",
      down: ["kafka"],
      notice: "Check the redirect numbers: nothing changed. The redirect servers send clicks without waiting for an answer, so a statistics outage cannot become a redirect outage. The price is lost click counts.",
    },
    {
      id: "processor-down",
      title: "The stream processor stops",
      down: ["processor"],
      notice: "Clicks collect in Kafka instead of being lost. Let the pile grow for a few seconds, restart the processor, and watch it catch up. That is what a queue between two parts buys you.",
    },
    {
      id: "kgs-down",
      title: "Key generation goes down",
      down: ["kgs"],
      notice: "Link creation keeps working. Each shorten server already holds a block of a million ids, so this service can be down for hours before anyone notices.",
    },
  ],
  step,
  caveat:
    "The numbers come from simple formulas for capacity, cache hit rates and queues. They show how the parts affect each other; they are not measurements, and the prices are only illustrative. Cache warm-up is sped up so you can watch it.",
};

export default urlShortener;
