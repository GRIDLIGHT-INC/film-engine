# Provider integration fixes

Five defects found while wiring MuAPI images and shooting the DRIVE-IN ident on
31 Aug 2026. Each one is stated with the evidence that produced it, because
three of the five present as something other than what they are.

Ordered by what costs the most when it goes wrong.

---

## 1. Async generations are abandoned by the host, not by the provider

**BLOCKING for the whole video stage.**

`lib/providers/seedance.js` polls for up to **fifteen minutes**:

```js
const POLL_TIMEOUT_MS = Number(process.env.SEEDANCE_POLL_TIMEOUT_MS || 900000);
```

A tool call through the MCP host is abandoned at **sixty seconds**. Any
generation still polling at that moment is not slow — it is LOST. The handler is
torn down mid-await, nothing is written to `film_assets`, and the caller is told:

```
Device 'mannys-mac-pro-local' did not respond within 60s.
```

Which reads like a connection fault. It is not. The provider very likely
finished the job and billed for it; the result had nowhere to be delivered.

Observed live: a MuAPI image generation with a 300s poll budget produced no
frame and no error after five minutes. The same shape applies to seedance video
at 480p and is far more expensive there — a 15s sequence clip is real money to
generate twice because the first result was thrown away.

**The fix is a job handle, not a longer timeout.** No poll budget can be both
longer than a 4K video render and shorter than the host's abort.

- POST the generation, persist `request_id` against the shot/scene with a
  `pending` asset row, and RETURN IMMEDIATELY.
- A second tool — `generation_collect` or similar — polls for a finished job and
  writes the asset when it lands.
- A generation whose handle is stored is never lost: the process can die, the
  host can abort, and the result is still collectable.

The `flow_run` / `flow_run_get` pair is the precedent already in this codebase
for a long job addressed by an id rather than held open on one call.

Until that exists, any adapter polling inline MUST keep its budget under the
host window. `muapi-image.js` is set to 48s for this reason and says so.

---

## 2. MuAPI rejects base64 reference images

`lib/providers/muapi-image.js` is written and works — the slug is right, the key
resolves, the body validates — except for reference images. MuAPI's validator:

```json
{"type":"url_too_long","loc":["body","images_list",0],
 "msg":"URL should have at most 2083 characters",
 "input":"data:image/jpeg;base64,/9j/4AAQ…"}
```

Two facts in one error: the field is **`images_list`**, not `image_urls`, and
the value must be a **fetchable URL** under 2083 characters.

This engine inlines every reference as a base64 data URI. Meshy accepts that;
MuAPI does not. References are not optional — they are the anchor system, which
is the whole mechanism keeping one shot continuous with the last.

**So MuAPI images need somewhere to host a reference**, and it cannot be
`localhost:3100`. Either MuAPI's own upload endpoint, or a short-lived signed
URL. Once that exists the adapter needs one rename and it works.

**Check seedance video for the same defect before queueing a sequence.** Its
dry run shows `init_image: "«image/png, 1360KB inline»"` — the same inlined
base64, to the same vendor that just rejected it. One cheap 480p clip answers
it. If it fails identically, reference hosting is a prerequisite for ALL video,
not a MuAPI-images nicety.

---

## 3. `prop_create` and `character_create` silently drop dimensions

`prop_create` accepted `height_m`, `width_m`, `length_m` and stored all three as
`null`. `prop_update` with the identical values persisted them correctly, so the
defect is in the create path only. `character_create` drops `height_m` the same
way.

Not cosmetic. The dimensions are what produce the scale clause in an image
prompt:

```
Scale: DRIVE-IN SPEAKER POST is roughly 1.7 times the size of a car tyre,
1.1m tall, 0.12m long, 0.55m wide
```

A subject created and never updated generates at whatever size the model
imagines, and nothing reports it. The tool description says these are "required
in practice" — which is true, and they were being thrown away.

---

## 4. A missing provider pin reroutes spend to another vendor in silence

`film_projects.provider_config` lost its `"image"` key mid-session. Nothing
failed and nothing was reported. Image generation fell through the resolution
order onto **Google**, billed against a personal Gemini key rather than the
Meshy account the project was configured for — discovered only when Google's
billing rejected it.

`resolveIdWithReason` already carries a `source` for exactly this
(`project` / `env` / `account_default` / `quality_tier` / preference walk). It
is computed and then discarded.

**Surface it.** When a generation resolves through anything other than an
explicit project pin, say so on the result and in the run plan: *"image →
google (account default; this project pins no image provider)."* The engine's
own comment predicted this failure and it happened anyway:

> the picker said every tier used Meshy while the project resolved to OpenAI,
> and both were telling the truth about different code.

`dry_run` reports the truth and costs nothing. Consider calling it as a
preflight on any batch that spends.

---

## 5. No runtime failover between configured providers

The ordered preference walk in `PREFERRED_WHEN_CONFIGURED` runs only when
nothing is pinned. Once an adapter is chosen it is chosen: a 429, a billing
rejection or a vendor outage fails the generation outright even when two other
credentialed adapters could serve it.

An afternoon was lost to one vendor's billing bug while two working image
providers sat in the registry.

For a studio billing clients per creative, a vendor outage should cost a
retry, not a job. Failover belongs in the same `resolve` path, on errors that
are clearly the provider's rather than the request's — 401, 402, 429, 5xx —
and never on a 400, which would just send a malformed request twice.

---

## Already fixed in the working tree, uncommitted

- `lib/providers/google-image.js` — `response_format.mime_type` was hard-coded
  `image/png`; Google now accepts only `image/jpeg`, so every image through that
  adapter 502'd. One word.
- `lib/providers/muapi-image.js` — new adapter, plus `muapi:image` in
  `lib/provider-pricing.js` and `muapi` in the image preference walk. Correct
  apart from item 2 above.
