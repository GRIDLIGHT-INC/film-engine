/**
 * Creating a subject and updating one must accept the same fields
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "`prop_create` accepted `height_m`, `width_m`, `length_m` and stored all
 *  three as `null`. `prop_update` with the identical values persisted them
 *  correctly, so the defect is in the create path only. `character_create`
 *  drops `height_m` the same way."
 *
 * Correct, and the two names in that report are a SYMPTOM. The create handlers
 * each carried their own INSERT column list, written when the table was smaller
 * and never grown -- so every column added since reached the update path and
 * nothing else. Measured before the fix: character dropped 1 field, location 4,
 * prop 9. The dimensions were simply the ones somebody noticed, because they
 * are the ones that produce the scale clause in an image prompt:
 *
 *     Scale: DRIVE-IN SPEAKER POST is roughly 1.7 times the size of a car
 *     tyre, 1.1m tall, 0.12m long, 0.55m wide
 *
 * A subject created and never updated generates at whatever size the model
 * imagines, and nothing reports it.
 *
 * THE INVARIANT IS A PROPERTY, NOT A FIELD LIST:
 *
 *     create(body)  ==  create({name}) then update(body)
 *
 * Written that way deliberately. A test that enumerates the fields it knows
 * about is only ever as complete as the afternoon it was written -- and the
 * column that gets added next is exactly the one that would be silently
 * dropped again. This compares the two code paths against each other over
 * EVERY column the table actually has, read from the schema at run time, so a
 * migration adding a column puts it in the denominator with nothing to
 * remember.
 *
 * A column the UPDATE path does not accept either is not a failure here: both
 * sides store the default and agree. This asks only that the two paths cannot
 * DISAGREE, which is the whole defect.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-ecf-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleCharacters } = require('../routes/characters');
const { handleLocations } = require('../routes/locations');

/** Columns that are identity, bookkeeping, or written by another subsystem. */
const NOT_AUTHORED = new Set([
    'id', 'project_id', 'created_at', 'updated_at',
    // Stamped by the bible link, not a value a caller sets directly.
    'bible_fingerprint',
    // Pointers owned by other tables' own routes.
    'voice_profile_id', 'default_costume_id',
]);

/**
 * The three subjects a production describes, and how each is reached.
 * `handleLocations` serves props as well -- one router, two entities.
 */
const ENTITIES = [
    { kind: 'character', table: 'film_characters', router: handleCharacters,
      create: pid => ['POST', `/film/projects/${pid}/characters`],
      update: id => ['PUT', `/film/characters/${id}`] },
    { kind: 'location', table: 'film_locations', router: handleLocations,
      create: pid => ['POST', `/film/projects/${pid}/locations`],
      update: id => ['PUT', `/film/locations/${id}`] },
    { kind: 'prop', table: 'film_props', router: handleLocations,
      create: pid => ['POST', `/film/projects/${pid}/props`],
      update: id => ['PUT', `/film/props/${id}`] },
];

function call(router, method, url, body) {
    return new Promise(resolve => {
        const chunks = [];
        const res = {
            writeHead(status) { this.statusCode = status; return this; },
            end(payload) {
                chunks.push(payload || '');
                let parsed = {};
                try { parsed = JSON.parse(chunks.join('') || '{}'); } catch (_) { parsed = {}; }
                resolve({ status: this.statusCode || 200, body: parsed });
            },
        };
        router({ method, url, body: body || {} }, res, url.split('?')[0].split('/').filter(Boolean));
    });
}

/**
 * A value this column will accept.
 *
 * Most are typed from the schema. The structured ones are named with the shape
 * their own route validates against -- a probe the route REFUSES proves nothing
 * about create and update agreeing, so a wrong sample here reads as a defect
 * that is not there.
 */
const SHAPED = {
    description_sections: { overview: 'a wide, low room' },
    continuity_flags: ['chalkboard stays blank'],
    plate_plan: [{ role: 'master', caption: 'south to north' }],
    orientation_plan: { north: 'the counter', south: 'the door' },
    materials_json: [{ name: 'enamel', role: 'body', hex: '#8899aa' }],
    constraints_json: ['must not read as modern'],
    continuity_states: [{ name: 'unlit', what: 'bulb dead', scene: '3' }],
    keywords: ['diner', 'chrome'],
    reference_images: ['https://example.test/a.png'],
    // Validated against lib/lighting's vocabulary.
    lighting_technique: 'rembrandt',
    lighting_key_side: 'left',
};

