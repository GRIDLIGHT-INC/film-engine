/**
 * Re-derive the Marble input contract from Marble itself.
 *
 *   node backend/tests/refresh-marble-contract.js
 *
 * WHY A FIXTURE RATHER THAN A LIVE TEST. Same reasoning as
 * refresh-muapi-contract.js: a test that reaches the network fails on a train
 * and passes in an office, and a suite red for unrelated reasons is one people
 * stop reading. So the contract is snapshotted WITH ITS DATE, on the rule the
 * rate book already follows — a figure with no source and no checked date
 * decays into a confident lie.
 *
 * WHY IT COSTS NOTHING, and this must stay true. Marble validates the request
 * BEFORE starting a world, so a body that omits a required field, or carries a
 * wrong-typed one, comes back 422 naming the field the endpoint wanted. Every
 * probe here is designed to be REFUSED; none can succeed, so none can spend the
 * 250 credits a draft world costs. A 2xx is treated as a bug in this file and
 * throws rather than being written into the snapshot.
 *
 * This exists because the adapter asserted `world_prompt.video.video_prompt`
 * "was read from the API's own 422" and recorded nothing — no date, no source,
 * no way to repeat it. RBF-002 already paid for that shape: a paid answer
 * nobody can re-read will be paid for twice.
 */

const fs = require('fs');
const path = require('path');

const BASE = (process.env.WORLDLABS_BASE_URL || 'https://api.worldlabs.ai').replace(/\/+$/, '');
const URL = `${BASE}/marble/v1/worlds:generate`;
const DEST = path.join(__dirname, 'fixtures', 'marble-contract.json');

function apiKey() {
    if (process.env.WORLDLABS_API_KEY) return process.env.WORLDLABS_API_KEY;
    try {
        const { getCredential } = require('../lib/providers/credentials');
        const c = getCredential('worldlabs');
        return c && (c.apiKey || c);
    } catch (_) { return null; }
}

/*
 * One probe per prompt type, each omitting the field under test so the refusal
 * has to name it, plus a wrong-typed `model` so nothing can validate by
 * accident. The last probe sends five images: if Direction Control caps at
 * four, the API states the bound and the cap stops being a number copied from
 * prose.
 */
const PROBES = [
    { type: 'multi-image', body: { world_prompt: { type: 'multi-image' }, model: 1 } },
    { type: 'video', body: { world_prompt: { type: 'video' }, model: 1 } },
    { type: 'image', body: { world_prompt: { type: 'image' }, model: 1 } },
    { type: 'text', body: { world_prompt: { type: 'text' }, model: 1 } },
    { type: '__image_cap__', body: { world_prompt: { type: 'multi-image', multi_image_prompt: [1, 2, 3, 4, 5] }, model: 1 } },

    /*
     * The probes above omit a field, so the refusal names only what was
     * REQUIRED. These carry every field this engine might send, each with the
     * wrong TYPE, so the refusal names the whole accepted set — and a field
     * Marble does not know is simply absent from it rather than refused. That
     * distinction is the entire reason this technique is worth the trouble:
     * every MuAPI reference image travelled under a field name the endpoint
     * ignored, was dropped, and the frame came back conditioned on nothing.
     */
    { type: '+multi-image', body: { world_prompt: { type: 'multi-image', multi_image_prompt: 1, text_prompt: 1 }, model: 1 } },
    { type: '+video', body: { world_prompt: { type: 'video', video_prompt: 1, text_prompt: 1 }, model: 1 } },
    /*
     * is_pano takes an OBJECT here, not 1. Pydantic coerces an int to a bool,
     * so `is_pano: 1` validated and the field vanished from the refusal — which
     * reads exactly like a field Marble does not know. An object cannot coerce
     * to 'auto', True or False, so a known field must reject it. That one
     * substitution is the difference between recording is_pano as accepted and
     * recording it as silently ignored.
     */
    { type: '+image', body: { world_prompt: { type: 'image', image_prompt: 1, is_pano: { a: 1 }, text_prompt: 1 }, model: 1 } },
    { type: '+text', body: { world_prompt: { type: 'text', text_prompt: 1 }, model: 1 } },
];

/**
 * Field names from a FastAPI 422 — only `detail[].loc`, and only the segment
 * after the container. An earlier version also scraped quoted identifiers from
 * the raw body and returned `ctx`, `msg`, `expected` and `literal_error`,
 * pydantic's own machinery, which would have entered the snapshot as though
 * Marble accepted fields by those names.
 */
