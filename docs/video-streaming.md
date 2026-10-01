# Video Streaming Platform

> YouTube/Netflix-style: creators upload videos, the platform transcodes them into many resolutions, and viewers stream smoothly on any network via a CDN.

## The problem in one minute

Video is the heaviest data on the internet, and it drives the design in two directions:

- **Processing:** a raw upload (say 10 GB of 4K footage) must be converted into many versions — different resolutions, bitrates and codecs — so every device and network can play it. Doing this serially takes hours; doing it in parallel across thousands of machines takes minutes.
- **Delivery:** a billion hours watched per day at a few megabits per second is **over 100 terabits per second** of traffic. No origin server farm can serve that. The system is really a **CDN** with an application attached, and the application's job is to make sure the CDN almost never has to ask the origin.

On top of that, players use **adaptive bitrate streaming** (HLS/DASH): the video is cut into 2–6 second segments at every bitrate, and the player picks the best bitrate for each segment based on the network it currently sees.

| Decision | Choice | Why |
| --- | --- | --- |
| Uploads | Pre-signed, multipart, resumable, straight to object storage | App servers never carry video bytes |
| Processing | A DAG: split at keyframes → encode chunks in parallel → assemble → package | Minutes instead of hours; failed chunks retry alone |
| Formats | HLS + DASH, a per-title bitrate ladder, H.264 fallback plus VP9/AV1 | Plays everywhere, uses less bandwidth where supported |
| Delivery | Multi-tier CDN: ISP caches / edge → regional shield → origin | ~95 %+ of bytes served from the edge |
| Playback control | A playback API that checks rights and signs short-lived URLs | Access control without proxying video |
| Metrics | Player heartbeats into Kafka → views, quality of experience | Counts and QoE at scale, eventually consistent |

## Requirements

### Functional

- Upload videos up to tens of GB with resumable uploads.
- Transcode into multiple resolutions and codecs; generate thumbnails, preview sprites, captions, and multiple audio tracks.
- Stream with adaptive bitrate on web, mobile, smart TVs and consoles.
- Video metadata (title, description, owner, visibility, status) and view counts.
- Access control: private/unlisted videos, geo-restrictions, subscriptions, DRM for premium content.
- (Out of scope here: search, recommendations, comments, live streaming — mentioned where relevant.)

### Non-functional

| Property | Target |
| --- | --- |
| Start-up time | First frame in < 2 s |
| Rebuffering | < 0.5 % of playback time |
| Availability | Playback 99.99 %; uploads can tolerate brief outages (clients resume) |
| Processing latency | Most videos playable within minutes of upload (low resolutions first) |
| Durability | Original uploads never lost |
| Cost | Bandwidth and storage dominate — optimise both relentlessly |

## Capacity estimation

- **Uploads:** 500 hours of video per minute → **720k hours/day**.
- **Raw storage:** at ~1–5 GB per hour of source video → roughly **1–3 PB/day** of originals.
- **Encoded storage:** the ladder (6–8 renditions × 2–3 codecs) adds 1–3× the original size, but compressed renditions are much smaller than raw sources → budget **~2–3 PB/day** total, before moving cold content to cheaper tiers.
- **Encoding compute:** encoding 1 hour of 1080p H.264 needs on the order of 1–2 CPU-hours; 4K/AV1 is 10×+ more. 720k hours/day × several renditions ≈ **millions of CPU-hours per day** → a large, elastic (often spot/preemptible) encoder fleet.
- **Views:** 1 B hours watched per day × 3 Mbps average = 1 B × 3,600 s × 3 Mb ≈ 1.1 × 10¹⁶ bits/day ÷ 86,400 ≈ **125 Tbps average egress**, with evening peaks 2–3× higher. This is why delivery must be almost entirely from caches close to viewers.
- **Metadata:** billions of videos × a few KB = tens of TB — ordinary sharded database territory.
- **Heartbeats:** if 50 M concurrent viewers each send a heartbeat every 30 s → **~1.7 M events/s** into Kafka.

