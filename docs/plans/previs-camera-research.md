# Research: how previsualization tools actually work

**Status:** Research — input to [`previs-camera-implementation-plan.md`](./previs-camera-implementation-plan.md)
**Date:** 2026-08-15

---

## 1. What the category is

Previs is the step between "we know what the scene is" and "we commit money to shooting it." It answers a small number of questions that storyboards cannot: where does the camera stand, what lens is on it, what is actually inside the frame, what does the move look like, and what do we have to rent to achieve it.

The tools split into three tiers, and they trade the same axis — speed against precision.

| Tier | Tools | What it gives you | What it costs |
|---|---|---|---|
| 2D diagram | Shot Designer | Drag cameras, actors, props on a floor plan; animate them | Fast, but no lens truth — you never see the frame |
| 3D previs | FrameForge, Previs Pro, Cine Tracer | Real lens models, scaled sets, camera moves, blocking | Slower to set up; precise |
| Real-time engine | Unreal, Maya, Blender | Everything, plus final-pixel virtual production | A department, not a tool |

FrameForge is the dedicated standard for 3D previs, building "photo-accurate 3D scaled sets" with simulated cameras — the emphasis on *scaled* is the point. Cine Tracer is built on Unreal and aims squarely at lighting. Shot Designer stays 2D deliberately, because a director drawing a floor plan does not want to model a room first.

The relevant lesson for us: **the value is in the lens simulation being physically real, not in the scene looking good.** A grey box at the correct distance under a correct 40mm is more useful than a beautiful render at a made-up focal length.

## 2. The optics a previs tool has to get right

This is the whole substance. Everything else is UI.

### Field of view

Field of view comes from focal length and the physical sensor, not from a number a user picks:

```
hFOV = 2 · atan( sensorWidthMm  / (2 · f) )
vFOV = 2 · atan( sensorHeightMm / (2 · f) )
```

The sensor is what makes a 50mm "normal" on Super 35 and long on Micro Four Thirds — the image sensor format determines the angle of view of a particular lens. Three.js models this directly: its `PerspectiveCamera` carries a **film gauge** (default 35mm) alongside FOV, and exposes `setFocalLength()` / `getFocalLength()` so a camera can be driven in lens terms rather than degrees.

### Framing → distance

The relation a director actually wants, and the one 2D tools cannot answer. For a subject of height `S` that should exactly fill the frame height:

```
distance = f · S / sensorHeightMm
```

So "put her in a close-up on a 50mm" has one answer, and previs can just tell you: with a 0.45 m head-and-shoulders on Super 35 (18.66 mm tall), `d = 50 · 450 / 18.66 ≈ 1.2 m`. Change to an 85mm and the camera moves to 2.0 m. **That is the number that changes how a scene is staged**, and it is why framing has to be a solved quantity rather than a text token.

### Depth of field

Hyperfocal distance:

```
H = f² / (N · c) + f
```

where `N` is the f-number and `c` the circle of confusion — the largest blur circle still read as a point. 0.03 mm is the conventional value for 35mm work; digital cinema formats scale it with sensor size, so it belongs on the sensor record, not as a global constant.

Near and far limits of acceptable sharpness at focus distance `d`:

```
near = d · f² / ( f² + N · c · (d − f) )
far  = d · f² / ( f² − N · c · (d − f) )        // → infinity when d ≥ H
```

Focus at `H` and everything from `H/2` to infinity is acceptably sharp. The far limit's denominator shrinks as the subject approaches the hyperfocal point, which is why depth extends roughly one third in front and two thirds behind.

For our purposes the DOF numbers matter less as a blur effect than as **a printed range on the frame**: "T2.8 on the 85 at 2 m gives you 1.94–2.06 m" tells a director the actor cannot lean forward. That is a previs output, not a render.

## 3. Rigs are a separate axis from moves

Every serious 3D previs tool models the *mount*, not just the motion — and this is the part our schema currently has no room for. Blender's camera rig add-ons ship Dolly and Crane rigs as distinct constructs, the crane carrying explicit **arm height** and **arm length** bones. Third-party kits build "Dolly, Crane, 2D, Orbit, Follow, or Two-Target" rigs from empties and constraints.

