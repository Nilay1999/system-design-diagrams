import { Diagram, Sequence, type DiagramSpec } from "./dsl";

function architecture() {
  return new Diagram("Video Streaming — architecture", "Bytes never touch app servers: uploads go straight to storage, playback comes from CDN caches")
    .zone("CDN", ["edge", "shield"], "#6741d9")
    .node("creator", "Creator", 0, 0, "client", { detail: "web / mobile / studio tools" })
    .node("upload", "Upload service", 1.1, 0, "service", { detail: ["create video row", "pre-signed multipart URLs"] })
    .node("raw", "Raw uploads", 2.2, 0, "storage", { detail: "S3: original files" })
    .node("orch", "Transcode orchestrator", 3.3, 0, "service", { detail: ["builds the job DAG", "retries failed tasks"] })
    .node("enc", "Encoder fleet", 4.4, 0, "worker", { detail: ["1,000s of workers, spot VMs", "segment × rendition tasks"] })
    .node("pkg", "Packager", 4.4, 1.1, "worker", { detail: ["HLS / DASH manifests", "thumbnails, captions"] })
    .node("origin", "Processed store (origin)", 3.3, 1.1, "storage", { detail: ["S3: segments + manifests", "hot / cold tiers"] })
    .node("meta", "Video metadata", 1.1, 1.1, "db", { detail: ["status, renditions, rights", "sharded by video_id"] })
    .node("viewer", "Viewer", 0, 2.4, "client", { detail: "player with ABR logic" })
    .node("play", "Playback API", 1.1, 2.4, "service", { detail: ["auth, geo rights, DRM", "signs CDN URLs"] })
    .node("edge", "CDN edge / ISP cache", 2.2, 3.4, "edge", { detail: ["~95 % of bytes served here", "popular titles pre-pushed"] })
    .node("shield", "Mid-tier shield", 3.3, 3.4, "edge", { detail: "collapses edge misses" })
    .node("views", "View events", 4.4, 2.4, "queue", { detail: ["Kafka: heartbeats, QoE", "→ view counts, analytics"] })
    .edge("creator", "upload", "1. create")
    .edge("creator", "raw", "2. PUT parts", { via: [[0.55, -0.9], [2.2, -0.9]] })
    .edge("raw", "orch", "3. ObjectCreated", { async: true })
    .edge("orch", "enc", "tasks", { async: true })
    .edge("enc", "pkg")
    .edge("pkg", "origin", "write")
    .edge("orch", "meta", "status READY", { via: [[3.3, 0.55], [1.1, 0.55]] })
    .edge("viewer", "play", "GET manifest")
    .edge("play", "meta")
    .edge("viewer", "edge", "GET segments")
    .edge("edge", "shield", "miss")
    .edge("shield", "origin", "miss")
    .edge("viewer", "views", "playback heartbeats", { async: true, via: [[0.4, 1.75], [4.4, 1.75]] })
    .panel(
      "Scale",
      ["500 hours uploaded per minute", "1 B hours watched per day", "Avg 3 Mbps → ~125 Tbps of egress on average", "The CDN is the system; the origin must almost never be hit"],
      5.5,
      0,
      { width: 400, tone: "info" },
    )
    .build();
}

function uploadFlow() {
  return new Sequence("Upload & processing", "A 10 GB file becomes a ladder of streamable renditions in minutes, in parallel", { gap: 230 })
    .actor("c", "Creator app", "client")
    .actor("u", "Upload service", "service")
    .actor("s3", "Raw store", "storage")
    .actor("o", "Orchestrator", "service")
    .actor("w", "Encoder workers", "worker")
    .actor("p", "Packager", "worker")
    .actor("m", "Metadata", "db")
    .msg("c", "u", "POST /videos {title, size, content_type}")
    .msg("u", "m", "INSERT video v-9 status UPLOADING")
    .msg("u", "c", "{video_id v-9, multipart upload id, part URLs}", { reply: true })
    .loop("for each 64 MB part (parallel, resumable)", "c", "s3")
    .msg("c", "s3", "PUT part n (pre-signed)")
    .end()
    .msg("c", "u", "POST /videos/v-9/complete (part ETags)")
    .msg("u", "m", "status PROCESSING")
    .msg("s3", "o", "ObjectCreated(v-9)", { async: true })
    .msg("o", "o", "probe: duration 42 min, 4K, 60 fps → split into 2 s GOP-aligned chunks (1,260)")
    .par("1,260 chunks × 6 renditions ≈ 7,560 tasks", "o", "w")
    .msg("o", "w", "encode(chunk k, 1080p H.264) …")
    .msg("w", "o", "done / failed → retry that task only", { reply: true })
    .end()
    .msg("o", "p", "all tasks done → package")
    .msg("p", "p", "stitch, HLS + DASH manifests, thumbnails, captions")
    .msg("p", "m", "renditions + manifest paths; status READY")
    .msg("m", "c", "notify: your video is live", { async: true })
    .note("Tasks are idempotent (output path = video/rendition/chunk), so a retried task simply overwrites the same file.", ["o", "p"], "info")
    .build();
}

