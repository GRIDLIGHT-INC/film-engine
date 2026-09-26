# Handoff: Production — one node graph replaces eight pages

## Overview

The Production phase currently has eight pages: Shot Board, Video Shots, Music & Sound, Music Cues, Score, Playback, Pipeline and Flows. This redesign replaces them with **one page, `production`**: a node graph with a drawer inspector and a playback bar.

- **Shot node** — the frame and its versions. Clicking it opens the full video prompt (editable by part or as one text), the plates and details to send, every video-generation input, and Regenerate / Upload / Refine / Anchor.
- **Sequence node** — shots wired in, in order. Each join has a type (cut, continuous move, dissolve, match cut, whip pan, morph) and a "how they connect" prompt. It can start or end on a **linked frame** borrowed from another sequence.
- **SFX / Ambient / Music nodes** — wired to a shot or sequence, these take its **scene details** automatically plus your own direction. A free preview shows exactly what will be sent.
- **Version nodes** — every generated image, video and sound is a version wired to its parent. **The selected version is what plays.**
- **Playback bar** — shots in running order. It plays the selected video version where there is one, holds the selected still for the shot's length where there isn't, and shows a slate where there's nothing.

Decisions already made with the director:

1. Nodes are placed automatically from the shot list. A node you drag stays put, and "Tidy layout" only re-places nodes nobody moved.
2. A shot belongs to one sequence only. Another sequence can borrow its frame as a start or end frame through a linked frame node. The borrowed frame is never played twice.
3. "Take" is called **version** everywhere in the UI.

## Files

The screens to build to are the `FE-*` files. Everything else supports them.

| File | What it is |
|---|---|
| `FE-Handoff.dc.html` | **Build brief** — nav changes, the route behind each node, the new schema, wiring and playback rules, and the done-when checklist. **Read this first.** |
| `FE-Production.dc.html` | Default screen (1440×900), nothing selected |
| `FE-Shot.dc.html` | Shot selected, drawer open |
| `FE-Sequence.dc.html` | Sequence selected |
| `FE-Sound.dc.html` | Music node selected |
| `FE-Version.dc.html` | Video version selected |
| `FE-Spec.dc.html` | Tokens, port colours, node anatomy and states, layout measurements |
| `DrawerShot / DrawerSequence / DrawerSound / DrawerVersion.dc.html` | Each drawer at full length. The footer is sticky; see the screens. |
| `TopBar / SidePanel / MainHeader / Graph / Playback.dc.html` | Shared pieces the screens import (`<dc-import>`) |
| `Main, MigrationMap, ShotInspector, SequenceInspector, SoundInspector, TakeViewer.dc.html` | The earlier low-fidelity flow spec. `MigrationMap` says where every capability of the 8 old pages goes. |
| `canvas.json` | How the boards were arranged on the design canvas; ignore it for the build |

## About the design files

These are **design references written in HTML, not production code**. They use the `.dc.html` component format: an HTML template plus a small logic class that the `support.js` runtime renders. Do not port that runtime. Rebuild the design inside `src/index.html` using the app's existing shell, the `.btn-*` classes, the input styles and the Flows SVG canvas (`.fnode`, `.fedge`).

To preview a board, put `support.js` beside the files. It is the same runtime as in `design_handoff_world_engine_previz/`. Then open a file in a browser. The screens import the shared pieces by file name, so keep all the files together.

## Fidelity

**High fidelity.** The colours, type, spacing, borders and states match the live `#fe-redesign` tokens and the Flows canvas styles, and should be followed closely. Some content is placeholder and should be wired to real data:

- The frame images are simple drawn stand-ins.
- Costs are shown as `$[x.xx]`. Use the existing free plan and estimate routes.
- Dates, and the phase fractions in the top bar.
- Shot durations and the wording of the shot and cue descriptions are demo content.

The route paths in `FE-Handoff` were read from the route files' own header comments. Confirm each one before calling it.
