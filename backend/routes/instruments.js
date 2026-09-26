/**
 * The instrument library: the director's own plugins and patches.
 *
 *   GET    /film/instruments                 what is in the library
 *   POST   /film/instruments                 keep a patch (a captured state, or an NKS preset)
 *   GET    /film/instruments/host            is the plugin sidecar there, and what does it hold (free)
 *   GET    /film/instruments/plugins         the plugins installed on this machine (free)
 *   POST   /film/instruments/capture         open a plugin's editor, keep what was loaded (supervised)
 *   GET    /film/instruments/catalogue       the director's own sounds, read live from Kontakt (free, stores nothing)
 *   POST   /film/instruments/scan            what NKS presets are on this machine (free, stores nothing)
 *   GET    /film/instruments/:id             one instrument
 *   PUT    /film/instruments/:id             rename, re-tag, re-file
 *   DELETE /film/instruments/:id             forget it (a preset file is the library's, and is left alone)
 *
 * Not project-scoped: a library outlives a film.
 */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const instruments = require('../lib/instruments');
const presets = require('../lib/instrument-presets');
const host = require('../lib/instrument-host');
const catalogue = require('../lib/instrument-catalogue');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Native Instruments puts library content on macOS. */
const PRESET_ROOTS = [
    '/Users/Shared/NI Resources/presets',
    '/Library/Application Support/Native Instruments',
    path.join(process.env.HOME || '', 'Documents', 'Native Instruments'),
    path.join(process.env.HOME || '', 'Library', 'Application Support', 'Native Instruments'),
];

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function handleInstruments(req, res, parts, query) {
    const tail = parts[2];

    if (!tail) {
        if (req.method === 'GET') {
            const list = instruments.listInstruments({ q: query && query.q, library: query && query.library });
            return json(res, 200, {
                instruments: list,
                unavailable: list.filter(i => !i.available).length,
                note: list.length ? undefined
                    : 'Nothing yet. Capture a patch from a plugin you own, or scan your NKS presets.',
            });
        }
        if (req.method === 'POST') return keepPreset(req, res);
    }

    if (tail === 'host' && req.method === 'GET') {
        return json(res, 200, await host.availability());
    }

    if (tail === 'plugins' && req.method === 'GET') {
        const found = await host.instruments();
        if (!found.ok) return json(res, found.stage === 'config' ? 503 : 502, found);
        return json(res, 200, { plugins: found.instruments, folders: found.folders, spends: 'nothing' });
    }

    if (tail === 'catalogue' && req.method === 'GET') {
        /*
         * THE DIRECTOR'S OWN SOUNDS, READ LIVE FROM KONTAKT.
         *
         * "Are you sure you want to index all sounds into our DB? We'll have
         * hundreds of thousands of entries." No: this reads Kontakt's own
         * index every time and stores NOTHING. Film Engine's library holds the
         * sounds that have been used, one row each.
         */
        const state = catalogue.availability();
        if (!state.available) return json(res, 503, { error: state.reason, path: state.path, sounds: 0 });
        try {
            const sounds = catalogue.searchSounds({
                q: query && query.q, library: query && query.library,
                kind: query && query.kind, limit: query && query.limit,
            });
            return json(res, 200, {
                sounds, total_indexed_by_kontakt: state.sounds, libraries: state.products,
                stored_here: 0, spends: 'nothing',
                note: 'Read live from Kontakt; nothing is copied. A sound becomes an instrument here when you capture or play it.',
            });
        } catch (err) { return json(res, err.status || 500, { error: err.message }); }
    }

    if (tail === 'capture' && req.method === 'POST') return capture(req, res);
    if (tail === 'scan' && req.method === 'POST') return scan(req, res);

    if (tail && UUID_RE.test(tail)) {
        if (req.method === 'GET') {
            const one = instruments.getInstrument(tail);
            return one ? json(res, 200, one) : json(res, 404, { error: 'no such instrument' });
        }
        if (req.method === 'PUT') {
            try {
                const updated = instruments.updateInstrument(tail, req.body || {});
                return updated ? json(res, 200, updated) : json(res, 404, { error: 'no such instrument' });
            } catch (err) { return json(res, err.status || 400, { error: err.message }); }
        }
        if (req.method === 'DELETE') {
            const gone = instruments.deleteInstrument(tail);
            return gone ? json(res, 200, gone) : json(res, 404, { error: 'no such instrument' });
        }
    }

    return json(res, 404, { error: 'Not found' });
}

/**
 * Open the plugin's own editor so a person loads the patch, and keep what they
 * left there. Blocking by nature — there is a window in front of somebody.
 */