function playback() {
  return new Sequence("Playback with adaptive bitrate", "The player picks a rendition per segment from measured bandwidth and buffer level", { gap: 250 })
    .actor("v", "Player", "client")
    .actor("api", "Playback API", "service")
    .actor("edge", "CDN edge", "edge")
    .actor("sh", "Shield", "edge")
    .actor("o", "Origin", "storage")
    .msg("v", "api", "GET /videos/v-9/play (auth token, device, country)")
    .msg("api", "api", "check rights (geo, subscription), pick CDN, DRM license URL")
    .msg("api", "v", "signed master manifest URL (expires in 6 h)", { reply: true })
    .msg("v", "edge", "GET master.m3u8 → list of renditions")
    .msg("v", "edge", "GET 480p/seg_0001.ts — start low for a fast first frame")
    .alt("edge hit", "v", "o")
    .msg("edge", "v", "segment (≈ 2 s of video)", { reply: true })
    .else("edge miss")
    .msg("edge", "sh", "GET segment")
    .msg("sh", "o", "GET segment (only if the shield also misses)")
    .msg("o", "sh", "bytes", { reply: true })
    .msg("sh", "edge", "bytes, cached", { reply: true })
    .msg("edge", "v", "segment", { reply: true })
    .end()
    .loop("every segment", "v", "edge")
    .msg("v", "v", "throughput 12 Mbps, buffer 18 s → switch up to 1080p")
    .msg("v", "edge", "GET 1080p/seg_000k.ts")
    .end()
    .msg("v", "api", "heartbeat every 30 s: position, bitrate, rebuffer events", { async: true })
    .build();
}

function transcodeDag() {
  return new Diagram("Deep dive — the transcoding DAG", "Split once, encode chunks in parallel, then assemble — a failed chunk retries alone")
    .node("src", "Raw file", 0, 1.5, "storage", { detail: "42 min, 4K60, 10 GB" })
    .node("probe", "Probe + validate", 1, 1.5, "worker", { detail: ["codec, fps, audio tracks", "reject corrupt files"] })
    .node("split", "Split at GOPs", 2, 1.5, "worker", { detail: "1,260 × 2 s chunks" })
    .node("e1", "240p / 480p", 3.1, 0, "worker", { detail: "H.264, 0.4–1 Mbps" })
    .node("e2", "720p / 1080p", 3.1, 1, "worker", { detail: "H.264 + VP9, 3–6 Mbps" })
    .node("e3", "4K", 3.1, 2, "worker", { detail: "AV1 / HEVC, 15 Mbps" })
    .node("audio", "Audio + captions", 3.1, 3, "worker", { detail: "AAC stereo, 5.1; WebVTT" })
    .node("asm", "Assemble + package", 4.2, 1.5, "worker", { detail: ["concat chunks per rendition", "HLS + DASH, DRM encrypt"] })
    .node("thumb", "Thumbnails + previews", 2, 3.1, "worker", { detail: "sprite sheet for scrubbing" })
    .node("out", "Publish", 5.3, 1.5, "storage", { detail: ["write origin, mark READY", "pre-warm CDN if popular"] })
    .edge("src", "probe")
    .edge("probe", "split")
    .edge("split", "e1")
    .edge("split", "e2")
    .edge("split", "e3")
    .edge("split", "audio")
    .edge("e1", "asm")
    .edge("e2", "asm")
    .edge("e3", "asm")
    .edge("audio", "asm")
    .edge("split", "thumb")
    .edge("asm", "out")
    .panel(
      "Why split and parallelise",
      ["Serial 4K encode of a 2-hour film can take many hours", "~7,500 small tasks on 1,000 workers finish in minutes", "Each task is idempotent and retryable; spot / preemptible VMs cut cost", "Chunks must start on keyframes (GOP boundaries) so they join seamlessly"],
      0,
      2.7,
      { width: 520, tone: "info" },
    )
    .build();
}

function delivery() {
  return new Diagram("Deep dive — ABR ladder & CDN tiers", "Multiple renditions let the player adapt; cache tiers keep the origin almost idle")
    .table(
      "ladder",
      "Bitrate ladder (per title)",
      ["rendition  codec  bitrate    use", "240p       H.264  0.4 Mbps   very weak networks", "480p       H.264  1.0 Mbps   mobile / start", "720p       H.264  3.0 Mbps   laptops", "1080p      VP9    4.5 Mbps   TVs, good Wi-Fi", "2160p      AV1    12  Mbps   4K TVs"],
      0,
      0,
      { kind: "storage" },
    )
    .panel(
      "Per-title encoding",
      ["Cartoons need far fewer bits than sports for the same quality", "Analyse complexity per title (or per shot) and pick the ladder", "Saves 20–50 % bandwidth at equal quality"],
      0,
      1.9,
      { width: 470, tone: "info" },
    )
    .node("player", "Player", 2, 0.2, "client", { detail: "buffer 18 s, 12 Mbps" })
    .node("isp", "ISP-embedded cache", 3.1, 0.2, "edge", { detail: ["Open Connect-style box", "popular titles pushed nightly"] })
    .node("pop", "CDN edge PoP", 3.1, 1.4, "edge", { detail: "pull on miss" })
    .node("shield", "Regional shield", 4.2, 1.4, "edge", { detail: "one fetch per region" })
    .node("origin", "Origin (S3)", 5.3, 1.4, "storage", { detail: "cold tier for long tail" })
    .edge("player", "isp", "segments")
    .edge("player", "pop", "fallback")
    .edge("pop", "shield", "miss")
    .edge("shield", "origin", "miss")
    .edge("isp", "shield", "fill / miss")
    .panel(
      "Keeping the origin quiet",
      ["Pre-position new releases before launch", "Shield tier collapses thousands of edge misses into one", "Multi-CDN with health-based steering", "Long segments (4–6 s) for VOD reduce request count; 2 s for low-latency live"],
      2,
      2.6,
      { width: 520, tone: "warn" },
    )
    .build();
}

export default [
  { id: "architecture", name: "Architecture", build: architecture },
  { id: "upload", name: "Upload & processing", build: uploadFlow },
  { id: "playback", name: "Playback (ABR)", build: playback },
  { id: "transcode-dag", name: "Transcoding DAG", build: transcodeDag },
  { id: "delivery", name: "ABR ladder & CDN", build: delivery },
] satisfies DiagramSpec[];
