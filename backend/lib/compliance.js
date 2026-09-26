'use strict';

/**
 * -- Checks that must run BEFORE spend --------------------------------------
 *
 * An automated pipeline can put "#1", "clinically proven" or "saves 50%" into a
 * paid advertisement in seconds. FTC, the Competition Act, the CAP Code and the
 * ACCC all require an objective claim to be substantiated, which is exactly why
 * the substantiation has to be a ROW SOMEBODY SIGNED rather than a memory.
 *
 * Enforced in the FREE surfaces — `run-plan`, `dry-run` — rather than at the
 * generator, because after generation the money is gone and the frames exist.
 * That is also why nothing here throws: it runs inside the previews that stop
 * money being spent, and a check that takes one of those down is worse than no
 * check at all.
 *
 * Pure. Takes rows, returns findings. No database, no I/O, no sockets.
 */

/**
 * Every check, with the input that must produce it.
 *
 * `probe` is not documentation — the test RUNS it through the real assembler, so
 * a check that can no longer fire fails rather than sitting here as a label.
 */
const CHECKS = [
    {
        id: 'banned_phrase', severity: 'error',
        label: 'Copy contains a phrase the brand forbids',
        probe: { script: 'This revolutionary blender.', brand: { banned_phrases: '["revolutionary"]' } },
    },
    {
        id: 'unsubstantiated', severity: 'error',
        label: 'Objective claim with no substantiated claim row',
        probe: { script: 'The #1 blender in America.', claims: [] },
    },
    {
        id: 'synthetic_customer', severity: 'error',
        label: 'Generated person presented as a real satisfied customer',
        probe: { script: 'A real customer tells us how it changed her life.' },
    },
    {
        id: 'rights_uncleared', severity: 'error',
        label: 'A referenced asset is not cleared in the rights register',
        probe: { rights: [{ subject: 'RAY', rights_type: 'likeness', status: 'unknown' }] },
    },
    {
        id: 'rights_expired', severity: 'error',
        label: 'A cleared right has passed its expiry',
        probe: {
            today: '2026-06-01',
            rights: [{ subject: 'Track', rights_type: 'music_license', status: 'cleared', expires_on: '2020-01-01' }],
        },
    },
    {
        id: 'no_legal_line', severity: 'warning',
        label: 'The brand carries a legal line and no deliverable places it',
        probe: { brand: { legal_line: 'Terms apply.' }, deliverables: [{ key: '30_16x9', caption_mode: 'none' }] },
    },
    {
        id: 'no_cta', severity: 'warning',
        label: 'No call to action in the script or on the brand',
        probe: { script: 'A blender sits on a counter.', brand: { name: 'Acme' }, deliverables: [{ key: '30_16x9' }] },
    },
];

/**
 * Claim patterns worth flagging.
 *
 * WHOLE PHRASES, never bare words. A detector that fires on "she is the best
 * friend he has" is switched off within a day and then protects nothing — the
 * same asymmetry the style-preset subject check is built around. Each of these
 * is a form an advertiser is actually challenged on.
 */
const CLAIM_PATTERNS = [
    /#\s?1\b/,
    /\bno\.\s?1\b/i,
    /*
     * A superlative followed by a PRODUCT, not by a relationship or a figure of
     * speech. `the best` alone fires on "she is the best friend he has", which
     * is ordinary prose in a screenplay — and a detector that flags that gets
     * switched off within a day, taking the real claim with it.
     *
     * The exception list is short and concrete rather than clever, because the
     * engine genuinely cannot tell "the fastest blender" (a claim) from "the
     * fastest runner" (description) in general. Named prose nouns are the cases
     * that actually appear in a script.
     */
    /\bthe\s+best\s+(?!friend|friends|man|men|woman|women|thing|things|part|parts|way|ways|day|days|time|times|years|of\b|I\b|we\b|he\b|she\b)/i,
    /\bclinically\s+proven\b/i,
    /\bscientifically\s+proven\b/i,
    /\bguarantee[ds]?\b/i,
    /\b\d+\s?%\s+(more|less|faster|cheaper|longer|stronger)\b/i,
    /\b\d+\s?(x|times)\s+(more|faster|stronger|longer)\b/i,
    /\bthe\s+(fastest|cheapest|strongest|longest[- ]lasting)\s+(?!friend|man|woman|thing|way|day|time|years|of\b)/i,
];

/** Testimonial language: a statement of fact about a real person's experience. */
const TESTIMONIAL_PATTERNS = [
    /\breal\s+(customer|customers|people|results)\b/i,
    /\b(actual|genuine)\s+customer\b/i,
    /\bnot\s+a\s+paid\s+actor\b/i,
    /\bI\s+lost\s+\d+/i,
    /\btestimonial\b/i,
];

const CTA_PATTERNS = [
    /\bbuy\s+now\b/i, /\bshop\s+now\b/i, /\blearn\s+more\b/i, /\bsign\s+up\b/i,
    /\bvisit\b/i, /\bdownload\b/i, /\border\s+(now|today)\b/i, /\bget\s+yours\b/i,
];