## API

```http
# Upload
POST /v1/videos
{ "title": "My trip", "size_bytes": 10737418240, "content_type": "video/mp4", "visibility": "public" }
→ 201 { "video_id": "v-9", "upload_id": "…", "part_size": 67108864,
        "part_urls": ["https://raw.s3…?partNumber=1&sig=…", "…"] }

PUT  <part_url>                                     # direct to object storage, retry per part
POST /v1/videos/v-9/complete   { "parts": [ { "n": 1, "etag": "…" }, … ] }
GET  /v1/videos/v-9            → { status: "PROCESSING" | "READY" | "FAILED", renditions: [...] }

# Playback
GET /v1/videos/v-9/play?device=tv&drm=widevine
→ 200 { "manifest": "https://cdn-a.example.net/v-9/master.m3u8?exp=…&sig=…",
        "license_url": "https://drm.example.com/widevine", "cdn": "cdn-a" }

POST /v1/playback/heartbeat   { video_id, session_id, position_s, bitrate, rebuffer_ms, errors }
```

## Data model

```text
videos        (video_id PK, owner_id, title, description, visibility, status,
               duration_s, source_path, created_at, published_at)
renditions    (video_id, rendition_id) PK, resolution, codec, bitrate, manifest_path, size_bytes
jobs          (job_id PK, video_id, state, created_at)          -- orchestrator state
tasks         (job_id, task_id) PK, type(split|encode|package|thumbnail), chunk, rendition,
               state, attempts, worker_id, output_path
rights        (video_id, region) PK, allowed, window_start, window_end   -- licensing
view_counts   (video_id PK, count)                              -- aggregated, eventually consistent
```

Object storage layout:

```text
raw/v-9/source.mp4
media/v-9/1080p_h264/seg_00001.m4s …        (segments per rendition)
media/v-9/master.m3u8, media/v-9/1080p_h264/playlist.m3u8, media/v-9/manifest.mpd
media/v-9/thumbs/sprite_000.jpg
```

## High-level architecture

