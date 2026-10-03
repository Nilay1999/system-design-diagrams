import type { BrandIcon, IconName } from "./icons.generated";
import type { NodeKind } from "./dsl";

/**
 * Picks an icon for a box from its text, so diagrams get sensible icons without
 * annotating every node. Precedence:
 *   1. a technology named in the title    ("Redis cluster" → redis)
 *   2. a technology named in the details  ("Message store · Cassandra" → cassandra)
 *   3. a keyword in the title             ("Push service" → bell)
 *   4. the node kind                      (db → database)
 * An explicit `icon` option on a node always wins.
 */

type Rule = [RegExp, IconName, NodeKind[]?];

const BRANDS: [RegExp, BrandIcon][] = [
  [/\bMSK\b/, "aws-msk"],
  [/kafka/i, "kafka"],
  [/postgres/i, "postgres"],
  [/aurora/i, "aws-aurora"],
  [/mysql/i, "mysql"],
  [/elasticache/i, "aws-elasticache"],
  [/\bredis\b|valkey/i, "redis"],
  [/memcache/i, "memcached"],
  [/scylla/i, "scylladb"],
  [/cassandra/i, "cassandra"],
  [/dynamo\s?db/i, "aws-dynamodb"],
  [/\bS3\b/, "aws-s3"],
  [/glacier/i, "aws-glacier"],
  [/cloudfront/i, "aws-cloudfront"],
  [/route\s?53/i, "aws-route53"],
  [/\bLambda\b/, "aws-lambda"],
  [/\bSQS\b/, "aws-sqs"],
  [/\bSNS\b/, "aws-sns"],
  [/\bSES\b/, "aws-ses"],
  [/kinesis/i, "aws-kinesis"],
  [/\bRDS\b/, "aws-rds"],
  [/redshift/i, "aws-redshift"],
  [/athena/i, "aws-athena"],
  [/step functions/i, "aws-step-functions"],
  [/eventbridge/i, "aws-eventbridge"],
  [/elasticsearch/i, "elasticsearch"],
  [/opensearch/i, "opensearch"],
  [/clickhouse/i, "clickhouse"],
  [/\bdruid\b/i, "druid"],
  [/flink/i, "flink"],
  [/\bspark\b/i, "spark"],
  [/hadoop|\bHDFS\b/i, "hadoop"],
  [/airflow/i, "airflow"],
  [/temporal/i, "temporal"],
  [/\betcd\b/i, "etcd"],
  [/consul/i, "consul"],
  [/nginx/i, "nginx"],
  [/envoy/i, "envoy"],
  [/kubernetes|\bk8s\b/i, "kubernetes"],
  [/docker/i, "docker"],
  [/mongo/i, "mongodb"],
  [/neo4j/i, "neo4j"],
  [/sqlite/i, "sqlite"],
  [/cockroach/i, "cockroachdb"],
  [/snowflake/i, "snowflake"],
  [/bigquery/i, "bigquery"],
  [/presto/i, "presto"],
  [/\btrino\b/i, "trino"],
  [/pulsar/i, "pulsar"],
  [/rabbitmq/i, "rabbitmq"],
  [/\bNATS\b/, "nats"],
  [/stripe/i, "stripe"],
  [/paypal/i, "paypal"],
  [/twilio/i, "twilio"],
  [/sendgrid/i, "sendgrid"],
  [/\bAPNs\b/, "apple"],
  [/\bFCM\b|firebase/i, "firebase"],
  [/cloudflare/i, "cloudflare"],
  [/fastly/i, "fastly"],
  [/akamai/i, "akamai"],
  [/prometheus/i, "prometheus"],
  [/grafana/i, "grafana"],
  [/jaeger/i, "jaeger"],
  [/opentelemetry/i, "opentelemetry"],
  [/websocket/i, "websocket"],
  [/\bgRPC\b/i, "grpc"],
  [/graphql/i, "graphql"],
  [/ffmpeg/i, "ffmpeg"],
  [/webrtc/i, "webrtc"],
  [/minio/i, "minio"],
  [/\bceph\b/i, "ceph"],
  [/istio/i, "istio"],
];

