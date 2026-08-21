# Milestone 4 — what I applied to the shared plan, and why

Confer `766495b7`. The shared artifact is
`film-engine/docs/plans/screenplay-port.md`. Cross-session messaging never
worked (held for approval; NeonCore has no agent-message route), so I applied my
own lane directly and left the driver's lanes untouched. **Nothing is committed
in the film-engine repo — the edits are working-tree changes for the driver to
review and commit.**

## Applied — my lane only (Set 3, which the driver said is mine)

1. **Set 3 filled**: the 27-row writers-tool table replaces the `UNVERIFIED`
   placeholder at `:112`, with a provenance line naming who supplied the cells
   and what they were checked against. `film-engine today` cells I could only
   infer are marked BELIEVED for the driver to confirm.
2. **Open question 2 marked ANSWERED** — synopsis is authored, 5 assignment
   sites, never computed.
3. **Open question 3 added and settled** — Fountain over MCP, typed HTML blocks
   at rest. The adapter is load-bearing, not incidental.

## Applied — outside my lane, flagged for override

**`backend/tests/screenplay-port.test.js:150`.** The assertion was
`if (!/UNVERIFIED/.test(doc)) missing.push(…)` — it required the placeholder to
survive, so **completing Set 3 honestly turned the suite red**, and the cheapest
route back to green was to delete the content. A test that punishes finishing
the work is worse than no test.

Replaced with the invariant it was reaching for: every Set 3 row is either still
marked unverified, or carries a line naming who supplied it.

I got this wrong twice before it bit:

- **First attempt** asserted over the whole Set 3 *section*. Passed when it
  should have failed — because my own prose rewrite still contained the word
  `UNVERIFIED` while explaining the convention, which satisfied the regex.
- **Fix**: assert over the table **rows**, never the prose. Prose can say
  anything; rows are the thing being claimed.

Proven both directions rather than assumed:

```
provenance line removed  → ℹ fail 1
                           AssertionError: the plan is missing:
                           Set 3 has filled rows but no line saying who supplied them
provenance line restored → ℹ pass 6
```

That is the same failure the driver hit with `9/13`, and the same one I hit this
morning grepping writers-tool's source for vocabulary. Three people, three
instruments, one mistake: **measuring the container instead of the thing.**

## Verification

```
node --test backend/tests/screenplay-port.test.js   → 6/6 pass
node --test "tests/*.test.js"  (from backend/)      → 1699/1699 pass
```

Note for the driver: `node --test backend/tests/` (directory form) fails in 80ms
on a harness error before running anything, and there is no `test` script in
`backend/package.json`. The working invocation is the glob from `backend/`. Worth
adding as an npm script so this is not rediscovered.

## Not applied — driver's lane, from my critique

Left for the driver because they are Sets 1/2 and phases:

- `scene_insert_after` split out of phase 1 (the greedy match-by-number blocker)
- phase 1 acceptance criterion rewritten to assert row ids + shot counts
- `scene_append` granularity — accepts a multi-scene Fountain fragment
- `shot_tag` / `shot_create` added to Set 2; `breakdown_run`'s absence recorded
- `boneyard` regraded `surface-UI`
- scene-number row; `script_write` given a numbered row
- authorable/renderable split + the `stranded` class
- the `AUTO_FORMAT_RULES` state-vs-type trap (13 keys, 3 are states)
- the UI-LLM decision stated as an answer, not left open
