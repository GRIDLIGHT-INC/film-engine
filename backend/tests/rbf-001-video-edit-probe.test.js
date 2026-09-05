const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const VERDICT = path.join(REPO, 'docs', 'plans', 'rbf-001-video-edit-probe.md');
const doc = () => fs.readFileSync(VERDICT, 'utf8');

/**
 * RBF-001 — does `video-edit`'s `images_list` act as KEYFRAMES or as STYLE
 * REFERENCES?
 *
 * The deliverable is not code, it is a RECORDED ANSWER: the epic branches on it,
 * and an answer nobody can re-read is one that will be probed again. So the
 * test is over the task's own acceptance criteria — the request, the output, the
 * verdict and the actual spend must all be on disk, and the verdict must be one
 * of a closed set rather than prose that can be read either way.
 *
 * Set-based over the four acceptance criteria, because a probe that ran and was
 * half-recorded is the expensive failure here: the money is spent either way.
 */

/** The only answers this probe may return. "inconclusive" is honest and allowed. */
const VERDICTS = ['keyframes', 'style-references', 'inconclusive'];

/** Every acceptance criterion RBF-001 declares, as a checkable rule. */
const CRITERIA = [
    { id: 'request recorded',
      why: 'a verdict without the request it came from cannot be re-derived or disputed',
      holds: (d) => /## Request/.test(d) && /seedance-2\.5-video-edit/.test(d)
                 && /images_list/.test(d) && /video_url/.test(d) },
    { id: 'result recorded',
      why: 'what came back is the evidence; a summary of it is not',
      holds: (d) => /## Result/.test(d) && /(frame|output|video)/i.test(d) },
    { id: 'verdict is from the closed set',
      why: 'prose that can be read either way sends the next task down both roads',
      holds: (d) => {
          const m = /^\s*-?\s*\*\*Verdict:\*\*\s*`?([a-z-]+)`?/m.exec(d);
          return !!m && VERDICTS.includes(m[1]);
      } },
    { id: 'actual spend recorded against the estimate',
      why: 'the epic priced this at ~$0.68; an estimate never checked is a number nobody can trust again',
      holds: (d) => /## Spend/.test(d) && /\$/.test(d) && /0\.68|estimate/i.test(d) },
];

test('the probe verdict has been recorded', () => {
    assert.ok(fs.existsSync(VERDICT),
        `no verdict at ${path.relative(REPO, VERDICT)} — the probe has not been run and recorded`);
});

test('every acceptance criterion of RBF-001 is satisfied', () => {
    const d = doc();
    assert.strictEqual(CRITERIA.length, 4, 'the criteria set has changed; re-derive it from the task');
    const unmet = CRITERIA.filter(c => !c.holds(d)).map(c => `${c.id} (${c.why})`);
    assert.deepStrictEqual(unmet, [], `unmet:\n  - ${unmet.join('\n  - ')}`);
});

/*
 * The finding that made the probe possible must survive with it: `images_list`
 * refuses data URIs, which is why the probe used public URLs and why any future
 * implementation cannot simply inline local frames.
 */
test('the constraint that shaped the probe is recorded', () => {
    const d = doc();
    assert.match(d, /data URI/i, 'the verdict does not record that images_list refuses data URIs');
    assert.match(d, /http/i, 'the verdict does not record that entries must be http(s) URLs');
});

/* A verdict must say what it means for the epic, or the next task re-derives it. */
test('the verdict states its consequence for the epic', () => {
    assert.match(doc(), /RBF-00[46]|splice|cross-clip/i,
        'the verdict does not say which downstream tasks it changes');
});
