// Generates src/diagrams/icons.generated.ts with only the icons the diagrams can use.
//
//   npm run icons
//
// Sources (dev dependencies, so the app never ships the full sets):
//   - @iconify-json/logos          full-colour brand logos, incl. AWS services (CC0)
//   - @iconify-json/simple-icons   single-colour brand logos for gaps in "logos" (CC0)
//   - @iconify-json/lucide         generic outline icons, tinted per node kind (ISC)
//
// To add an icon: add a line to the right table below and re-run the script.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Our name → icon name in @iconify-json/logos. */
const LOGOS = {
  aws: "aws",
  "aws-api-gateway": "aws-api-gateway",
  "aws-athena": "aws-athena",
  "aws-aurora": "aws-aurora",
  "aws-cloudfront": "aws-cloudfront",
  "aws-cloudwatch": "aws-cloudwatch",
  "aws-cognito": "aws-cognito",
  "aws-dynamodb": "aws-dynamodb",
  "aws-ec2": "aws-ec2",
  "aws-ecs": "aws-ecs",
  "aws-eks": "aws-eks",
  "aws-elasticache": "aws-elasticache",
  "aws-elb": "aws-elb",
  "aws-eventbridge": "aws-eventbridge",
  "aws-fargate": "aws-fargate",
  "aws-glacier": "aws-glacier",
  "aws-glue": "aws-glue",
  "aws-keyspaces": "aws-keyspaces",
  "aws-kinesis": "aws-kinesis",
  "aws-kms": "aws-kms",
  "aws-lambda": "aws-lambda",
  "aws-msk": "aws-msk",
  "aws-opensearch": "aws-open-search",
  "aws-rds": "aws-rds",
  "aws-redshift": "aws-redshift",
  "aws-route53": "aws-route53",
  "aws-s3": "aws-s3",
  "aws-ses": "aws-ses",
  "aws-shield": "aws-shield",
  "aws-sns": "aws-sns",
  "aws-sqs": "aws-sqs",
  "aws-step-functions": "aws-step-functions",
  "aws-vpc": "aws-vpc",
  "aws-waf": "aws-waf",
  airflow: "airflow-icon",
  akamai: "akamai",
  android: "android-icon",
  apple: "apple",
  cassandra: "cassandra",
  chrome: "chrome",
  cloudflare: "cloudflare-icon",
  consul: "consul",
  docker: "docker-icon",
  elasticsearch: "elasticsearch",
  envoy: "envoy-icon",
  etcd: "etcd",
  fastly: "fastly",
  firebase: "firebase-icon",
  google: "google-icon",
  grafana: "grafana",
  graphql: "graphql",
  grpc: "grpc",
  hbase: "hbase",
  kafka: "kafka-icon",
  kubernetes: "kubernetes",
  memcached: "memcached",
  mongodb: "mongodb-icon",
  mysql: "mysql-icon",
  neo4j: "neo4j",
  nginx: "nginx",
  opensearch: "opensearch-icon",
  opentelemetry: "opentelemetry-icon",
  paypal: "paypal",
  postgres: "postgresql",
  presto: "presto-icon",
  prometheus: "prometheus",
  rabbitmq: "rabbitmq-icon",
  redis: "redis",
  sendgrid: "sendgrid-icon",
  snowflake: "snowflake-icon",
  spark: "apache-spark",
  sqlite: "sqlite",
  stripe: "stripe",
  temporal: "temporal-icon",
  twilio: "twilio-icon",
  vault: "vault-icon",
  websocket: "websocket",
};

/** Our name → [icon name in @iconify-json/simple-icons, colour]. Colours are darkened where the brand colour is too pale on light boxes. */
const SIMPLE = {
  bigquery: ["googlebigquery", "#4285F4"],
  ceph: ["ceph", "#EF5C55"],
  clickhouse: ["clickhouse", "#1e1e1e"],
  cockroachdb: ["cockroachlabs", "#6933FF"],
  druid: ["apachedruid", "#0b8a99"],
  flink: ["apacheflink", "#E6526F"],
  hadoop: ["apachehadoop", "#1f8ac0"],
  ffmpeg: ["ffmpeg", "#007808"],
  istio: ["istio", "#466BB0"],
  jaeger: ["jaeger", "#2c9fb5"],
  minio: ["minio", "#C72E49"],
  nats: ["natsdotio", "#27AAE1"],
  pulsar: ["apachepulsar", "#188FFF"],
  scylladb: ["scylladb", "#2b8fb3"],
  trino: ["trino", "#DD00A1"],
  webrtc: ["webrtc", "#333333"],
  whatsapp: ["whatsapp", "#25D366"],
};

