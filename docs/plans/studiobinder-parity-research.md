# Deep Research: StudioBinder Feature Parity for AI Film Production

**Subject:** What StudioBinder provides, what Film Engine provides, and what is missing to reach
parity — reinterpreted for a pipeline where the crew is a set of generation providers.

**Date:** 2026-08-18 · **Method:** web research (StudioBinder's own product pages) + local
inventory derived from code (43 route modules, 64 tables), not from CLAUDE.md prose.

---

## Web Findings

| Source | URL | Key insight |
|---|---|---|
| All-in-One Film Production Software | https://www.studiobinder.com/film-production-software/ | The canonical module list: screenwriting, AV scripts, breakdown/element tagger, stripboards, sides, mood boards, shot lists, storyboards, contacts CRM, calendar, task boards, media library, call sheets (+templates, attachments, private notes, distribution, analytics), reports, view-only links. |
| Movie Production Software | https://www.studiobinder.com/movie-production-software/ | Names the four report types explicitly — **breakdown summary, elements list, DOOD report, shooting schedule** — and that call sheets auto-populate weather, locations and **nearest hospitals**. Distribution is email **and SMS**, with delivery/bounce/view/confirmation tracking. |
| Storyboard Blocking | https://www.studiobinder.com/storyboard-blocking/ | Panels carry scene number, description, notes, and an image; an editor adds **arrows, text, shapes** to mark movement paths. Panels group by scene/location/**shooting day**. Shot specs (type, angle, lens, frame rate) are *linked to* blocking notes. Export: **PDF with blocking notes**, or view-only links with comments. |
| Shot List / Shot Designer | https://www.studiobinder.com/shot-list-storyboard/ · /shot-designer/ | Shot fields: size, movement, lens, **focal length**, frame rate, angle, sound, equipment, location. Shots group into **camera/lighting setups**, drag-reordered into an efficient shooting order. **Shot Tagger**: select a line of action or dialogue in the script and a shot is created from it. |
| Enterprise | https://www.studiobinder.com/enterprise/ | Roles are **Owner / Admin / Member**; users see only assigned projects; centralized admin console; SSO on request; activity feeds; whitelabelling (brand colors, subdomain, email/report branding). |
| Breakdown automation (third-party review) | https://www.techjockey.com/us/detail/studiobinder · https://filmustage.com/filmustage-as-an-alternative-to-studiobinder/ | The load-bearing claim is **propagation**, not tagging: "changes made to a scene in the script automatically update across your breakdown, schedule, and call sheets." Also: create shot lists directly from script descriptions. |
| AI filmmaking tools roundup (StudioBinder's own blog) | https://www.studiobinder.com/blog/ai-filmmaking-tools/ | StudioBinder positions AI tools as *adjacent* to its workflow, not inside it. It has no generation, no previs 3D, no provider/model layer — which is the whole axis Film Engine is built on. |

**What StudioBinder does not have** (relevant because parity is not the ceiling): no media
generation, no provider/model routing, no render reproducibility ledger, no 3D previs, no NLE
export, no cost-per-generation forecasting, no agent/MCP surface.

---

## Local Findings

Derived by probing the code, not by reading docs. Several apparent matches were **false
positives** and are recorded as such, because they are the ones that would otherwise be scored
as parity:

| Probe | Result | Note |
|---|---|---|
| `lib/scheduling-engine.js` | **Not production scheduling** | It is GPU model-residency and VRAM batching (`MODEL_PROFILES`, `buildSchedule`). No stripboard, no shoot days. |
| "crew/departments" | False positive | Matched a comment in `013_film_shot_notes.sql` ("department notes"). |
| "AV scripts / two-column" | False positive | Matched the word *JavaScript*. |
| "production documents / contracts" | False positive | Matched `prompt_contract` in `routes/consistency.js`. |
| "permissions/roles/users" | False positive | Matched `required_roles` in `045_consistency_profiles.sql`. **No user, team, auth or session table exists** (`SELECT ... LIKE '%user%'` → NONE). |
| email/SMS capability | NONE | Backend has exactly one dependency, `better-sqlite3`. No nodemailer/SMTP/Twilio/SendGrid. |

**Genuinely present and StudioBinder-comparable:** `routes/scripts.js` (Fountain parse/render,
versions, revisions, FDX in/out, title page), `routes/breakdown.js` (AI breakdown, SSE),
`routes/shots.js` + `film_shots` (shot list, ordering, transitions), `routes/storyboard.js`
(generated keyframes), `routes/call-sheets.js` (generated scene/project call sheets),
`routes/notes.js` (`film_shot_notes`, review workflow), `film_screenplay_comments`,
`routes/budget.js` + `film_cost_entries`, `film_milestones` (phase + target/actual dates),
`routes/continuity.js` (`film_continuity_refs` — the closest thing to a mood board),
`routes/acts.js` (episodic/act structure), `routes/assets.js` (`film_assets`, 22 types).

**Present and *beyond* StudioBinder:** `routes/previs.js` + `lib/previs-*.js` (3D blocking with
real optics), `routes/flows.js` (node-graph pipelines), `routes/providers.js` (11 capabilities),
`render_ledger`, `routes/qa.js`, `lib/nle-export.js` (FCPXML/EDL/Premiere/FDX), `routes/takes.js`,
`routes/consistency.js`, `backend/mcp-server.js` (64 tools).

---

## Gap Matrix — 42 StudioBinder features

Verdicts: **HAVE** (comparable or better) · **PARTIAL** (exists, materially short) · **MISSING**.
"AI reading" is what the feature should become when the crew is a set of providers.

### Writing & Script (7)
| # | StudioBinder feature | Verdict | AI reading / gap |
|---|---|---|---|
| 1 | Industry-standard screenwriting | HAVE | Full Fountain editor + renderer. |
| 2 | Script versions | HAVE | `film_scripts` versioned. |
| 3 | Title page designer | HAVE | Built. |
| 4 | Script outlines / episodic structure | PARTIAL | `film_acts` exists; no outline view. |
| 5 | Co-writer collaboration / client approval | MISSING | No users, so no "approve" by anyone in particular. |
| 6 | **AV scripts (two-column)** | MISSING | Real gap for commercials/trailers — a two-column AV script maps directly onto per-shot generation + VO. |
| 7 | Production documents / contracts | MISSING | Low value here; rights already live in `film_rights`. |

### Breakdown (5)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 8 | Script breakdown | HAVE | AI breakdown, SSE-streamed. |
| 9 | **Element tagger (colour-coded, per-scene)** | PARTIAL | `film_scene_props` / `film_scene_characters` exist; there is no tagging surface and no colour taxonomy. |
| 10 | **Custom breakdown categories** | MISSING | Categories are hard-coded enums. |
| 11 | Breakdown summary / elements list report | MISSING | No report export. |
| 12 | **Change propagation (script → breakdown → schedule → call sheet)** | MISSING | The single most load-bearing StudioBinder behaviour. Editing a scene here does **not** invalidate downstream scene cards, plates or frames. |

### Scheduling (5)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 13 | **Stripboard / shooting schedule** | MISSING | AI reading: a **run plan** — order shots into generation batches by provider/model, with cost and wall-clock per strip. `lib/scheduling-engine.js` already does the GPU half; it has no shoot-day/strip concept. |
| 14 | Auto-sort (location, cast, page length) | MISSING | AI reading: sort by **model residency and plate reuse**, not by driving distance. |
| 15 | Alternate schedules | MISSING | AI reading: A/B run plans under a budget ceiling. |
| 16 | **DOOD report** | MISSING | AI reading: which character appears in which shots → drives refsheet/voice needs and per-character spend. Data exists in `film_scene_characters`; nothing reports it. |
| 17 | **Script sides** | MISSING | AI reading: per-character dialogue packet — directly useful for voice generation review. |

### Visualisation (7)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 18 | Shot list (size, angle, lens, focal, movement, fps, equipment) | HAVE | Scene cards carry all of it; previs adds real optics. |
| 19 | **Shot Tagger (select script line → create shot)** | MISSING | High value: the fastest path from screenplay to shot list, and we make the user create shots by hand or by agent. |
| 20 | **Camera/lighting setups (grouping + reorder)** | PARTIAL | Rig exists per shot; no grouping of shots into setups. AI reading: group by **plate/style/seed reuse**. |
| 21 | Storyboards | HAVE (beyond) | We *generate* panels; SB uploads sketches. |
| 22 | **Storyboard annotation (arrows, text, shapes)** | MISSING | A director cannot mark up a generated frame — the natural way to say "move her left" before re-generating. |
| 23 | **Panel grouping (by scene / location / shooting day)** | MISSING | Board is a flat grid. |
| 24 | **Mood boards** | MISSING | AI reading: this is the **style/reference board** — the thing that should feed `style_preset` and plates. We have `film_continuity_refs` and plates but no board where a look is assembled *before* generating. |

### Contacts & Call Sheets (7)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 25 | Contacts / CRM, headshots, day rates | PARTIAL | `film_characters` + `film_voice_profiles` cover the *cast* analogue; no crew/vendor records. Day rates exist on characters. |
| 26 | Custom contact lists | MISSING | — |
| 27 | Call sheet builder | HAVE | Generated per scene/project. |
| 28 | **Call sheet templates** | MISSING | — |
| 29 | **Distribution (email + SMS)** | MISSING | No mail/SMS dependency at all. AI reading: notify on **run completion**, not on crew call. |
| 30 | **Delivery analytics (sent/delivered/viewed/confirmed)** | MISSING | — |
| 31 | Auto-populated weather / hospitals | MISSING | **Not applicable** to AI production; explicitly out of scope. |

### Project Management (6)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 32 | **Gantt production calendar** | PARTIAL | `film_milestones` has phase + target/actual dates; no timeline view. |
| 33 | **Task boards (assign, due, checklists, attachments)** | MISSING | AI reading: the natural home for "shots awaiting approval / re-generation". |
| 34 | Task notifications | MISSING | — |
| 35 | **Media library (browse/upload/organise)** | PARTIAL | `film_assets` is a registry with 22 types; there is no library UI and no arbitrary upload. |
| 36 | Budget tracking | HAVE (beyond) | Ledger, forecast, limit, plus pre-flight cost estimation and a 402 budget gate. |
| 37 | Reports (custom, styled, exportable) | MISSING | Dashboard/QA exist; no report artefacts. |

### Collaboration & Platform (5)
| # | Feature | Verdict | AI reading / gap |
|---|---|---|---|
| 38 | **Users, teams, roles (Owner/Admin/Member)** | MISSING | No user/auth/team table exists. Everything else in this section depends on it. |
| 39 | **View-only share links** | MISSING | The natural way to show a client a board or a cut. |
| 40 | Comments / feedback | PARTIAL | Screenplay comments + shot notes exist; no comment on a *frame* or a *board*. |
| 41 | Activity feed | MISSING | AI reading: a run/spend audit trail, partly latent in `render_ledger`. |
| 42 | SSO / whitelabel / mobile | MISSING | Enterprise-tier concerns; lowest priority. |

**Tally: 8 HAVE (6 comparable + 2 beyond) · 7 PARTIAL · 27 MISSING** — counted off the matrix
rows, not estimated. One of the 27 (weather/hospitals) is deliberately out of scope for AI
production, so the real target is 26.

---

## Key Ideas & Themes

1. **The gap is not the creative tools — it is the connective tissue.** Film Engine matches or
   beats StudioBinder on script, shot list, storyboard and blocking, and is far ahead on
   generation, previs optics, cost control and reproducibility. What is missing is almost
   entirely *production management*: schedule, tasks, reports, contacts, sharing, identity.

2. **Change propagation is the highest-value single feature.** StudioBinder's real claim is that
   editing a scene updates the breakdown, schedule and call sheets. Our equivalent is stronger
   and entirely absent: editing a scene should mark its **scene card, plates and generated
   frames stale**. We already proved the failure mode — a clip-art plate survived its own fix
   by fourteen hours and silently poisoned every frame that referenced it. Staleness propagation
   is the parity feature *and* the correctness fix.

3. **Every scheduling feature translates, but the axis rotates.** A stripboard minimises travel
   and cast idle time; a run plan minimises **model swaps, plate re-generation and spend**.
   `scheduling-engine.js` already optimises GPU residency — it needs a shoot-day/strip abstraction
   above it and a cost projection beside it (`lib/flow-cost.js` exists).

4. **The mood board is the missing front of the pipeline.** A director assembles a look *before*
   shooting. We generate plates from text and have no surface where references are gathered and
   a style is decided — which is exactly why `style_preset` ended up carrying the subject noun
   "anatomical beast" and put a creature in an establishing shot meant to be empty.

5. **Storyboard annotation is the missing back of the loop.** We can generate a frame and
   re-block it in 3D, but a director cannot draw on the frame. Arrows and shapes are the
   fastest known notation for "move her left, push in" — and in our pipeline that markup could
   feed the next generation rather than a human artist.

6. **Identity is the keystone for a third of the matrix.** Roles, share links, frame comments,
   activity feed, approvals and client review all sit on a user table that does not exist. It
   is one schema decision gating ~8 features.

7. **Two features should be reinterpreted rather than copied.** Call-sheet SMS distribution and
   weather/hospital lookup have no AI-production meaning; the useful version is **run
   notification** (a generation batch finished, cost X, N shots failed) delivered wherever the
   director already is — which, given the MCP surface, is plausibly the agent host.

8. **Sides and DOOD are cheap and already latent.** Both are reports over data we already store
   (`film_scene_characters`, dialogue in scene cards). They are among the lowest-effort,
   highest-credibility parity wins.
