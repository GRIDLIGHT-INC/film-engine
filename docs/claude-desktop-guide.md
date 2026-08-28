# Film Engine from Claude Desktop

**180 tools, 44 families.** Everything the app can do, you can ask for in a
conversation.

Held to the code by `backend/tests/mcp-guide.test.js`: if a tool is renamed or a
family added, that test fails rather than this page quietly going stale.

---

## Do I have to name the tools?

**No.** Say what you want in natural language and Claude picks the tool.

> *"Read the screenplay for Wingfall and tell me which scenes have no shots yet."*
> *"Add this chapter as scenes at the end."*
> *"Show me every attempt at shot 1B and put the third one back."*

You do not need to name a tool, ever. Claude chooses from the tool descriptions,
which say what each one is for, what it costs and what to read first.

Name one when you want *that one specifically* — usually because you already
know the answer and want to skip the model's search:

> *"Use shot_prompt on 2A"* rather than *"what would 2A send to the image model?"*

**Where naming genuinely helps:** when two tools do similar things and you care
which. `scene_update` replaces a whole scene; `scene_edit` changes named phrases
in place. Asking for "a small change" may get either; naming `scene_edit` gets
the surgical one.

---

## Connecting

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "film-engine": {
      "command": "node",
      "args": ["/Users/mannyhenri/code/film-engine/backend/mcp-server.js"],
      "env": { "FILM_DATA_DIR": "/Users/mannyhenri/.gridlight/film-engine/data" }
    }
  }
}
```

`FILM_DATA_DIR` must be the **same database the app uses**, or Claude will be
working on an empty project set while the UI shows your films. Restart Claude
Desktop after editing. The HTTP server does not need to be running for MCP to
work — they are two front doors onto one database — but run it if you want to
watch changes appear in the browser.

---

## The pipeline, in the order you do it

Each stage names the tools it uses; you can still just describe the goal.

### 1. Screenplay

`script_get` · `script_write` · `script_versions` · `script_stats` ·
`scene_append` · `scene_insert_after` · `scene_list` · `scene_get` ·
`scene_update` · `scene_edit` · `scene_delete` · `scene_history` ·
`scene_restore` ·
`scene_card_write` · `outline_get` · `outline_write` ·
`beats_get` · `beats_apply` · `beat_link` · `directives_get` ·
`directives_write` · `screenplay_drift` · `screenplay_baseline`

**Importing a novel chapter by chapter** is what `scene_append` exists for. Paste
or reference a chapter and ask Claude to convert it — *Claude* writes the
Fountain, because no tool here calls another language model. One call per
chapter, not per scene: it takes a fragment with several scene headings, and
everything above it stays byte-identical so no existing shot is marked stale.

`beats_get` reports the **holes** — beats with no scene against them. On a
forty-chapter adaptation that is the question worth asking.

### 2. Entities

`entities_create` · `character_create` · `character_update` · `character_list` ·
`character_delete` · `location_create` · `location_update` · `location_list` ·
`location_delete` · `prop_create` · `prop_update` · `prop_list` ·
`prop_delete` · `bible_get` · `bible_write` · `bible_delete` · `bible_drift` ·
`scale_check` · `production_describe`

Descriptions are **your** work: read the screenplay, write the appearance. An
entity with no description generates a bare name, which is how a character
becomes a different person in every frame.

`scale_check` finds subjects whose size is undeclared — an image model has no
metric sense, so a 30cm sprinkler comes back the size of a car.

### 3. Plates

A location plate is one side of a place. Every shot pointed the other way is
handed a picture of what is BEHIND its camera and invents the rest — which is
how a reverse angle acquires a road that is not there. `plate_compass` turns
the plate you have into all four sides, each a quarter turn from it, and a shot
then names the side it is looking at in its scene card's location_view field.
A sweep skips a side that already exists, so it is never paid for twice —
`plate_view_delete` is how you have a bad one re-shot. To keep a plate and
change one thing — wet the road, add fog, remove a parked car — use
`plate_refine`: it edits the picture you have rather than rolling a new one.

A plate does not have to be generated. `plate_upload` takes a picture made
outside Film Engine — a photograph of the real location, a render from Midjourney,
art the department already made — and puts it exactly where a generated plate
goes, for a character, a location, a prop or the mood board. It is free, and it
is not tracked against the subject's description, so editing that description
will never tell you to regenerate over a picture you supplied.

`plate_generate` · `plate_upload` · `plate_refine` · `plate_compass` ·
`storyboard_upload` · `previs_image_upload` · `model_upload` · `plate_view_list` · `plate_view_delete` · `plate_generate_all` · `consistency_create` ·
`consistency_lock` · `consistency_list` · `consistency_unlock` ·
`consistency_delete` · `mood_board_add` · `mood_board_compose` ·
`mood_board_list` · `mood_board_remove`

A plate is a reference photograph of one subject. Generating one does **not**
lock it — `consistency_lock` is the commitment generation conditions on.

**Costs money.**

### 4. Shots

`shot_create` · `shot_tag` · `shot_get` · `shot_update` · `shot_list` ·
`shot_delete` · `shot_prompt` · `shot_frames` · `shot_frame_restore` ·

`shot_review` hands you the pictures themselves — the board frame the director selected, plus frames sampled across the generated clip — so you can compare them and say what moved and by how much. Costs nothing, and nothing calls a server-side model to do it: you are the model. Read it after a clip comes back, before deciding whether to refine or regenerate.
`shot_annotate` · `card_vocabulary` · `breakdown_summary` · `elements_list` ·
`sides_report` · `dood_report` · `board_groups` · `setups`

There is deliberately **no breakdown tool** — composing a scene card is
reasoning, and you are talking to the model that does it. Read `card_vocabulary`
first so the card validates.

`shot_prompt` shows exactly what a frame would send, and **spends nothing**.

### 5. Storyboard

**You can board a film without spending a credit on images.** `storyboard_upload`
puts a frame you generated yourself onto a shot: read the card and its
references, make the picture, show it for approval, upload it. It becomes the
shot's current frame and the one it replaces is kept as a recoverable version.
Then `video_preview` shows exactly what a clip would cost before you buy one.

`storyboard_generate` · `storyboard_regenerate` · `storyboard_refine` ·
- `storyboard_recompose` — keep the PERFORMANCE from one frame and replace its BACKGROUND with a photographed view of the shot's location. Use it when the acting, framing and camera are right and the place behind them is wrong; `storyboard_refine` cannot, because its contract refuses composition changes and on a close-up the background is most of the composition. The background must be a view of that shot's own location — photograph the view you need first. Costs credits.
`anchor_get` · `anchor_set` · `anchor_clear` · `annotation_list` ·
`annotation_delete`

`continuity_upload` attaches a picture to a continuity reference — normally a
photograph of what was actually shot. It is a record for people to compare
against, **not** a generation reference: no prompt reads it. Use `plate_upload`
for a picture that should condition future frames.

**How good the frame needs to be is a choice, and it has a tool.** `quality_get`
reads the project's image quality tier and tells you what each tier would
actually use on this machine; `quality_set` changes it. Say what the work needs,
not which company makes the model:

- **draft** — cheap variations while you are still deciding a composition.
- **standard** — most storyboard frames.
- **precision** — a frame that has to hold an established location, a specific
  subject and a camera change all at once. Costs more per image and saves the
  retries.
- **auto** — lifts to precision by itself when a request carries several
  references or edits an existing frame.

Setting a tier changes what every *subsequent* frame generates on. It does not
regenerate anything already on the board, and it does not touch which provider
serves video, voice or 3D.

`storyboard_refine` keeps a picture and changes one thing about it;
`storyboard_regenerate` builds a new one from the card. `anchor_set` points at a
frame that has the scene right, and the next shots are generated **from** it.

**Costs money.**

### 6. Previs

`previs_get` · `previs_set` · `previs_solve` · `previs_from_card` ·
`previs_apply` · `previs_approve` · `previs_to_storyboard`

Block a shot in 3D — lens, height, distance, movement, named staging, direction,
background view and lighting — then `previs_apply` commits those staged choices
to the card. `previs_to_storyboard` returns the exact staged image payload and
states that it is unapplied; it generates nothing and spends nothing.

### 7. Video and audio

`node_gen_video` · `node_gen_voice` · `node_gen_music` · `node_gen_sfx` ·
`node_gen_ambient` · `node_gen_lipsync` · `node_gen_post` · `node_gen_image` ·
`node_gen_llm` · `node_gen_model3d` · `media_upload` · `media_kinds` ·
`sequence_create` · `sequence_list` · `sequence_plan` · `sequence_generate` ·
`sequence_generate_native` · `sequence_update` · `sequence_stitch` · `sequence_delete` · `video_preview`

Video, voice, music, SFX and ambient audio — each runs one generation in
isolation. **All cost money.**

None of it has to be generated here. `media_upload` takes a clip cut in another
tool, dialogue recorded properly, or a licensed music bed, and stores it exactly
where a generated file goes — so the timeline, the conform and the delivery
pick it up unchanged. `media_kinds` says what can be uploaded, what formats are
accepted, and whether each belongs to a shot or a scene. Both are free.

A single shot generates from one picture, so where it is going can only be
described in words. A **sequence** is several shots in play order with a
description true of all of them: each neighbouring pair becomes one clip that
starts on the first frame and ends on the second. `sequence_plan` is free and
states exactly how many generations it costs; a shot with no keyframe refuses
the whole sequence rather than being skipped. `sequence_stitch` then joins the
clips into one file — free, since it re-encodes footage already paid for.
Pass the segment_index argument to `sequence_generate` to buy and review one continuous
leg at a time. `sequence_generate_native` is a different Runway operation: one
3–5-shot clip with real editorial cuts, but less fidelity to individual boards.

### 8. Assembly and export

`node_out_assembly` · `node_out_timeline` · `node_out_asset` · `node_tf_mix` ·
`node_tf_stitch` · `node_tf_encode` · `node_tf_fanout` · `node_tf_select` ·
`node_in_prompt` · `node_in_asset` · `node_in_scene` · `node_in_subject` ·
`node_in_stock` · `run_plan` · `run_report`

`run_plan` orders the work to minimise model swaps and reports the cost
**before** anything generates.

### Running whole pipelines

`flow_list` · `flow_get` · `flow_create` · `flow_update` · `flow_delete` ·
`flow_validate` · `flow_estimate` · `flow_run` · `flow_run_get` ·
`flow_run_cancel` · `flow_run_branches` · `flow_run_select` ·
`flow_create_from_template` · `flow_templates` · `flow_node_types`

Validate before running, estimate before any fan-out. **`flow_run` costs money.**

### Keeping track

`project_list` · `project_get` · `project_create` · `project_update` ·
`project_delete` · `staleness_report` · `staleness_accept` · `impact_report` · `artefact_accept`

`impact_report` answers *what did that change break* — one edit, all the way
down, splitting **redo now** from **waiting on something above it**.

---

### Marketing

A poster, key art, a banner or a social card — the artwork that ships beside the
film. `marketing_create` plans one, `marketing_list` reads them.

Two ways to get the picture. **`marketing_upload` puts artwork you made
yourself onto it and costs nothing**, which is the usual path since this kind of
art is normally made in a design tool. Or generate it: `marketing_preview` shows
what would be sent and on which provider for free, then `marketing_generate`
buys it.

Generation appends the project's **style preset** after your prompt, so the art
looks like the film rather than like a different one. The preview says whether a
preset is set — without one, it will not match. Write the prompt as the
*subject*; the look is added for you.

`marketing_delete` removes the record and deliberately leaves the artwork file
on disk, because it cost money to make.

### Before you spend: the dry run

`dry_run` reports, for every capability the production uses, which provider and
model would run, **what the request is composed from**, the exact body the
provider would receive, and what it costs. It sends nothing and opens no socket.

It is built from the same construction path the real generations use and from
each adapter's own request builder, so it cannot drift from what is actually
sent. Credentials never appear in it and pictures are described rather than
printed — a reference is megabytes of base64, and a report nobody can read is
one nobody checks.

Use it to answer *what will this cost and what will it be asked for* before
committing to a run.

## What costs money

These resolve a provider and bill you:

`node_gen_llm` · `node_gen_image` · `node_gen_video` · `node_gen_voice` ·
`node_gen_music` · `node_gen_sfx` · `node_gen_ambient` · `node_gen_lipsync` ·
`node_gen_post` · `node_gen_model3d` · `storyboard_generate` ·
`storyboard_regenerate` · `storyboard_refine` · `plate_generate` ·
`plate_generate_all` · `flow_run`

**Free and worth reading first:** `shot_prompt` (what a frame would send),
`flow_estimate` (projected cost), `run_plan` (cost of a whole batch),
`beats_get`, `script_stats`, `scene_history`, `outline_get`, `shot_frames`.

### Telling it what the music should be

`music_cue_create` · `music_cue_list` · `music_cue_update` · `music_cue_delete`

A cue is the BRIEF for a piece of music, separate from generating it. What
reaches the generator: description, mood, genre, instruments, tempo, key and
reference_track. "notes" is production-facing and reaches nothing, so the brief
must not go there.

In description, say what the music DOES against the scene — "holds under the
dialogue, lifts when she stands, out on the door" — rather than only what it
sounds like; mood and genre already carry that. reference_track is sent as
"in the style of X", which is the clearest single note a director gives and was
stored and read by nothing until now.

OMIT duration_ms and the cue is scored to the MEASURED length of that scene's
footage. Set it only to run deliberately past or under the cut. Before this,
every cue was generated at a hardcoded thirty seconds.

`music_cue_update` merges, so refining one sentence cannot clear the
instruments. Deleting a cue keeps any audio generated from it — that is an
asset on the scene and cost money to make.

### Your own shots, kept across every film

`stylebook_list` · `stylebook_get` · `stylebook_create` · `stylebook_update` ·
`stylebook_delete` · `stylebook_apply`

The style book is the director's, not a project's: an entry with scope
"library" is visible from every film and accumulates into a directing style,
while scope "project" is a variant specific to one. `stylebook_create` takes
the SAME camera facets a scene card carries — shot_type, movement, lens,
sensor, aperture, focus_distance_m, height_m, note — and every one is
optional, so "85mm, that is all I know" is a legitimate entry. **height_m** is
worth setting whenever the angle is the point: it is what makes a shot read as
low or high, and nothing else expresses it.

`stylebook_apply` is the one that matters. It MERGES an entry's facets onto a
shot's scene card, which is already what the image and video prompt builders
read — so a favourite angle reaches the next generation with nothing else to
change. The card's description, dialogue and cast survive untouched, a facet
the entry says nothing about is left alone, and the response names what it
applied and what it skipped. Regenerate the frame afterwards to see it.

A stage pose (position, rotation) is deliberately NOT carried: six degrees
of freedom in one previs stage's coordinates put the camera somewhere else
entirely in another scene.

Visuals attached to an entry are reference for a person. A style still is the
lowest-ranked reference kind and is dropped before the request is built on any
shot with a cast and a location; a clip reaches no generator at all.

### What it actually cost

`spend_report` · `spend_usage` · `spend_backfill` · `spend_rates` · `spend_compare`

Every provider call is metered automatically — nothing to enter by hand.
`spend_report` gives dollars *and* the provider's own units (credits at Meshy
and Runway, characters and seconds at ElevenLabs, tokens at Anthropic), broken
down by capability, provider, model, day and shot, with cost per minute of
footage. `spend_usage` is the raw meter, one row per call, for when you want to
know *why* a number is what it is.

`spend_rates` shows where every price comes from, with the source URL and the
date it was checked. Meshy publishes what an operation costs in credits and not
what a credit costs, so its dollar figure is the Pro-plan rate — correct it for
your plan and past events keep the rate they were priced at.

`spend_compare` answers the question you have BEFORE generating: which
generator should I use. Every image or video model, priced against one unit of
real work — a frame, a clip — and against a scene of them. That conversion is
the point: the providers do not bill in the same unit (Runway and OpenAI per
image, Meshy per call, BFL per megapixel, video per second), so a raw rate
cannot be ranked. Pass `project_id` to price the per-megapixel providers
against your film's actual delivery frame. Uncredentialed providers are listed
and marked rather than hidden, because "this one is half the price if you sign
up" is part of the decision. Cheapest is not best — each row carries the tier
it serves, and a draft model exists to be rolled repeatedly while a precision
one exists to be right once.

`spend_backfill` reconstructs what a project spent *before* metering existed, by
pricing the assets already on record. It is a floor: a generation that failed
cost money and left nothing to count. Everything it writes is flagged as an
estimate and totalled separately from measured spend.

**The LLM is not in these numbers, and that is deliberate.** You are reading this
in Claude Desktop, which means the model is *already here* — nothing calls an
LLM API, so nothing is billed per token. Token traffic is still counted, against
the rolling 5-hour and weekly windows your plan is enforced in. No percentage is
shown until you calibrate it: Anthropic publishes plan multipliers and no token
count for any plan, and a bar drawn against a made-up ceiling would get planned
around.

Ask Claude to check before generating at volume — *"estimate this before you run
it"* works.

---

## Two things that surprise people

**No tool calls another language model.** The reasoning — writing a scene, a
description, a card — is yours, done in the conversation. That is why there is
no `breakdown` or `convert` tool: they existed, called a server-side model, and
were removed. Doing it in the conversation is also better, because you have the
whole revision in context rather than one scene of it.

**A locked profile is what generation uses.** `consistency_create` makes a
profile and `consistency_lock` commits it. A draft profile reaches nothing, and
"I created a profile" looks identical to "the subject is now consistent" from
the outside.
