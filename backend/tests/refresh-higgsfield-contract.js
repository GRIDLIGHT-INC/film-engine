/**
 * Re-derive the Higgsfield model contract from Higgsfield's own documentation.
 *
 *   node backend/tests/refresh-higgsfield-contract.js
 *
 * Higgsfield's docs say the per-model page is the authority ("Use the exact
 * schema documented on the selected model page"; the OpenAPI file is
 * "supplementary" and lists 6 of 82 endpoints). Every workflow page carries
 * its endpoint ID and its request JSON Schema, so this reads them all and
 * writes lib/providers/higgsfield-models.json WITH THE DATE, on the rule every
 * provider snapshot here follows. Reading the docs is free; nothing is sent to
 * the API.
 */

const fs = require('fs');
const path = require('path');

const DOCS = 'https://docs.higgsfield.ai/docs/models';
const OUT = path.join(__dirname, '..', 'lib', 'providers', 'higgsfield-models.json');

async function text(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.text();
}

function workflowsOf(family, md) {
    const re = new RegExp(`/docs/models/${family}/([a-z0-9-]+)`, 'g');
    return [...new Set([...md.matchAll(re)].map(m => m[1]))];
}

/** The page's endpoint ID and its request schema (the first JSON block with "properties"). */
function parsePage(md) {
    const id = (md.match(/\*\*Endpoint ID:\*\*\s*`([^`]+)`/) || [])[1];
    const title = (md.match(/^# (.+)$/m) || [])[1] || null;
    const notes = [];
    const usage = md.split('## Usage notes')[1];
    if (usage) for (const line of usage.split('\n## ')[0].split('\n')) {
        const t = line.replace(/<[^>]*>/g, '').replace(/^\s*\*\s*/, '').replace(/\\_/g, '_').trim();
        if (t) notes.push(t);
    }
    let schema = null;
    for (const block of md.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
        try {
            const j = JSON.parse(block[1]);
            if (j && j.type === 'object' && j.properties) { schema = j; break; }
        } catch (_) { /* an example, not a schema */ }
    }
    const output = /"video"\s*:\s*\{/.test(md.split('A completed response')[1] || '') ? 'video'
        : /"images"\s*:/.test(md.split('A completed response')[1] || '') ? 'image'
        : /"audio"\s*:/.test(md.split('A completed response')[1] || '') ? 'audio' : null;
    return { id, title, notes, schema, output };
}

async function main() {
    const families = [];
    for (const cat of ['video-generation', 'image-generation']) {
        const md = await text(`${DOCS}/${cat}.md`);
        for (const m of md.matchAll(/href="\/docs\/models\/([a-z0-9-]+)"/g)) families.push(m[1]);
    }
    const models = {};
    const skipped = [];
    for (const family of [...new Set(families)]) {
        const famMd = await text(`${DOCS}/${family}.md`);
        for (const wf of workflowsOf(family, famMd)) {
            const page = parsePage(await text(`${DOCS}/${family}/${wf}.md`));
            if (!page.id || !page.schema || !page.output) { skipped.push(`${family}/${wf}`); continue; }
            models[page.id] = { family, workflow: wf, title: page.title, output: page.output,
                notes: page.notes, schema: page.schema };
        }
    }
    const out = {
        checked: new Date().toISOString().slice(0, 10),
        source: 'https://docs.higgsfield.ai/docs/models.md (each workflow page: Endpoint ID + input schema)',
        skipped,
        models,
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${Object.keys(models).length} endpoints to ${path.relative(process.cwd(), OUT)}; skipped ${skipped.length}: ${skipped.join(', ')}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parsePage };
