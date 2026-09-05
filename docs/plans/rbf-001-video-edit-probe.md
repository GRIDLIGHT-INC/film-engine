# RBF-001 · Does `video-edit`'s `images_list` act as keyframes?

Task: GRD-3431 · Epic: GRD-3427 — Redo the video between two chosen frames
Date: 2026-09-05 · Evidence: `docs/plans/rbf-001-evidence/`

---

## Verdict

- **Verdict:** `style-references`

The two stills are composited **into the scene as reference imagery**, both
present simultaneously and for the whole clip. They are not honoured as a start
and an end frame.

## Request

One 480p generation to `seedance-2.5-video-edit-480p`, designed so the two
possible answers could not be confused: the stills were solid colour cards with
large text, so "keyframes" would open on pure red and end on pure blue, while
"style references" would leave Big Buck Bunny recognisable.

```json
{
  "prompt": "keep the scene exactly as it is",
  "video_url": "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4",
  "images_list": [
    "https://placehold.co/1280x720/FF0000/FFFFFF.png?text=START",
    "https://placehold.co/1280x720/0000FF/FFFFFF.png?text=END"
  ],
  "duration": 4
}
```

## Result

`completed` in ~176s. Output: `854x480`, **9.7 s**.

Both the first and the last frame show the source scene with **both cards
composited as background** — red START on the left, blue END on the right, the
tree and grass in front. Mean RGB of the first frame `132,72,87` and of the last
`124,78,89`: near-identical, so there is no red-to-blue transition. A keyframe
reading would have produced a near-pure `255,0,0` opening and `0,0,255` close.

Frames: `rbf-001-evidence/output-first-frame.png`, `output-last-frame.png`.

## Four other findings, none of them documented by the vendor

1. **`images_list` refuses data URIs.** `URL scheme should be 'http' or 'https'`.
   Entries must be fetchable by MuAPI. Film Engine serves media on **localhost
   only**, so any implementation must expose frames at a URL the provider can
   reach — a requirement the epic did not know about and which affects RBF-004
   and RBF-008.
2. **A minimum source size.** `video pixel count ... must be greater than or
   equal to 407696` (≈854×480). A 640×360 source was refused.
3. **`duration` is ignored.** 4 was requested; the output is 9.7 s, the source's
   own length.
4. **Billing follows the SOURCE length, not the requested duration**, and a
   FAILED job still billed.

## Spend

| | |
|---|---|
| Epic estimate | **$0.68** (4 s × $0.17) |
| Attempt 1 — 640×360 source, **failed** on the pixel floor | **$1.658** charged, `refunded: false` at submit; no refund reported on the result |
| Attempt 2 — 720p 10 s source, completed | **$1.547** |
| **Actual total** | **$3.205** — **4.7× the estimate** |

The estimate was wrong because it assumed the requested duration priced the job.
It does not: the source length does. Any future `video-edit` costing must price
the clip handed in, not the clip wanted back — and a failed request is not free.

## What this changes in the epic

**Approach B is dead.** The provider will not substitute a middle section for us,
so the splice is ours after all.

- **RBF-004** (`buildTrimArgs` + substitution splice) — **does not shrink**. Required in full.
- **RBF-006** (pure planner) — **does not shrink**. Required in full.
- **RBF-002** should record that the cross-clip and within-a-clip cases now share
  one implementation, since neither can be delegated to the provider.
- **New constraint for RBF-008:** frames must reach the provider as fetchable
  URLs. Either the repair uses `first-last-frame` with hosted stills, or the
  engine gains a way to expose a frame temporarily. This is not yet a task.
