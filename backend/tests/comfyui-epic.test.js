/**
 * THE COMFYUI EPIC, HELD TO ITSELF, TO ITS BRIEF AND TO THE CODE.
 *
 *   ITS OWN SHAPE. Every section the format asks for; tasks that parse, are
 *   numbered consecutively and depend only on EARLIER tasks.
 *
 *   ITS BRIEF. Every Top Idea and every Open Question in the research brief is
 *   either a task or an open question here — derived from the brief's own
 *   numbered lists, so an idea dropped between documents fails.
 *
 *   THE CODE. A provider adapter is not one file; the registries that refuse to
 *   boot or silently misreport without it are derived from the source, and
 *   each must be named by a task. The render-ledger columns nothing fills are
 *   read from the migration, and each must be named too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = path.join(ROOT, 'docs/plans/comfyui-epic.md');
const doc = () => fs.readFileSync(EPIC, 'utf8');
const BRIEF = fs.readFileSync(path.join(ROOT, 'docs/plans/comfyui-research-brief.md'), 'utf8');

const REQUIRED = ['Overview', 'Business Goals', 'Current State', 'Target State',
    'Constraints', 'Task Breakdown', 'Open Questions', 'Success Metrics'];

function section(text, heading, level = '##') {
    const m = text.match(new RegExp(`^${level} ${heading}\\s*$([\\s\\S]*?)(?=^#{2,3} |(?![\\s\\S]))`, 'm'));
    assert.ok(m, `no "${heading}" section`);
    return m[1];
}

function tasks() {
    return [...doc().matchAll(/^\|\s*(CUI-(\d{3}))\s*\|([^|]*)\|([^|]*)\|\s*([SML])\s*\|([^|]*)\|/gm)]
        .map(m => ({ id: m[1], n: +m[2], title: m[3].trim(), description: m[4].trim(), deps: m[6].trim() }));
}

function depNumbers(deps) {
    if (/^none$/i.test(deps)) return [];
    return deps.split(',').map(s => s.trim()).map(part => {
        const one = part.match(/^CUI-(\d{3})$/);
        assert.ok(one, `unparseable dependency "${part}"`);
        return +one[1];
    });
}

const taskText = () => tasks().map(t => `${t.title} ${t.description}`).join('\n');

test('the epic exists and carries every section the format asks for', () => {
    assert.ok(fs.existsSync(EPIC), 'docs/plans/comfyui-epic.md does not exist');
    const have = new Set([...doc().matchAll(/^## (.+)$/gm)].map(m => m[1].trim()));
    assert.deepEqual(REQUIRED.filter(s => !have.has(s)), []);
});

test('it records the user direction verbatim', () => {
    assert.ok(doc().includes('"Go with recommendation"'));
});

test('every task is well formed and consecutively numbered', () => {
    const all = tasks();
    assert.ok(all.length >= 15, `only ${all.length} tasks parsed`);
    all.forEach((t, i) => {
        assert.equal(t.n, i + 1, `${t.id} is out of sequence`);
        assert.ok(t.title.length > 3 && t.description.length > 60, `${t.id} is not described`);
    });
});

test('every dependency names an EARLIER task that exists', () => {
    for (const t of tasks()) {
        for (const d of depNumbers(t.deps)) {
            assert.ok(d < t.n, `${t.id} depends on CUI-${String(d).padStart(3, '0')}, which is not earlier`);
        }
    }
});

test('every Top Idea in the brief is a task', () => {
    // Derived from the brief: each numbered idea's bold title.
    const ideas = [...section(BRIEF, 'Top Ideas & Opportunities', '###').matchAll(/^\d+\.\s+\*\*([^*]+)\*\*/gm)].map(m => m[1]);
    assert.ok(ideas.length >= 7, `brief scan found ${ideas.length} ideas`);
    // Each idea carries a KEY term that must reach some task.
    const KEY = { 'Lip-sync': /lip-?sync/i, 'Wan 2.2': /FLF2V|first.last/i, 'finishing': /SeedVR2/, 'Previs': /ControlNet/,
        'identity': /LoRA|PuLID/, 'render ledger': /render_ledger|render ledger/i, 'GPU cost': /gpu_seconds/ };
    const text = taskText();
    const missing = ideas.filter(idea => {
        const k = Object.keys(KEY).find(key => idea.toLowerCase().includes(key.toLowerCase()));
        assert.ok(k, `idea "${idea}" has no key term — update KEY`);
        return !KEY[k].test(text);
    });
    assert.deepEqual(missing, []);
});

