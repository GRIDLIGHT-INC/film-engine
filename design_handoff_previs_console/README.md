# Handoff: Previs console — the real set, a bigger view, decisions you can lock

## Overview

This redesign of `#page-previs` fixes three problems with the current page:

1. **It scrolls through almost three screens.** At 1920 the page is about 2,170 px tall inside an 810 px window. The camera view gets only about 665×375, and the controls that change the camera sit below it, out of sight.
2. **The view shows only the collider mesh.** Every Marble world also includes Gaussian splats in three detail tiers plus a 360° panorama. `lib/world-assets.js` records the splat links but nothing renders them, because `WORLD_SPLATS` is off.
3. **Directing decisions have no visible state.** `lib/decision-contract.js` and `routes/previs.js` already support Apply (write to the scene card) and Approve (store a fingerprint and flag later changes as stale). The UI doesn't show either, and Production doesn't show what was locked.

**Start by reading `PV-Brief.dc.html`.**

## Files

| File | What it is |
|---|---|
| `PV-Brief.dc.html` | **Build brief:** layout, view modes, splat backend changes, the decision states mapped to the existing contract and routes, Explore, Direct, a bug found during review, and a done-when checklist |
| `PV-Look.dc.html` | Look view (splats), Camera tab |
| `PV-Direct.dc.html` | A proposal shown on the view as a dashed frame, Direct tab |
| `PV-Explore.dc.html` | Camera C in the view, six rendered thumbnails |
| `PV-Plan.dc.html` | Top-down plan with camera cones, Scene tab |
| `PvHeader / PvView / PvPanel / PvTimeline / PvSidePanel.dc.html` | Shared pieces the screens import |
| `DinerScene.dc.html`, `PlanView.dc.html` | **Drawn stand-ins** for the splat render and the plan. They are not art to reproduce: the real view comes from Spark and the world's splats, and the plan comes from the collider. |
| `TopBar.dc.html` | The app top bar. It now takes the project name, subtitle and active phase as props. |

The Production side of this handoff, a "From Previs" section in the shot drawer, is in `design_handoff_production_graph/DrawerShot.dc.html` (updated).

## About the design files

These are **design references, not production code**. They use the `.dc.html` component format rendered by `support.js` (included, the same runtime as the other handoffs). Open a file in a browser with all the files kept together. Rebuild the design in `src/index.html` with the app's existing shell, `.btn-*` classes and `#fe-redesign` tokens.

## Fidelity

High fidelity for layout, type, colours and states; they match the live `#fe-redesign` tokens. Placeholders:

- The diner render and the plan are simplified drawings.
- Shots 1A–1F are **demo content**: The Glass Harbour has a calibrated world but no shots yet.
- The measurements, proposal deltas and camera specs are illustrative.
- The world facts are real: The Glass Harbour diner, v1, marble-1.0-draft, scale ×1.75, and June and Ray.

Route paths in the brief were read from the route files. Confirm each one before calling it.