The reason to model it: a rig constrains what moves are possible. A tripod cannot translate. A slider has 0.3–1.5 m of travel, so a 3 m tracking shot on one is a mistake previs should catch before the truck is loaded. A crane's arm length bounds its arc radius. Drone is the only rig that reaches an aerial. Encoding affordances per rig turns previs from a drawing into a feasibility check — which is exactly the "specific tooling used for this shot" question being asked here.

## 4. Interchange: glTF is the settled answer

Previs Pro accepts custom rigged humanoid characters as **`.glb` (glTF 2.0 binary)** with a standard humanoid skeleton, exportable from Blender, Mixamo or ReadyPlayerMe.

This matters more to us than to most: `lib/threed-prompt.js` and `routes/threed.js` already generate `.glb` for characters and props through Meshy, store them at `data/3d/{project_id}/{name}.glb`, and serve them at `GET /film/3d/:projectId/:filename`. The subject a previs viewer needs to place is **already being produced by the pipeline**, in the format the category has standardised on. glTF is also right-handed, +Y up, −Z forward, which is why the taxonomy adopts that convention rather than inventing one.

## 5. Where the browser constraint bites

`gridlight.json` pins `build.target: single-html`, and `src/index.html` is a 17,659-line SPA with no bundler. The Flows canvas hit this exact wall and resolved it by hand-rolling SVG rather than introducing React Flow — a dependency that would have meant adding a build system to ship one page.

Previs splits cleanly along the same line:

- **Grey-box previs** — a ground plane, boxes or billboards for subjects, a camera frustum, and the camera's own view — needs a 4×4 matrix pipeline and a polygon rasteriser. Canvas 2D does this in a few hundred lines. No dependency, no build step, and the optics above are the hard part regardless of renderer.
- **Real `.glb` subjects** — needs glTF parsing, a scene graph and PBR shading. That is Three.js (or an equivalent), and it is a genuine dependency decision deserving its own ADR.

The first tier answers every question in the original ask: place a plane, place a subject, place a camera, move it 360°, simulate lens and aperture, see the camera's view. The second tier makes it *look* like the film. They should not be the same phase, and the second must not block the first.

## 6. What we would be building that the category does not have

Two things fall out of already having the rest of the pipeline:

1. **Previs that feeds generation.** Every existing tool ends at a diagram or an animatic a human then interprets. Our `camera_control` payload is already the generator's input, and `CAMERA_CONTROL_MAP` already has an entry per movement. Blocking a shot in 3D and emitting the sampled path as that payload closes a loop nobody else has, because nobody else owns both ends.
2. **Subjects that are the actual characters.** The `.glb` is generated from the same character record that drives the LoRA tokens and the consistency profile. The person in the previs is the person in the render.

---

## Sources

- [The 12 Best Previs Tools in 2026 — Storyflow](https://storyflow.so/blog/best-previs-tools-2026)
- [Previsualization (Previz) Software & Techniques — wolfcrow](https://wolfcrow.com/an-overview-of-previsualization-previz-software-and-methods/)
- [FrameForge 3D Studio — Wikipedia](https://en.wikipedia.org/wiki/FrameForge_3D_Studio)
- [Affordable Previz Tools for Directors 2026 — M Studio](https://mstudio.ai/insights/best-previs-software-2026)
- [How Previs Has Gone Real-Time — VFX Voice](https://vfxvoice.com/how-previs-has-gone-real-time/)
- [PerspectiveCamera — three.js docs](https://threejs.org/docs/pages/PerspectiveCamera.html)
- [Simulating Real Cameras using Three.js — Segments.ai](https://segments.ai/blog/simulating-cameras-three-js/)
- [Image sensor format — Wikipedia](https://en.wikipedia.org/wiki/Image_sensor_format)
- [Depth of field — Wikipedia](https://en.wikipedia.org/wiki/Depth_of_field)
- [Depth of Field and Hyperfocal Distance Equations — UC Berkeley CS39J](https://inst.eecs.berkeley.edu//~cs39j/sp05/handouts/depth.of.field.writeup.html)
- [Circle of confusion, depth of field and hyperfocal distance — TULARC lens tutorial](https://stason.org/TULARC//recreation/photography/lenses-tutorial/04-Circle-of-confusion-depth-of-field-and-hyperfocal-dista.html)
- [Add Camera Rigs — Blender Extensions](https://extensions.blender.org/add-ons/add-camera-rigs/)
- [Camera Toolkit — StraySpark](https://www.strayspark.studio/products/camera-toolkit)
- [Previs Pro Wiki](https://wiki.previspro.com/)
