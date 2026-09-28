/**
 * The Runway parity brief, held to the code it describes.
 *
 * A research brief states facts about an adapter and an API, and both move:
 * Runway ships a model a fortnight and this adapter is edited weekly. A brief
 * whose numbers nobody re-checks becomes a confident description of a system
 * that no longer exists. So every factual claim in it is DERIVED here — from
 * the adapter, the provider registry and a dated snapshot of Runway's own
 * OpenAPI spec — and a claim the code has outgrown fails rather than rots.
 *
 * The denominators are the registries, never a list typed into this file:
 * the spec's models per endpoint, the spec's last-frame support, the provider
 * registry's capabilities.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BRIEF = fs.readFileSync(path.join(ROOT, 'docs/plans/runway-parity-brief.md'), 'utf8');
const RESEARCH = fs.readFileSync(path.join(ROOT, 'docs/plans/runway-parity-research.md'), 'utf8');
const SPEC = require('./fixtures/runway-openapi-snapshot.json');
const runway = require('../lib/providers/runway');
const ADAPTER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/providers/runway.js'), 'utf8');
const providers = require('../lib/providers');
const { CAPABILITIES } = require('../lib/providers/base');

const VIDEO_ENDPOINTS = ['/v1/image_to_video', '/v1/text_to_video', '/v1/video_to_video'];
const specVideoModels = new Set(VIDEO_ENDPOINTS.flatMap(p => SPEC.models[p] || []));
const ours = Object.keys(runway.RUNWAY_VIDEO_MODELS);

/*
 * Which spec paths the adapter REQUESTS — read from the URLs it builds, never
 * from any mention of a path. The first version matched the path text anywhere
 * in the file and reported /v1/uploads as called, because the refusal message
 * naming it as the unbuilt remedy contains it. A detector that counts prose as
 * calls would let the brief propose work that is "already built".
 */
