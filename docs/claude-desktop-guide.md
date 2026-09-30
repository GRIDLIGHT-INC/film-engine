# Film Engine from Claude Desktop

**417 tools, 83 families.** Everything the app can do, you can ask for in a
conversation.

Held to the code by `backend/tests/mcp-guide.test.js`: if a tool is renamed or a
family added, that test fails rather than this page quietly going stale.

---

## If Claude says a tool does not exist

**Restart Claude Desktop.** Quit it fully and reopen it.

Claude Desktop starts the Film Engine MCP server once, when the app launches,
and the list of tools that connection can see is fixed at that moment. A tool
shipped afterwards is invisible to that conversation — and invisible in a way
that looks exactly like it was never built. Asked to use `analysis_brief`, a
connected model checked the name, searched the catalogue by keyword, re-queried
the server, correctly found nothing, and offered to design the pair that already
existed. Every step of that reasoning was right; the tool list it was reading
was nineteen hours old.

Nothing inside the tool list can warn you about this, because a stale connection
serves a stale list — a diagnostic tool would be missing from exactly the
connections that need it. Two things do reach it:

- **`initialize`** reports the build, e.g. `1.0.1+375tools.2026-09-27T12:00:00Z`.
  That timestamp is when the connection's server process started.
- **Calling a tool this build does not have** returns an error that names the
  tools on disk it is missing and tells you to reconnect.

If a restart does not fix it, the tool genuinely is not built.

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
      "args": ["/ABSOLUTE/PATH/TO/film-engine/backend/mcp-server.js"],
      "env": { "FILM_DATA_DIR": "/Users/YOU/.gridlight/film-engine/data" }
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
`directives_write` · `screenplay_drift` · `screenplay_drift_accept` · `screenplay_baseline` ·
`shots_resync` · `shot_audit` ·
`treatment_get` · `treatment_write` · `treatment_versions` · `treatment_delete` ·
`analysis_brief` · `analysis_write` · `analysis_get` · `analysis_delete` ·
`script_timing`

**Start with a treatment if the story is not written yet.** `treatment_write`
takes prose — what happens, in order, no dialogue and no format. Then ask Claude
to draft the screenplay from it: it reads the treatment, writes the Fountain
itself, and saves it with `script_write`. The engine never generates the
screenplay for you, which is the same rule everywhere here — the model you are
talking to is the one that writes.

**Reading the script** is a pair of tools, not one. `analysis_brief` hands over
the screenplay, a thirteen-dimension rubric merged from the Academy Nicholl
scoring rubric and the Sundance curriculum, the output schema, and the
mechanical findings the engine already computed — malformed sluglines, dense
action blocks, characters whose names differ by one letter. **You** do the
reading; `analysis_write` stores it.

The rule the schema enforces is *diagnose before prescribing*. Every note
carries evidence, the effect on a reader, a question that lets the writer test
their own intent, and strategies — never drafted lines. An overall score is
refused outright: a number gets quoted without the reasoning that produced it.
Rewritten dialogue is refused too, and that one is practical as well as
creative — the Nicholl rules prohibit AI-written dialogue, characters and scene
description, so a tool that quietly rewrites your work can disqualify the
screenplay it was helping.

**Scoring a scene** starts with `music_brief`, which is free: it hands you the
heading, what happens, who is in it, how many lines of dialogue, how many shots,
the film's look, and the real length of the cut — and returns no conclusion,
because what a scene should sound like is your judgement. Store it with
`music_cue_create`; a cue you write always beats the derivation. Watch the
dialogue count: a wall-to-wall dialogue scene wants sparse underscore that never
becomes melodic.

**`script_timing` gives three numbers per scene and keeps them apart.** How much
page it occupies (`4/8`, the way a stripboard writes it), how long it is likely
to play as a range with a confidence, and how hard it is to *shoot* — which is
independent of both. `The bridge explodes.` is an eighth of a page and can eat a
shooting day. Where the one-page-one-minute rule disagrees with what the scene
actually contains, the scene says so rather than the two being averaged into a
single number that hides which method produced it.

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

**Casting a voice, and hearing a line.** `voice_catalogue` lists what the
account can use — gender, age, accent, and a preview the provider hosts, free
to play. `voice_cast` gives a character a voice, which every line of theirs is
then spoken in. `casting_report` says who is still uncast, ordered by how many
lines they have.

`voice_audition` speaks one line **attached to nothing** — no shot, no asset —
so a reading you were trying out can never be mistaken for the take that ships.
`table_read` does a whole scene, each character in their cast voice, before the
breakdown. Both have free previews: `voice_audition_preview` and
`table_read_get`.

`voice_generate` makes the take that ships: every line on one shot's card, in
each character's cast voice, stored as that shot's dialogue for playback, the
NLE sound lanes and the conform. An unchanged line is reused rather than bought
again; pass `regenerate` for a new take of every line.

An uncast character is not an error: their lines generate in the provider's
default voice, which sounds like a decision rather than an omission. Cast
everyone who speaks.

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

A location also carries an ORIENTATION PLAN — which way is north, what stands
against each wall, where the camera can and cannot go. It is what keeps the
geography consistent between one plate and the next, so a reverse angle puts
the door where the first plate put it. `orientation_plan_brief` is FREE and
hands over what the plan would be written from: the location's description,
its existing views, and the scenes shot there. You write the plan; nothing
here asks a server-side model to write it for you, because you are the model
this engine is connected to. `orientation_plan_update` records what you
decided, and `orientation_plan_upload` puts the PNG/JPEG you generated into
that same section without calling a server-side model.

The plan is prose and geometry, not a picture — and a director can also upload
a hand-drawn one, which is stored beside it rather than instead of it. An
uploaded plan is deliberately NOT a plate: it is never attached to a shot as a
reference, because a floor diagram conditioning every frame of a location is
exactly the failure it exists to prevent.

`orientation_plan_brief` · `orientation_plan_update` · `orientation_plan_upload` ·


`refsheet_orbit` builds a character turnaround from ONE orbiting clip and cuts it into five views — front, three-quarter, profile, back three-quarter, back. Frames of one motion cannot disagree with each other the way three separately generated plates can. It SPENDS CREDITS (~25 for a 5-second orbit, against roughly 45 for three plates); read `refsheet_orbit_preview` first, which is free. It is a bootstrap: it will not replace an approved front anchor, and says which views it left alone.
`storyboard_upload` · `previs_image_upload` · `model_upload` · `plate_consistency` · `plate_view_list` · `plate_view_delete` · `plate_generate_all` · `consistency_create` ·
`consistency_lock` · `consistency_list` · `consistency_unlock` ·
`consistency_delete` · `mood_board_add` · `mood_board_compose` ·
`mood_board_list` · `mood_board_remove`