/** Our name → icon name in @iconify-json/lucide. These keep `currentColor` and are tinted at render time. */
const LUCIDE = {
  activity: "activity",
  bell: "bell",
  book: "book-open",
  bot: "bot",
  box: "box",
  boxes: "boxes",
  brain: "brain",
  calendar: "calendar",
  car: "car",
  cart: "shopping-cart",
  chart: "chart-column",
  clock: "clock",
  cloud: "cloud",
  code: "code",
  cog: "cog",
  cpu: "cpu",
  "credit-card": "credit-card",
  database: "database",
  eye: "eye",
  file: "file-text",
  files: "files",
  filter: "filter",
  fingerprint: "fingerprint",
  folder: "folder",
  gauge: "gauge",
  "git-branch": "git-branch",
  globe: "globe",
  "hard-drive": "hard-drive",
  hash: "hash",
  image: "image",
  inbox: "inbox",
  key: "key",
  landmark: "landmark",
  laptop: "laptop",
  layers: "layers",
  link: "link",
  list: "list-ordered",
  "list-checks": "list-checks",
  lock: "lock",
  mail: "mail",
  map: "map",
  "map-pin": "map-pin",
  merge: "merge",
  message: "message-square",
  monitor: "monitor",
  network: "network",
  package: "package",
  radio: "radio",
  receipt: "receipt",
  refresh: "refresh-cw",
  route: "route",
  router: "router",
  scale: "scale",
  search: "search",
  send: "send",
  server: "server",
  shield: "shield",
  "shield-check": "shield-check",
  siren: "siren",
  smartphone: "smartphone",
  split: "split",
  tag: "tag",
  terminal: "terminal",
  ticket: "ticket",
  timer: "timer",
  trophy: "trophy",
  truck: "truck",
  user: "user",
  users: "users",
  video: "video",
  wallet: "wallet",
  warehouse: "warehouse",
  workflow: "workflow",
  zap: "zap",
};

function loadSet(pkg) {
  return JSON.parse(readFileSync(require.resolve(`${pkg}/icons.json`), "utf8"));
}

/** Resolve an icon (following simple aliases) to a standalone SVG string. */
function toSvg(set, name, colour) {
  let icon = set.icons[name];
  let alias = set.aliases?.[name];
  while (!icon && alias) {
    icon = set.icons[alias.parent];
    alias = set.aliases?.[alias.parent];
  }
  if (!icon) throw new Error(`Icon "${name}" not found in ${set.prefix}`);
  const w = icon.width ?? set.width ?? 16;
  const h = icon.height ?? set.height ?? 16;
  const left = icon.left ?? set.left ?? 0;
  const top = icon.top ?? set.top ?? 0;
  let body = icon.body;
  if (colour) body = body.replaceAll("currentColor", colour);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${w} ${h}" width="64" height="64">${body}</svg>`;
}

const logos = loadSet("@iconify-json/logos");
const simple = loadSet("@iconify-json/simple-icons");
const lucide = loadSet("@iconify-json/lucide");

const brand = {};
for (const [ours, theirs] of Object.entries(LOGOS)) brand[ours] = toSvg(logos, theirs);
for (const [ours, [theirs, colour]] of Object.entries(SIMPLE)) brand[ours] = toSvg(simple, theirs, colour);
const generic = {};
for (const [ours, theirs] of Object.entries(LUCIDE)) generic[ours] = toSvg(lucide, theirs);

const clash = Object.keys(brand).filter((k) => k in generic);
if (clash.length) throw new Error(`Icon names used twice: ${clash.join(", ")}`);

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const out = `// Generated by scripts/build-icons.mjs — do not edit by hand. Run \`npm run icons\` instead.
// Brand logos: Iconify "logos" (CC0) and Simple Icons (CC0). Generic icons: Lucide (ISC).

/** Full-colour brand logos. */
export const BRAND_ICONS = ${JSON.stringify(sorted(brand), null, 2)} as const;

/** Generic outline icons; \`currentColor\` is replaced with the node's colour when rendered. */
export const GENERIC_ICONS = ${JSON.stringify(sorted(generic), null, 2)} as const;

export type BrandIcon = keyof typeof BRAND_ICONS;
export type GenericIcon = keyof typeof GENERIC_ICONS;
export type IconName = BrandIcon | GenericIcon;
`;
writeFileSync(join(root, "src/diagrams/icons.generated.ts"), out);
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`[build-icons] ${Object.keys(brand).length} brand + ${Object.keys(generic).length} generic icons → src/diagrams/icons.generated.ts (${kb} KB)`);
