const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const EPIC = path.join(REPO, 'docs', 'plans', 'redo-between-frames-epic.md');
const src = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const epic = () => fs.readFileSync(EPIC, 'utf8');

/**
 * AN EPIC IS A PROMISE ABOUT THE CODE, AND THE CODE MOVES.
 *
 * This one is read to size and sequence real work: it says what exists, what is
 * missing, and what a task will cost. Every one of those is a claim about the
 * source, and a claim that has drifted is worse than no document — it is
 * confidently wrong about the thing somebody opened it to check. That failure
 * has already been paid for once here, when a build order said "Not started"
 * against five shipped items and sent the same work round twice.
 *
 * Set-based over three registries: the sections the template mandates, the
 * phases and tasks the epic itself declares, and the claims it rests on.
 */

/** The template's own required structure. */
const REQUIRED_SECTIONS = [
    '# Epic:', '## Overview', '## Business Goals', '## Current State',
    '## Target State', '## Constraints', '## Task Breakdown',
    '## Open Questions', '## Success Metrics',
];

/**
 * Claims about this codebase. Checked against the SOURCE, never against the
 * brief — which is a secondary source and could have drifted too.
 */
const CLAIMS = [
    { id: 'video-sequence exists', why: 'the planner precedent tasks are told to mirror',
      holds: () => fs.existsSync(path.join(REPO, 'backend/lib/video-sequence.js')) },
    { id: 'inbetweens exists', why: 'the station model a marked range may reuse',
      holds: () => fs.existsSync(path.join(REPO, 'backend/lib/inbetweens.js')) },
    { id: 'concat exists', why: 'joining is shipped; only trimming is not',
      holds: () => /function buildConcatArgs/.test(src('backend/lib/ffmpeg.js')) },
    { id: 'no trim helper yet', why: 'the first build task; asserted ABSENT so it self-retires',
      holds: () => !/function (buildTrimArgs|buildSpliceArgs|trimClip)/.test(src('backend/lib/ffmpeg.js')) },
    { id: 'first-last-frame takes 2 images', why: 'the mechanism the epic is built on',
      holds: () => /'first-last-frame':\s*\{\s*images:\s*2\s*\}/.test(src('backend/lib/providers/seedance.js')) },
    { id: 'first-last-frame uses images_list', why: 'the field name; MuAPI is not uniform',
      holds: () => /'first-last-frame':\s*'images_list'/.test(src('backend/lib/providers/seedance.js')) },
    { id: 'duration floor is 4s', why: 'the constraint that shapes acceptance criteria',
      holds: () => /MIN_DURATION\s*=\s*4\b/.test(src('backend/lib/providers/seedance.js')) },
    { id: 'duration ceiling is 30s', why: 'the upper bound on one re-roll',
      holds: () => /MAX_DURATION\s*=\s*30\b/.test(src('backend/lib/providers/seedance.js')) },
    { id: 'rates 0.17 / 0.85 / 1.70', why: 'every cost figure in the epic',
      holds: () => {
          const s = src('backend/lib/providers/seedance.js');
          return /usdPerSecond:\s*0\.17/.test(s) && /usdPerSecond:\s*0\.85/.test(s)
              && /usdPerSecond:\s*1\.70/.test(s);
      } },
    /* Was "extraction at 3 sites" — RBF-003 consolidated it, so this now pins
     * the helper and fails if a fourth local copy appears. */
    { id: 'frame extraction is one helper', why: 'the consolidation task, done',
      holds: () => /function extractFrame/.test(src('backend/lib/ffmpeg.js'))
          && ['backend/routes/characters.js', 'backend/lib/review-proxy.js',
              'backend/lib/mcp-tools.js'].every(f => !/'-frames:v'/.test(src(f)) && /extractFrame/.test(src(f))) },
    { id: 'playback scrubs, cannot mark', why: 'the surface task',
      holds: () => { const p = src('src/index.html');
                     return /pbScrub/.test(p) && !/pbMarkIn|pbMarkOut/.test(p); } },
    { id: 'video-edit sends no images', why: 'what the probe task changes',
      holds: () => /images:\s*\[\]/.test(src('backend/lib/providers/seedance.js')) },
    { id: 'color-match exists', why: 'the remedy named for the colour open question',
      holds: () => /'color-match'/.test(src('backend/routes/post-production.js')) },
    /*
     * THE CORRECTION THE EPIC HAD TO MAKE.
     *
     * The brief said inheriting the source clip's model and resolution was
     * "free — the values are already stored per generation". The columns exist
     * and are EMPTY: measured on the live database, all five video assets carry
     * no provider_model and no width/height, including the three generated
     * in-engine. So the epic must probe the file, not read the row. Asserted as
     * a schema fact rather than a data count, because a test that depends on
     * this install's rows would pass or fail by accident elsewhere.
     */
    { id: 'the columns inherit would read DO exist in the schema',
      why: 'the epic says the columns exist and are empty, so it probes the file instead; '
         + 'if they were absent the epic would be wrong about WHY inherit fails',
      holds: () => {
          // Across every migration, not one guessed filename: the columns were
          // added by later ALTERs, so scanning the CREATE alone misses them.
          const dir = path.join(REPO, 'backend', 'db', 'migrations');
          const all = fs.readdirSync(dir).filter(f => f.endsWith('.sql'))
              .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
          return /provider_model/.test(all) && /\bwidth\b/.test(all) && /\bheight\b/.test(all);
      } },
];

