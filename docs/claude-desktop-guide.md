# Film Engine from Claude Desktop

**138 tools, 37 families.** Everything the app can do, you can ask for in a
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

`plate_generate` · `plate_generate_all` · `consistency_create` ·
`consistency_lock` · `consistency_list` · `consistency_unlock` ·
`consistency_delete` · `mood_board_add` · `mood_board_compose` ·
`mood_board_list` · `mood_board_remove`

A plate is a reference photograph of one subject. Generating one does **not**
lock it — `consistency_lock` is the commitment generation conditions on.

**Costs money.**

### 4. Shots

`shot_create` · `shot_tag` · `shot_get` · `shot_update` · `shot_list` ·
`shot_delete` · `shot_prompt` · `shot_frames` · `shot_frame_restore` ·
`shot_annotate` · `card_vocabulary` · `breakdown_summary` · `elements_list` ·
`sides_report` · `dood_report` · `board_groups` · `setups`

There is deliberately **no breakdown tool** — composing a scene card is
reasoning, and you are talking to the model that does it. Read `card_vocabulary`
first so the card validates.

`shot_prompt` shows exactly what a frame would send, and **spends nothing**.

### 5. Storyboard

`storyboard_generate` · `storyboard_regenerate` · `storyboard_refine` ·
- `storyboard_recompose` — keep the PERFORMANCE from one frame and replace its BACKGROUND with a photographed view of the shot's location. Use it when the acting, framing and camera are right and the place behind them is wrong; `storyboard_refine` cannot, because its contract refuses composition changes and on a close-up the background is most of the composition. The background must be a view of that shot's own location — photograph the view you need first. Costs credits.
`anchor_get` · `anchor_set` · `anchor_clear` · `annotation_list` ·
`annotation_delete`

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
`node_gen_llm` · `node_gen_model3d`

Video, voice, music, SFX and ambient audio — each runs one generation in
isolation. **All cost money.**

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
`project_delete` · `staleness_report` · `impact_report` · `artefact_accept`

`impact_report` answers *what did that change break* — one edit, all the way
down, splitting **redo now** from **waiting on something above it**.

---

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

### What it actually cost

`spend_report` · `spend_usage` · `spend_backfill` · `spend_rates`

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