async function capture(req, res) {
    const body = req.body || {};
    if (!body.plugin) return json(res, 400, { error: 'name the plugin to open, from /film/instruments/plugins' });

    /*
     * WHERE THE NAME COMES FROM.
     *
     * A captured patch is compressed binary: it carries no name, the plugin's
     * parameters do not either, and Kontakt logs nothing about what it loaded.
     * So the sound is NAMED BY THE CATALOGUE — say which sound you are about to
     * load and the library, vendor, tags and source file come from NI's own
     * index rather than from typing.
     */
    let sound = null;
    if (body.sound_id) {
        try { sound = catalogue.soundById(body.sound_id); } catch (err) { return json(res, err.status || 503, { error: err.message }); }
        if (!sound) return json(res, 404, { error: `no sound ${body.sound_id} in the catalogue`, find: 'GET /film/instruments/catalogue?q=' });
    }
    if (!body.name && !sound) {
        return json(res, 400, {
            error: 'say which sound this is: pass sound_id from the catalogue, or a name',
            find: 'GET /film/instruments/catalogue?q=cello',
        });
    }

    const got = await host.capture({ plugin: body.plugin, state: body.state, supervised: true });
    if (!got.ok) {
        return json(res, got.stage === 'config' || got.stage === 'unreachable' ? 503 : 502, {
            error: got.reason, stage: got.stage, fix: got.fix,
            guide: 'docs/instrument-sidecar.md',
        });
    }
    try {
        const kept = instruments.createCaptured({
            name: body.name || (sound && sound.name), plugin: body.plugin, state: got.state_b64,
            library: body.library || (sound && sound.library), vendor: body.vendor || (sound && sound.vendor),
            tags: body.tags || (sound && sound.tags), notes: body.notes || (sound && sound.comment),
            source_ref: sound && sound.id, source_file: sound && sound.file,
        });
        return json(res, 201, {
            instrument: kept, sound: sound || null, recovered: got.recovered || undefined,
            note: sound
                ? `Captured as ${sound.name} (${sound.library}). The source is recorded, so you will know what this is later.`
                : 'Captured. Pass sound_id next time and the name, library and source come from Kontakt\u2019s own catalogue.',
        });
    } catch (err) {
        return json(res, err.status || 400, { error: err.message });
    }
}

/** Keep a patch that is already in hand: an NKS preset file, or a state blob. */
function keepPreset(req, res) {
    const body = req.body || {};
    try {
        if (body.preset_path) {
            // Only an NKS preset inside a Native Instruments folder. This API
            // answers any origin with no login, so a path taken as given let a
            // caller learn whether any file on the Mac exists and read it; the
            // refusal is the same whether or not the file is there.
            const refuse = () => json(res, 400, {
                error: 'preset_path must be an .nksf preset inside a Native Instruments folder',
                searched: PRESET_ROOTS,
            });
            const asked = path.resolve(String(body.preset_path));
            if (path.extname(asked).toLowerCase() !== '.nksf') return refuse();
            let file;
            try { file = fs.realpathSync(asked); } catch (_) { return refuse(); }
            const inside = PRESET_ROOTS.filter(Boolean).some(r => {
                let root; try { root = fs.realpathSync(r); } catch (_) { return false; }
                return file.startsWith(root + path.sep);
            });
            if (!inside) return refuse();
            const read = presets.readPreset(file);
            if (!body.plugin) return json(res, 400, { error: 'name the plugin that plays this preset' });
            const format = instruments.formatOf(body.plugin);
            if (!format) return json(res, 400, { error: `${body.plugin} is not a plugin this engine can play` });
            const id = generateId();
            db.prepare(`INSERT INTO film_instruments
                (id, name, plugin_path, plugin_format, source, preset_path, state_bytes, library, vendor, tags_json, notes)
                VALUES (?, ?, ?, ?, 'nks', ?, ?, ?, ?, ?, ?)`)
                .run(id, String(body.name || read.name).slice(0, 200), body.plugin, format, file, read.state_bytes,
                    String(body.library || read.library || '').slice(0, 120),
                    String(body.vendor || read.vendor || '').slice(0, 120),
                    JSON.stringify(read.tags || []), String(body.notes || read.comment || '').slice(0, 2000));
            return json(res, 201, { instrument: instruments.getInstrument(id) });
        }
        if (body.state_b64) {
            const kept = instruments.createCaptured({
                name: body.name, plugin: body.plugin, state: body.state_b64,
                library: body.library, vendor: body.vendor, tags: body.tags, notes: body.notes,
            });
            return json(res, 201, { instrument: kept });
        }
        return json(res, 400, { error: 'send a preset_path (an .nksf) or a state_b64 captured from a plugin' });
    } catch (err) {
        return json(res, err.status || 400, { error: err.message });
    }
}

/**
 * What NKS presets are on this machine. FREE, local, and it stores NOTHING.
 *
 * "Maybe we add the patch when we use it in the index." Exactly: a library of
 * hundreds of thousands of presets is browsed, not copied. A preset becomes a
 * row in Film Engine's own library the first time something plays it.
 */
function scan(req, res) {
    const body = req.body || {};
    const roots = Array.isArray(body.roots) && body.roots.length
        ? body.roots.map(r => path.resolve(String(r)))
        : PRESET_ROOTS.filter(r => r && fs.existsSync(r));
    if (!roots.length) {
        return json(res, 200, {
            found: 0, presets: [], roots: [], searched: PRESET_ROOTS, stored_here: 0,
            note: 'No Native Instruments preset folders exist on this machine. Kontakt libraries usually ship '
                + '.nki instruments and snapshots instead — browse those with /film/instruments/catalogue.',
        });
    }

    const files = roots.flatMap(r => presets.findPresets(r, { limit: Number(body.limit) || 5000 }));
    const known = new Set(db.prepare("SELECT preset_path FROM film_instruments WHERE source = 'nks'").all().map(r => r.preset_path));
    const found = [], unreadable = [];
    for (const file of files) {
        try {
            const read = presets.readPreset(file);
            found.push({
                name: read.name, library: read.library, vendor: read.vendor, tags: read.tags,
                preset_path: file, state_bytes: read.state_bytes, in_library: known.has(file),
            });
        } catch (err) {
            unreadable.push({ file: path.basename(file), reason: err.message });
        }
    }
    return json(res, 200, {
        found: found.length, presets: found.slice(0, Number(body.limit) || 500),
        unreadable: unreadable.slice(0, 20), unreadable_count: unreadable.length,
        roots, stored_here: found.filter(f => f.in_library).length, spends: 'nothing',
        note: 'Nothing was stored. Play a part with preset_path and that preset joins your instruments then, '
            + 'so the library holds what you have used rather than everything you own.',
    });
}

module.exports = { handleInstruments, PRESET_ROOTS };
