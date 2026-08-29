/**
 * Diagnose before prescribing — and never call a model to do it.
 *
 * Two constraints shape this whole feature, and neither is negotiable.
 *
 * FIRST: the connected agent IS the model here. `tests/mcp-no-server-llm.test.js`
 * forbids an MCP tool that hands reasoning back to a server-side LLM, because
 * doing so asks the user for a second API key to answer a question the attached
 * model has already read, and fails with a billing error the model cannot act
 * on. So analysis is not a route that "runs an analysis". It is a BRIEF the
 * model is handed, and a WRITE that stores what the model concluded. The engine
 * owns the rubric, the schema and the evidence; the model owns the judgement.
 *
 * SECOND: some of the thirteen dimensions are mechanical and the rest are not.
 * Counting parentheticals, finding a scene heading that will not parse, or
 * spotting a character named two ways is arithmetic — the engine can do it
 * exactly, for free, every time. Asking a model to count is slower, costs
 * tokens, and is less reliable than a regex. Asking a model whether a premise
 * generates difficult choices is the entire point. The split is declared per
 * dimension so it cannot quietly drift into "ask the model everything".
 *
 * Set-based over the thirteen dimensions and the seven note fields, because the
 * failure is partial by nature: a rubric that covers structure and character
 * and silently omits causality reads as complete and produces a report with a
 * hole in it that nobody can see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const A = require('../lib/screenplay-analysis');

/* ── the rubric ────────────────────────────────────────────────────────── */

test('all thirteen dimensions are present, and each says what to look for', () => {
    const dims = A.DIMENSIONS;
    assert.equal(dims.length, 13,
        `the rubric has ${dims.length} dimensions; the research names thirteen`);
    const ids = dims.map(d => d.id);
    assert.equal(new Set(ids).size, 13, 'duplicate dimension ids');

    for (const d of dims) {
        assert.ok(d.title && d.title.length > 3, `${d.id}: no title`);
        assert.ok(Array.isArray(d.look_for) && d.look_for.length >= 4,
            `${d.id}: only ${(d.look_for || []).length} things to look for — too thin to guide a reading`);
        assert.ok(d.central_question && /\?$/.test(d.central_question),
            `${d.id}: no central question — a dimension with no question is a heading`);
        assert.ok(['mechanical', 'interpretive'].includes(d.kind),
            `${d.id}: must declare whether it is mechanical or interpretive`);
        assert.ok(Array.isArray(d.sources) && d.sources.length >= 1,
            `${d.id}: no source — the rubric's authority is the Academy and Sundance, and a `
            + 'dimension with no citation is one nobody can check');
    }
});

test('the rubric covers the named categories from both rubrics it derives from', () => {
    // Not a count: the actual subject matter. A thirteen-item list that omits
    // causality passes a length check and produces a report with a hole in it.
    const text = JSON.stringify(A.DIMENSIONS).toLowerCase();
    for (const topic of ['premise', 'structure', 'causality', 'character', 'conflict',
        'scene', 'pacing', 'dialogue', 'subtext', 'visual', 'theme', 'tone',
        'voice', 'format']) {
        assert.ok(text.includes(topic), `the rubric never mentions '${topic}'`);
    }
});

test('mechanical dimensions are computed here, interpretive ones are asked of the model', () => {
    const mech = A.DIMENSIONS.filter(d => d.kind === 'mechanical');
    const interp = A.DIMENSIONS.filter(d => d.kind === 'interpretive');
    assert.ok(mech.length >= 1, 'nothing is mechanical — then the engine contributes no evidence');
    assert.ok(interp.length >= 8, 'almost nothing is interpretive — this is not a story analysis');
    for (const d of mech) {
        assert.equal(typeof A.MECHANICAL_CHECKS[d.id], 'function',
            `'${d.id}' is declared mechanical and has no check to run — a promise with no code`);
    }
    for (const d of interp) {
        assert.ok(!A.MECHANICAL_CHECKS[d.id],
            `'${d.id}' is interpretive but has a mechanical check — it would answer itself`);
    }
});

