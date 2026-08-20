/**
 * Phase 3 — the board where a look is decided, before anything generates.
 *
 * A director assembles references and settles a look before a frame is shot.
 * We had no such surface: `style_preset` was a free-text column typed once,
 * applied to every image prompt forever, and never assembled from anything. So
 * the string that shipped read "…teal/amber, wet streets, mist, anatomical
 * beast, anamorphic, grain" — a subject smuggled into a look, appended to every
 * prompt in the production, drawing a creature into an establishing shot whose
 * card says "Empty, ordinary, still."
 *
 * The board is where that becomes catchable, because the board's OUTPUT is the
 * style preset. A mood board that sits beside generation is a scrapbook; one
 * whose output feeds generation is look development.
 *
 * Set-based over the reference kinds, because the failure is per-kind: a board
 * that handles uploaded images but not generated frames, or palette entries but
 * not lens notes, is a board a director works around rather than in.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mood-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleMoodBoard } = require('../routes/mood-board');

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handleMoodBoard({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function makeProject() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Mood Test');
    return projectId;
}

/**
 * The kinds of thing that belong on a look board. Each must round-trip, because
 * a board that silently drops one is a board a director stops trusting.
 */
const REF_KINDS = [
    { kind: 'palette',  note: 'teal shadows, amber sodium practicals' },
    { kind: 'lighting', note: 'hard sodium key from frame right, deep falloff' },
    { kind: 'lens',     note: 'anamorphic, long lenses, oval bokeh' },
    { kind: 'texture',  note: '35mm grain, halation on highlights' },
    { kind: 'framing',  note: 'wide, centred, subject small in frame' },
    { kind: 'image',    note: 'reference still', image_path: '/tmp/ref.png' },
];

