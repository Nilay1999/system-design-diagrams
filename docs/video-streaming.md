# Video Streaming Platform

> YouTube/Netflix-style: creators upload videos, the platform transcodes them into many resolutions, and viewers stream smoothly on any network via a CDN.

## Requirements

### Functional
- Upload videos (up to several GB), with resumable uploads.
- Transcode into multiple resolutions/codecs; generate thumbnails.
- Stream with **adaptive bitrate** (ABR) on web, mobile, TV.
- Video metadata: title, description, view counts; search and recommendations are out of scope here.

### Non-functional
- Smooth playback: fast start (< 2 s), minimal rebuffering.
- Highly available and globally distributed reads.
- Uploads may take minutes to process — that's acceptable.
- Cost efficiency: bandwidth and storage dominate the bill.

## Estimation

| Metric | Assumption | Result |
| --- | --- | --- |
| Uploads | 500 hours of video/minute | 720k hours/day |
| Storage | ~1 GB/hour raw; ×3–5 for the encoding ladder | ~3 PB/day of encoded output (before dedup/cold tiering) |
| Views | 1 B hours watched/day, avg 3 Mbps | ~125 Tbps average egress → **must** be served by CDNs |

The numbers show why the CDN, not your origin, is the system.

## API

```http
POST /v1/videos                       → { video_id, upload_url (pre-signed, multipart) }
PUT  <upload_url>?partNumber=n        (direct to object storage)
POST /v1/videos/{id}/complete
GET  /v1/videos/{id}                  → metadata + status
GET  /v1/videos/{id}/manifest.m3u8    → HLS master playlist (signed CDN URLs)
```

## Data model

```text
videos      (video_id, owner_id, title, description, status[UPLOADING|PROCESSING|READY|FAILED],
             duration, created_at)
renditions  (video_id, resolution, codec, bitrate, manifest_path)
view_counts (video_id, count)  -- sharded counters, aggregated asynchronously
```

Metadata → relational DB (sharded by `video_id`) or a wide-column store; blobs → object storage.

## High-level design

### Upload & processing
1. Client asks the upload service for a **pre-signed multipart upload URL** and a `video_id` (row created as `UPLOADING`).
2. Client uploads chunks **directly to object storage** (no app servers in the byte path; resumable per part).
3. An `ObjectCreated` event enqueues a transcode job.
4. The **transcoding DAG** runs:
   - **Split** the video into GOP-aligned segments (a few seconds each).
   - **Encode** segments in parallel across many workers into a **bitrate ladder** (e.g. 240p → 4K; H.264, VP9/AV1).
   - Generate thumbnails, extract audio tracks, captions.
   - **Merge/package** into HLS/DASH segments + manifests.
5. Outputs land in object storage; metadata status → `READY`.

### Playback
1. Player requests metadata and the **manifest** (playback API checks auth/geo rights, signs URLs).
2. Player fetches 2–6 s **segments from the nearest CDN PoP**, choosing a rendition based on measured bandwidth and buffer level (ABR).
3. CDN misses pull from origin (object storage, often via a mid-tier shield cache).

## Deep dives

### Why split-and-parallelise transcoding?
A 2-hour 4K movie encoded serially could take hours. Splitting into segments and encoding in parallel on hundreds of workers turns it into minutes, and a failed segment can be retried alone.

### Adaptive bitrate streaming
- **HLS** (Apple) and **MPEG-DASH** break video into small segments at multiple bitrates, described by a manifest.
- The player switches renditions segment-by-segment — this is what avoids rebuffering on bad networks.
- **Per-title / per-shot encoding** chooses ladders per video complexity (cartoons need fewer bits than sports), saving 20–50 % bandwidth.

### CDN strategy
- Popular content: pre-position (push) at the edge; long tail: pull on demand.
- Large platforms place caches **inside ISPs** (e.g. Netflix Open Connect) to cut transit cost.
- Use origin shielding to avoid thundering herds on new releases.

### Cost optimisation
- Encode long-tail videos lazily or with fewer renditions; re-encode with better codecs once popular.
- Tier rarely watched originals and renditions to cold storage.

### View counting
Count at the edge/log level, stream into Kafka, aggregate in batches; approximate real-time counts are fine. Deduplicate views per session to limit abuse.

### Security / DRM
Signed, expiring URLs or cookies; DRM (Widevine, FairPlay, PlayReady) for premium content; geo-restriction at the playback API.

## Scaling & reliability

- Upload and playback APIs are stateless; processing is queue-driven and retryable (idempotent job IDs).
- Multi-CDN with health-based steering for resilience.
- Metadata read path is cached heavily; view counts are eventually consistent.

## Trade-offs

- **Segment length:** shorter = faster start and quicker bitrate switching, but more requests/overhead.
- **Codec choice:** AV1/VP9 save bandwidth but cost more CPU to encode and aren't supported everywhere — keep H.264 as a fallback.
- **Storage vs compute:** storing every rendition vs just-in-time packaging/transcoding for rare formats.
