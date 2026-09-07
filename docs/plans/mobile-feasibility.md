# Working a Film Engine project from a phone

**Question:** like NeonCore, could there be a mobile version to work on a Film Engine project?

**Short answer: yes, and the useful version is smaller than it sounds.** One of the three
options already exists and costs nothing; a second is about a day; the third is the NeonCore
shape and is weeks. Which one is right depends on what you actually want to do on a phone,
and the honest answer is that most of Film Engine is not phone work.

Nothing here is built. Every number below is measured from the code, not recalled.

---


## Status: Option B is built (2026-08-27)

Option A needed nothing. **Option B was built**; Option C is still not recommended.

What changed, and the measurements that replaced the ones above:

| | assessed | now |
|---|---|---|
| `.main` width at 386px | 128px | **362px** |
| Context panel | fixed 232px, always | off-canvas drawer under 700px |
| Phase track on a phone | unreachable | **moved** into the drawer, one node |
| API base | literal `http://localhost:3100` | follows `location.hostname` |
| Page server | `127.0.0.1`, no opt-out | `FILM_ENGINE_HOST`, **default still loopback** |
| Shell-aware media queries | 0 of 6 | **1 of 14 media queries** — the phone breakpoint |

Verified in a real browser at both widths: at 1920px the panel is still 232px, `.main`
still starts at 262px and the burger is hidden — **not one computed value above 700px
changed**. At 386px the drawer opens to 300px, the scrim shows, tapping a page closes it,
and nothing scrolls sideways on a real project.

Option C's cost was never React Native. It is **a second surface**, and this codebase has
paid three times in one week for two surfaces disagreeing (the plate pointer, the frame
pointer, `effectiveCamera`). That argument is unchanged by Option B shipping.


## 1. The precedent, read rather than imagined

`~/code/neoncore/mobile` is a **native React Native app** (React Native 0.86, ejected from
Expo — `expo-updates`, EAS and Expo Go all removed). Its README states the scope plainly:

> *Read what your agents are doing, answer their approvals, launch workflows and unblock work —
> from your phone, over your LAN.*
> **Scope:** LAN-only · iOS · no cloud relay, by design.

Two things matter about that, and both carry over.

It talks to the orchestrator's ordinary **HTTP API** — `/api/agents`, `/api/queue`,
`/api/permissions`, `/api/goals` and a dozen more. No separate mobile backend.

And it is a **companion, not a port**. It does not attempt the dashboard. It does the handful of
things that are genuinely better on a phone: seeing state, answering a question, unblocking
something. That is the single most useful thing to copy.

---

## 2. Measured, not assumed

| | | |
|---|---|---|
| Pages in the SPA | **38** | `id="page-*"` |
| Modals | **31** | |
| Rail entries | **7** | `var RAIL` |
| MCP tools | **236** | `listTools()` |
| SPA size | **2.01 MB** | one file, `build.target: single-html` |
| Non-print media queries | **7** | six incidental + the phone breakpoint Option B added; see below |

**The responsive layout did not exist.** There are 14 media queries that are not `print` (12 at
the time of this assessment, plus the one the character sheet's two-up block
added when its layout was brought back to the reference design), and it
is easy to read that as "already responsive". Not one of them touches the **app shell**. They
govern:

- `.home-phases` and `.home-row-2` — one home-page widget, at 1000px and 1200px and 700px
- `.onboarding-dock` / `.onboarding-panel` — at 900px
- `.guide-layout` / `.guide-index` — at 820px
- `.pb-columns` / `.sel-columns` — playback and selects, at 900px

The sidebar is `position: fixed` at **260px**, `body` is `overflow: hidden`, and no breakpoint
changes either. At 390px the sidebar alone takes two thirds of the screen and the body cannot
scroll. So the honest statement as assessed was: **12 media queries existed and zero of them made the
application usable on a phone.** A test asserts that none touches the shell, so if that changes
this assessment has to be revisited rather than quietly going stale.

**The transport is already 90% there, with one hard blocker.**

| | |
|---|---|
| The API binds **every interface** — `server.listen(PORT)` with no host, so 0.0.0.0 | ✅ reachable from a phone on the LAN |
| CORS sends `Access-Control-Allow-Origin: *` | ✅ any origin, including a native app |
| The **page** server bound `127.0.0.1` unconditionally | ❌ was the one hard blocker — now `FILM_ENGINE_HOST` opts in, default still loopback |

That last line is the whole reason "just open it on your phone" does not work today, and it is a
one-line change. It is deliberately not made here: binding a server with no authentication to
the LAN is a decision for whoever owns the network, not a side effect of a feasibility study.