test('every reference kind round-trips through the board', async () => {
    const projectId = makeProject();
    const broken = [];
    for (const ref of REF_KINDS) {
        const add = await call('POST', `/film/projects/${projectId}/mood-board`, ref);
        if (add.status >= 400) { broken.push(`${ref.kind}: refused — ${JSON.stringify(add.body)}`); continue; }
        const board = await call('GET', `/film/projects/${projectId}/mood-board`);
        const found = (board.body.entries || []).find(e => e.kind === ref.kind);
        if (!found) broken.push(`${ref.kind}: added but not on the board`);
        else if (found.note !== ref.note) broken.push(`${ref.kind}: note came back changed`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('the board composes a style preset from what is on it', async () => {
    // The load-bearing claim. A board whose output does not reach generation is
    // a scrapbook.
    const projectId = makeProject();
    for (const ref of REF_KINDS.filter(r => r.kind !== 'image')) {
        await call('POST', `/film/projects/${projectId}/mood-board`, ref);
    }
    const composed = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    assert.strictEqual(composed.status, 200, JSON.stringify(composed.body));
    const style = composed.body.style_preset;
    assert.ok(style && style.length > 20, `no style composed: ${JSON.stringify(style)}`);
    for (const word of ['anamorphic', 'grain', 'teal']) {
        assert.ok(style.toLowerCase().includes(word), `"${word}" was on the board and is not in the style`);
    }
});

/**
 * The independent ways a composed style can be wrong.
 *
 * Two problems, two causes, and they can happen together — a long style that
 * also names a creature. Reporting only the first found would hide the other,
 * so the check is set-based over the warning types rather than over one
 * example of one of them.
 */
const WARNING_TYPES = ['subject', 'length'];

test('the warning registry matches what compose can actually raise', async () => {
    const projectId = makeProject();
    await call('POST', `/film/projects/${projectId}/mood-board`,
        { kind: 'texture', note: 'anatomical beast, ' + 'wet stone and cold light, '.repeat(12) });
    const r = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    const raised = (r.body.warnings || []).map(w => w.type).sort();
    assert.deepStrictEqual(raised, WARNING_TYPES.slice().sort(),
        `a style that is both too long AND names a subject raised only: ${JSON.stringify(raised)}`);
});

test('composing says how much of the style will actually reach a prompt', async () => {
    // The trap this exists for: a board composed 1654 characters of careful
    // look development, and STYLE_ALLOWANCE trims it to 140 at prompt-build
    // time. Ninety-two per cent was discarded silently, so the director was
    // generating against roughly the first sentence and a half of what they
    // wrote — and nothing anywhere said so.
    const { STYLE_ALLOWANCE } = require('../lib/storyboard-prompt');
    const projectId = makeProject();
    await call('POST', `/film/projects/${projectId}/mood-board`,
        { kind: 'palette', note: 'teal and amber with sodium practicals, '.repeat(10) });

    const r = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    const lengthWarning = (r.body.warnings || []).find(w => w.type === 'length');
    assert.ok(lengthWarning, 'an over-long style composed with no warning at all');
    assert.strictEqual(lengthWarning.allowance, STYLE_ALLOWANCE,
        'the warning quotes an allowance that is not the one the prompt builder uses');
    assert.ok(lengthWarning.composed > STYLE_ALLOWANCE);
    assert.ok(/\d+%/.test(lengthWarning.detail), 'the warning does not say how much is lost');

    // And it shows the text that survives, because "92% is discarded" is a
    // statistic while the surviving sentence is the thing to judge.
    assert.ok(r.body.effective_style, 'no effective style returned');
    assert.ok(r.body.effective_style.length <= STYLE_ALLOWANCE + 3,
        `effective style is ${r.body.effective_style.length}, above the allowance`);
    assert.ok(r.body.style_preset.startsWith(r.body.effective_style.slice(0, 40)),
        'the effective style is not the head of the composed one');
});

test('a style that fits raises no length warning', async () => {
    // A warning that fires on everything is a warning nobody reads.
    const projectId = makeProject();
    await call('POST', `/film/projects/${projectId}/mood-board`, { kind: 'palette', note: 'teal and amber, anamorphic' });
    const r = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    assert.ok(!(r.body.warnings || []).some(w => w.type === 'length'),
        'a 26-character style was warned about for length');
});

test('composing warns when the board would put a subject in every frame', async () => {
    // The exact defect that shipped, caught at the moment the look is decided
    // rather than after eight frames have been paid for.
    const projectId = makeProject();
    await call('POST', `/film/projects/${projectId}/mood-board`,
        { kind: 'texture', note: 'anatomical beast, wet stone' });
    const composed = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    assert.strictEqual(composed.status, 200, 'composing was blocked rather than warned');
    const subject = (composed.body.warnings || []).find(w => w.type === 'subject');
    assert.ok(subject, 'no warning about the subject on the board');
    assert.ok((subject.subjects || []).some(w => /beast/i.test(w)),
        `the offending word was not named: ${JSON.stringify(subject)}`);
});

test('composing does not apply the style until asked', async () => {
    // Previewing a look and committing to it are different decisions. Applying
    // silently would rewrite the look of every future frame from a preview.
    const projectId = makeProject();
    await call('POST', `/film/projects/${projectId}/mood-board`, { kind: 'palette', note: 'teal and amber' });
    await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    const before = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(projectId).style_preset;
    assert.ok(!before, `compose wrote the style preset without being asked: ${before}`);

    const applied = await call('POST', `/film/projects/${projectId}/mood-board/compose`, { apply: true });
    assert.strictEqual(applied.status, 200);
    const after = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(projectId).style_preset;
    assert.ok(after && after.includes('teal'), `apply did not write the style: ${after}`);
});

test('an entry can be removed, and the style recomposes without it', async () => {
    const projectId = makeProject();
    const a = await call('POST', `/film/projects/${projectId}/mood-board`, { kind: 'palette', note: 'teal and amber' });
    await call('POST', `/film/projects/${projectId}/mood-board`, { kind: 'lens', note: 'anamorphic' });
    const withBoth = (await call('POST', `/film/projects/${projectId}/mood-board/compose`)).body.style_preset;
    assert.ok(withBoth.includes('teal') && withBoth.includes('anamorphic'));

    const del = await call('DELETE', `/film/mood-board/${a.body.entry.id}`);
    assert.ok(del.status < 400, JSON.stringify(del.body));
    const after = (await call('POST', `/film/projects/${projectId}/mood-board/compose`)).body.style_preset;
    assert.ok(!after.includes('teal'), `the removed entry is still in the style: ${after}`);
    assert.ok(after.includes('anamorphic'), 'removing one entry dropped the others');
});

test('an empty board composes nothing rather than an empty style', async () => {
    // Applying an empty string would silently strip the look from a project
    // that already had one.
    const projectId = makeProject();
    const composed = await call('POST', `/film/projects/${projectId}/mood-board/compose`);
    assert.strictEqual(composed.body.style_preset, '', 'an empty board invented a style');
    assert.ok(composed.body.message, 'no explanation of why nothing was composed');
});


test('the length warning quotes the allowance THIS project actually gets', () => {
    // It quoted the base constant — the share at the 1000-char ceiling, which
    // is Runway's. A project generating on Meshy has a 4000 ceiling and a 560
    // allowance, so the warning claimed 140 and told a director nine tenths of
    // their look was being discarded when almost all of it survived. A warning
    // that is wrong in the alarming direction is how a warning gets ignored.
    const { allowancesFor } = require('../lib/storyboard-prompt');
    const { imagePromptLimit } = require('../lib/capability-payloads');

    const projectId = makeProject();
    db.prepare("UPDATE film_projects SET provider_config = ? WHERE id = ?")
        .run(JSON.stringify({ image: 'meshy' }), projectId);

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    const limit = imagePromptLimit(project);
    assert.strictEqual(limit, 4000, `meshy should give 4000, got ${limit}`);
    assert.strictEqual(allowancesFor(limit).style, 560,
        'the style allowance at meshy\'s ceiling is not what the warning should quote');
});