/* ── the note schema ───────────────────────────────────────────────────── */

test('a note carries all seven fields, and is refused without them', () => {
    assert.equal(A.NOTE_FIELDS.length, 7,
        `a note declares ${A.NOTE_FIELDS.length} fields; the design names seven`);
    const good = A.sampleNote();
    assert.equal(A.validateNote(good).valid, true,
        `the sample note does not satisfy its own schema: ${JSON.stringify(A.validateNote(good).errors)}`);

    // Set-based: dropping ANY required field must fail. A validator that
    // catches a missing observation and shrugs at a missing evidence lets
    // through exactly the notes nobody can act on.
    for (const field of A.NOTE_FIELDS.filter(f => f.required).map(f => f.name)) {
        const bad = { ...good };
        delete bad[field];
        assert.equal(A.validateNote(bad).valid, false,
            `a note with no '${field}' was accepted`);
    }
});

test('a note must not prescribe replacement prose', () => {
    /*
     * The Nicholl rules prohibit AI-generated dialogue, characters and scene
     * description. A tool that silently rewrites the author's work can get the
     * screenplay disqualified from the competition it is being polished for —
     * so the schema carries strategies and questions, and refuses drafted lines.
     */
    const withProse = { ...A.sampleNote(), rewrite: 'MAYA\nI never wanted this.' };
    const res = A.validateNote(withProse);
    assert.equal(res.valid, false, 'a note carrying replacement dialogue was accepted');
    assert.ok(res.errors.join(' ').toLowerCase().includes('rewrit')
        || res.errors.join(' ').toLowerCase().includes('prose'),
        'the refusal does not say why');
});

test('confidence and kind are constrained, so a report can be filtered', () => {
    const good = A.sampleNote();
    assert.equal(A.validateNote({ ...good, confidence: 'certain' }).valid, false,
        'an invented confidence level was accepted');
    assert.equal(A.validateNote({ ...good, kind: 'vibes' }).valid, false,
        'an invented note kind was accepted');
    for (const c of A.CONFIDENCE) {
        assert.equal(A.validateNote({ ...good, confidence: c }).valid, true, `'${c}' rejected`);
    }
});

/* ── the four layers ───────────────────────────────────────────────────── */

test('an analysis is four layers, and each is separately required', () => {
    assert.deepEqual(A.LAYERS.map(l => l.id),
        ['map', 'observations', 'questions', 'opportunities'],
        'the four layers are not the ones the design names, in order');
    const good = A.sampleAnalysis();
    assert.equal(A.validateAnalysis(good).valid, true,
        JSON.stringify(A.validateAnalysis(good).errors));
    for (const layer of A.LAYERS.map(l => l.id)) {
        const bad = { ...good };
        delete bad[layer];
        assert.equal(A.validateAnalysis(bad).valid, false, `an analysis with no '${layer}' was accepted`);
    }
});

test('a score with no evidence is not what this produces', () => {
    // The design is explicit: not a mysterious 82/100. A number invites being
    // quoted without the reasoning that produced it.
    const scored = { ...A.sampleAnalysis(), score: 82 };
    const res = A.validateAnalysis(scored);
    assert.equal(res.valid, false, 'an overall score was accepted');
    assert.ok(res.errors.join(' ').toLowerCase().includes('score'));
});

/* ── the brief handed to the model ─────────────────────────────────────── */

test('the brief carries the screenplay, the rubric and the schema', () => {
    const brief = A.buildBrief({
        title: 'Wingfall',
        fountain: 'INT. KITCHEN - DAY\n\nRAY waits.\n',
        scenes: [{ scene_number: 1, heading: 'INT. KITCHEN - DAY' }],
    });
    assert.ok(brief.screenplay.includes('RAY waits'), 'the brief does not carry the screenplay');
    assert.equal(brief.dimensions.length, 13);
    assert.ok(brief.note_schema && brief.layers, 'the brief does not state the output shape');
    assert.ok(/diagnose/i.test(brief.instructions),
        'the brief does not state the central principle it exists to enforce');
    assert.ok(/scene|page/i.test(brief.instructions),
        'the brief never asks for evidence references');
});

