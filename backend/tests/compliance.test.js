'use strict';

/**
 * -- Checks that must run BEFORE spend --------------------------------------
 *
 * An automated pipeline can put "#1", "clinically proven" or "saves 50%" into a
 * paid advertisement in seconds. FTC, the Competition Act, the CAP Code and the
 * ACCC all require an objective claim to be substantiated — which is exactly why
 * the substantiation has to be a ROW SOMEBODY SIGNED rather than a memory.
 *
 * After generation the money is gone and the frames exist, so this is enforced
 * in the FREE surfaces — run-plan, dry-run — rather than at the generator. It
 * returns findings; it never throws, never writes and never opens a socket.
 *
 * Set-based over CHECKS because the failure is per-check: a gate that catches a
 * banned phrase and misses an expired licence passes any test written against
 * the first.
 */

process.env.FILM_DATA_DIR = require('fs').mkdtempSync(
    require('path').join(require('os').tmpdir(), 'fe-compl-'));

const test = require('node:test');
const assert = require('node:assert');

const {
    CHECKS, CLAIM_PATTERNS, checkCopy, checkRights, findingsFor, blocks,
} = require('../lib/compliance');

const BRAND = {
    name: 'Acme', banned_phrases: JSON.stringify(['revolutionary', 'game changer']),
    legal_line: 'Terms apply.', cta: 'Buy now',
};

test('every declared check can actually fire', () => {
    /*
     * A check nobody can trigger is a label. Each declares a `probe` — the
     * input that must produce it — and the probe is RUN through the real
     * assembler rather than asserted to exist.
     */
    for (const c of CHECKS) {
        assert.ok(c.id && c.label, `a check has no id or label: ${JSON.stringify(c)}`);
        assert.ok(['error', 'warning'].includes(c.severity), `${c.id} has no usable severity`);
        assert.ok(c.probe, `${c.id} declares no probe — nothing proves it can fire`);

        const found = findingsFor(c.probe);
        assert.ok(found.some(f => f.id === c.id),
            `${c.id} did not fire on its own probe — it is a label, not a check`);
    }
});

test('a banned phrase is caught, and the phrase is named', () => {
    const out = checkCopy('This revolutionary blender changes everything.', BRAND, []);
    const f = out.find(x => x.id === 'banned_phrase');
    assert.ok(f, 'a phrase the brand forbids was not caught');
    assert.ok(/revolutionary/i.test(JSON.stringify(f)),
        'the finding does not name the phrase — "your copy contains a banned phrase" sends you to re-read it');
    assert.equal(f.severity, 'error');

    assert.equal(checkCopy('A blender that works.', BRAND, []).filter(x => x.id === 'banned_phrase').length, 0,
        'clean copy was flagged');
});

test('an objective claim needs a substantiated row, not just any row', () => {
    const copy = 'The #1 blender, clinically proven to last 50% longer.';

    /*
     * A row that exists but is not substantiated must NOT clear it — the
     * difference between a record and evidence.
     *
     * Bound to the PHRASE, not to "some finding exists": this copy carries three
     * claims, so a check that wrongly cleared "clinically proven" would still
     * report #1 and 50% and satisfy a looser assertion completely.
     */
    const flagged = rows => new Set(checkCopy(copy, BRAND, rows)
        .filter(f => f.id === 'unsubstantiated').map(f => f.phrase.toLowerCase()));

    assert.ok(flagged([]).has('clinically proven'), 'an unsupported claim was not caught');
    for (const status of ['unsubstantiated', 'withdrawn']) {
        assert.ok(flagged([{ claim: 'clinically proven', status }]).has('clinically proven'),
            `a ${status} claim row cleared the check — a record is not evidence`);
    }
    // And a substantiated one clears THAT claim and no other.
    const cleared = flagged([{ claim: 'clinically proven', status: 'substantiated' }]);
    assert.ok(!cleared.has('clinically proven'), 'a substantiated claim did not clear its own phrase');
    assert.ok(cleared.has('#1'), 'substantiating one claim cleared a different, unsupported one');
});

test('every claim pattern is a phrase an advertiser would actually be challenged on', () => {
    // Whole-phrase, never a bare word: a detector that fires on ordinary copy
    // gets switched off within a day, and then it protects nothing — the same
    // asymmetry the style subject-check is built around.
    const innocuous = [
        'She is the best friend he has.',       // "best" inside ordinary prose
        'It arrives faster than we expected.',
        'a number one hit on the radio',
    ];
    for (const text of innocuous) {
        const hits = CLAIM_PATTERNS.filter(re => re.test(text));
        assert.equal(hits.length, 0,
            `"${text}" was read as an advertising claim by ${hits.map(String).join(', ')}`);
    }
    const real = ['The #1 blender', 'clinically proven results', '50% more powerful', 'the fastest blender'];
    for (const text of real) {
        assert.ok(CLAIM_PATTERNS.some(re => re.test(text)), `"${text}" is a claim and was not matched`);
    }
});

test('a synthetic person presented as a real customer is an error', () => {
    /*
     * The one that is genuinely about generated media rather than copy. A
     * testimonial is a statement of fact about a real person's experience, and
     * a generated face delivering one is a fabricated endorsement.
     */
    const out = checkCopy('MAYA (to camera): I lost 20 pounds with this. Real customer, real results.',
        BRAND, []);
    assert.ok(out.some(f => f.id === 'synthetic_customer'),
        'a generated performer delivering a testimonial was not flagged');
});