test('the epic exists', () => {
    assert.ok(fs.existsSync(EPIC), `no epic at ${path.relative(REPO, EPIC)}`);
});

test('every section the template mandates is present', () => {
    const e = epic();
    const missing = REQUIRED_SECTIONS.filter(s => !e.includes(s));
    assert.deepStrictEqual(missing, [], `sections missing: ${missing.join(', ')}`);
});

/* Phases and tasks are the epic's OWN registry — read them out of it rather
 * than assuming a count, so a phase added later is covered. */
test('every declared task is well formed', () => {
    const e = epic();
    const phases = [...e.matchAll(/^### Phase \d+: (.+)$/gm)].map(m => m[1]);
    assert.ok(phases.length >= 2, `only ${phases.length} phase(s); the template requires at least 2`);

    const rows = [...e.matchAll(/^\|\s*(RBF-\d{3})\s*\|([^|]+)\|([^|]+)\|\s*([SML])\s*\|([^|]+)\|/gm)];
    assert.ok(rows.length >= 6, `only ${rows.length} tasks parsed; an epic this size needs more`);

    /*
     * EVERY DECLARED TASK MUST PARSE.
     *
     * A malformed row — a missing size, a dropped column — simply stops matching
     * the pattern, so it leaves the set instead of failing it, and every
     * assertion below then holds over the rows that happened to be well formed.
     * Proven by mutation: deleting one task's size left this green. Counting the
     * ids independently of the row pattern is what closes it.
     */
    const declared = [...e.matchAll(/^\|\s*(RBF-\d{3})\s*\|/gm)].map(m => m[1]);
    assert.strictEqual(rows.length, declared.length,
        `${declared.length} task rows are declared and only ${rows.length} parse — `
        + `malformed: ${declared.filter(id => !rows.some(r => r[1] === id)).join(', ')}`);

    const ids = rows.map(r => r[1]);
    assert.deepStrictEqual(ids, [...new Set(ids)], 'duplicate task ids');

    for (const r of rows) {
        const [, id, title, desc, size, deps] = r;
        assert.ok(title.trim().length > 3, `${id} has no title`);
        assert.ok(desc.trim().length > 20, `${id} has a description too thin to act on`);
        assert.ok(['S', 'M', 'L'].includes(size), `${id} has size "${size}"`);
        const d = deps.trim();
        assert.ok(d.length > 0, `${id} does not state its dependencies`);
        // A dependency must name a task that exists, or say None.
        if (!/^none$/i.test(d)) {
            for (const dep of d.split(/[,+]/).map(x => x.trim()).filter(Boolean)) {
                assert.ok(ids.includes(dep), `${id} depends on "${dep}", which is not a task in this epic`);
            }
        }
    }
});

test('every claim the epic rests on still holds in the code', () => {
    assert.ok(CLAIMS.length >= 13, `only ${CLAIMS.length} claims; this is not the real set`);
    const broken = CLAIMS.filter(c => !c.holds()).map(c => `${c.id} (${c.why})`);
    assert.deepStrictEqual(broken, [], `the epic asserts these and the code disagrees:\n  - ${broken.join('\n  - ')}`);
});

/* The decisions that shape the work must be stated, not merely true. */
test('the epic states the constraints that decide the design', () => {
    const e = epic();
    for (const [what, re] of [
        ['the 4-second floor', /4[- ]second|\b4s\b|MIN_DURATION/],
        ['the probe going first', /probe/i],
        ['that inherit cannot read the row', /provider_model|probe the file|ffprobe/i],
        ['the cost per second', /0\.17/],
    ]) assert.match(e, re, `the epic never states ${what}`);
});
