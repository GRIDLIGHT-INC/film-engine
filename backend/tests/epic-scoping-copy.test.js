const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCE = path.join(__dirname, '..', '..', 'docs', 'plans', 'redo-between-frames-epic.md');
const SCOPING = '/Users/mannyhenri/Documents/Git/gridlight/.claude/scoping';
const SLUG = 'redo-between-frames';
const COPY = path.join(SCOPING, `EPIC-${SLUG}.md`);

/**
 * A SCOPED EPIC THAT IS NOT THE EPIC IS WORSE THAN NO COPY.
 *
 * The instruction is "do not modify the epic content — copy it exactly", and the
 * failure it guards against is silent: a copy written by re-typing the content
 * through a heredoc or a template can lose a backtick, expand a `$`, or stop
 * early, and the result still looks like an epic. Nobody reads two files
 * side by side to notice.
 *
 * So identity is checked by HASH, and the structure is checked independently on
 * the copy — because a hash match proves the bytes and says nothing about
 * whether the source itself carried every section, while the structure checks
 * would pass on a file that was correct and truncated identically in both
 * places. Neither alone is enough.
 */

const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** What the template mandates — the same registry the epic's own test uses. */
const REQUIRED_SECTIONS = [
    '# Epic:', '## Overview', '## Business Goals', '## Current State',
    '## Target State', '## Constraints', '## Task Breakdown',
    '## Open Questions', '## Success Metrics',
];

test('the scoping copy exists', () => {
    assert.ok(fs.existsSync(COPY), `no epic at ${COPY}`);
});

test('the copy is byte-identical to the source', () => {
    assert.strictEqual(sha(COPY), sha(SOURCE),
        'the scoping copy differs from the epic it was copied from — '
        + `${fs.statSync(COPY).size} bytes against ${fs.statSync(SOURCE).size}`);
});

test('every mandated section survived the copy', () => {
    const c = read(COPY);
    const missing = REQUIRED_SECTIONS.filter(s => !c.includes(s));
    assert.deepStrictEqual(missing, [], `sections lost in the copy: ${missing.join(', ')}`);
});

/*
 * Task ids are counted on BOTH sides. A copy that stopped early keeps every
 * heading it had already written, so a section check alone passes on a file
 * truncated mid-table — which is exactly what a partial write looks like.
 */
test('every task survived the copy', () => {
    const ids = (s) => [...s.matchAll(/\bRBF-\d{3}\b/g)].map(m => m[0]);
    const inSource = new Set(ids(read(SOURCE)));
    const inCopy = new Set(ids(read(COPY)));
    assert.ok(inSource.size >= 10, `only ${inSource.size} tasks in the source; this scan is wrong`);
    const lost = [...inSource].filter(id => !inCopy.has(id));
    assert.deepStrictEqual(lost, [], `tasks lost in the copy: ${lost.join(', ')}`);
});

/* The slug must be kebab-case and match what the directory already does. */
test('the filename follows the scoping convention', () => {
    assert.match(path.basename(COPY), /^EPIC-[a-z0-9]+(-[a-z0-9]+)*\.md$/,
        'the filename is not EPIC-<kebab-case>.md');
    const siblings = fs.readdirSync(SCOPING).filter(f => /^EPIC-.*\.md$/.test(f));
    assert.ok(siblings.length >= 2,
        `only ${siblings.length} EPIC files; cannot confirm the convention`);
    for (const f of siblings) {
        assert.match(f, /^EPIC-[a-z0-9]+(-[a-z0-9]+)*\.md$/,
            `${f} breaks the convention this copy was matched against`);
    }
});