/** A JSON column that may be junk. Never throws — a malformed kit is not a crash. */
function parseList(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'string') return [];
    try {
        const out = JSON.parse(value);
        return Array.isArray(out) ? out : [];
    } catch (_) { return []; }
}

function finding(id, message, extra) {
    const spec = CHECKS.find(c => c.id === id) || { severity: 'warning', label: id };
    return { id, severity: spec.severity, label: spec.label, message, ...(extra || {}) };
}

/**
 * (text, brand, claims) -> findings. No database.
 *
 * A claim is cleared only by a SUBSTANTIATED row. A row that exists and is not
 * substantiated must not clear it: that is the difference between a record and
 * evidence, and it is the whole reason the table has a status.
 */
function checkCopy(text, brand, claims) {
    const out = [];
    const copy = String(text || '');
    const b = brand || {};
    const rows = Array.isArray(claims) ? claims : [];

    for (const phrase of parseList(b.banned_phrases)) {
        const p = String(phrase || '').trim();
        if (!p) continue;
        // Whole word, so "revolutionary" does not fire on "revolutionaries".
        const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(copy)) {
            out.push(finding('banned_phrase',
                `The copy contains "${p}", which this brand forbids.`, { phrase: p }));
        }
    }

    const substantiated = rows
        .filter(r => r && r.status === 'substantiated')
        .map(r => String(r.claim || '').toLowerCase());
    for (const re of CLAIM_PATTERNS) {
        const m = copy.match(re);
        if (!m) continue;
        const phrase = m[0];
        const covered = substantiated.some(c => c && (copy.toLowerCase().includes(c)
            ? phrase.toLowerCase().includes(c) || c.includes(phrase.toLowerCase())
            : false));
        if (!covered) {
            out.push(finding('unsubstantiated',
                `"${phrase}" is an objective claim with no substantiated claim row. `
                + 'Record the evidence and mark it substantiated, or change the line.',
                { phrase }));
        }
    }

    for (const re of TESTIMONIAL_PATTERNS) {
        const m = copy.match(re);
        if (!m) continue;
        out.push(finding('synthetic_customer',
            `"${m[0]}" presents a performance as a real customer's experience. Every person in `
            + 'this spot is generated, so that is a fabricated endorsement rather than a testimonial.',
            { phrase: m[0] }));
        break;
    }
    return out;
}

/** (rightsRows, today) -> findings. No database. */
function checkRights(rows, today) {
    const out = [];
    const list = Array.isArray(rows) ? rows : [];
    const now = String(today || '').slice(0, 10) || new Date().toISOString().slice(0, 10);

    for (const r of list) {
        if (!r) continue;
        const status = r.status || 'unknown';
        if (status !== 'cleared') {
            out.push(finding('rights_uncleared',
                `${r.subject || 'An asset'} (${r.rights_type || 'right'}) is "${status}", not cleared.`,
                { subject: r.subject, rights_type: r.rights_type, status }));
            continue;
        }
        const expires = String(r.expires_on || '').slice(0, 10);
        if (expires && expires < now) {
            out.push(finding('rights_expired',
                `${r.subject || 'An asset'} was cleared until ${expires}, which has passed.`,
                { subject: r.subject, expires_on: expires }));
        }
    }
    return out;
}

/**
 * The one a caller uses. Errors first, because that is the order they matter in
 * and a caller that stops reading has read the blocking ones.
 */
function findingsFor(input) {
    const i = input || {};
    const out = [];
    try {
        out.push(...checkCopy(i.script, i.brand, i.claims));
        out.push(...checkRights(i.rights, i.today));

        const brand = i.brand || {};
        const deliverables = Array.isArray(i.deliverables) ? i.deliverables : [];

        /*
         * A legal line the brand carries and no deliverable places. A WARNING
         * rather than an error: where the super goes is a timeline operation in
         * Premiere, so the engine can only say that nothing here is carrying it.
         */
        if (brand.legal_line && deliverables.length
            && !deliverables.some(d => d && d.caption_mode && d.caption_mode !== 'none')) {
            out.push(finding('no_legal_line',
                `${brand.name || 'This brand'} carries a legal line and no deliverable has captions `
                + 'turned on, so nothing in this set places it.'));
        }

        // A spot with no call to action anywhere. Warning: an awareness film is
        // a real thing to make and does not need one.
        const copy = String(i.script || '');
        const hasCta = CTA_PATTERNS.some(re => re.test(copy)) || !!(brand.cta || '').trim();
        if (!hasCta && (deliverables.length || brand.name)) {
            out.push(finding('no_cta',
                'No call to action in the script, and none on the brand.'));
        }
    } catch (_) {
        /*
         * Never throws. This runs inside the free previews that stop money
         * being spent, and a compliance check that takes one down is worse than
         * no check — the same rule stampAsset already documents for
         * fingerprinting a generation that already succeeded.
         */
    }
    const rank = { error: 0, warning: 1 };
    return out.sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
}

/** true when any finding is an error. run-plan refuses on this. */
function blocks(findings) {
    return Array.isArray(findings) && findings.some(f => f && f.severity === 'error');
}

module.exports = {    CHECKS, CLAIM_PATTERNS,
    checkCopy, checkRights, findingsFor, blocks, parseList,};