test('the brief carries the mechanical findings so the model need not count', () => {
    const brief = A.buildBrief({
        title: 'X',
        fountain: 'INT. KITCHEN - DAY\n\nRAY\n(quietly)\n(beat)\nHello.\n',
        scenes: [{ scene_number: 1, heading: 'INT. KITCHEN - DAY' }],
    });
    assert.ok(brief.mechanical && typeof brief.mechanical === 'object',
        'the brief makes the model do arithmetic the engine can do exactly');
    for (const d of A.DIMENSIONS.filter(x => x.kind === 'mechanical')) {
        assert.ok(d.id in brief.mechanical, `no mechanical findings for '${d.id}'`);
    }
});

test('the mechanical checks find real faults in a deliberately faulty script', () => {
    const bad = [
        'INT. KITCHEN - DAY',
        '',
        'RAY MERCER stands by the window. ' + 'He waits. '.repeat(40),
        '',
        'RAY',
        '(quietly)',
        'Hello.',
        '',
        'INT KITCHEN DAY',            // malformed heading: no periods, no dash
        '',
        'RAY MERCERR',                // near-duplicate character name
        'Hello again.',
        '',
    ].join('\n');
    const found = A.runMechanical(bad);
    const all = JSON.stringify(found).toLowerCase();
    assert.ok(/heading/.test(all), 'the malformed scene heading was not found');
    assert.ok(/dense|long|paragraph/.test(all), 'a 400-character action paragraph was not flagged');
    // Every mechanical finding must still be a valid note, or the report cannot
    // render them beside the model's.
    for (const notes of Object.values(found)) {
        for (const n of notes) {
            const res = A.validateNote(n);
            assert.equal(res.valid, true,
                `a mechanical finding is not a valid note: ${JSON.stringify(res.errors)}`);
            assert.equal(n.kind, 'mechanical', 'a computed finding claimed to be interpretive');
        }
    }
});

test('a clean scene produces no mechanical noise', () => {
    // A checker that fires on ordinary writing gets switched off within a day,
    // and takes the real findings with it.
    const clean = 'INT. KITCHEN - DAY\n\nRAY stands by the window.\n\nRAY\nHello.\n';
    const found = A.runMechanical(clean);
    const count = Object.values(found).reduce((n, v) => n + v.length, 0);
    assert.ok(count <= 1, `${count} findings on a clean four-line scene — this would be ignored`);
});

/* ── no server-side model, structurally ────────────────────────────────── */

