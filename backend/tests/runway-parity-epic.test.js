/**
 * THE RUNWAY PARITY EPIC, HELD TO ITSELF, TO ITS BRIEF AND TO THE CODE.
 *
 * Three failures an epic document can have, each checked:
 *
 *   ITS OWN SHAPE. Tasks that do not parse, IDs that skip, dependencies on a
 *   task that does not exist or comes later — a plan nobody can execute in
 *   order is a list, not a plan.
 *
 *   ITS BRIEF. Everything the brief proposed must be either a task or named as
 *   out of scope. The set is DERIVED from the brief — every Runway endpoint it
 *   names that exists in the spec snapshot, every video model the registry
 *   lacks — so a dropped item fails rather than disappearing between documents.
 *
 *   ITS ASSUMPTIONS. The user accepted the brief without answering its open
 *   questions. Every decision the architect therefore had to make is marked
 *   "(assumption)" and must survive as an open question, because an assumption
 *   presented as a finding is how the last camera epic went wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const doc = () => fs.readFileSync(path.join(ROOT, 'docs/plans/runway-parity-epic.md'), 'utf8');
const BRIEF = fs.readFileSync(path.join(ROOT, 'docs/plans/runway-parity-brief.md'), 'utf8');
const SPEC = require('./fixtures/runway-openapi-snapshot.json');
const runway = require('../lib/providers/runway');
const ADAPTER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/providers/runway.js'), 'utf8');
const PRICING_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/provider-pricing.js'), 'utf8');

const REQUIRED = ['Overview', 'Business Goals', 'Current State', 'Target State',
    'Constraints', 'Task Breakdown', 'Open Questions', 'Success Metrics'];

/** One section's body, bounded by its own heading — never a character window. */
function section(name) {
    const m = doc().match(new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
    assert.ok(m, `the epic has no ${name} section`);
    return m[1];
}

function tasks() {
    return [...doc().matchAll(/^\|\s*(RWP-(\d{3}))\s*\|([^|]*)\|([^|]*)\|\s*([SML])\s*\|([^|]*)\|/gm)]
        .map(m => ({ id: m[1], n: Number(m[2]), title: m[3].trim(), description: m[4].trim(), size: m[5], deps: m[6].trim() }));
}

/** "RWP-002..RWP-022" and "RWP-001, RWP-003" both expand to task numbers. */
function depNumbers(deps) {
    if (/^none$/i.test(deps)) return [];
    const out = [];
    for (const part of deps.split(',').map(s => s.trim())) {
        const range = part.match(/^RWP-(\d{3})\.\.RWP-(\d{3})$/);
        if (range) { for (let i = +range[1]; i <= +range[2]; i++) out.push(i); continue; }
        const one = part.match(/^RWP-(\d{3})$/);
        assert.ok(one, `unparseable dependency "${part}"`);
        out.push(+one[1]);
    }
    return out;
}

test('the epic carries every section the format asks for', () => {
    const have = new Set([...doc().matchAll(/^## (.+)$/gm)].map(m => m[1].trim()));
    assert.deepEqual(REQUIRED.filter(s => !have.has(s)), []);
});

test('it records the user direction verbatim', () => {
    assert.ok(doc().includes('"Follow brief: M1→M2→M3"'));
});

test('every task is well formed, uniquely and consecutively numbered', () => {
    const all = tasks();
    assert.ok(all.length >= 20, `only ${all.length} tasks parsed — the scan is broken or the plan is thin`);
    all.forEach((t, i) => {
        assert.equal(t.n, i + 1, `${t.id} is out of sequence`);
        assert.ok(t.title.length > 3 && t.description.length > 40, `${t.id} is not described`);
    });
});

test('every dependency names an EARLIER task that exists', () => {
    const all = tasks();
    for (const t of all) {
        for (const d of depNumbers(t.deps)) {
            assert.ok(d >= 1 && d <= all.length, `${t.id} depends on RWP-${d}, which does not exist`);
            assert.ok(d < t.n, `${t.id} depends on a later task RWP-${d}`);
        }
    }
});

test('the phases are the user\'s milestones, in the order chosen', () => {
    const phases = [...section('Task Breakdown').matchAll(/^### Phase (\d): .*\((M\d)\)\s*$/gm)].map(m => m[2]);
    assert.deepEqual(phases, ['M1', 'M2', 'M3']);
});

test('every Runway endpoint the brief names is planned in the epic (derived from the brief)', () => {
    const stems = [...new Set(SPEC.operations.map(o => o.split(' ')[1].replace('/v1/', '').split('/{')[0]))];
    const named = stems.filter(s => new RegExp('`(POST |GET |DELETE )?(/v1/)?' + s.replace(/[/]/g, '\\/') + '(`|/)').test(BRIEF));
    assert.ok(named.length >= 6, `only ${named.length} endpoints found in the brief — the scan is broken`);
    const epicTasks = section('Task Breakdown') + section('Open Questions');
    const unplanned = named.filter(s => !epicTasks.includes(s));
    assert.deepEqual(unplanned, [], `brief endpoints with no task and no open question: ${unplanned.join(', ')}`);
});

test('every spec video model the registry lacks is named in a task', () => {
    const video = new Set(['/v1/image_to_video', '/v1/text_to_video', '/v1/video_to_video'].flatMap(p => SPEC.models[p] || []));
    const missing = [...video].filter(m => !runway.RUNWAY_VIDEO_MODELS[m]);
    const breakdown = section('Task Breakdown');
    // When RWP-003 lands this set empties; the epic's task still names what it added.
    for (const m of missing) assert.ok(breakdown.includes(`\`${m}\``), `missing model ${m} is in no task`);
});

test('the Current State claims are still true of the code', () => {
    const cur = section('Current State');
    const paths = [...new Set(SPEC.operations.map(o => o.split(' ')[1]))];
    assert.ok(cur.includes(`of ${paths.length} spec paths`));
    assert.ok(/const MAX_KEYFRAMES = 2;/.test(ADAPTER_SRC) && cur.includes('`MAX_KEYFRAMES = 2`'));
    const lf = SPEC.image_to_video_last_frame;
    assert.ok(cur.includes(`${Object.values(lf).filter(Boolean).length} of ${Object.keys(lf).length} i2v models`));
    for (const m of ['gen4.5', 'gen4_turbo', 'hailuo3']) assert.equal(lf[m], false, `${m} is claimed first-only`);
    assert.ok(/'gen3a_turbo'/.test(PRICING_SRC), 'gen3a_turbo is claimed to still be in the rate book');
    // PGN-012 built the per-job cancel (`cancelJob`); what stays unbuilt is a
    // cancelled PIPELINE run cancelling its in-flight tasks — RWP-014's scope.
    assert.ok(/async cancelJob\(/.test(ADAPTER_SRC) && cur.includes('`cancelJob`'), 'the per-job cancel is not recorded as built');
    const pipeline = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pipeline.js'), 'utf8');
    const cancelFn = pipeline.slice(pipeline.indexOf('function cancelPipeline'), pipeline.indexOf('function cancelPipeline') + 2000);
    assert.ok(!/cancelJob|generation-cancel/.test(cancelFn), 'a pipeline run now cancels its tasks — the claim is stale, update it and RWP-014');
});

test('every assumption is labelled and survives as an open question', () => {
    const labelled = [...section('Constraints').matchAll(/^- \*\*([^*]+?) \(assumption\)\*\*/gm)].map(m => m[1]);
    assert.ok(labelled.length >= 3, `only ${labelled.length} assumptions labelled`);
    const oq = section('Open Questions');
    const assumedInOQ = (oq.match(/\*assumes\*/g) || []).length;
    assert.ok(assumedInOQ >= labelled.length,
        `${labelled.length} assumptions in Constraints, only ${assumedInOQ} carried into Open Questions`);
});

test('the default two-frame model is left open, not decided by a task', () => {
    const oq = section('Open Questions');
    assert.ok(oq.includes('`h3_max`') && oq.includes('`seedance2_5`'));
    const t7 = tasks().find(t => t.id === 'RWP-007');
    assert.ok(/not hardcode/i.test(t7.description));
});

test('no task routes generation through Runway\'s MCP, and none adds a server-side LLM', () => {
    for (const t of tasks()) {
        assert.ok(!/mcp\.runwayml\.com|runway mcp/i.test(t.description), `${t.id} routes through Runway's MCP`);
        assert.ok(!/llm-client|server-side (llm|model)/i.test(t.description), `${t.id} adds a server-side model call`);
    }
    assert.ok(/Our adapter, not Runway's MCP/.test(section('Constraints')));
});

test('every paid probe is named, and only probes spend in tests', () => {
    const probes = tasks().filter(t => /paid/i.test(t.description)).map(t => t.id);
    assert.deepEqual(probes, ['RWP-018', 'RWP-020']);
    assert.ok(section('Constraints').includes('(RWP-018, RWP-020)'));
});
