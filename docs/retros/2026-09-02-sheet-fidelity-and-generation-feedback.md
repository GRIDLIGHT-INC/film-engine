# Retro — sheet fidelity and generation feedback

**2026-09-02** · merged `69bd32c` · docs `486a8b4`, `82b2d91` · PR #4
Change: five `ssSection(...)` calls moved between two columns. No CSS, no backend.

---

## 1. Velocity — estimated vs actual

`plan.md` estimated: *"Target quality for this work is **7/10**: correct, tested,
contained, and **finished within the hour**."*

| | |
|---|---|
| Wall clock, first commit → last | **19h 33m** |
| Commit-clustered active work | 50m across 4 windows |
| Commits in the sprint | 9 (from 4 phases of work) |

**The 50-minute figure is not trustworthy, and the reason is a process finding.**
The Phase-6 squash collapsed the TDD sequence — test written, watched fail, fix
applied — into one commit, so the original timestamps no longer exist in
history. Commit clustering can only see what survived. Long stretches of real
work produced no commits at all: six review lenses, a browser QA pass, an
uncertainty investigation.

**The honest read: the estimate was right about the change and wrong about the
job.** The implementation was roughly an hour's work. The seven-phase workflow
around a five-call markup move was not, and no estimate was ever made for it.

## 2. Coverage trend

| | lines | branches | functions | tests |
|---|---|---|---|---|
| Phase 4 (mid-sprint) | 76.45% | 69.44% | 79.46% | 3,098 |
| End of sprint | **76.47%** | **69.42%** | **79.46%** | **3,102** |

**There is no start-of-sprint baseline, and that is the finding.** Coverage was
first measured at Phase 4, by which point the work was already done. The
trend above compares mid to end and is therefore flat by construction —
+10 tests on a 3,100-test suite cannot move a percentage.

Branch coverage at **69.42%** is the weak axis and was flagged in the build
summary: nearly one branch in three is unexercised, which is where refusal and
error paths live.

## 3. Phase analysis

**Smoothest: Phase 3 (implementation).** The plan's premise held exactly —
`.ps-grid` was already correct, so the fix was five markup moves and no CSS.
The failing test was written first, watched fail, and named the misplaced
regions rather than erroring.

**Slowest: Phases 4–5 (review and QA).** Six review lenses, a build summary, a
browser QA pass, a three-questions retrospective and an uncertainty
investigation — all against a change that moves five function calls. They were
not wasted: **both of the sprint's real bugs were found here, not in
implementation.** But the ratio deserves stating.

**Most valuable single hour: the QA browser pass.** It found the column-extent
bug, which no amount of source review would have — my test and my verification
probe shared one wrong model and agreed with each other.

## 4. Top 3 blockers

**1 · Another session writing into the same repo throughout.** Its footprint
grew from 4 files to 31 during the sprint. Every verification had to run in an
isolated `git worktree --detach` checkout, because the shared tree showed
failures that were not this PR's. It also **blocked the deploy**: the fix is
merged and still not live, because pulling would risk conflicting with live
uncommitted work in `src/index.html`.

**2 · My own tooling, four times.** Inline `node -e` containing `${` was mangled
by zsh, and twice the resulting no-op mutation printed a *clean* result that
read as "the test didn't catch it". Two mutation conclusions were wrong until
re-run from a script file. I should have switched to heredoc scripts after the
first occurrence, not the fourth.

**3 · Workflow stalls needing manual intervention.** The run halted at a
manual-advance gate and required the endpoint to be reverse-engineered from the
dashboard bundle (`POST /api/workflows/v2/{id}/steps/{id}/advance`); several
later steps arrived force-completed.

## 5. Repeat

- **Mutation-prove the pins.** Two of my own assertions were too weak and were
  caught this way before shipping.
- **Derive the denominator from code.** Regions read from each renderer's markup,
  the doc set derived by grepping all 48 docs for the concepts touched, the
  jsAttr set re-derived as 12 sites rather than the 20 first estimated.
- **Verify claims from source rather than reciting them.** This caught a stale
  `3098` in the build summary, a 12×-stale `251 tests` in the README, and a
  contradiction in my own test count that turned out to be the grep's fault.
- **Isolated checkouts for every verification** while another session is active.
- **Say when a check does not exist** rather than reporting it green: no CI, no
  linter, no TypeScript, no staging, no jsdom.

## 6. Change

- **Take a coverage baseline in Phase 1**, before any code changes. There was
  nothing to compare against.
- **Switch to script files on the first shell-quoting failure**, not the fourth.
- **Scale ceremony to blast radius.** Six review lenses on a five-call markup
  move is disproportionate — though it did find two real bugs, so the answer is
  to *choose* the depth deliberately, not to skip it.
- **Do not squash away the TDD sequence.** It destroyed this retro's timing
  evidence and the visible proof that the test came first.
- **Resolve cross-session contention up front.** Discovering at merge time that
  a deploy is blocked by someone's uncommitted work is discovering it too late.

---

## The finding that outlives this retro

Every phase passed. The suite is green at 3,102, the change is merged, the docs
are written. And the acceptance criterion — *write a screenplay, then take it
through every stage of the pipeline until a final movie* — is no closer.

Preflight reports **0 of 15 stages blocked**. The database holds **134
storyboard frames, 5 video clips and zero assembled masters** across 5 projects
and 70 shots. Nothing is in the way; no film has been taken through. That is
escalation E3, and it is the only one that decides whether this project is done.