test('every Open Question in the brief survives, as a task or an open question', () => {
    const qs = [...section(BRIEF, 'Open Questions', '###').matchAll(/^\d+\.\s+\*\*([^*:]+)/gm)].map(m => m[1].trim().replace(/\.$/, ''));
    assert.ok(qs.length >= 6, `brief scan found ${qs.length} questions`);
    const KEY = { Images: /house standard/i, 'GPU host': /RunPod|Modal/, 'Model licences': /Hunyuan/, 'Real cost per second': /measure/i,
        'Custom-node trust': /allowlist/i, 'LoRA training': /LoRA training|train/i };
    const here = section(doc(), 'Open Questions') + taskText();
    qs.forEach(q => assert.ok(KEY[q], `brief question "${q}" has no key term — update KEY`));
    assert.deepEqual(qs.filter(q => !KEY[q].test(here)), []);
});

test('every registry a new provider adapter must satisfy is named by a task (derived from the code)', () => {
    const B = path.join(ROOT, 'backend');
    const src = f => fs.readFileSync(path.join(B, f), 'utf8');
    const REGISTRIES = [];
    if (/function assertCoverage/.test(src('lib/provider-pricing.js'))) REGISTRIES.push(['rate book coverage', /comfyui:\*|rate row|RATE_BOOK/]);
    if (/adapter\.available\(\)/.test(src('lib/providers/index.js'))) REGISTRIES.push(['synchronous available()', /available\(\)/]);
    if (/asyncGeneration/.test(src('lib/providers/index.js'))) REGISTRIES.push(['async job handle', /asyncGeneration|collect\(\)/]);
    if (/'USD', 0,/.test(src('lib/usage-meter.js'))) REGISTRIES.push(['gpu seconds hard-coded to zero', /gpu_seconds/]);
    if (/STANDARD_PROVIDERS/.test(src('lib/providers/index.js'))) REGISTRIES.push(['image house standard', /house standard/i]);
    if (/function preflight/.test(src('lib/e2e-preflight.js'))) REGISTRIES.push(['e2e preflight', /preflight/i]);
    assert.ok(REGISTRIES.length >= 5, `derived only ${REGISTRIES.length} registries — the detector is broken`);
    const text = taskText();
    assert.deepEqual(REGISTRIES.filter(([, re]) => !re.test(text)).map(([n]) => n), []);
});

test('every render_ledger generation column is named by a task (derived from the migration)', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'backend/db/migrations/011_render_ledger.sql'), 'utf8');
    const cols = ['seed', 'sampler', 'steps', 'guidance', 'lora_ids', 'controlnets', 'model_hash']
        .filter(c => new RegExp(`\\b${c}\\b`).test(sql));
    assert.equal(cols.length, 7, 'the migration no longer declares the columns this epic fills');
    const text = taskText();
    assert.deepEqual(cols.filter(c => !text.includes(c)), []);
});

test('every repo path the epic cites exists, except the files it proposes', () => {
    const PROPOSED = new Set(['backend/lib/providers/comfyui.js', 'backend/lib/comfyui-workflows.js',
        'backend/tests/comfyui-adapter.test.js', 'docs/comfyui-host.md']);
    const cited = [...new Set([...doc().matchAll(/`((?:backend|docs|src)\/[A-Za-z0-9_./-]+\.(?:js|md|sql|json))`/g)].map(m => m[1]))];
    assert.ok(cited.length >= 8, `only ${cited.length} paths cited`);
    assert.deepEqual(cited.filter(p => !PROPOSED.has(p) && !fs.existsSync(path.join(ROOT, p))), []);
});