const KEYWORDS: Rule[] = [
  [/laptop/i, "laptop", ["client"]],
  [/phone|mobile|\bapp\b|device/i, "smartphone", ["client"]],
  [/browser/i, "globe", ["client"]],
  [/users|players|shoppers|viewers|members|buyers|followers|crowd/i, "users", ["client"]],
  [/rider|driver|user|visitor|creator|shopper|player|customer|author|reader|marketer|owner|viewer|sender|recipient|alice|bob|carol|reader|merchant|advertiser/i, "user", ["client"]],
  [/\bcdn\b|edge|geo\s?dns|\bdns\b|\bpop\b/i, "globe"],
  [/load balancer|\bLB\b/, "split"],
  [/router/i, "router"],
  [/gateway|proxy|\bBFF\b/i, "network"],
  [/\bwaf\b|ddos|shield|fraud|risk|anti-cheat|abuse|safety|bot defen/i, "shield"],
  [/idempoten/i, "key"],
  [/\block\b|lease|auth|secret/i, "lock"],
  [/refund|receipt|invoice|billing/i, "receipt"],
  [/ledger|account|bank/i, "landmark"],
  [/wallet|payout/i, "wallet"],
  [/payment|\bpsp\b|charge|card/i, "credit-card"],
  [/notif|push|alert/i, "bell"],
  [/e-?mail/i, "mail"],
  [/\bsms\b|message|chat/i, "message"],
  [/crawl|fetcher|spider|robots/i, "bot"],
  [/search|index|trie|suggest|autocomplete/i, "search"],
  [/schedul|cron|timer|timing|clock|expir|sweeper|reaper|recrawl/i, "clock"],
  [/geo|location|proximity|\bmap\b|h3|geohash|quadtree/i, "map-pin"],
  [/trip|ride|dispatch|matching/i, "car"],
  [/ticket|booking|seat/i, "ticket"],
  [/inventory|warehouse|stock/i, "warehouse"],
  [/fulfil|shipping|delivery/i, "truck"],
  [/cart|checkout|order/i, "cart"],
  [/product|catalog/i, "package"],
  [/video|transcod|encod|playback|\bplayer\b/i, "video"],
  [/thumbnail|image|photo|media/i, "image"],
  [/rank|score|leaderboard|trending|top-k/i, "trophy"],
  [/analytic|dashboard|olap|metric|stats|aggregat|report/i, "chart"],
  [/model|\bml\b|recommend|feature store|training/i, "brain"],
  [/template/i, "file"],
  [/file|chunk|block|document|snapshot|warc|archive|upload/i, "files"],
  [/rule|config|preference|setting/i, "list-checks"],
  [/presence|session|registry/i, "radio"],
  [/coordinat|controller|orchestrat|workflow|saga|scheduler/i, "workflow"],
  [/cache/i, "zap"],
  [/campaign|segment/i, "send"],
  [/sync|replicat|cdc|change stream|relay/i, "refresh"],
];

const BY_KIND: Record<NodeKind, IconName> = {
  client: "monitor",
  edge: "globe",
  service: "server",
  worker: "cog",
  queue: "list",
  cache: "zap",
  db: "database",
  storage: "hard-drive",
  external: "cloud",
};

/** First brand mentioned in the text (by position), if any. */
export function findBrand(text: string): BrandIcon | undefined {
  let best: { at: number; icon: BrandIcon } | undefined;
  for (const [re, icon] of BRANDS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, icon };
  }
  return best?.icon;
}

export function inferIcon(title: string, detail: string[], kind: NodeKind): IconName {
  const brand = findBrand(title) ?? findBrand(detail.join(" "));
  if (brand) return brand;
  for (const [re, icon, kinds] of KEYWORDS) if ((!kinds || kinds.includes(kind)) && re.test(title)) return icon;
  return BY_KIND[kind];
}
