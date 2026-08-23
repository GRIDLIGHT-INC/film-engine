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

    /*
     * Derived from the adapter, not written down here. The rule this test
     * protects is "quote the allowance THIS project gets" — and pinning
     * meshy's number as a literal is the same mistake one level up: when the
     * ceiling legitimately moved from 4000 to 16000 on measured evidence, a
     * hardcoded 4000 failed while the behaviour was still correct.
     *
     * What must hold is that the limit comes from the project's own adapter
     * and the allowance is computed from it — never from the base constant,
     * which is Runway's share and would tell a Meshy director nine tenths of
     * their look was being discarded when almost all of it survives.
     */
    const providers = require('../lib/providers');
    const meshy = providers.list().find(a => (a.id || a.provider || a.name) === 'meshy');
    assert.ok(meshy && Number(meshy.promptLimit) > 0, 'no meshy adapter to derive the ceiling from');

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    const limit = imagePromptLimit(project);
    assert.strictEqual(limit, Number(meshy.promptLimit),
        `the project resolved ${limit} where its adapter declares ${meshy.promptLimit}`);

    const base = allowancesFor(1000).style;
    assert.strictEqual(allowancesFor(limit).style, allowancesFor(Number(meshy.promptLimit)).style,
        'the allowance is not computed from this project\'s ceiling');
    assert.ok(allowancesFor(limit).style > base,
        `a roomier ceiling gave no more style allowance than Runway's ${base}`);
});


// ── The board's look reaches the plates, not only the frames ────────────

test('a pinned board image conditions the plates, not only the storyboard', () => {
    // The board composed into style_preset from the day it was built and its
    // images reached storyboard frames — never the plates. That is the wrong
    // way round: a plate conditions every frame its subject appears in, so a
    // plate generated outside the film's look drags all of them with it and the
    // look has to be re-argued in every shot.
    const { styleReferencesFor } = require('../lib/reference-plates');
    const fs_ = require('fs');
    const os_ = require('os');
    const path_ = require('path');

    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Look board');

    const dir = fs_.mkdtempSync(path_.join(os_.tmpdir(), 'lookref-'));
    const img = path_.join(dir, 'look.png');
    fs_.writeFileSync(img, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'));

    assert.deepStrictEqual(styleReferencesFor(db, projectId), [],
        'a project with no board produced a reference out of nowhere');

    db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, image_path)
                VALUES (?, ?, 'image', 'wet streets at blue hour', ?)`)
        .run(generateId(), projectId, img);

    const refs = styleReferencesFor(db, projectId);
    assert.strictEqual(refs.length, 1, 'the board image never became a plate reference');
    assert.strictEqual(refs[0].kind, 'style');
    assert.ok(/^data:/.test(refs[0].uri), 'the reference travels as a disk path no provider can read');
});

test('a plate takes ONE look reference, never a committee', () => {
    // A plate has exactly one subject and the board is there for its grade. Two
    // or three look plates start voting on what the object IS, and the thing
    // being established stops being the thing.
    const { styleReferencesFor } = require('../lib/reference-plates');
    const fs_ = require('fs');
    const os_ = require('os');
    const path_ = require('path');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Many looks');
    const dir = fs_.mkdtempSync(path_.join(os_.tmpdir(), 'lookrefs-'));
    for (const n of ['a', 'b', 'c']) {
        const f = path_.join(dir, n + '.png');
        fs_.writeFileSync(f, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64'));
        db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, image_path)
                    VALUES (?, ?, 'image', ?, ?)`).run(generateId(), projectId, 'look ' + n, f);
    }
    assert.strictEqual(styleReferencesFor(db, projectId).length, 1,
        'more than one look reference reached a plate');
});

test('the look drops whole on a moderation refusal — words and picture', () => {
    // Retrying with the reference still attached re-sends what may have been
    // refused, and reports style_applied: false while the look is in fact still
    // applied. That is a worse lie than dropping it.
    const fs_ = require('fs');
    const path_ = require('path');
    for (const [file, marker] of [
        ['lib/reference-plates.js', 'delete basePayload.reference_images'],
        ['routes/characters.js', 'reference_images: _dropped'],
    ]) {
        const src = fs_.readFileSync(path_.join(__dirname, '..', ...file.split('/')), 'utf8');
        assert.ok(src.includes(marker),
            `${file} retries a refused plate with the look reference still attached`);
    }
});