See the [Architecture](#diagram/architecture) diagram.

| Component | Responsibility |
| --- | --- |
| Upload service | Create the video record, issue multipart upload URLs, verify completion |
| Raw store | Original files (durable, later moved to a cheaper tier) |
| Transcode orchestrator | Builds and runs the processing DAG, tracks tasks, retries failures |
| Encoder fleet | Stateless workers that encode chunks; autoscaled on queue depth, often on spot capacity |
| Packager | Stitches chunks, writes HLS/DASH manifests, encrypts for DRM, makes thumbnails |
| Processed store (origin) | Segments and manifests; the CDN's origin |
| Metadata DB | Videos, renditions, rights, status |
| Playback API | Authorisation, geo rights, DRM license info, CDN selection, signed URLs |
| CDN | ISP-embedded caches and edge PoPs, a regional shield tier, then origin |
| View events | Player heartbeats → Kafka → view counts, quality metrics, recommendations |

## Upload and processing

See [Upload & processing](#diagram/upload).

1. The app calls `POST /videos`; the service creates `v-9` with status `UPLOADING` and returns a multipart upload ID and pre-signed part URLs.
2. The app uploads 64 MB parts **in parallel directly to object storage**. A failed part is retried alone; after a crash, the app asks which parts exist and resumes.
3. `POST /complete` finalises the multipart upload; status becomes `PROCESSING`.
4. The storage event (`ObjectCreated`) triggers the orchestrator.
5. The orchestrator probes the file (duration, resolution, frame rate, audio tracks), rejects corrupt or disallowed files, and splits the video at **keyframes (GOP boundaries)** into ~2-second chunks.
6. It fans out **chunk × rendition** encode tasks (e.g. 1,260 chunks × 6 renditions ≈ 7,500 tasks) to the encoder fleet.
7. When every task for a rendition is done, the packager concatenates the chunks, writes HLS and DASH playlists, encrypts for DRM, and generates thumbnails and scrubbing sprites.
8. Metadata is updated with the renditions and status `READY`; the creator is notified.

**Fast availability:** encode low resolutions first and publish as soon as 360p/720p are ready; higher resolutions appear minutes later.

## Playback

See [Playback (ABR)](#diagram/playback).

1. The player calls the playback API with the user's token, device type and location.
2. The API checks rights (visibility, subscription, geo-window), chooses a CDN (health, cost, region), and returns a **signed manifest URL** that expires in a few hours, plus the DRM license URL.
3. The player downloads the master manifest (the list of renditions) and starts with a **low** rendition to show the first frame fast.
4. For each segment, it measures download throughput and watches its buffer. With a healthy buffer and good throughput it switches up; if throughput drops or the buffer drains, it switches down **before** stalling.
5. Segments come from the nearest CDN cache; misses go to the regional shield, and only shield misses reach the origin.
6. Every ~30 s the player sends a heartbeat: position, bitrate, rebuffering, errors. These drive view counts and quality monitoring.

## Deep dives

### 1. The transcoding DAG

See [Transcoding DAG](#diagram/transcode-dag).

- **Why split?** A serial 4K encode of a 2-hour film can take many hours. Splitting into chunks encoded in parallel turns it into minutes and lets one failed chunk retry without redoing the rest.
- **Keyframe alignment:** each chunk must start with a keyframe (an I-frame) so chunks decode independently and join seamlessly. The splitter cuts on GOP boundaries; encoders are configured with fixed GOP lengths so every rendition has aligned segment boundaries — required for switching bitrates mid-stream.
- **Idempotent tasks:** output paths are deterministic (`media/v-9/1080p/chunk_0042`), so a retried task just overwrites the same file.
- **Cost:** encoders run on spot/preemptible instances; a preempted task is just retried. Popular videos get extra, more expensive encodes (AV1, higher quality) later.
- **Workflow engine:** the orchestrator's state (jobs, tasks, attempts) lives in a database, or in a workflow engine (Temporal, Step Functions) that handles retries and timeouts.

### 2. Adaptive bitrate streaming

- **HLS** (Apple, `.m3u8` playlists) and **MPEG-DASH** (`.mpd`) describe the same idea: a list of renditions, each a sequence of short segments. **CMAF** lets both share one set of fragmented MP4 segments, halving storage.
- The player's ABR algorithm balances throughput estimates and buffer level (buffer-based algorithms like BOLA avoid over-reacting to noisy throughput).
- **Segment length:** 2 s gives faster start and quicker adaptation but more requests and slightly worse compression; 4–6 s is common for on-demand video.

### 3. The bitrate ladder and per-title encoding

See [ABR ladder & CDN](#diagram/delivery).

| Rendition | Codec | Bitrate | Typical use |
| --- | --- | --- | --- |
| 240p | H.264 | 0.4 Mbps | Very weak networks |
| 480p | H.264 | 1 Mbps | Mobile, start-up |
| 720p | H.264 | 3 Mbps | Laptops |
| 1080p | VP9 / H.264 | 4.5–6 Mbps | TVs, good Wi-Fi |
| 2160p | AV1 / HEVC | 12–16 Mbps | 4K TVs |

A fixed ladder wastes bits: a cartoon looks perfect at a fraction of the bitrate a football match needs. **Per-title (or per-shot) encoding** analyses each video's complexity and picks bitrates to hit a target quality score (e.g. VMAF), saving 20–50 % bandwidth.

**Codecs:** AV1 and VP9 need 30–50 % fewer bits than H.264 for the same quality but cost much more CPU to encode and aren't supported everywhere. Keep H.264 as the universal fallback; add better codecs for popular content where the bandwidth savings pay for the encoding.

### 4. CDN strategy

- **Tiers:** ISP-embedded caches (Netflix Open Connect, Google Global Cache) and edge PoPs serve viewers; a **regional shield** absorbs edge misses so the origin sees roughly one request per segment per region.
- **Push vs pull:** popular and new-release content is **pushed** to edge caches overnight; the long tail is **pulled** on demand.
- **Multi-CDN:** the playback API steers each session to a CDN based on real-time health and cost; the player can fail over mid-stream.
- **Thundering herd on a premiere:** pre-position content, and rely on shield request collapsing so one miss fetches from origin while other requests wait.

### 5. Storage cost

- Originals move to a cold tier after processing (re-encoding from them is rare).
- Long-tail videos (never watched) get fewer renditions, or are encoded lazily on first view.
- Renditions of videos not watched for months move to infrequent-access storage.

### 6. View counting

- Count from heartbeats: a view is counted after a minimum watch time (e.g. 30 s), once per session.
- Heartbeats → Kafka → a streaming job with dedup per session → per-video counters flushed every few seconds. Displayed counts are approximate and slightly delayed.
- Abuse detection filters bots and view farms before counts become "official" (e.g. for monetisation).

### 7. Security and DRM

- Signed, expiring URLs (or signed cookies) scoped to one video stop hotlinking.
- DRM: segments are encrypted (CENC); the player gets a license from Widevine/FairPlay/PlayReady servers after the playback API authorises it.
- Geo-restrictions and licensing windows are enforced in the playback API.

### 8. Live streaming (brief)

Live changes the ingest side: the broadcaster pushes RTMP/SRT to an ingest server, which transcodes in real time into the ladder and publishes rolling playlists with short segments (1–2 s, or low-latency HLS with partial segments). Delivery is the same CDN, but caches must refresh playlists every few seconds.

## Scaling and reliability

- Upload, metadata and playback APIs are stateless.
- Processing is queue-driven and retryable; the orchestrator's state is durable.
- The CDN absorbs load; the origin is sized for shield misses only.

### Failure modes

| Failure | Impact | Handling |
| --- | --- | --- |
| Upload interrupted | Partial upload | Resume from existing parts; abort incomplete multipart uploads after N days |
| Encoder VM preempted | Task lost | Retry the task; idempotent outputs |
| Corrupt source | Processing fails | Mark `FAILED` with a reason; notify the creator |
| CDN outage in a region | Playback errors | Multi-CDN steering; player failover to an alternate CDN URL |
| Origin overload (premiere) | Slow starts | Pre-positioning, shield collapsing, rate-limited origin fetches |
| Playback API down | New sessions can't start | Multi-region deployment; cached manifests for sessions already playing |

## Observability

- Quality of experience: start-up time, rebuffering ratio, average bitrate, playback failures — by device, ISP, CDN, region.
- CDN cache hit ratio per tier; origin egress.
- Processing: time from upload to `READY`, task failure rate, queue depth, cost per encoded hour.

## Trade-offs to discuss

- **Segment length:** faster start and adaptation vs request overhead and compression efficiency.
- **Codec choice:** bandwidth savings vs encoding cost and device support.
- **Store every rendition vs just-in-time packaging:** storing is simple and fast to serve; packaging on the fly saves storage for rare formats but costs CPU at request time.
- **Encode everything vs encode on demand:** eager encoding makes every video instantly playable at all qualities; lazy encoding saves compute on the long tail.

## Interview follow-up questions

- **How do you make a new upload playable quickly?** Encode and publish low resolutions first; add higher ones later.
- **How would you add live streaming?** Real-time transcode at ingest, rolling playlists, short segments, low-latency HLS/DASH.
- **How do you handle a video going viral an hour after upload?** The shield tier absorbs misses; the platform can trigger higher-quality encodes and pre-position at the edge.
- **How do you resume playback on another device?** Heartbeats store the position per user and video; the playback API returns it.
- **How do you estimate CDN cost?** Egress per GB by region × watch hours × average bitrate; the biggest levers are codec efficiency, per-title encoding, and ISP-embedded caches.
