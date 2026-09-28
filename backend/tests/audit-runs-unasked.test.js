/**
 * The audit runs where nobody has to remember it.
 *
 * `elements_list` and `scale_check` both existed while the Drive-In board
 * carried three subjects that reached the model as neither picture nor
 * description. Neither caught it, because a free-standing checker is a thing
 * you have to think of, and nobody thinks of it on the day they are trying to
 * ship. A button you press is worth less than a check you cannot skip.
 *
 * Three insertion points, in order of how much they save:
 *
 *   run_plan          — refuses on an error. Protects the money.
 *   shot derivation   — reports on what it just made. Protects the afternoon,
 *                       and every defect the hand audit found was present at
 *                       exactly this moment.
 *   resync (apply)    — a resync changes cards; the audit is how you see what
 *                       it did.
 *
 * All three must be non-fatal: a check that can fail the thing it is checking
 * gets removed the first time it misfires.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const bare = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('run_plan refuses to spend on an unresolved subject', () => {
    const src = bare(read('lib', 'run-plan.js'));
    assert.ok(/auditFor\s*\(/.test(src), 'run_plan never audits');
    assert.ok(/blockedByAudit/.test(src), 'the audit result does not reach the refusal');
    assert.ok(/ignore_audit/.test(src),
        'there is no way past the gate — a check with no override gets deleted the first time it is wrong');
});

test('deriving a shot list audits what it just made', () => {
    const src = read('routes', 'breakdown.js');
    const code = bare(src);
    assert.ok(/function auditAfterDerive\s*\(/.test(code), 'nothing audits a fresh derivation');
    // Both doors: the buffered response and the streaming one.
    assert.ok(/result\.audit\s*=\s*audit/.test(code),
        'the buffered breakdown does not return its audit');
    assert.ok(/sendEvent\('audit'/.test(code),
        'the streaming breakdown does not emit its audit');
    // Every call site sits next to an autoSaveShots, not somewhere else.
    const saves = (code.match(/autoSaveShots\(/g) || []).length - 1; // minus the definition
    const audits = (code.match(/auditAfterDerive\(projectId\)/g) || []).length - 1; // minus the definition
    assert.equal(audits, saves,
        `${saves} place(s) save shots but ${audits} audit them — a door that saves without auditing is the hole`);
});

test('an applied resync reports the audit of what it changed', () => {
    const code = bare(read('lib', 'shots-resync.js'));
    assert.ok(/auditShots\(projectId\)/.test(code), 'a resync never audits its own work');
    assert.ok(/if\s*\(apply\)/.test(code),
        'a dry run audits too, which reports the board as it already is and reads as a consequence '
        + 'of a plan that has not happened');
});

test('none of the three can fail the thing it is checking', () => {
    const cases = [
        ['lib/run-plan.js', 'function auditFor'],
        ['routes/breakdown.js', 'function auditAfterDerive'],
        ['lib/shots-resync.js', 'auditShots(projectId)'],
    ];
    for (const [file, marker] of cases) {
        const code = bare(read(...file.split('/')));
        const at = code.indexOf(marker);
        assert.ok(at > 0, `${file}: ${marker} is missing`);
        // Generous on BOTH sides: the try can open before the marker (the
        // resync audits inline, inside resyncShots) and the catch can close
        // well after it (auditFor returns a long summary first).
        const window = code.slice(Math.max(0, at - 600), at + 2000);
        assert.ok(/try\s*\{/.test(window) && /catch/.test(window),
            `${file}: the audit is not wrapped — it can fail a derivation, a resync or a run that succeeded`);
    }
});

test('the audit reports errors specifically, not just a total', () => {
    for (const file of ['routes/breakdown.js', 'lib/shots-resync.js']) {
        const code = bare(read(...file.split('/')));
        assert.ok(/severity === 'error'/.test(code),
            `${file}: the audit is attached without separating the finding that blocks a run from the notes`);
    }
});
