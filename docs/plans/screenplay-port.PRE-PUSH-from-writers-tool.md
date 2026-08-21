# Pre-push review — two things before you commit

Confer `766495b7`. You asked for a shout before pushing. Set 3 and the test fix
are fine as merged — no changes wanted there. Two items in **your** lane did not
make it in, and the first is a correctness issue.

## Verified on my side, independently

`authorable 6/13` is right. Re-derived without reading your script: 5 classifier
seeds (`action, character, parenthetical, scene-heading, transition`), plus
`dialogue` reachable through `nextType`. Your reachability-not-membership
framing is the correct one and it is why 5 was wrong.

One small correction for the record: scanning `AUTO_FORMAT_RULES` `nextType`
pairs, the only self-loop I find is `'action': 'action'` — not `'lyrics'`. The
*conclusion* is unaffected (a self-loop is not a way in either way), but if the
plan cites `lyrics` as the example it will not survive a reader checking it.

## BLOCKER — `scene_insert_after` is still in phase 1

`screenplay-port.md`, Phase 1 line 2. My M3 critique on this was not applied and
I do not think the phase can ship with it.

`syncScenesWithScreenplay` matches by `scene_number` **first and greedily**
(`routes/scripts.js:322-363`). Insert at position *k* and every row from *k*
down is overwritten with its **predecessor's** text; `stampScene` moves each
fingerprint; pass 2 cannot recover them because pass 1 already consumed those
rows by number. That is not a risk, it is the deterministic result of the
matching order, on every call.

`scene_append` is safe and for a specific reason worth keeping in the plan:
appended scenes take fresh numbers, 1..N−1 match with identical text, `moved()`
is false, and `stampScene` short-circuits on an unchanged fingerprint
(`lib/screenplay-drift.js:73`).

**Asked change:** split the line. `scene_append` phase 1. `scene_insert_after`
phase 1 **only with** an identity that survives renumbering — Fountain scene
numbers (`#3#`, the parser already reads them) or a `meta` id — otherwise
deferred with *From the Mist* importing strictly in order, which is fine for a
first pass and much better than discovering it after 40 chapters.

## The acceptance criterion still asserts the wrong thing

Current: *"adding chapter N leaves scenes 1..N−1 byte-identical."*

Shots hang off scene **row ids**. The reconciler can preserve text while
reassigning which row holds it — which is exactly the insert failure above.
Byte-identical passes; the scene→shot mapping is already destroyed. And because
the criterion only describes appending, insert is never exercised by it.

**Asked change:**

> **Done when:** appending chapter N leaves scenes 1..N−1 with the same **row
> ids**, the same `source_fingerprint`, and the same **shot counts** — asserted
> on a project that has shots, not an empty one. Insert is held to the same bar
> or explicitly deferred.

An empty project cannot demonstrate this bug. The test needs something to lose.

## Phase 1 reaching shots — conceding, with the scope flag standing

You extended phase 1 past writing over my objection. I still think coupling an
import primitive to a production stage risks making phase 1 unshippable, and
*From the Mist* cannot be imported **at all** today.

But you are the driver, your reasoning is on the record, and `shot_tag` /
`shot_create` already exist — so the coupling is to something real rather than
to work that has yet to happen. I withdraw the objection **on the condition**
that the scope question gets settled by Manny rather than by us:

> The criterion "every stage of the pipeline until a final movie" is **not in my
> copy of the task**. Mine reads: screenplay functions, "use ONLY film engine to
> write screenplays", and load the novel chapter by chapter. Full stop.

If your text is authoritative, phase 1 as you have written it is right. If mine
is, phase 1 is carrying a stage the user did not ask for while the thing he did
ask for is still blocked. That is a question for him, and the plan should say so
in `## Open questions` rather than resolving it silently in a phase boundary.

## Agreed, no changes wanted

Set 3 as merged · the `stranded` class · authorable/renderable split · the
rabbit-hole section marked NEEDS MANNY · `send_to_film_engine` reframing ·
recording our shared substring-match bug as a section.

On that last one — your generalisation is better than mine and I would adopt it
verbatim: **a conformance test that goes red when the work is done correctly
will be deleted, not fixed.**

---

# Milestone 5 — confirmation

Verified against the landed commits (`e5ac0e3`, `eed987f`), not taken on trust.

## Confirmed accurate

| claim | how checked | result |
|---|---|---|
| Set 3 merged verbatim | diffed my 27 source rows against the merged table by row number | **27/27 present, 0 altered** |
| `authorable 6/13` | re-derived: 5 classifier seeds + `dialogue` via `nextType` reachability | ✓ |
| `stranded` = centered, lyrics, note | one toggle command exists in the whole editor (`toggleDualDialogue`, `src/index.html:16898`); no classifier or Tab path for the three | ✓ |
| plan conformance test | `node --test backend/tests/screenplay-port.test.js` | **7/7** |
| full backend suite | `node --test "tests/*.test.js"` from `backend/` | **1700/1700** |
| working tree clean | `git status --short` | ✓ (only my pre-push note untracked) |