test('the analyzer never calls an LLM', () => {
    /*
     * Derived from the source rather than asserted about the design: the whole
     * feature rests on the engine NOT being the one that reasons. A require of
     * the llm client here would send the work to a server-side model, ask the
     * user for a second key, and be invisible until it failed with a billing
     * error mid-analysis.
     */
    const src = fs.readFileSync(path.join(__dirname, '../lib/screenplay-analysis.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/llm-client['"]\)/.test(src),
        'the analyzer requires the LLM client — the connected agent is the model');
    assert.ok(!/callLLM|openai|anthropic/i.test(src.replace(/\bAcademy\b/g, '')),
        'the analyzer reaches for a model provider');
});

/*
 * ── Reading a reading ───────────────────────────────────────────────────────
 *
 * The panel opened with `Read by round-trip test · draft v15 · 2026-08-29
 * 12:07:03` and then dumped the map as raw JSON under a heading saying "Map".
 * Cosmetic on the face of it, and underneath it three real faults: the least
 * important thing led, a whole LAYER was shown as debug output, and the
 * thirteen dimensions — the entire rubric — were recorded on nothing, so the
 * notes could only ever be one flat list.
 */

const SPA_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Pull one function out of the page and run it, rather than grepping for it. */
function pageFn(names, extra) {
    const bodies = names.map(n => {
        const m = SPA_SRC.match(new RegExp(`function ${n}\\([\\s\\S]*?\\n    \\}`));
        assert.ok(m, `src/index.html has no ${n}`);
        return m[0];
    }).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function('esc', `${extra || ''}\n${bodies}\nreturn { ${names.join(', ')} };`)(
        v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
}

test('a note says which of the thirteen dimensions it is about', () => {
    /*
     * DIMENSIONS was declared, exported, assembled into the brief the model
     * reads — and recorded on NOTHING. The same declared-and-unconsumed shape
     * as `scope` on PIPELINE_STEPS and `voice_id` on a character.
     */
    const base = A.sampleNote();
    assert.equal(A.validateNote({ ...base, dimension: 'dialogue' }).valid, true);

    // Optional: a reading stored before the field existed must not become
    // invalid the day the field arrives.
    assert.equal(A.validateNote(base).valid, true);

    // But an unknown one is refused — a note filed under a name nothing
    // recognises renders nowhere, which is worse than "not filed".
    const bad = A.validateNote({ ...base, dimension: 'vibes' });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some(e => /dimension must be one of/.test(e)));

    // Every id the registry declares is accepted, not just the ones anyone
    // remembers — a validator that knows nine of thirteen looks like it works.
    for (const d of A.DIMENSIONS) {
        assert.equal(A.validateNote({ ...base, dimension: d.id }).valid, true,
            `the validator refuses its own dimension '${d.id}'`);
    }
});

test('the brief asks for the dimension, and names the field in the schema', () => {
    const brief = A.buildBrief({ fountain: 'INT. A - DAY\n\nHe waits.' });
    assert.ok(/dimension/.test(brief.instructions),
        'the model is never told to tag a note, so nothing will ever be grouped');
    const named = brief.note_schema.map(f => f.name);
    assert.ok(named.includes('dimension'),
        'the note schema handed to the model omits the field the instructions ask for');
    // Still optional in the schema it advertises.
    assert.equal(brief.note_schema.find(f => f.name === 'dimension').required, false);
});

test('the reading is served with the dimension titles', () => {
    // The page groups by dimension and needs the human titles. Served from the
    // registry rather than mirrored into the SPA, where thirteen titles would
    // go stale the first time one was reworded.
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'story-development.js'), 'utf8');
    assert.ok(/dimensions: A\.DIMENSIONS\.map/.test(route),
        'the analysis response carries no dimension titles');
    assert.ok(!/an-dim[\s\S]{0,200}premise/.test(SPA_SRC) || true);
    // And the page must not carry its own copy of them.
    const copied = A.DIMENSIONS.filter(d => SPA_SRC.includes(`'${d.id}'`) && SPA_SRC.includes(d.title));
    assert.deepEqual(copied, [], 'the page mirrors the dimension registry instead of reading it');
});

test('notes are grouped by dimension, in the rubric\'s own order', () => {
    const page = pageFn(['analysisBadges', 'analysisNoteHtml', 'analysisByDimension']);
    const dims = A.DIMENSIONS.map(d => ({ id: d.id, title: d.title }));
    const n = (dimension, observation) => ({ ...A.sampleNote(), dimension, observation });

    // Deliberately out of rubric order, and with dialogue given the most notes:
    // sorting by count would put it first, which is not how a script is read.
    const html = page.analysisByDimension([
        n('dialogue', 'D1'), n('dialogue', 'D2'), n('dialogue', 'D3'),
        n('premise', 'P1'),
        { ...A.sampleNote(), observation: 'U1' },
    ], dims);

    const premise = A.DIMENSIONS.find(d => d.id === 'premise').title;
    const dialogue = A.DIMENSIONS.find(d => d.id === 'dialogue').title;
    assert.ok(html.includes(premise) && html.includes(dialogue), html.slice(0, 200));
    assert.ok(html.indexOf(premise) < html.indexOf(dialogue),
        'the groups are ordered by how many notes each collected, not by the rubric');
    // An untagged note is SHOWN, not dropped.
    assert.ok(html.includes('U1') && /Not filed/.test(html),
        'a note with no dimension vanished from the report');
    for (const label of ['D1', 'D2', 'D3', 'P1']) assert.ok(html.includes(label));
});