A plate is a reference photograph of one subject. Generating one does **not**
lock it — `consistency_lock` is the commitment generation conditions on.

**Costs money.**

**A subject is a workspace, not a form.** `gallery_get` shows every picture of a
character, location or prop with what it *is*: **reference** (the approved
plate — the only thing that conditions a frame), **concept** (an exploration,
kept and comparable), **inspiration** (gathered rather than made).

`gallery_explore` generates several looks at once as concepts — *"try MAYA
older and scarred"* — and the approved plate is untouched until you
`gallery_promote` one. `gallery_explore_preview` shows what it would send and
whether the provider will even honour the resolution, and costs nothing.

`gallery_inspire` keeps a still or a link with the subject. It reaches **no**
prompt: it is usually somebody else's image, and sending it to a provider is a
different act from looking at it — promoting one has to be asked for explicitly.
`gallery_remove` takes a picture out; the bytes move to a `deleted/` folder
rather than being destroyed, because a generated plate cost money.

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
Then `video_preview` shows exactly what a clip would cost before you buy one, and
`video_generate` buys it — one clip for one shot, from its selected frame.
The preview's options.controls are what that model lets you choose, read from
the provider's own schema: length, frame, resolution, sound, the shot whose
frame the clip ends on (last_frame), output format (Gen-4.5's HDR formats),
seed. Pass the same options object to both tools; a value the model does not
take is refused by name and nothing is sent.

On a project whose video runs on the Gridlight gateway, read
`gridlight_video_capabilities` first. It is free and reads the gateway's own
manifest: which models are up, and which references each takes (keyframes,
clips, characters, locations, props, a transform), how many, and where. A
reference the chosen model does not take is dropped and reported, never sent
for a 422. A 503 means the GPU box is off, which is a normal state.

`storyboard_generate` · `storyboard_regenerate` · `storyboard_refine` ·
- `storyboard_angles_preview` · `storyboard_angles` · `storyboard_angles_list` · `storyboard_angles_pick` — explore FOUR ANGLES on one shot: four separate Nano Banana Pro images, one camera each, at the project's resolution, joined into a contact sheet. Nothing replaces the frame until you pick one ("use B"), which makes it a new version on the board. The preview is free and shows the four prompts; the exploration costs four images.
- `storyboard_recompose` — keep the PERFORMANCE from one frame and replace its BACKGROUND with a photographed view of the shot's location. Use it when the acting, framing and camera are right and the place behind them is wrong; `storyboard_refine` cannot, because its contract refuses composition changes and on a close-up the background is most of the composition. The background must be a view of that shot's own location — photograph the view you need first. Costs credits.
`anchor_get` · `anchor_set` · `anchor_clear` · `annotation_list` ·
`annotation_delete`

`continuity_upload` attaches a picture to a continuity reference — normally a
photograph of what was actually shot. It is a record for people to compare
against, **not** a generation reference: no prompt reads it. Use `plate_upload`
for a picture that should condition future frames.

`world_capture_upload` attaches a **capture of the real place** to a location:
the environment itself, shot rather than imagined. One tool takes all three
media a capture arrives as — a 360 panorama, a short orbit clip, or a LiDAR
scan — and **which one it is comes from the bytes, not the filename**, because
a phone names a clip `IMG_0431.MOV` and a still `IMG_0430.HEIC`. The response
reports **capture_kind** so you know which medium was recognised.

This is what a world is reconstructed **from**, and it is deliberately not a
plate: a plate is one picture this engine generated, a capture is evidence of
somewhere that exists. World Labs' own documentation calls a panorama the most
accurate spatial representation, which is why it is the default medium. Use
`plate_upload` if you want a reference picture instead.

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
`previs_apply` · `previs_approve` · `previs_lock` · `previs_unlock` ·
`previs_to_storyboard` · `shot_motion` · `previs_stage` · `previs_library`

`previs_library` lists the free people (a man, a woman, a boy, a girl) and 140
low-poly furniture pieces, each at its real size; `previs_stage` places, moves,
turns or removes them, or one of the project's own 3D models such as a Meshy
creature, and keeps the camera exactly as it was. Both are free.

Block a shot in 3D — lens, height, distance, movement, named staging, direction,
background view and lighting — then `previs_apply` commits those staged choices
to the card. `previs_lock` then locks decisions one at a time (camera, direction,
lighting, set view, cast, props, move) — only an applied decision can be locked,
and a locked one that changes reads as stale; `all: true` locks the whole shot and
approves it. `previs_to_storyboard` returns the exact staged image payload and
states that it is unapplied; it generates nothing and spends nothing.

`shot_motion` is the move as it will actually PLAY over the shot's storyboard
frame: the transform track playback uses, computed from the blocking if the shot
has any and from the movement written on its card if it does not. It also says
what showing it costs — `magnification` (a travelling move has to push into the
frame to have room), `carried` (false when the move is bigger than a still can
honestly show), `perceptible` (false when the move is real but will not read at
this framing). A still holds no parallax: the subject comes out right and the
background travels with it. Free.

### 7. Video and audio

`node_gen_video` · `node_gen_voice` · `node_gen_music` · `node_gen_sfx` ·
`node_gen_ambient` · `node_gen_lipsync` · `node_gen_post` · `node_gen_image` ·
`node_gen_llm` · `node_gen_model3d` · `media_upload` · `media_kinds` ·
`sequence_create` · `sequence_list` · `sequence_plan` · `sequence_generate` ·
`sequence_plan_inbetweens` · `sequence_inbetweens` · `sequence_station_list` ·
`sequence_station_update` · `sequence_station_delete` · `sequence_inbetweens_approve` ·
`sequence_generate_native` · `sequence_update` · `sequence_stitch` · `sequence_delete` · `video_preview` ·
`video_background_preview` · `video_background_replace` · `shot_upscale_preview` · `shot_upscale`

**Bring a clip up to the delivery size.** `shot_upscale_preview` is free: it
measures the shot's selected clip (or `asset_id`), and names the factor or tier
the upscaler picks to reach the project's resolution, and the price.
`shot_upscale` uploads the clip to MuAPI, runs the named upscaler
(`topaz-video-upscale`, `ai-video-upscaler`, `ai-video-upscaler-pro` or
`flux-3-video-upscaler`), and keeps the result as a new version that becomes the
selected clip, with its sound. The original stays. On the production canvas
the same thing is **Upscale…** in the node menu of a shot or a shot's clip.

**Your own recorded dialogue in the clip.** Upload each line to the shot with
`media_upload` (capability `voice`), then pass `use_dialogue_audio: true` to
`video_preview` and `video_generate`. The shot's lines travel in the order they
are said, as audio references, to Seedance 2.5: the audio list on MuAPI, where
the shot runs the omni-reference workflow and the storyboard frame becomes a
reference rather than the exact first frame; or Runway's reference audio with
`video_model: seedance2_5`. The preview says how many lines would go, or why
none can: a model that takes no audio is named rather than ignored.

**Keep the actor, change the background.** Every other generator here makes a
NEW picture; `video_background_replace` takes footage that already exists and
changes one thing about it — the performance is preserved by the model rather
than by a matte, so describe the PLACE and nothing else. Naming the people is
what makes it re-render them. `video_background_preview` prices it for free
first, and the price is the length of the clip handed IN rather than anything
asked for: a 20-second take costs twice a 10-second one for the same edit, so
trimming the source is what makes it cheaper. The result lands as a NEW version
and the take being edited survives.

**The in-between strip.** A shot reaches a video model as ONE picture and a
sentence, so on a five-second push-in seconds two, three and four are the
model's opinion — and the model's opinion is what drifts. `sequence_plan_inbetweens`
is free and shows the shot as a station per second, derived from its own camera
blocking: how many stations, how many need generating, and what that costs.
`sequence_inbetweens` generates them, each refined **from the one before it** —
independently generated stations would be N rolls of the dice and would
reinvent the drift the strip removes. `sequence_station_list` reads the strip,
`sequence_station_update` redoes one station **and everything after it** (a
chain re-inherits from the frame that changed), and `sequence_inbetweens_approve`
signs it off so video generation refuses if the strip changes afterwards.

A shot whose move will not READ contributes exactly one station and costs
nothing, which is today's behaviour unchanged.

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
`run_plan` · `run_report` · `conform_plan` · `conform_run` · `delivery_check` · `export_preflight` · `export_package` ·
`export_premiere_scenes_plan` · `export_premiere_scenes` ·
`deliverable_list` · `deliverable_plan` · `deliverable_create` · `deliverable_update` ·
`deliverable_delete` · `deliverable_check` · `brand_list` · `brand_get` ·
`brand_create` · `brand_update` · `brand_delete` · `claim_list` · `claim_create` ·
`claim_update` · `claim_delete` · `compliance_check`

`delivery_check` is free: it measures every shot's SELECTED clip, from the
file, against the project's delivery size, and names each one below it with
its fix (the upscale). Every generator is asked for the delivery size; one that
cannot reach it renders its best, and the video preview's `delivery` block says
so before anything is bought.

`export_premiere_scenes` writes the Premiere handover with one folder per
scene: `Scene_NN_<heading>/Video` holds each shot's selected clip named by shot
code, `Sound` its dialogue, effects and the scene's beds, and the XML carries
the cut plus a bin per scene. `export_premiere_scenes_plan` says what it would
copy and what is missing, for free. Every NLE export now plays the selected
clip, the same rule as the master.

**Before you spend on a spot, read `compliance_check`.** It is free, and it is
where an automated pipeline gets a client sued: it catches a phrase the brand
forbids, an objective claim with no substantiated row, a generated performer
presented as a real customer, and a right that is uncleared or expired. Errors
block `run_plan`; warnings do not. Only a **substantiated** claim row clears a
claim — a row that merely exists is a record, not evidence.

A brand kit outlives a project. Only its **tone** and **palette** reach a
generation; the CTA, the legal line and the fonts are words and type placed in
Premiere, because asking a diffusion model for legible text bakes a smudge into
a frame you paid for.

**A commercial is a fan-out, not a short film.** A film has one shape; a spot
resolves to fourteen to twenty-two files. `deliverable_plan` applies a package
(rapid, campaign, broadcast) and writes one row per file — and the set is decided
**before anything is boarded**, because it is what says which ratios must be
SHOT rather than cropped. A 9:16 crop of a 16:9 frame keeps 32% of its width, and
no reframing tool can invent the two-thirds that were never generated.

`deliverable_check` is free and carries the actionable line: **needs native
shots** means a vertical placement exists with no shot flagged for it, so every vertical
file will be a crop of the master — invisible until the client sees the cut.

`run_plan` orders the work to minimise model swaps and reports the cost
**before** anything generates.

**The film is one file, and `conform_run` is what makes it.** Every shot's best
cut — graded over synced over raw — joined in running order, with the project
audio mix laid under it when one exists and the clips' own sound when it does
not, registered as the project master and served at the `url` it returns. It
spends no provider credits (local ffmpeg does the work) and it REFUSES rather
than shortens: a shot with no footage stops the conform and is named, because a
film missing shot 7 plays fine and is wrong. `conform_plan` is free and shows
all of that first. Conforming again replaces the previous master; nothing
accumulates.

**Read `export_preflight` before you hand anyone an export.** It is free, and it
catches the failure that looks most like success: a perfectly well-formed
timeline file describing **nothing**, because no shot has a duration and every
format refuses a zero-length clip. It also names the shots that will not appear
at all — a film with thirteen shots and two of them shot exports two clips and
says nothing about the other eleven.

`export_package` writes the XML **and the media it names** into one folder with
the paths rewritten. An ordinary export references media by absolute path, so
handed to an editor on another machine it opens with every clip offline: the
cuts are right and there is no picture. It copies rather than moves, and it
refuses exactly what the preflight blocks.

### Running whole pipelines

`flow_list` · `flow_get` · `flow_create` · `flow_update` · `flow_delete` ·
`flow_validate` · `flow_estimate` · `flow_run` · `flow_run_get` ·
`flow_run_cancel` · `flow_run_branches` · `flow_run_select` ·
`flow_create_from_template` · `flow_templates` · `flow_node_types` ·
`flow_apply_plan` · `flow_apply` · `flow_apply_get` · `flow_form`

Validate before running, estimate before any fan-out. **`flow_run` costs money.**
To apply one flow to several shots, `flow_apply_plan` (free) takes the
Production graph's node keys, binds each shot's inputs, prices every run and
answers the budget; a sequence expands to its shots.
`flow_apply` takes that plan's fingerprint and starts one run per shot —
**it costs money** — and is refused if the plan moved since you read it;
`flow_apply_get` shows its runs. A flow whose input nodes are marked exposed has
a form: `flow_form` (free) lists them as fields — a prompt's text, an asset,
a subject — and their values go to both calls as `inputs`.

What an applied flow makes stays a **candidate** on its shot (a flow version on
`production_graph_get`) and replaces nothing. When a run stops at a "pick one"
step, `flow_apply_get` shows it `paused` and `generation_queue` lists it under
`paused`. Read its variations with `flow_run_branches`, then `flow_run_select`
with the branch key you want: that variation becomes the shot's frame, clip or sound,
and the run finishes from there without generating anything again.
`flow_run_cancel` ends a run and keeps what it made. `asset_provenance` on a
flow's output names the flow, the node, the run and the apply.

### Keeping track

`project_list` · `project_get` · `project_create` · `project_update` ·
`project_delete` · `staleness_report` · `staleness_accept` · `impact_report` · `artefact_accept`

`impact_report` answers *what did that change break* — one edit, all the way
down, splitting **redo now** from **waiting on something above it**.

### Where the files are

`storage_suggest` · `storage_layout` · `storage_browse` · `project_storage_get` ·
`project_storage_move`

Every film has one folder, laid out in the order the film is made
(`01 References` … `06 Delivery`). **Ask where to save before `project_create`**:
`storage_suggest` shows the folder a title would get, free, and `project_create`
takes a parent folder (make the film's folder inside this one) or an exact folder
(exactly this folder). `project_storage_get` reports what is in each sub-folder.
`project_storage_move` moves every file and repoints every record. It spends
nothing, but it changes where the person finds their work, so confirm the
destination first. A project made before folders existed moves into one the
same way.

`backup_folder_status` · `backup_folder_set` · `backup_folder_run`

Each person backs up to a folder they choose (`backup_folder_set`, e.g. a
Dropbox or Google Drive folder), every six hours unless told otherwise. A
backup is a consistent snapshot of the whole database, written into
`Film Engine Backups/<user>@<machine>` so people sharing one folder never
overwrite each other. `backup_folder_status` is free and carries the restore
steps; `backup_folder_run` writes one now. Media is not in the snapshot: it
lives in each project's own folder.

### Bringing an edit back from Premiere

`edit_list` · `edit_get` · `edit_import` · `edit_cut_import` · `edit_cut_rematch` ·
`edit_update` · `edit_delete`

Export the cut from Premiere and import it with `edit_import`: every import is
the next version (nothing is overwritten), kept in the project's "05 Edit"
folder. Add the Final Cut Pro XML or EDL it was exported with (`edit_cut_import`,
or in the same call) and the cut is read into which Film Engine shot plays
where, matched by clip file or shot code; titles and stock are kept and named.
To score the cut, create the session with an edit id on `music_session_create`: the
brief follows the edit, the session is the edit's length, and the stems line up
at 00:00 of the Premiere sequence. A newer edit version is reported on the
session and moved to only when you say so.

---

### When a generation takes longer than I do

`generation_pending` · `generation_collect`

A tool call is abandoned by the agent host at **sixty seconds**, and a clip or a
4K mesh routinely takes longer. That does not mean it failed: the provider
accepted the job, is still working, and is already billing for it. What used to
happen then is that the result had nowhere to be delivered and the call came
back as *"the device did not respond"* — which reads like a connection fault, so
the natural next move was to generate the same thing again and pay twice.

Every asynchronous provider now hands back a **handle** the moment it accepts a
job, and that handle is written down before any waiting starts. So:

- a long generation returns *"still running, collect it with `generation_collect`"*
- `generation_pending` lists everything outstanding for a project
- `generation_collect` delivers one, and is **free** — it polls work already
  paid for, never starts anything new

Collecting is safe to repeat. A job that has not finished answers *"not yet"*
and stays collectable; a job already delivered says so rather than being
delivered twice.

**Check `generation_pending` before re-running a generation that seemed to
fail.** It is the difference between collecting a clip you have bought and
buying it again.

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
`node_gen_post` · `node_gen_model3d` · `node_gen_world` · `world_generate` ·
`storyboard_generate` ·
`storyboard_regenerate` · `storyboard_refine` · `plate_generate` ·
`plate_generate_all` · `flow_run` · `run_changed` · `run_to_here`

**Free and worth reading first:** `shot_prompt` (what a frame would send),
`flow_estimate` (projected cost), `run_plan` (cost of a whole batch), `conform_plan`,
`beats_get`, `script_stats`, `scene_history`, `outline_get`, `shot_frames`.

### Telling it what the music should be

`music_cue_create` · `music_cue_list` · `music_cue_update` · `music_cue_delete` ·
`music_cue_generate`

A cue is the BRIEF for a piece of music, separate from generating it. What
reaches the generator: description, mood, genre, instruments, tempo, key and
reference_track. "notes" is production-facing and reaches nothing, so the brief
must not go there.

In description, say what the music DOES against the scene — "holds under the
dialogue, lifts when she stands, out on the door" — rather than only what it
sounds like; mood and genre already carry that. reference_track is sent as
"in the style of X", which is the clearest single note a director gives and was
stored and read by nothing until now.

**`music_cue_generate` is what plays it.** It takes a **cue id**, not a scene:
a scene holds a score, a room tone and effects at once, and anything addressed
by scene has to guess which you meant. It reads your cue, generates it, stores
it as an asset and links the asset back to the cue.

**Do not reach for `node_gen_music`.** That is a graph node: it derives its own
prompt from the scene and never reads your cue, so a written orchestral score
comes back as a scene-derived bed. Run alone it also stores nothing — the audio
arrives in the tool result and no asset row is written.

An **SFX cue** is refused here on purpose and tells you where to go: effects are
built from a shot's scene card, through `POST /film/shots/:id/sfx/generate`.

OMIT duration_ms and the cue is scored to the MEASURED length of that scene's
footage. Set it only to run deliberately past or under the cut. Before this,
every cue was generated at a hardcoded thirty seconds.

`music_cue_update` merges, so refining one sentence cannot clear the
instruments. Deleting a cue keeps any audio generated from it — that is an
asset on the scene and cost money to make.

### Playing a part on the director's own instruments

`instrument_catalogue` · `instrument_list` · `instrument_get` · `instrument_scan` ·
`instrument_update` · `instrument_delete` · `music_track_render` ·
`music_midi_render_part`

**Start with `instrument_catalogue`.** It reads the director's own Kontakt index
live — every sound they own, by name, library and tag ("cello", "Ethereal
Earth", "metallic") — and stores nothing. That is how you choose a sound: find
it there, and the capture that follows records its real name, library, vendor
and source file rather than something typed.

The director owns 248 sample libraries. An **instrument** is one sound out of
one of them: a plugin plus the patch that recalls it — and Film Engine's own
library holds only the sounds that have actually been used, never a copy of
somebody's collection. `instrument_list` is how
you find one — search by name, library, vendor or tag — and an instrument marked
unavailable has lost its plugin or its patch and will not play.

**A composition is built on the SCORE, not on a cue.** `music_track_update`
gives a lane its own part and its own instrument — `notes: { program, notes:
[{ start_ms, duration_ms, pitch, velocity }] }` in milliseconds, and an
`instrument_id` from `instrument_list` — and `music_track_render` plays it into
that lane. That is the loop: write a melody, choose one of their sounds, play
it, listen, write the next lane. Nothing is billed; it runs on their machine.

On a lane that already holds a take the new one arrives as a **candidate**, so
what is playing keeps playing until somebody selects it — never say a take was
replaced. A render that comes back silent is refused rather than kept, because
that is what a plugin with no patch loaded produces, and every refusal names its
stage.

`music_midi_render_part` is the same thing for ONE part of a music CUE, when the
work is a single cue rather than a composition: write the parts with
`music_midi_write`, give each one an instrument, render them, and the cue exists
part by part — no ElevenLabs and no DAW.

`instrument_scan` indexes the NKS presets the installed libraries ship, so their
sounds can be chosen by name. It copies nothing. A library that is not NKS-ready
ships no preset and is reported: those patches are captured from the plugin
instead, by a person, once.

### Writing the notes, and playing a part yourself

`music_midi_get` · `music_midi_write` · `music_midi_import_part` · `music_midi_delete` ·
`music_midi_render_plan` · `music_midi_render`

A cue can carry NOTES as well as audio: a Standard MIDI File with one track per
part, which Ableton opens as separate instruments. You compose them; nothing
here calls a model and nothing spends money. Read `music_brief` for what the
scene is and `music_midi_get` for the contract — the cue’s length in
milliseconds, the one-frame tolerance and the 128 General MIDI programs.

Write **parts over a harmonic plan**, not a whole cue at once: fix the tempo,
meter, key, chord changes and sections first, then one part per instrument
against those chords. Everything is in **milliseconds from the start of the
cue**, never beats, because the cut is in milliseconds. A note that ends past
the cue is refused, naming the part and the note.

**The director plays melodies.** A .mid they performed arrives through
`music_midi_import_part` onto one named part, which replaces only that part and
keeps the original file. Your next `music_midi_write` keeps a played part as it
is unless you name it in replace_performed — so when a tune has been played,
write the harmony around it rather than over it.

**Hearing it.** `music_midi_render` plays the notes through a SoundFont installed on
this machine (FluidSynth) into a WAV exactly the cue’s length and makes it the
cue’s audio. It is free and nothing is billed. `music_midi_render_plan` says
first which library and licence it would use and what is missing. A silent
render is refused rather than kept, and the library’s licence is recorded on
the file.

### Scoring the picture

`music_session_list` · `music_session_create` · `music_session_get` ·
`music_session_brief` · `music_session_drift` · `music_session_update` ·
`music_session_delete` · `music_session_rebase` · `music_session_batch` ·
`music_track_list` · `music_track_create` · `music_track_update` · `music_track_delete` ·
`music_clip_list` · `music_clip_create` · `music_clip_update` · `music_clip_delete` ·
`music_marker_list` · `music_marker_create` · `music_marker_update` · `music_marker_delete` ·
`music_emotion_list` · `music_emotion_create` · `music_emotion_update` · `music_emotion_delete` ·
`music_automation_list` · `music_automation_create` · `music_automation_update` · `music_automation_delete` ·
`music_stem_import` · `music_bounce_plan` · `music_bounce` · `music_bounce_list` · `music_capabilities` ·
`music_emotion_brief` · `music_emotion_propose` · `music_emotion_proposals` · `music_emotion_accept` ·
`music_separate_plan` · `music_separate` · `music_separation_status` · `music_separation_list` · `music_separation_retry` ·
`music_generate_plan` · `music_generate` · `music_generation_list` ·
`music_job_list` · `music_job_get` · `music_job_poll` · `music_job_retry` ·
`music_package_build` · `music_package_list` · `music_package_validate` · `music_package_import` ·
`music_session_approve` · `music_session_unapprove` · `music_score_report` · `music_score_lineage` · `music_health`

A cue is one piece of music. A **score session** is the soundtrack of an
ordered picture sequence: tracks, clips over immutable audio, an emotional arc,
markers and automation, written against the exact screenplay version and cut
it was created for. `music_session_create` attaches one to a sequence (or a
scene, when the project has none) and stamps it with the brief it was written
against.

**Read `music_session_brief` first.** It is free and it is the facts: the shots
in play order with their real timings and cameras, the exact screenplay
passages, the cast and how much they talk, the look, the cues already written,
the accepted emotional arc, and the themes already made. It decides nothing
about what the music should be — that is your judgement, recorded with
`music_emotion_create` (a director's ranges are accepted; yours are
**proposals** until a person accepts them, and nothing paid rests on a
proposal) and with the cues.

**`music_session_drift` says when the ground moved.** A script edit or a
re-cut after the session was stamped is reported, with which side moved, and
nothing is changed. `music_session_rebase` is the explicit act of accepting
the new ground.

Every create and update tool carries the exact vocabulary the database
accepts, so a refusal names the field rather than failing on save. Deleting
anything here removes the arrangement row only; audio assets stay registered.
`music_session_batch` writes several edits in order, atomically, with `$n`
naming an earlier op's result — a track and the clips on it in one call.

`music_stem_import` brings a composer's stems in **aligned**: every file lands
as its own track and clip at one common start with a source offset of 0, so the
leading silence — which IS the alignment — is never trimmed. The bytes decide
the format (WAV/BWF, AIFF, FLAC, MP3, M4A), the original is stored
byte-identical and hashed, the technical facts are read from the file, and BPM
and key from tags or the filename are recorded as hints. Asking for 48k adds
a 48 kHz working copy beside the original with its resampling written down. A
rights row is recorded per file — `unknown` unless declared, never assumed
cleared. One unreadable file refuses the whole batch and nothing is written.
It spends nothing.

`music_bounce_plan` is free and says what a bounce WOULD render: the audible
clips with their resolved gain, pan, fades, loops and automation, every clip
left out with its reason (muted, another track soloed, take not selected, a
reference track), the delivery stems the chosen mode groups, and whether the
session is unchanged since the last render. `music_bounce` renders it through
the local encoder — a 48 kHz, 24-bit stereo master plus equal-length delivery
stems grouped per instrument, family or production bus — registers every
output with its render parameters, keeps every earlier version, and refuses an
unchanged session unless forced. `music_bounce_list` lists every version with
its files. None of the three reaches a provider.

**Generating on a session adds takes and never replaces one.**
`music_generate_plan` is free and answers for any of the five generating
workflows — compose, native parts, reference, picture, inpaint — with the
provider's own reason when it cannot, the length, the outputs and their kind,
the context sent (tempo, meter, key and the accepted arc, never a proposal) and
the cost hint. `music_generate` spends: each output is a new asset and clip, a
candidate take beside what a track already holds. It refuses when no arc is
accepted unless you say to go without one (the ignore_emotion argument). `music_generation_list` reads them.

**An approved score is the film's music, once.** `music_session_approve` selects
a bounce as the session's mix: only from review, and a bounce made before the
session last changed is refused. From then on the timeline, playback, the audio
mix, the pipeline, the NLE exports and the conformed master each lay that one
mix at the start of the session's picture, and the scene music under it is
dropped. Ask before approving; it is the director's decision.
`music_session_unapprove` takes it back. `music_score_report` is free: which
mixes the film uses and where, and every session that is not used and why
(unapproved, stale, missing, unplaced, overlapping, or shadowed by a finished
project mix).

**Rights follow the music.** `music_score_lineage` is free. It walks every clip
and the mix to their sources, with each source's origin (original, generated,
licensed, public domain or unknown) and rights status. A derivative (a bounce,
a separated stem, a take made over a source, a stem returned from a DAW) carries
the most encumbered status of what it was made from. Nothing is assumed: a
generated file is generated, not cleared. Approval and the final master follow
the rights policy: blocked material blocks both, expired material blocks the
master, and unknown or restricted material warns. A person can change that in
settings. A block can be passed only by saying so, and that is recorded.

**When something looks stuck, ask for `music_health`.** It is free. It
reports every score operation by area: renders, generation jobs, separations,
packages, DAW pushes and pulls, and stem imports. For each area it shows what is
running, what has stalled, and what failed recently. Every failure comes with
its session and how to recover. An operation has stalled when no process owns a
job, for example after the server restarted mid-generation, or when anything
else has run far past its limit. The report also says whether the encoder is
available and whether each DAW is configured. Pass `probe: true` to also ask
the DAW whether it responds. You can paste the report into a ticket: it never
includes a token, a key or a local path.

**A score package takes the session to any DAW and back.**
`music_package_build` spends nothing and builds one byte-stable archive. It holds
a manifest, equal-length aligned Broadcast WAV stems, the master and the
reference picture. `music_package_validate` checks a package and writes nothing.
`music_package_import` brings one back. Into the session it came from, each stem
lands on its own track as a candidate take; otherwise a new session is made with
the tempo map, markers and arc restored.

**Ableton Live, through the sidecar you start yourself.**
`ableton_status` · `ableton_session_read` · `ableton_score_push_plan` · `ableton_score_push` ·
`ableton_mix_pull_plan` · `ableton_mix_pull` · `ableton_transport`

Each tool is one operation of the DAW contract, and none of them can reach into
Live any other way: there is no tool that takes an OSC address or a Live
property. `ableton_status` and `ableton_session_read` are free and say whether
Live is reachable, which version answered, and which tracks are Film Engine's.
`ableton_score_push_plan` is free and shows what a push would create, update and
leave alone, with every conflict. `ableton_score_push` pushes exactly the plan
you read, into Film Engine's own marked tracks, and pushing the same plan twice
does nothing the second time. Live cannot load audio from a file over OSC, so
each pushed track names the stem to drag in at bar 1.1.1. Live cannot export a
render over OSC either, so `ableton_mix_pull_plan` is empty with the reason, and
stems exported by hand come back with `music_package_import`. `ableton_transport`
plays, stops or locates Live only when a person asked for it. Setup is in
docs/ableton-sidecar.md.
`music_daw_audit` is free and needs no connection: every push, pull and
transport a session has sent to a DAW, with its outcome, and for a push whose
outcome is unknown, the key to retry it with.

**Every generation and separation is one job with its outputs in order.**
`music_job_list` and `music_job_get` are free. They show each job's outputs with
the provider job id, cost, attempt, fingerprints, take number and whether the
take was accepted. A job is complete only when every output it expected is.
`music_job_poll` is free and reports a job whose run was lost to a restart as
interrupted. `music_job_retry` spends: it runs a failed job again as the next
attempt.

**Separating a recording costs money and never touches the recording.**
`music_separate_plan` is free: the provider, the variation (two stems —
vocals and instrumental — or six: vocals, drums, bass, guitar, piano, other),
the stems expected back, the placement every stem will take and a cost hint.
`music_separate` sends the clip's recording and answers at once with a running
operation; each returned stem becomes its own asset, track and clip, placed
exactly where the source clip sits, carrying the source's rights, with the
source untouched. A bad archive or a provider error leaves the operation
failed with nothing registered; `music_separation_retry` tries a failed one
again as a new operation that names it. `music_separation_status` and
`music_separation_list` read them for free.

`music_capabilities` is free and answers, for the project's own music
provider, which of the six music workflows it serves — compose a whole cue,
generate native parts, separate a recording into stems, condition on a
reference, condition on the picture, regenerate a selected range — each
available, planned or unsupported **with the reason**, its limits, a cost hint
from the rate book, the neutral plan and result schemas, and which other
providers could do it. A workflow the provider does not serve is refused with
that answer, never attempted.

**The emotional arc is yours to propose and the director's to accept.**
`music_emotion_brief` is free: the ScoreBrief, the arc already accepted, the
proposals waiting, the range schema with the exact bounds, the coverage rule
and the instructions — you are the model, so read it and decide.
`music_emotion_propose` writes your arc as ranges with a label, valence,
arousal, intensity, confidence and a rationale each; they land PROPOSED, never
accepted, and nothing paid rests on them. `music_emotion_proposals` lists
every proposal and what became of it. `music_emotion_accept` is the director's
explicit act, per range, with edits — call it only when they have said so.

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

### The world a shot is framed inside

`world_create` · `world_list` · `world_get` · `world_plan` · `world_generate` ·
`world_calibrate` · `world_lock` · `world_unlock` · `world_pin_shot` ·
`world_delete` · `world_import_glb`

A world is the persistent SET — a place reconstructed from a location's own
plates, that many shots are framed inside. It is not a shot and not a subject.

`world_generate` is the only one here that spends; `world_plan` prices it first,
for free, through the same rate table the run bills from.

Two things worth knowing before you use them. A world has **no scale** until
`world_calibrate` is given one known measurement — Marble reconstructs geometry
without a unit, so until then every distance in it is decorative, and the world
says `APPROXIMATE SCALE` rather than guessing. And a version is **never**
overwritten: improving a world makes a new one, and a shot pinned to the old
version stays there until somebody moves it deliberately.

A set built in Blender (by hand, or by Higgsfield's Scene Builder in your open
Blender) comes in with `world_import_glb`, FREE: export it as glTF Binary (.glb,
no Draco) into the project's own folder and pass its path. It becomes the next
version of the world, drawn textured in Previs's Look view, and it arrives in
metres, so it needs no `world_calibrate`. Pin a shot to it with `world_pin_shot`;
the camera kept in Previs is applied to the shot's card like any other.

### A location's set, built in Blender from its plates

`set_build_brief` · `set_build_render` · `set_build_list` · `set_build_get` ·
`set_build_finish`

The free way to make a world, and the one that needs no provider: YOU read the
plates and write the room; Blender, on this Mac, builds it. `set_build_brief`
hands you the plates as pictures, the location's own description, the layout
vocabulary (room, openings, objects, one camera per plate) and whether Blender is
installed. Write a layout in metres and call `set_build_render`: the set is built
headless and rendered from every plate camera, and you get one sheet per plate,
the plate beside your render and the two blended, so you can SEE where it is
wrong. Fix the cameras first, then the geometry, and render again; every attempt
is kept. `set_build_finish` paints each plate onto the surfaces it sees, makes the
set the next version of the location's world (creating the world if there is
none) and keeps it as a 3D model asset. All of it is FREE. Surfaces no plate saw
keep their plain colour; another plate from a new position fills them.

### The geometric plate

`generation_plate`

What a plate for this shot would carry: the camera and blocking it renders from,
the raster it renders at — the shot's own delivery shape, so a vertical shot is
rendered vertical rather than cropped later — the three outputs (image, depth,
subject masks) and the sentence that names it in the prompt. **Free**: it is a
local render, and it is the step that precedes every paid generation.

A plate **leads** the reference list. It fixes the camera, the framing and where
each subject stands; the image model supplies appearance, identity, light and
polish. A plate whose world version has been deleted reports as **detached**
rather than stale — you cannot re-render against geometry that no longer exists.

### Directing the shot

`cinematography_brief` · `camera_propose` · `camera_explore_brief` ·
`camera_explore_accept` · `camera_compare`

All four are free, and none of them calls a model — **you are the model**. The
brief hands you the geometry and deliberately returns no answer: the camera as
it stands, where each subject is and which way they read in frame, the world
bounds and whether it has a real scale, the 180° axis and which side the scene
was established on. You decide; `camera_propose` refuses a camera the world
will not accept and names the check that caught it.

Crossing the 180° line is a **warning, not a refusal**. It is a real creative
choice, and a tool that blocked it would be one nobody leaves switched on.

### Matching a frame you already have

`match_reference`

You have the shot in your hand — a Framed Ink panel, a storyboard, a still from
another film — and you want this camera to sit where that one did. **Free**, and
**manual assist**: the tool takes the marks a director drew, never the picture,
so there is nothing here that could detect a horizon and it claims none. Two
points along the horizon give the roll exactly; add a box round the subject and
that subject's real height and it gives the camera height too, because the
horizon crosses a standing figure at the camera's own eye level.

Everything it cannot work out is returned **null with the marks that were
missing** — a lens needs converging lines, a tilt needs a focal length — and the
confidence is derived from what was actually marked rather than asserted. It is
an approximation of a camera, not a reconstruction of one, and the payload says
so. Applying is separate, writes **camera fields only**, and goes through the
same validator every other camera does: a composition copied from a still can
still put the lens inside a wall.

### Whether the shot will survive generation

`shot_complexity`

**Free, and it belongs before the spend.** Seven inputs, one grade — LOW, MEDIUM
or HIGH — with every input's contribution shown, so the grade can be argued
with. HIGH carries a split suggestion naming what to cut on, because the remedy
for a crowded shot is to split it and no amount of prompt wording achieves that.

Three inputs are derived from what the engine holds: how many subjects, how much
the camera moves, how long the shot is. **Four are marked `ask`** — which
subjects move, contact with the set, occlusion, and how many distinct actions
the shot contains. Those are readings rather than counts, and the engine will
not guess them: you have read the scene, it has not.

### Handing the geometry to somebody else

`world_export`

The manifest, not the bytes — whether each output exists is the question worth
answering before packaging 25 MB of splat. Seven outputs: camera JSON, world
metadata JSON, the collider GLB, the splat **as a URL rather than a file**, the
generation plate, the depth pass, and the shot thumbnail.

**Every one names the world version it came from.** A camera JSON without it is
a set of numbers in an unnamed space, and on an uncalibrated world the export
says outright that its distances are not metres. An output that does not exist
yet is named with its reason rather than quietly left out of the list.

### Redoing the video between two chosen frames

`repair_plan` · `repair_run` · `bridge_list`

A fault in the middle of a shot — a hand through a table, two seconds of drift —
used to mean re-rolling the whole clip and losing everything that was right
about it. Mark an in-point and an out-point and regenerate only what lies
between them.

**The marks are CLIP-RELATIVE SECONDS**, offsets into that shot's own footage,
not positions in the finished film. A mark at 00:41 of the cut is 3.2 seconds
into shot 2B, and the two numbers are not interchangeable: sending the wrong one
produces a valid, playable repair of somewhere else.

`repair_plan` is **free** and spends nothing, so try three ranges before
committing to one. It reports the two frames it would extract, what it would
generate and at what raster, how the result goes back in, and the cost from the
provider's own table.

**The four-second floor is the thing to expect.** The model will not generate a
shorter clip, and a fault is very often shorter — so the commonest range you
will mark is refused. Both remedies come back priced: widen the marks, which
changes what you marked, or generate four seconds and trim back, which pays for
footage nobody sees. Neither is chosen for you.

**Across a cut is a BRIDGE, not two repairs.** When the *transition* between two
shots reads wrong, neither shot is individually at fault — so repairing either
one cannot fix it. Mark out in the first and in in the second, pass `bridge`,
and what comes back replaces the tail of one and the head of the other: its own
piece of footage plus two trim points.

A bridge is **deliberately not in the timeline, the conform or any NLE export**.
One that placed itself would be making the edit you opened your editor to make.
`bridge_list` is therefore the only way to find one — **free**, and each row
carries the two shots it sits between, where to trim each of them, its length
and a servable URL. Without those trim points a bridge is a clip nobody knows
where to put.

`repair_run` **spends**, and registers the result as a **new version** — the
take being repaired was paid for and survives the attempt. Every failure names
the stage it happened at, so "it failed" is never the whole answer.

### Handing somebody a decision

`approval_envelope` · `take_candidates`

Two moments need a decision and they are not the same one. **Before** the
spend, no picture exists and what decides it is numbers and words. **After**
it, the pictures exist and *are* the decision, and every attempt is already
archived and sitting there unjudged.

`approval_envelope` is the first. **Free**, and assembled from the previews that
already answer these questions rather than recomputing them — so it cannot
disagree with what actually runs. It carries the prompt that will really be
sent with its ceiling and the tail that will not fit, which references are
attached and in what role, the tier, model and provider, and the estimate.

Its `warnings` array is what turns a yes/no into an informed one. A stale
input, a subject with no plate, a subject with no declared size, a provider
nobody chose — none of that is visible in a picture and all of it changes the
answer.

It also carries a **fingerprint** of the inputs. Hand that back as
`approval_fingerprint` on the run and the engine re-derives it and refuses with
**409 STALE_APPROVAL** if anything moved in between. Without that, "I approved
that" and "that is what ran" are two claims nothing afterwards can separate.

`take_candidates` is the second. Newest first, each carrying the thing that
actually separates two near-identical frames: *why it exists* — refined from
which version on what instruction, restored, sent from another shot, or simply
generated. An attempt whose own picture was never archived is listed as **not
selectable with the reason** rather than dropped, because it is real history.
Pass a proxy byte ceiling and video candidates get a 720p proxy under it,
plus a still; a clip that cannot be brought under it returns no proxy and says
why rather than handing back something oversized. Resolving goes back through
the selection that already exists.

Media in both travels as **absolute paths**, and the packet says so in
`media.transport` — a serving URL only resolves on this machine's own network.

### Working on the production graph

`production_graph_get` · `production_graph_running` · `generation_queue` ·
`run_changed_plan` · `run_changed` · `run_changed_status` · `run_to_here_plan` ·
`run_to_here` · `run_cancel` · `generation_cancel` · `asset_provenance` ·
`graph_hold` · `version_select` · `pattern_list` · `pattern_preview` ·
`pattern_create`

Production as one graph. `production_graph_get` returns every shot, sequence,
sound and version as a node with a key (`shot:<id>`, `seq:<id>`, `sound:<id>`,
`ver:<id>`) and says which are behind, held or running; the other tools take
those keys. "Run what changed" (`run_changed_plan`, then `run_changed`) redoes
what is out of date in dependency order; "Run to here" (`run_to_here_plan`, then
`run_to_here`) makes what one node still needs. Both plans are free; both runs
**cost money**, work in the background, and are followed with
`run_changed_status` and stopped with `run_cancel`. `generation_queue` shows
running, waiting, done, awaiting collection and failed work;
`generation_cancel` cancels one job where the provider really can, and
otherwise stops waiting and says it may still bill. `asset_provenance` says how
a version was made. `graph_hold` holds a node so batch runs skip it — it stays
in the film. `version_select` chooses which clip or sound plays. The patterns
(`pattern_list`, `pattern_preview`, `pattern_create`) lay down shot / reverse,
insert then reaction, or wide / medium / close after a shot, generating nothing.

### Where the production stands

`milestone_list` · `milestone_update`

The production timeline: every milestone with its phase, status and completion.
`milestone_update` moves one — its status, percentage, dates or title. These
describe the SCHEDULE, not the work: marking a milestone complete generates
nothing and does not change what a report says about the shots underneath it.

### What is on the other end of this connection

`agent_presence`

What the engine knows about the agent host attached to it, and what that host
can do. It exists because the connected model IS the language model here — there
is no server-side one — so which host is attached decides which work can happen
in the conversation rather than being paid for at a provider.

### Which self-hosted models exist, and whether they may run
`model_catalog` · `model_controls` · `model_catalog_audit` · `model_licence_grants` · `model_licence_grant` · `model_licence_revoke` — all free.

The self-hosted models (MiniMax H3, FLUX.2 [dev], Fish Audio S2 Pro, Stable Audio 3 Medium and Small SFX, LatentSync 1.6) are catalogued in gridlight and read here. `model_catalog` shows each one's capabilities, licence and commercial-use state, allowed AWS regions, consent requirements, cost and limits; a field is null only when the catalog says why. `model_controls` is one model's control schema, as the Production client reads it. `model_catalog_audit` lists every recorded change to the catalog. Whether a model may run is decided fail-closed: H3 outside ca-central-1, an expired licence, a production run on a model not permitted commercially, or a request carrying a voice sample or a face without that consent is refused. A model whose public licence does not permit commercial use can be enabled for production only while the organisation's own licence for it is recorded: `model_licence_grant` records one (only a licence the user says they hold, with their name), `model_licence_grants` lists them, and `model_licence_revoke` revokes one without deleting the record.

### What it actually cost

`spend_report` · `spend_usage` · `spend_backfill` · `spend_rates` · `spend_compare` ·
`spend_record`

Every provider call is metered automatically — nothing to enter by hand.
`spend_report` gives dollars *and* the provider's own units (credits at Meshy
and Runway, characters and seconds at ElevenLabs, tokens at Anthropic), broken
down by capability, provider, model, day and shot, with cost per minute of
footage. `spend_usage` is the raw meter, one row per call, for when you want to
know *why* a number is what it is.

`spend_record` is the exception to "nothing to enter by hand": a charge the
engine did not observe — a clip bought on a provider's own website, a plan fee —
has no call to meter, so it is the one way the ledger can be told about money
that was really spent.

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