function sampleFor(col) {
    if (col.name in SHAPED) return SHAPED[col.name];
    const type = String(col.type || '').toUpperCase();
    const dflt = col.dflt_value === null ? null : String(col.dflt_value).replace(/^'|'$/g, '');
    if (type.includes('INT')) return col.name === 'practical' ? 1 : 3;
    if (type.includes('REAL')) return 1.25;
    if (dflt === '[]') return ['alpha', 'beta'];           // an unshaped JSON list column
    // A few columns are validated against a vocabulary rather than free text.
    // The real vocabulary, from the registry the CHECK constraint mirrors --
    // an invented value is refused by SQLite and reads as a create defect.
    if (col.name === 'category') return require('../lib/prop-categories').PROP_CATEGORIES[1];
    if (col.name === 'talent_tier') return 'lead';
    return `probe-${col.name}`;
}

function projectWithScene() {
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))`).run(pid, 'create-vs-update ' + pid.slice(0, 6));
    return pid;
}

/** Everything but identity and bookkeeping, compared as stored. */
function readable(table) {
    return db.prepare(`PRAGMA table_info(${table})`).all()
        .filter(c => !NOT_AUTHORED.has(c.name));
}

function snapshot(table, id) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    const out = {};
    for (const c of readable(table)) out[c.name] = row ? row[c.name] : undefined;
    return out;
}

for (const ent of ENTITIES) {
    test(`${ent.kind}: creating with a field stores what updating with it stores`, async () => {
        const cols = readable(ent.table);
        assert.ok(cols.length >= 5, `${ent.table} exposed only ${cols.length} authored columns — the schema read has gone wrong`);

        const body = { name: `PROBE ${ent.kind.toUpperCase()}` };
        for (const c of cols) {
            if (c.name === 'name') continue;
            body[c.name] = sampleFor(c);
        }

        // Path A: everything at once, on create.
        const pidA = projectWithScene();
        const [cm, cu] = ent.create(pidA);
        const madeA = await call(ent.router, cm, cu, body);
        assert.ok(madeA.status === 200 || madeA.status === 201,
            `create returned ${madeA.status}: ${JSON.stringify(madeA.body).slice(0, 300)}`);
        const idA = madeA.body.id;
        assert.ok(idA, `create returned no id: ${JSON.stringify(madeA.body).slice(0, 200)}`);

        // Path B: the name on create, everything else on update.
        const pidB = projectWithScene();
        const madeB = await call(ent.router, cm, ent.create(pidB)[1], { name: body.name });
        const idB = madeB.body.id;
        assert.ok(idB, `minimal create returned no id: ${JSON.stringify(madeB.body).slice(0, 200)}`);
        const [um, uu] = ent.update(idB);
        const upd = await call(ent.router, um, uu, body);
        assert.ok(upd.status === 200, `update returned ${upd.status}: ${JSON.stringify(upd.body).slice(0, 300)}`);

        const a = snapshot(ent.table, idA);
        const b = snapshot(ent.table, idB);

        const disagree = [];
        for (const key of Object.keys(b)) {
            // Only where the UPDATE path actually took the value. A column
            // neither path accepts leaves both at the default and is not this
            // test's business.
            const def = db.prepare(`PRAGMA table_info(${ent.table})`).all().find(c => c.name === key);
            const defaultish = def && def.dflt_value !== null
                ? String(def.dflt_value).replace(/^'|'$/g, '') : null;
            const updateTookIt = String(b[key]) !== String(defaultish) && b[key] !== null;
            if (!updateTookIt) continue;
            if (String(a[key]) !== String(b[key])) {
                disagree.push(`${key}: create stored ${JSON.stringify(a[key])}, update stored ${JSON.stringify(b[key])}`);
            }
        }
        assert.deepStrictEqual(disagree, [],
            `${ent.kind}: fields the update path persists and the create path drops:\n  ` + disagree.join('\n  '));
    });
}

/**
 * The dimensions specifically, because they are the ones that reach a prompt.
 * Kept as a named case beside the property above: the property proves the two
 * paths agree, and this proves the thing they agree ON is actually stored --
 * two create paths that both drop a field agree perfectly.
 */
test('a subject created with its size keeps it, on every kind that has one', async () => {
    const SIZED = [
        { kind: 'character', table: 'film_characters', router: handleCharacters,
          url: pid => `/film/projects/${pid}/characters`, dims: ['height_m'] },
        { kind: 'prop', table: 'film_props', router: handleLocations,
          url: pid => `/film/projects/${pid}/props`, dims: ['height_m', 'width_m', 'length_m'] },
    ];
    const missing = [];
    for (const s of SIZED) {
        const pid = projectWithScene();
        const body = { name: `SIZED ${s.kind}` };
        s.dims.forEach((d, i) => { body[d] = 1.1 + i; });
        const made = await call(s.router, 'POST', s.url(pid), body);
        const row = db.prepare(`SELECT * FROM ${s.table} WHERE id = ?`).get(made.body.id);
        for (const d of s.dims) {
            if (row == null || row[d] === null || row[d] === undefined) {
                missing.push(`${s.kind}_create dropped ${d} — the scale clause cannot be built`);
            }
        }
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});
