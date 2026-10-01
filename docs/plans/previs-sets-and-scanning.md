# Previs sets, staging and our own scanner

Decisions and open work from the Previs rebuild (September 2026). What is built
is described in CLAUDE.md; this file holds what was decided and what comes next.

## Decided

| | |
|---|---|
| **Sets are built in Blender, headless, for free.** | The agent writes the layout from the location's plates; the engine builds, renders comparison sheets and finishes a world version and a 3D asset. Blender does not need to be open. |
| **Previs is clean, not textured.** | Projected plates look right from where they were shot and smeared from anywhere else. A set is flat colour per object sampled from the plates (`clean`, the default); `painted` stays available. The purpose is planning shoots and angles, not a finished image. |
| **Proxies come from a library.** | Kenney Furniture Kit (CC0, 140 pieces) and four people made in the repo (man, woman, boy, girl) at real heights. No licence questions. |
| **Anything can be staged and moved.** | People, furniture and the project's own 3D models (e.g. a Meshy creature) are placed, moved and turned on the Plan view; the camera is never touched by staging. |
| **Marble (World Labs) is kept for now.** | The user expects to remove it once the Blender path is proven on more locations. Not before. |
| **A phone video is not enough for a complex location.** | Measured on The Lodgers house: the camera path solves, but the geometry is sparse and splits into six unconnected pieces. A multi-level house needs LiDAR. |
| **We build our own scanner, not a subscription.** | See below. The user has a paid Apple developer account; the signing certificate is fixed when we publish to TestFlight. |

## Built (2026-09-30)

- Previs: people, furniture and project 3D models staged and moved; panels fold away; the camera moves with the mouse; framing and angle in film terms (EWS–ECU; eye, shoulder, hip, knee, ground, low, high, overhead, Dutch); draggable Camera Operate values; the playhead shows the move.
- Lighting: seventeen techniques over the card's moods, per shot, per location, with the film's look as the general style; lit in Previs and drawn on the plan.
- The scanner, step 1: RoomPlan in the iOS app, room after room in one session (multiple storeys included), uploaded and built as the location's set.
- The scanner, step 2 (2026-09-30): the phone app is now ONLY the scanner (the full page is no longer on the phone). Offline: scan, then guided photos (one per wall from across the room, with where to stand and which way to turn), each kept with its ARKit pose; saved on the phone and sent later to a project's location. The photos become the location's plates and measured plate cameras; the scan is rendered beside each. Claude's brief gets the scan as `scan_base` and an instruction to inventory and build every object in the photos (shapes and flat colours).

## Next: the scanner in the Film Engine iOS app

The existing iOS app (`ios/FilmEngine`) gains a native **Scan location** screen.

1. **RoomPlan** (LiDAR, iPhone Pro). It gives walls, doors, windows, floors and furniture as labelled boxes, in metres, room by room, and supports multi-room capture on iOS 17 and later. Export the `CapturedStructure` as JSON plus USDZ.
2. **Guided plates (built).** After the scan the app knows the room, so it tells you where to stand: one plate per wall from the opposite corner at eye height, plus a master wide, with an on-screen target and level. Each plate is saved with its camera pose from ARKit, so it lines up with the scan exactly (no solving).
3. **Upload** to the location in Film Engine through the resumable upload route (already built): the RoomPlan JSON, the USDZ and the posed plates.
4. **Engine side.** Convert the RoomPlan JSON into the set-build layout vocabulary (walls, openings, slabs, stairs, objects), swap each furniture box for the nearest library piece at its measured size, and use the posed plates for the clean colour sampling. The build is then automatic.

## Open

- Compare the user's two scans of their office (Scaniverse GLB, RoomPlan USDZ), once they are in `The Lodgers/03 Previs`. This decides how much detail to keep from a mesh scan against RoomPlan's boxes.
- The Lodgers project still needs its house location and a shot 1, created from the scan.
- Remove Marble once Blender sets have been proven on more locations.