---

## 3. Which of the 34 pages is phone work?

The design question, and the answer is not "all of them". Classified by what the page asks a
person to *do*:

**Genuinely good on a phone — review and judgement (11).**
`dashboard`, `storyboard`, `shotboard`, `playback`, `notes`, `characters`, `locations`,
`props`, `stylebook`, `jobsqueue`, `moodboard`. These are look-at-it-and-decide surfaces: is
this frame right, is that plate the character, what is running, add a note, capture a shot idea
while it is in your head. The style book in particular is a phone feature that happens to live
on a desktop — you think of an angle away from the desk.

**Read-only on a phone, edited elsewhere (12).**
`scenes`, `milestones`, `budget`, `assets`, `renderhistory`, `provenance`, `rights`,
`musiccues`, `production`, `titles`, `subtitles`, `brand`. Useful to check, painful to edit with a thumb,
and nothing is lost by making them read-only. `titles` and `subtitles` are the clearest case of
that shape: a credit roll and a cue list are read to check a spelling, and typed with a keyboard.

**Desktop only, and that is correct (19).**
`screenplay` (a full-page editor with pagination), `previs` (a 3D stage with six-axis drag),
`flows` (an SVG graph canvas), `timeline`-adjacent work in `videoshots` and `selects`,
`colorgrading`, `colorpipeline`, `broadcastqc`, `dubbing`, `consistency`, `continuity`,
`exportpage`, `pipeline`, `projects`, `settings`, `threed`, `marketing`, `music`,
`deliverables` (a spec table of rasters and rates — read on a phone, filled in at a desk). These are
precision work on a large canvas. A phone version of the previs stage would be a worse tool that
took weeks.

So a mobile companion covering **11 pages properly** is worth more than 38 covered badly — which
is exactly the judgement NeonCore's README already made.

---

## 4. Three options

### Option A — the agent surface, which already works ✅ zero cost

**267 MCP tools** are reachable from Claude on a phone today. That is not a workaround; for this
codebase it is the native mobile interface. You can already, from a phone:

- read the screenplay, revise a scene, re-run a breakdown
- read and write scene cards, apply a style-book entry
- write music direction, generate a plate, regenerate a frame
- read the staleness, drift, impact and run-plan reports
- check spend and compare generators before spending

What it cannot do is **show you a picture and let you judge it**, which is the half that matters
most on a phone. It is a strong baseline and a poor gallery.

### Option B — make the shell responsive 🟡 about a day

The SPA already sends `width=device-width`, and 2.01MB over a LAN is fine. What is missing is
the shell: collapse the 260px sidebar to a drawer, let `body` scroll, stack the card grids, and
make the modals full-screen below 700px. Then bind the page server to the LAN and open it in
Safari.

**Cost:** one media query block and one binding change. **Risk:** low — additive CSS behind a
breakpoint changes nothing above it. **Ceiling:** the 18 desktop-only pages stay bad; they
simply become reachable-and-bad rather than unreachable.

This is the highest ratio of usefulness to effort by a wide margin.

### Option C — a native companion, the NeonCore shape 🔴 weeks

React Native, LAN-only, against the existing HTTP API — the same architecture as
`~/code/neoncore/mobile`, which proves the pattern works against a Gridlight backend. Scoped to
the 11 review pages, it would beat a responsive web view on the things phones are good at:
camera roll upload for reference plates, push when a long generation finishes, offline reading
of a shot list on set.

**Cost:** a second UI to keep in step with an SPA that changes daily — and this codebase's
recurring failure is exactly *two surfaces disagreeing*, which is what `effectiveCamera`, the
plate pointer and the storyboard frame pointer each cost. **It should not be started until the
feature set is stable.**

---

## 5. Recommendation

**Do A and B; do not do C yet.**

A is already true and should be said out loud rather than discovered: Claude on a phone is a
working Film Engine client for everything except looking at pictures.

B is a day and closes the gap A leaves — the eleven review pages become genuinely usable, and
*"is this frame right"* becomes answerable from the sofa. It needs one decision that is not
mine: **binding the page server to the LAN means an unauthenticated Film Engine on your
network.** On a home LAN that is probably fine; it should be a deliberate setting, defaulting
off, the way the Gridlight gateway switch already is.

C is the right shape eventually and the wrong time now. The thing that makes it expensive is not
React Native, it is the second surface — and this codebase has paid for a second surface
disagreeing with the first more than once in a single week.

**Order:** the LAN-binding setting (off by default), then the responsive shell for the 11 review
pages, then re-ask about C once the pipeline stops changing under it.
