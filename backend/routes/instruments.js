/**
 * The instrument library: the director's own plugins and patches.
 *
 *   GET    /film/instruments                 what is in the library
 *   POST   /film/instruments                 keep a patch (a captured state, or an NKS preset)
 *   GET    /film/instruments/host            is the plugin sidecar there, and what does it hold (free)
 *   GET    /film/instruments/plugins         the plugins installed on this machine (free)
 *   POST   /film/instruments/capture         open a plugin's editor, keep what was loaded (supervised)
 *   POST   /film/instruments/scan            index NKS presets from installed libraries
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
    if (!body.name) return json(res, 400, { error: 'name the sound you are about to capture, so you can find it later' });

    const got = await host.capture({ plugin: body.plugin, state: body.state, supervised: true });
    if (!got.ok) {
        return json(res, got.stage === 'config' || got.stage === 'unreachable' ? 503 : 502, {
            error: got.reason, stage: got.stage, fix: got.fix,
            guide: 'docs/instrument-sidecar.md',
        });
    }
    try {
        const kept = instruments.createCaptured({
            name: body.name, plugin: body.plugin, state: got.state_b64,
            library: body.library, vendor: body.vendor, tags: body.tags, notes: body.notes,
        });
        return json(res, 201, {
            instrument: kept,
            note: 'Captured. Assign it to a part and render — the patch comes back exactly as you left it.',
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
            const file = path.resolve(String(body.preset_path));
            if (!fs.existsSync(file)) return json(res, 400, { error: `there is no preset at ${file}` });
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
 * Index the NKS presets the installed libraries ship. Free, local, and additive:
 * a preset already in the library is left alone rather than duplicated.
 */
function scan(req, res) {
    const body = req.body || {};
    const roots = Array.isArray(body.roots) && body.roots.length
        ? body.roots.map(r => path.resolve(String(r)))
        : PRESET_ROOTS.filter(r => r && fs.existsSync(r));
    if (!roots.length) {
        return json(res, 200, {
            added: 0, found: 0, roots: [], searched: PRESET_ROOTS,
            note: 'No Native Instruments content folders exist on this machine yet. Install a library, then scan again.',
        });
    }
    const plugin = body.plugin || '/Library/Audio/Plug-Ins/VST3/Kontakt 8.vst3';
    const format = instruments.formatOf(plugin);
    if (!format) return json(res, 400, { error: `${plugin} is not a plugin this engine can play` });

    const known = new Set(db.prepare("SELECT preset_path FROM film_instruments WHERE source = 'nks'").all().map(r => r.preset_path));
    const files = roots.flatMap(r => presets.findPresets(r, { limit: Number(body.limit) || 5000 }));
    const unreadable = [];
    let added = 0;
    const insert = db.prepare(`INSERT INTO film_instruments
        (id, name, plugin_path, plugin_format, source, preset_path, state_bytes, library, vendor, tags_json, notes)
        VALUES (?, ?, ?, ?, 'nks', ?, ?, ?, ?, ?, ?)`);
    const write = db.transaction(rows => {
        for (const r of rows) {
            insert.run(generateId(), r.name.slice(0, 200), plugin, format, r.file, r.state_bytes,
                String(r.library || '').slice(0, 120), String(r.vendor || '').slice(0, 120),
                JSON.stringify(r.tags || []), String(r.comment || '').slice(0, 2000));
        }
    });
    const rows = [];
    for (const file of files) {
        if (known.has(file)) continue;
        try { rows.push(presets.readPreset(file)); } catch (err) { unreadable.push({ file: path.basename(file), reason: err.message }); }
    }
    if (rows.length) { write(rows); added = rows.length; }

    return json(res, 200, {
        added, found: files.length, already_known: files.length - rows.length - unreadable.length,
        unreadable: unreadable.slice(0, 20), unreadable_count: unreadable.length,
        roots, plugin, spends: 'nothing',
        note: added
            ? 'Indexed. These are read where Native Access installed them; nothing was copied.'
            : 'No new presets. A library that is not NKS-ready ships no .nksf — capture those patches from the plugin instead.',
    });
}

module.exports = { handleInstruments, PRESET_ROOTS };
