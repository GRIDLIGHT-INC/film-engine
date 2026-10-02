/**
 * The AI video and image tools brief, held to the code it describes.
 *
 * docs/plans/ai-video-image-tools-api-brief.md is the synthesis of
 * ai-video-image-tools-api-research.md. A brief that says "Film Engine already
 * offers X" or "MuAPI does not carry Y" is only useful while it is true, so its
 * claims are written as tables and every row is checked here:
 *
 *   - OFFERED: a model id a registered adapter serves today (modelIdsFor);
 *   - NOT OFFERED: a MuAPI model the brief proposes adding, that no adapter
 *     offers yet but that MuAPI's catalogue snapshot does carry;
 *   - MUAPI LACKS: a family the brief says to reach elsewhere, absent from
 *     the snapshot.
 *
 * Set-based over the brief's own rows, so a claim added later is checked with
 * nothing to remember, and the brief must carry every section the format asks
 * for and name its research source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BRIEF = path.join(ROOT, 'docs', 'plans', 'ai-video-image-tools-api-brief.md');
const RESEARCH = path.join(ROOT, 'docs', 'plans', 'ai-video-image-tools-api-research.md');

function brief() {
    assert.ok(fs.existsSync(BRIEF), `the brief is missing: ${path.relative(ROOT, BRIEF)}`);
    return fs.readFileSync(BRIEF, 'utf8');
}

/** The rows of the table under a heading, as arrays of cell text (backticks stripped). */
function tableUnder(src, heading) {
    const at = src.indexOf(heading);
    assert.ok(at >= 0, `the brief has no "${heading}" table`);
    const rows = [];
    let started = false;
    for (const line of src.slice(at + heading.length).split('\n')) {
        if (/^\s*\|/.test(line)) {
            started = true;
            // A cell may hold an escaped pipe (`\|`, a regex alternation), so
            // split on unescaped pipes only and unescape afterwards.
            const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/)
                .map(c => c.trim().replace(/\\\|/g, '|').replace(/`/g, ''));
            if (cells.every(c => /^:?-+:?$/.test(c))) continue;
            rows.push(cells);
        } else if (started) break;
    }
    return rows.slice(1);                       // drop the header row
}

function muapiNames() {
    const j = require('./fixtures/muapi-contract.json');
    const names = [];
    const walk = o => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') {
            if (o.name && o.category) names.push(o.name);
            Object.values(o).forEach(walk);
        }
    };
    walk(j.catalogue);
    return names;
}

function offeredToday() {
    const providers = require('../lib/providers');
    const out = new Map();                      // model id -> [adapter:capability]
    for (const a of providers.list()) {
        for (const cap of a.capabilities || []) {
            for (const id of providers.modelIdsFor(a, cap) || []) {
                out.set(id, [...(out.get(id) || []), `${a.id}:${cap}`]);
            }
        }
    }
    return out;
}

test('the brief carries every section of the research-brief format and names its research', () => {
    const src = brief();
    for (const h of ['## Research Brief:', '### Executive Summary', '### Key Themes', '### Top Ideas & Opportunities',
        '### Technical Approaches', '### Open Questions', '### Recommended Direction']) {
        assert.ok(src.includes(h), `missing section: ${h}`);
    }
    assert.ok(src.includes('ai-video-image-tools-api-research.md'), 'the brief names the research it summarises');
    assert.ok(fs.existsSync(RESEARCH), 'and that research document exists');
});

test('every model the brief says Film Engine already offers is served by a registered adapter', () => {
    const rows = tableUnder(brief(), '#### Offered today');
    assert.ok(rows.length >= 8, `only ${rows.length} rows: the table is not being read`);
    const offered = offeredToday();
    const wrong = rows.filter(([adapter, id]) => !(offered.get(id) || []).some(x => x.startsWith(adapter + ':')))
        .map(([adapter, id]) => `${adapter} ${id}`);
    assert.deepEqual(wrong, [], `the brief claims these are offered and they are not:\n  ${wrong.join('\n  ')}`);
});

test('every MuAPI model the brief proposes adding is in MuAPI\'s catalogue and not offered yet', () => {
    const rows = tableUnder(brief(), '#### MuAPI models not offered yet');
    assert.ok(rows.length >= 8, `only ${rows.length} rows: the table is not being read`);
    const names = new Set(muapiNames());
    const offered = offeredToday();
    const notInCatalogue = rows.filter(([id]) => !names.has(id)).map(([id]) => id);
    // A gap ON MUAPI: the same model id served by another vendor (Higgsfield's Z-Image) does not close it.
    const alreadyOffered = rows.filter(([id]) => (offered.get(id) || []).some(x => /^(muapi|seedance):/.test(x))).map(([id]) => id);
    assert.deepEqual(notInCatalogue, [], `not in the MuAPI snapshot: ${notInCatalogue.join(', ')}`);
    assert.deepEqual(alreadyOffered, [], `already offered, so not a gap: ${alreadyOffered.join(', ')}`);
});

test('every family the brief says MuAPI lacks is absent from the catalogue snapshot', () => {
    const rows = tableUnder(brief(), '#### Not on MuAPI');
    assert.ok(rows.length >= 4, `only ${rows.length} rows: the table is not being read`);
    const names = muapiNames().map(n => n.toLowerCase());
    const present = rows.filter(([, pattern]) => names.some(n => new RegExp(pattern, 'i').test(n)))
        .map(([family, pattern]) => `${family} (${pattern}) matches ${names.filter(n => new RegExp(pattern, 'i').test(n)).join(', ')}`);
    assert.deepEqual(present, [], `the brief says MuAPI lacks these and the snapshot carries them:\n  ${present.join('\n  ')}`);
});

test('the model the brief says to retire is still offered, so the action is real', () => {
    const rows = tableUnder(brief(), '#### To retire');
    assert.ok(rows.length >= 1);
    const offered = offeredToday();
    for (const [id, when] of rows) {
        assert.ok(offered.has(id), `${id} is no longer offered; the brief's retirement row is stale`);
        assert.match(when, /^\d{4}-\d{2}-\d{2}$/, `${id} carries a dated deadline`);
    }
});