const REQUESTED = (() => {
    const stems = new Set();
    for (const m of ADAPTER_SRC.matchAll(/`\$\{baseUrl\(\)\}\/([a-z_/]+)/g)) stems.add('/' + m[1].replace(/\/$/, ''));
    if (ADAPTER_SRC.includes('`${baseUrl()}/${mode}`')) {
        for (const m of ADAPTER_SRC.matchAll(/\bconst mode\s*=[^;]*/g)) {
            for (const q of m[0].matchAll(/'([a-z_]+_to_[a-z_]+)'/g)) stems.add('/' + q[1]);
        }
    }
    return stems;
})();
function adapterCalls(specPath) {
    const stem = specPath.replace(/^\/v1/, '').split('/{')[0];
    return REQUESTED.has(stem) || REQUESTED.has(stem + '/');
}

test('the snapshot is a real, dated reading of the spec', () => {
    assert.match(SPEC.source, /docs\.dev\.runwayml\.com\/openapi\.json/);
    assert.match(SPEC.fetched, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(SPEC.operations.length > 20, 'a snapshot with almost no operations is a failed parse');
    assert.ok(Object.keys(SPEC.image_to_video_last_frame).length > 5);
});

test('the brief has every section the research brief template requires', () => {
    for (const h of ['Executive Summary', 'Key Themes', 'Top Ideas & Opportunities',
        'Technical Approaches', 'Open Questions', 'Recommended Direction']) {
        assert.ok(new RegExp(`^### ${h.replace(/[&]/g, '\\&')}\\s*$`, 'm').test(BRIEF), `missing section: ${h}`);
    }
});

test('the operation count the brief states is the spec\'s', () => {
    assert.ok(new RegExp(`\\*\\*${SPEC.operations.length} operations\\*\\*`).test(BRIEF), `brief does not state ${SPEC.operations.length} operations`);
});

test('the paths-reached count the brief states is derived from the adapter source', () => {
    const paths = [...new Set(SPEC.operations.map(o => o.split(' ')[1]))];
    const reached = paths.filter(adapterCalls);
    assert.ok(new RegExp(`\\*\\*${reached.length} of the ${paths.length} paths\\*\\*`).test(BRIEF),
        `adapter reaches ${reached.length}/${paths.length}: ${reached.join(', ')}`);
});

test('every spec video model the registry lacks is named, and the count matches', () => {
    const missing = [...specVideoModels].filter(m => !runway.RUNWAY_VIDEO_MODELS[m]);
    assert.ok(new RegExp(`\\*\\*${missing.length} video models\\*\\*`).test(BRIEF), `brief does not state ${missing.length} missing video models`);
    for (const m of missing) assert.ok(RESEARCH.includes(m), `research does not name missing model ${m}`);
    // …and the registry holds nothing the spec does not serve.
    assert.deepEqual(ours.filter(m => !specVideoModels.has(m)), []);
});

test('the last-frame count is the spec\'s, and every model the brief calls first-only is', () => {
    const lf = SPEC.image_to_video_last_frame;
    const accepting = Object.values(lf).filter(Boolean).length;
    assert.ok(new RegExp(`\\*\\*${accepting} of ${Object.keys(lf).length}\\*\\*`).test(BRIEF), `brief does not state ${accepting} of ${Object.keys(lf).length}`);
    for (const m of ['gen4.5', 'gen4_turbo', 'hailuo3']) {
        assert.equal(lf[m], false, `${m} is claimed first-only`);
        assert.ok(BRIEF.includes(`\`${m}\``));
    }
    assert.equal(lf.h3_max, true, 'h3_max is named as a first+last model');
});

test('the keyframe defect the brief names is still present: one ceiling above a first-only default', () => {
    // When this fails, the defect was fixed — update the brief's "live defect" framing.
    assert.match(ADAPTER_SRC, /const MAX_KEYFRAMES = 2;/);
    const firstOnlyRegistered = ours.filter(m => SPEC.image_to_video_last_frame[m] === false);
    assert.ok(firstOnlyRegistered.includes('gen4.5') && firstOnlyRegistered.length > 1,
        `registered first-only models: ${firstOnlyRegistered.join(', ')}`);
    for (const m of firstOnlyRegistered) {
        assert.equal(runway.RUNWAY_VIDEO_MODELS[m].maxKeyframes, undefined,
            `${m} now declares its own ceiling — the defect is fixed; revise the brief`);
    }
});

test('every capability the brief calls unserved has no hosted provider today', () => {
    const hosted = cap => providers.list().filter(a => a.id !== 'gridlight' && a.capabilities.includes(cap)).map(a => a.id);
    const unserved = CAPABILITIES.filter(c => hosted(c).length === 0);
    assert.deepEqual(unserved, ['lipsync'], `capabilities with no hosted provider: ${unserved.join(', ')}`);
    for (const c of unserved) assert.ok(BRIEF.includes(`\`${c}\``));
    assert.deepEqual(hosted('post'), ['seedance'], 'the brief says post is served by Seedance alone');
});

/*
 * The proposed set is DERIVED from the brief's own Top Ideas — every endpoint it
 * names in backticks — never typed here. The first version listed seven by hand,
 * so an endpoint added to or dropped from the brief changed nothing this test
 * checked: exactly the partial-coverage hole a set-based test exists to close.
 */
function proposedEndpoints() {
    const ideas = BRIEF.match(/^### Top Ideas & Opportunities\s*$([\s\S]*?)^### /m)[1];
    const stems = [...new Set(SPEC.operations.map(o => o.split(' ')[1].split('/{')[0]))];
    return stems.filter(p => new RegExp('`(POST |GET |DELETE )?(/v1/)?' + p.replace('/v1/', '').replace(/\//g, '\\/') + '(`|/)').test(ideas));
}

test('every Runway endpoint the brief proposes exists in the spec and is not yet called', () => {
    const proposed = proposedEndpoints();
    assert.ok(proposed.length >= 6, `only ${proposed.length} endpoints found in Top Ideas — the scan is broken`);
    // Every one the brief proposes as NEW work must not already be built.
    const built = proposed.filter(adapterCalls);
    const alreadyInUse = ['/v1/tasks']; // named in idea 8 for its DELETE verb, whose GET is already called
    assert.deepEqual(built.filter(p => !alreadyInUse.includes(p)), [],
        `the brief proposes endpoints the adapter already calls: ${built.join(', ')}`);
    assert.ok(SPEC.operations.includes('DELETE /v1/tasks/{id}'));
    // The brief proposed task cancel. PGN-012 built it for ONE job (`cancelJob`);
    // the DELETE must live only there until a run's cancel reaches it (RWP-014).
    const deletes = [...ADAPTER_SRC.matchAll(/method:\s*'DELETE'/g)].length;
    assert.ok(deletes <= 1, 'task cancel is called from more places than the per-job cancel');
    if (deletes) assert.ok(/async cancelJob\([\s\S]{0,400}method:\s*'DELETE'/.test(ADAPTER_SRC), 'the DELETE is not the per-job cancel');
});

test('generate-native still passes no handle, as the brief says', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes/sequences.js'), 'utf8');
    const start = src.indexOf('function generateNativeSequence');
    assert.ok(start >= 0);
    let depth = 0, i = src.indexOf('{', start), end = i;
    for (; end < src.length; end++) { if (src[end] === '{') depth++; else if (src[end] === '}' && --depth === 0) break; }
    assert.ok(!/onHandle/.test(src.slice(i, end)), 'generate-native now records a handle — revise the brief');
});