function fieldsFromRefusal(json) {
    const names = new Set();
    for (const d of (json && Array.isArray(json.detail) ? json.detail : [])) {
        const loc = Array.isArray(d.loc) ? d.loc.filter((x) => typeof x === 'string') : [];
        const last = loc[loc.length - 1];
        /*
         * A discriminated-union error puts the branch's own literal INTO the
         * loc, e.g. "literal['marble-1.0-draft',...]". That is a type tag, not
         * a field, and writing it into the snapshot would claim Marble accepts
         * a field by that name.
         */
        const isTag = !last || /[[\]']/.test(last);
        if (last && !isTag && !['body', 'world_prompt', 'model'].includes(last)) names.add(last);
        /*
         * A value_error names the field in its MESSAGE, not its loc: the text
         * branch refuses at loc ["body","world_prompt","text"] — the branch
         * name — while the message says "text_prompt is required". Recording
         * the loc alone would have written `text` into the snapshot as a field
         * Marble accepts, which is precisely the wrong-field-name error this
         * whole file exists to stop.
         */
        const m = /\b([a-z][a-z0-9_]{2,})\s+is required\b/.exec(String(d.msg || ''));
        if (m) { names.delete(last); names.add(m[1]); }
    }
    return [...names].sort();
}

/** Any enum the refusal names — the model list arrives this way. */
function enumsFromRefusal(json) {
    const found = {};
    for (const d of (json && Array.isArray(json.detail) ? json.detail : [])) {
        const exp = d.ctx && d.ctx.expected;
        if (!exp) continue;
        // The literal tag is itself the last loc segment; the FIELD is the one
        // before it, so keying on `pop()` records the enum under a name nobody
        // can look up.
        const loc = (Array.isArray(d.loc) ? d.loc : []).filter((x) => typeof x === 'string');
        const key = [...loc].reverse().find((x) => !/[[\]']/.test(x));
        if (!key || key === 'body') continue;
        const vals = [...String(exp).matchAll(/'([^']+)'/g)].map((m) => m[1]);
        if (vals.length) found[key] = [...new Set([...(found[key] || []), ...vals])].sort();
    }
    return found;
}

/** Any numeric bound the refusal states, e.g. "at most 4 items". */
function boundsFromRefusal(json) {
    const found = {};
    for (const d of (json && Array.isArray(json.detail) ? json.detail : [])) {
        const key = (Array.isArray(d.loc) ? d.loc : []).filter((x) => typeof x === 'string').pop();
        const n = d.ctx && (d.ctx.max_length ?? d.ctx.max_items ?? d.ctx.le);
        if (key && Number.isFinite(Number(n))) found[key] = Number(n);
    }
    return found;
}

async function probe(p, attempt = 0) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': apiKey() },
        body: JSON.stringify(p.body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* prose refusal */ }
    if (res.ok) {
        throw new Error(`PROBE ${p.type} was ACCEPTED (${res.status}). This file must only send `
            + 'bodies that cannot validate — a 2xx here may have started a paid world. Fix the probe.');
    }
    /*
     * 429 is the account being busy, not an answer about the contract. Backing
     * off is what makes this re-runnable; writing a rate-limit body into the
     * snapshot as though it were the field list is how a record becomes wrong
     * while looking complete.
     */
    if (res.status === 429 && attempt < 4) {
        const wait = 15000 * (attempt + 1);
        process.stderr.write(`429, waiting ${wait / 1000}s… `);
        await new Promise((r) => setTimeout(r, wait));
        return probe(p, attempt + 1);
    }
    if (res.status === 429) throw new Error(`${p.type}: still rate limited after 4 retries`);
    return {
        status: res.status,
        fields: fieldsFromRefusal(json),
        enums: enumsFromRefusal(json),
        bounds: boundsFromRefusal(json),
        refusal: text.slice(0, 400),
    };
}

async function main() {
    if (!apiKey()) {
        console.error('No WORLDLABS_API_KEY. The snapshot cannot be refreshed without one.');
        process.exit(2);
    }
    const results = {};
    for (const p of PROBES) {
        process.stderr.write(`probing ${p.type}… `);
        const r = await probe(p);
        process.stderr.write(`${r.status} — ${r.fields.join(', ') || '(no field named)'}\n`);
        results[p.type] = r;
        await new Promise((r2) => setTimeout(r2, 8000));   // the account throttles hard
    }

    const cap = results.__image_cap__ || {};
    const probedCap = cap.bounds && (cap.bounds.multi_image_prompt ?? cap.bounds.max_items);

    const prompt_types = {};
    for (const t of ['multi-image', 'video', 'image', 'text']) {
        const req = results[t];
        const all = results[`+${t}`];
        if (!req) continue;
        // required = what the omission probe named; fields = the union, which is
        // what the adapter is actually allowed to send.
        const fields = [...new Set([...(req.fields || []), ...((all && all.fields) || [])])].sort();
        prompt_types[t] = {
            fields,
            required: req.fields,
            // The value domain of any enum field — is_pano's 'auto'/true/false
            // is the set a control has to offer, and a picker built from a
            // guess offers values the API refuses.
            enums: (all && all.enums) || {},
            status: req.status,
            refusal: req.refusal,
        };
    }

    const out = {
        source: 'https://docs.worldlabs.ai/',
        endpoint: URL,
        checked: new Date().toISOString().slice(0, 10),
        how: "Read from the API's own 422 refusals: each probe omits the field under test and "
            + 'carries a wrong-typed model, so every request is rejected by validation before any '
            + 'world is started. Nothing is generated and nothing is charged, which is what makes '
            + 'it safe to re-run: node backend/tests/refresh-marble-contract.js',
        prompt_types,
        models: (results['multi-image'] && results['multi-image'].enums.model) || [],
        limits: {
            max_input_images: Number.isFinite(Number(probedCap)) ? Number(probedCap) : 4,
            max_input_images_source: Number.isFinite(Number(probedCap))
                ? 'probed: the API stated the bound'
                : 'documented: Direction Control takes up to four images (docs.worldlabs.ai)',
            video_max_bytes: 100 * 1024 * 1024,
            video_max_bytes_source: 'documented: "Upload short video clips (under 100MB)" (docs.worldlabs.ai)',
            /*
             * NOT STATED, and recorded as such rather than omitted. Marble
             * bounds video by SIZE and says nothing about length; a duration
             * cap invented here would be a limit the engine enforces and the
             * provider does not, which is how a legitimate 20-second walk-
             * through gets refused by us for no reason.
             */
            video_max_seconds: null,
            video_max_seconds_source: 'not stated by the provider: the documented bound is size, not length',
        },
    };
    fs.writeFileSync(DEST, JSON.stringify(out, null, 1));
    console.error(`\nwrote ${path.relative(process.cwd(), DEST)}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { PROBES, fieldsFromRefusal, enumsFromRefusal, boundsFromRefusal };
