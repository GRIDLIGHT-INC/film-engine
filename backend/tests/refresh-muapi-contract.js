/**
 * Re-derive the MuAPI contract fixture from MuAPI itself.
 *
 *   node backend/tests/refresh-muapi-contract.js
 *
 * WHY A FIXTURE RATHER THAN A LIVE TEST. The catalogue is the authority, but a
 * test that reaches the network fails on a train and passes in an office, and a
 * suite that is red for reasons unrelated to the change is one people stop
 * reading. So the contract is snapshotted WITH ITS DATE, on the same rule the
 * rate book already follows: a figure with no source and no checked date decays
 * into a confident lie.
 *
 * HOW THE FIELD LIST IS OBTAINED, and why it costs nothing. MuAPI validates
 * before it bills: a body whose every field carries the WRONG TYPE comes back
 * 422 naming exactly the fields the endpoint knows, and an unknown field is
 * absent from that list because FastAPI ignores it. So the accepted-field set
 * is read from the refusal. Nothing is generated and nothing is charged.
 *
 * That distinction is the whole reason this file exists: `image_urls` is not
 * rejected by the text-to-image endpoint, it is SILENTLY IGNORED — so every
 * reference travelled, was dropped, and the frame came back plausible.
 */

const fs = require('fs');
const path = require('path');
const { getCredential } = require('../lib/providers/credentials');

const BASE = process.env.MUAPI_BASE_URL || 'https://api.muapi.ai/api/v1';

/* Every field this engine might send, each with a deliberately wrong type. */
const WRONG_TYPED = {
    prompt: 123, aspect_ratio: 1, resolution: 1, output_format: 1,
    images_list: 'x', image_urls: 1, seed: 'x', negative_prompt: 1,
    num_images: 'x', duration: 'x', model: 1, size: 1, quality: 1,
};

async function acceptedFields(slug, apiKey) {
    const res = await fetch(`${BASE}/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, accept: 'application/json' },
        body: JSON.stringify(WRONG_TYPED),
    });
    const json = await res.json().catch(() => ({}));
    const fields = {};
    for (const d of (json.detail || [])) {
        const name = d.loc[d.loc.length - 1];
        if (name === 'body') continue;
        fields[name] = { required: d.type === 'missing', enum: enumFrom(d.msg) };
    }
    return fields;
}

/** "Input should be '1k', '2k' or '4k'" -> ['1k','2k','4k'] */
function enumFrom(msg) {
    if (!/Input should be/.test(String(msg || ''))) return null;
    const found = String(msg).match(/'([^']+)'/g);
    return found ? found.map(s => s.slice(1, -1)) : null;
}

async function main() {
    const { apiKey } = getCredential('muapi');
    if (!apiKey) throw new Error('no MuAPI credential stored — cannot refresh');

    const res = await fetch(`${BASE}/models`, { headers: { 'x-api-key': apiKey } });
    if (!res.ok) throw new Error(`muapi /models -> HTTP ${res.status}`);
    const catalogue = (await res.json()).models || [];

    /* The endpoints this engine actually posts to, so the probe stays small. */
    const { MODELS: IMAGE_MODELS } = require('../lib/providers/muapi-image');
    const probe = new Set();
    for (const spec of Object.values(IMAGE_MODELS || {})) {
        if (spec.slug) probe.add(spec.slug);
        if (spec.editSlug) probe.add(spec.editSlug);
    }
    for (const s of ['nano-banana-pro', 'nano-banana-pro-edit', 'nano-banana-2', 'nano-banana-2-edit',
                     'nano-banana-2-lite', 'nano-banana-2-lite-edit', 'nano-banana', 'nano-banana-edit']) probe.add(s);

    const endpoints = {};
    for (const slug of [...probe].sort()) endpoints[slug] = await acceptedFields(slug, apiKey);

    const out = {
        source: `${BASE}/models`,
        checked: new Date().toISOString().slice(0, 10),
        how: 'Accepted fields read from a 422 on an all-wrong-types body: free, and an ignored field is absent.',
        catalogue: catalogue.map(m => ({
            name: m.name, category: m.category, family: m.family,
            cost: m.cost, cost_currency: m.cost_currency,
        })).sort((a, b) => a.name.localeCompare(b.name)),
        endpoints,
    };
    const dest = path.join(__dirname, 'fixtures', 'muapi-contract.json');
    fs.writeFileSync(dest, JSON.stringify(out, null, 1));
    console.log(`wrote ${dest}: ${out.catalogue.length} models, ${Object.keys(endpoints).length} endpoints probed`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