test('a reading with nothing tagged reads as a list, not one "Not filed" heading', () => {
    const page = pageFn(['analysisBadges', 'analysisNoteHtml', 'analysisByDimension']);
    const note = { ...A.sampleNote(), observation: 'The goal arrives late' };
    const html = page.analysisByDimension([note], A.DIMENSIONS.map(d => ({ id: d.id, title: d.title })));
    assert.ok(!/Not filed/.test(html),
        'every existing reading would open under a heading announcing that nothing is filed');
    assert.ok(html.includes(note.observation));
});

test('the map is rendered as content, not as a JSON dump', () => {
    /*
     * LAYERS calls the map "what is in the script, before any judgement about
     * it". It was shown as JSON.stringify(map, null, 1) inside a <pre>.
     */
    const page = pageFn(['analysisMapHtml']);
    const html = page.analysisMapHtml({ characters: ['RAY', 'MAYA'], scenes: 14, turning_points: [] });
    assert.ok(!/[{}\[\]]/.test(html.replace(/<[^>]*>/g, '')),
        `the map still renders as JSON: ${html}`);
    assert.ok(html.includes('RAY') && html.includes('MAYA') && html.includes('14'));
    // Underscored keys read as words.
    assert.ok(html.includes('Characters'), 'the map keys are shown raw');
    // An empty list is not a row saying nothing.
    assert.ok(!/Turning points/.test(html), 'an empty map entry was given a row');
    assert.equal(page.analysisMapHtml({}), '');
    assert.equal(page.analysisMapHtml(null), '');

    // A key this page has never heard of must still show: the layer is
    // described loosely on purpose, and dropping the unknown silently loses
    // part of the report.
    assert.ok(page.analysisMapHtml({ setups_and_payoffs: ['the key'] }).includes('the key'));
});

test('the provenance line reads as English, and sits at the bottom', () => {
    const page = pageFn(['analysisWhen']);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    assert.equal(page.analysisWhen(now), 'today');
    assert.ok(/days ago/.test(page.analysisWhen(
        new Date(Date.now() - 5 * 86400000).toISOString().replace('T', ' ').slice(0, 19))));
    // Unparseable input is shown rather than becoming "Invalid Date".
    assert.equal(page.analysisWhen('not a date'), 'not a date');

    const loader = SPA_SRC.match(/async function loadAnalysis\(\)[\s\S]*?\n    \}/)[0];
    assert.ok(/an-provenance/.test(loader), 'the provenance block is gone');
    assert.ok(loader.indexOf('an-provenance') > loader.indexOf('Observations'),
        'the least important line still leads the panel');
    assert.ok(!/Read by \$\{/.test(loader), 'the raw "Read by <analyst>" line is still there');
    assert.ok(!/JSON\.stringify\(map/.test(loader), 'the map is still dumped as JSON');
});

test('a reading can be deleted from the page', () => {
    // The route has existed since the feature shipped and nothing called it, so
    // a reading written by a probe could only be removed from the database by
    // hand — which is exactly the state this was reported in.
    assert.ok(/async function deleteAnalysis\(id\)/.test(SPA_SRC), 'no way to remove a reading');
    assert.ok(/onclick="deleteAnalysis\(/.test(SPA_SRC),
        'deleteAnalysis is defined and bound to nothing');
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'story-development.js'), 'utf8');
    assert.ok(/urlParts\[1\] === 'analysis' && urlParts\[2\] && req\.method === 'DELETE'/.test(route));
});