Their statement of what this is **not** is accurate and I would not soften it:
a plan and a test were delivered, not the capability. Nothing in phases 1–3 is
implemented.

## One omission — the only correction I have

**The `scene_insert_after` blocker is not recorded anywhere in the plan.**
`grep -cin "greedy|match.*scene_number.*first|insert.*renumber|stable identity"`
→ **0**. And phase 1 still reads:

```
- `scene_append`, `scene_insert_after` — route + MCP tool
Done when: … adding chapter N leaves scenes 1..N−1 byte-identical …
```

Both halves of my M3 critique survive unaddressed:

1. **`scene_insert_after` cannot be built as scoped.**
   `syncScenesWithScreenplay` matches by `scene_number` first and greedily
   (`routes/scripts.js:322-363`). Insert at *k* and every row from *k* down is
   overwritten with its predecessor's text, each fingerprint moves, and pass 2
   cannot recover them because pass 1 consumed those rows by number. Whoever
   implements phase 1 will discover this on the first insert into a project that
   has shots.
2. **Byte-identical is the wrong assertion.** Shots hang off scene **row ids**.
   The reconciler can preserve text while reassigning which row holds it — which
   is precisely the insert failure. The criterion passes while the scene→shot
   mapping is destroyed, and it never exercises insert at all.

This is not a disagreement about judgement; it is a fact about the matching
order that the plan does not contain. Everything else I raised was either
applied or consciously overruled, which is fine. This one appears to have been
missed rather than decided.

**Minimum fix**, whoever picks it up: split the phase-1 line so `scene_append`
ships alone, and change *Done when* to assert **same row ids, same
`source_fingerprint`, same shot counts, on a project that has shots**. An empty
project cannot show the bug.

## Scope, still unsettled — for Manny, not for us

The plan is built on *"every stage of the pipeline until a final movie"*. That
sentence is **not in my copy of the task**, which reads: screenplay functions,
"use ONLY film engine to write screenplays", load the novel chapter by chapter.

If the driver's text is authoritative, phase 1 is correctly scoped. If mine is,
phase 1 carries a production stage the user did not ask for while the thing he
did ask for — importing *From the Mist* — stays blocked. Worth one sentence from
him before phase 1 starts.

---

# Final check of `4061a86` — one residual, not a blocker

Verified independently on the landed commit:

| claim | result |
|---|---|
| plan test | **8/8** |
| full backend suite | **1701/1701** |
| phase 1 uncoupled from shots | ✓ — reads *"a chapter can be imported at all"*, `scene_append` only |
| `scene_insert_after` excluded and blocked | ✓ |
| shots handoff leads phase 2 | ✓ |
| the counting trap actually bites | ✓ — set `STATES = ['default']` and got `AssertionError: AUTO_FORMAT_RULES has keys that are neither an element type nor a known state: after-scene, in-dialogue` |

## The residual: phase 1's *Done when* is still byte-identical

> *"adding chapter N leaves scenes 1..N−1 byte-identical."*

**This is now much weaker than it was, not wrong.** With insert removed, append
is the only operation, and for append byte-identical text really is sufficient:
scenes keep their numbers, pass 1 matches them, the unconditional UPDATE writes
identical values, and `stampScene` short-circuits on an unchanged fingerprint.
So the criterion does not currently hide a bug.

Two reasons I would still strengthen it, and neither is worth holding the close:

1. **It passes trivially on an empty project.** Nothing in the criterion says the
   test must run against a project that *has shots*. The failure mode being
   guarded is "shots go stale", and a project with no shots cannot demonstrate
   it either way.
2. **It asserts text, and the thing at risk is identity.** Shots hang off scene
   **row ids**. Today append preserves them as a consequence of match-by-number,
   not because anything checks. If reconciliation is ever changed — and phase 2
   changes reconciliation, since that is where insert's stable identity has to
   come from — byte-identical text can hold while row ids move, and this
   criterion would stay green through it.

**One-line strengthening, for whoever writes the phase 1 test:**

> **Done when:** appending chapter N leaves scenes 1..N−1 with the same **row
> ids**, the same `source_fingerprint`, and the same **shot counts** — on a
> project that has shots.

That is the same assertion insert will need in phase 2, so writing it now means
phase 2 inherits a test rather than needing a new one.

## Otherwise: confirmed, close it

Everything I raised across M3–M5 is either applied or consciously overruled with
the reasoning recorded. I have no further corrections.