test('rights are checked for both absence and expiry, against a date', () => {
    const today = '2026-06-01';
    const rows = [
        { subject: 'MAYA', rights_type: 'likeness', status: 'cleared', expires_on: '2027-01-01' },
        { subject: 'RAY',  rights_type: 'likeness', status: 'unknown', expires_on: '' },
        { subject: 'Track', rights_type: 'music_license', status: 'cleared', expires_on: '2026-01-01' },
    ];
    const out = checkRights(rows, today);

    const uncleared = out.find(f => f.id === 'rights_uncleared');
    assert.ok(uncleared, 'an uncleared right was not reported');
    assert.ok(/RAY/.test(JSON.stringify(uncleared)), 'the uncleared subject is not named');

    const expired = out.find(f => f.id === 'rights_expired');
    assert.ok(expired, 'a licence that has passed its expiry was not reported');
    assert.ok(/Track/.test(JSON.stringify(expired)), 'the expired subject is not named');

    // The cleared, unexpired one must not be reported at all.
    assert.ok(!/MAYA/.test(JSON.stringify(out)), 'a cleared right was reported as a problem');
});

test('blocks() is true for an error and false for a warning', () => {
    /*
     * The whole gate turns on this. A warning that blocks a run makes the check
     * something people disable; an error that does not block is a check that
     * changes nothing.
     */
    assert.equal(blocks([{ id: 'x', severity: 'warning' }]), false);
    assert.equal(blocks([{ id: 'x', severity: 'error' }]), true);
    assert.equal(blocks([]), false);
    assert.equal(blocks(null), false, 'no findings at all must not block');
});

test('findings are ordered errors first, and nothing throws on junk input', () => {
    const out = findingsFor({
        script: 'The #1 revolutionary blender.', brand: BRAND, claims: [], rights: [], deliverables: [],
    });
    const firstWarning = out.findIndex(f => f.severity === 'warning');
    const lastError = out.map(f => f.severity).lastIndexOf('error');
    if (firstWarning !== -1 && lastError !== -1) {
        assert.ok(lastError < firstWarning, 'a warning is sorted above an error');
    }

    /*
     * Never throws. It runs inside run-plan and dry-run, and a compliance check
     * that takes down the free preview is worse than no check: the preview is
     * the surface that stops money being spent.
     */
    for (const junk of [undefined, null, {}, { brand: null, claims: null, rights: null },
        { brand: { banned_phrases: 'not json' }, script: null }]) {
        assert.doesNotThrow(() => findingsFor(junk), `findingsFor threw on ${JSON.stringify(junk)}`);
    }
});

test('a project with no brand and no claims produces no errors', () => {
    /*
     * Every film in this tool is in this state. A gate that fires on them is one
     * switched off the day it ships, taking the real case with it.
     */
    const out = findingsFor({ script: 'MAYA walks to the door.', brand: null, claims: [], rights: [] });
    assert.equal(out.filter(f => f.severity === 'error').length, 0,
        `a plain film was blocked: ${JSON.stringify(out)}`);
    assert.equal(blocks(out), false);
});

test('M5 acceptance: an unsubstantiated claim cannot start a run', () => {
    /*
     * The milestone's own acceptance, run through the real planner: a project
     * whose script says "clinically proven" with no substantiated claim row
     * CANNOT start a run, and the finding names the phrase.
     *
     * Asserted on `refused` rather than on the findings list, because a finding
     * that is reported and does not stop the run is a warning wearing an
     * error's label — and the money is gone either way.
     */
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { buildRunPlan } = require('../lib/run-plan');

    const mk = (script, claims) => {
        const pid = generateId();
        const bid = generateId();
        db.prepare(`INSERT INTO film_brands (id, name, banned_phrases) VALUES (?, 'Acme', '[]')`).run(bid);
        db.prepare(`INSERT INTO film_projects (id, title, brand_id, budget_total) VALUES (?, 'Spot', ?, 0)`)
            .run(pid, bid);
        db.prepare(`INSERT INTO film_scripts (id, project_id, version, content)
                    VALUES (?, ?, 1, ?)`).run(generateId(), pid, script);
        const sc = generateId();
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(sc, pid);
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml)
                    VALUES (?, ?, '1A', 4000, ?)`)
            .run(generateId(), sc, JSON.stringify({ shot_code: '1A', description: 'a blender' }));
        for (const c of claims || []) {
            db.prepare(`INSERT INTO film_claims (id, project_id, claim, status) VALUES (?, ?, ?, ?)`)
                .run(generateId(), pid, c.claim, c.status);
        }
        return pid;
    };

    const blocked = buildRunPlan(mk('The blender is clinically proven to last longer.', []));
    assert.equal(blocked.refused, true, 'a run started on an unsubstantiated claim');
    assert.equal(blocked.blocked_by_compliance, true, 'the refusal is not attributed to compliance');
    assert.ok(/clinically proven/i.test(JSON.stringify(blocked.compliance)),
        'the finding does not name the phrase — a director cannot act on "there is a claim"');

    // Substantiated: the same script runs.
    const cleared = buildRunPlan(mk('The blender is clinically proven to last longer.',
        [{ claim: 'clinically proven', status: 'substantiated' }]));
    assert.equal(cleared.blocked_by_compliance, false,
        `a substantiated claim still blocked: ${JSON.stringify(cleared.compliance)}`);

    // And the gate is passable, on the precedent every other gate here follows.
    const forced = buildRunPlan(mk('The blender is clinically proven to last longer.', []),
        { ignore_compliance: true });
    assert.equal(forced.blocked_by_compliance, false, 'ignore_compliance does not get past the gate');

    /*
     * A plain film -- no brand, no claims -- is unaffected. That is every
     * project in this tool, and a gate that fires on them is switched off the
     * day it ships.
     */
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, budget_total) VALUES (?, 'A Film', 0)`).run(pid);
    const film = buildRunPlan(pid);
    assert.equal(film.blocked_by_compliance, false, 'a plain film was blocked by the compliance gate');
});
