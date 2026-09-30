/**
 * The AI video and image tools epic, held to its brief and to the code.
 *
 * docs/plans/ai-tools-epic.md plans the brief's Recommended Direction (user
 * direction: "Follow the recommendation"). An epic is a registry of tasks, so
 * it is checked the way a registry is:
 *
 *   - it has every section of the epic format;
 *   - every task is well formed (unique id, size S/M/L, dependencies that
 *     exist, come earlier and never loop);
 *   - every MuAPI model the brief proposes is planned by exactly one task;
 *   - every place in the code that offers, prices or tiers the retiring model
 *     is named by the retirement task, derived from the SOURCE so a new
 *     reference fails here rather than surviving the shutdown;
 *   - the vendors the brief defers are named as out of scope, and Midjourney
 *     as never.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = path.join(ROOT, 'docs', 'plans', 'ai-tools-epic.md');
const BRIEF = path.join(ROOT, 'docs', 'plans', 'ai-video-image-tools-api-brief.md');

function epic() {
    assert.ok(fs.existsSync(EPIC), `the epic is missing: ${path.relative(ROOT, EPIC)}`);
    return fs.readFileSync(EPIC, 'utf8');
}

function cells(line) {
    return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|').replace(/`/g, ''));
}

/** Every task row in the epic, from every phase table. */
function tasks(src) {
    const out = [];
    for (const line of src.split('\n')) {
        const m = /^\|\s*(AIT-\d{3})\s*\|/.exec(line);
        if (!m) continue;
        const [id, title, description, size, deps] = cells(line);
        out.push({ id, title, description, size, deps: deps === 'None' ? [] : deps.split(/,\s*/) });
    }
    return out;
}

/** The brief's proposed MuAPI models: the first column of its table. */
function proposedModels() {
    const src = fs.readFileSync(BRIEF, 'utf8');
    const at = src.indexOf('#### MuAPI models not offered yet');
    const rows = [];
    let started = false;
    for (const line of src.slice(at).split('\n').slice(1)) {
        if (/^\s*\|/.test(line)) { started = true; rows.push(cells(line)); } else if (started) break;
    }
    return rows.slice(2).map(r => r[0]);      // drop header and separator
}

/** Every lib/ file that names the retiring model's ids, derived from source. */
function retiringModelSites() {
    const ids = [/['"]nano-banana['"]/, /gemini_2\.5_flash/];
    const out = [];
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js') && ids.some(re => re.test(fs.readFileSync(p, 'utf8')))) {
                out.push(path.relative(path.join(ROOT, 'backend'), p));
            }
        }
    };
    walk(path.join(ROOT, 'backend', 'lib'));
    return out.sort();
}

test('the epic carries every section of the epic format and names its brief and direction', () => {
    const src = epic();
    for (const h of ['# Epic:', '## Overview', '## Business Goals', '## Current State', '## Target State',
        '## Constraints', '## Task Breakdown', '### Phase 1:', '### Phase 2:', '## Open Questions', '## Success Metrics']) {
        assert.ok(src.includes(h), `missing section: ${h}`);
    }
    assert.ok(src.includes('ai-video-image-tools-api-brief.md'), 'names the brief it plans');
    assert.ok(src.includes('Follow the recommendation'), 'records the user direction verbatim');
});

test('every task is well formed: unique id, a size, dependencies that exist, come earlier and never loop', () => {
    const list = tasks(epic());
    assert.ok(list.length >= 10, `only ${list.length} tasks read: the table is not being parsed`);
    const ids = list.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, 'task ids are unique');
    const order = new Map(ids.map((id, i) => [id, i]));
    for (const t of list) {
        assert.match(t.size, /^(S|M|L)$/, `${t.id} has a size of S, M or L`);
        assert.ok(t.title && t.description && t.description.length > 40, `${t.id} has a title and a real description`);
        for (const d of t.deps) {
            assert.ok(order.has(d), `${t.id} depends on ${d}, which is not a task`);
            assert.ok(order.get(d) < order.get(t.id), `${t.id} depends on ${d}, which comes after it`);
        }
    }
});

test('every MuAPI model the brief proposes is planned by exactly one task', () => {
    const list = tasks(epic());
    const models = proposedModels();
    assert.equal(models.length, 15, `the brief proposes 15 models, read ${models.length}`);
    const problems = [];
    for (const m of models) {
        const owners = list.filter(t => new RegExp(`(^|[^\\w.-])${m.replace(/[.]/g, '\\.')}([^\\w.-]|$)`).test(t.description)).map(t => t.id);
        if (owners.length !== 1) problems.push(`${m}: ${owners.length ? owners.join(', ') : 'no task'}`);
    }
    assert.deepEqual(problems, [], `each model must be planned exactly once:\n  ${problems.join('\n  ')}`);
});

test('the retirement task names every place in the code that offers, prices or tiers the retiring model', () => {
    const list = tasks(epic());
    const retire = list.find(t => /retire/i.test(t.title) && /nano-banana/.test(t.description));
    assert.ok(retire, 'there is a task that retires nano-banana');
    const sites = retiringModelSites();
    assert.ok(sites.length >= 3, `only ${sites.length} source sites found: the scan is broken`);
    const missing = sites.filter(s => !retire.description.includes(s));
    assert.deepEqual(missing, [], `the retirement task does not name: ${missing.join(', ')}`);
    assert.ok(retire.description.includes('gemini_2.5_flash'), 'it names Runway\'s id for the same model too');
    assert.equal(list.indexOf(retire), 0, 'it is the first task, because it has a date');
});

test('the deferred vendors are out of scope and Midjourney is never wired', () => {
    const src = epic();
    const constraints = src.slice(src.indexOf('## Constraints'), src.indexOf('## Task Breakdown'));
    for (const v of ['Luma', 'Magnific', 'Recraft', 'HeyGen', 'Pika']) {
        assert.ok(constraints.includes(v), `${v} is named in the constraints as deferred`);
    }
    assert.match(constraints, /Midjourney[^\n]*never/i, 'Midjourney is named as never wired');
    const taskText = tasks(src).map(t => t.description).join('\n');
    assert.ok(!/Midjourney/i.test(taskText.replace(/never[^.]*Midjourney|Midjourney[^.]*never/gi, '')),
        'no task plans a Midjourney integration');
});

test('the plan reaches the goal: an end-to-end proof through MCP, and no server-side LLM', () => {
    const list = tasks(epic());
    const proof = list.find(t => /end.to.end/i.test(t.title));
    assert.ok(proof, 'there is an end-to-end proof task');
    assert.match(proof.description, /MCP/, 'it runs through the MCP tools');
    assert.match(proof.description, /screenplay/i, 'it starts from a screenplay');
    assert.match(proof.description, /final (movie|film|master)/i, 'and ends at a final movie');
    assert.match(epic(), /server-side LLM/, 'the epic states the no-server-LLM rule');
});
