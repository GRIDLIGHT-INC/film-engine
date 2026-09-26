/**
 * THE DIRECTOR'S INSTRUMENTS: a plugin, and the state that recalls a patch.
 *
 * "I have 248 libraries that I paid for over the years." An instrument here is
 * not a sample library — it is one SOUND out of one: a plugin path plus the
 * state blob that loads that patch. A plugin exposes its state and not its
 * browser, so this is the only thing that can recall a sound without somebody
 * clicking through Kontakt.
 *
 * Two ways one arrives, and the registry records which:
 *   captured — a person opened the plugin's editor, loaded the patch, closed it
 *   nks      — an NKS preset was read, whose PCHK chunk IS that state
 *
 * NOT project-scoped, on the style-book precedent: a library outlives a film,
 * and re-capturing a patch per project is the time this exists to save.
 */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const { DATA_DIR } = require('./file-storage');

const FORMATS = Object.freeze(['vst3', 'au', 'vst']);
const SOURCES = Object.freeze(['captured', 'nks']);
const MAX_STATE_BYTES = 64 * 1024 * 1024;

const root = () => path.join(DATA_DIR, 'instruments');

/** A state file is ours, written under our own root, and never read from outside it. */
function statePath(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error('an instrument needs an id');
    return path.join(root(), `${safe}.state`);
}

function contained(file) {
    const real = path.resolve(file);
    const base = path.resolve(root());
    return real === base || real.startsWith(base + path.sep);
}

function formatOf(pluginPath) {
    const lower = String(pluginPath || '').toLowerCase();
    if (lower.endsWith('.vst3')) return 'vst3';
    if (lower.endsWith('.component')) return 'au';
    if (lower.endsWith('.vst')) return 'vst';
    return null;
}

function rowToInstrument(row) {
    if (!row) return null;
    let tags = [];
    try { tags = JSON.parse(row.tags_json || '[]') || []; } catch (_) { tags = []; }
    return {
        id: row.id, name: row.name, plugin: row.plugin_path, format: row.plugin_format,
        source: row.source, library: row.library, vendor: row.vendor, tags, notes: row.notes,
        state_bytes: row.state_bytes, preset_path: row.preset_path || null,
        // Where the sound came from, so it is recognisable in six months:
        // the catalogue row NI has for it, and the file it lives in.
        source_ref: row.source_ref || null, source_file: row.source_file || null,
        // The plugin has to still be installed for this to play anything.
        available: fs.existsSync(row.plugin_path)
            && (row.source === 'nks' ? !!row.preset_path && fs.existsSync(row.preset_path) : !!row.state_path && fs.existsSync(row.state_path)),
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

function listInstruments({ q, library, limit = 200 } = {}) {
    const where = [], args = [];
    if (q) { where.push('(name LIKE ? OR library LIKE ? OR vendor LIKE ? OR tags_json LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
    if (library) { where.push('library = ?'); args.push(library); }
    const rows = db.prepare(`SELECT * FROM film_instruments
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY library, name LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 1000));
    return rows.map(rowToInstrument);
}

const getInstrument = id => rowToInstrument(db.prepare('SELECT * FROM film_instruments WHERE id = ?').get(id));

/** The bytes that recall the sound, whichever way this instrument arrived. */
function stateOf(id) {
    const row = db.prepare('SELECT * FROM film_instruments WHERE id = ?').get(id);
    if (!row) return { ok: false, reason: 'no such instrument' };
    if (row.source === 'nks') {
        if (!row.preset_path || !fs.existsSync(row.preset_path)) {
            return { ok: false, reason: `the preset this instrument was read from is gone: ${row.preset_path}` };
        }
        const { presetState } = require('./instrument-presets');
        return presetState(row.preset_path);
    }
    if (!row.state_path || !contained(row.state_path) || !fs.existsSync(row.state_path)) {
        return { ok: false, reason: 'the patch this instrument was captured into is missing' };
    }
    return { ok: true, state: fs.readFileSync(row.state_path) };
}

/**
 * Keep a captured patch. The state is written to our own root — never a path a
 * caller chose, because a caller-supplied path is how a write escapes.
 */
function createCaptured({ name, plugin, state, library, vendor, tags, notes, source_ref, source_file }) {
    const format = formatOf(plugin);
    if (!format) throw Object.assign(new Error(`${plugin} is not a plugin this engine can play (${FORMATS.join(', ')})`), { status: 400 });
    if (!fs.existsSync(plugin)) throw Object.assign(new Error(`there is no plugin at ${plugin}`), { status: 400 });
    const blob = Buffer.isBuffer(state) ? state : Buffer.from(String(state || ''), 'base64');
    if (!blob.length) throw Object.assign(new Error('a captured instrument needs the state that recalls it'), { status: 400 });
    if (blob.length > MAX_STATE_BYTES) throw Object.assign(new Error(`that state is ${blob.length} bytes; the ceiling is ${MAX_STATE_BYTES}`), { status: 413 });
    const clean = String(name || '').trim();
    if (!clean) throw Object.assign(new Error('an instrument needs a name you will recognise later'), { status: 400 });

    const id = generateId();
    fs.mkdirSync(root(), { recursive: true });
    const file = statePath(id);
    fs.writeFileSync(file, blob);
    db.prepare(`INSERT INTO film_instruments
        (id, name, plugin_path, plugin_format, source, state_path, state_bytes, library, vendor, tags_json, notes, source_ref, source_file)
        VALUES (?, ?, ?, ?, 'captured', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, clean.slice(0, 200), plugin, format, file, blob.length,
            String(library || '').slice(0, 120), String(vendor || '').slice(0, 120),
            JSON.stringify(Array.isArray(tags) ? tags.map(t => String(t).slice(0, 40)).slice(0, 20) : []),
            String(notes || '').slice(0, 2000),
            source_ref ? String(source_ref).slice(0, 120) : null,
            source_file ? String(source_file).slice(0, 500) : null);
    return getInstrument(id);
}

/** Rename, re-tag, re-file. Merged, never replaced: a name change must not clear the tags. */
function updateInstrument(id, body) {
    const row = db.prepare('SELECT * FROM film_instruments WHERE id = ?').get(id);
    if (!row) return null;
    const sets = [], args = [];
    const put = (col, value) => { sets.push(`${col} = ?`); args.push(value); };
    if (body.name != null) {
        const clean = String(body.name).trim();
        if (!clean) throw Object.assign(new Error('an instrument needs a name'), { status: 400 });
        put('name', clean.slice(0, 200));
    }
    if (body.library != null) put('library', String(body.library).slice(0, 120));
    if (body.vendor != null) put('vendor', String(body.vendor).slice(0, 120));
    if (body.notes != null) put('notes', String(body.notes).slice(0, 2000));
    if (body.tags != null) {
        if (!Array.isArray(body.tags)) throw Object.assign(new Error('tags is a list of words'), { status: 400 });
        put('tags_json', JSON.stringify(body.tags.map(t => String(t).slice(0, 40)).slice(0, 20)));
    }
    if (!sets.length) return getInstrument(id);
    db.prepare(`UPDATE film_instruments SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...args, id);
    return getInstrument(id);
}

/**
 * Forget an instrument. Its captured state goes with it — it is ours and
 * nothing else can read it — but a preset file belongs to the library it came
 * from and is left exactly where Native Access put it.
 */
function deleteInstrument(id) {
    const row = db.prepare('SELECT * FROM film_instruments WHERE id = ?').get(id);
    if (!row) return null;
    if (row.source === 'captured' && row.state_path && contained(row.state_path)) {
        try { fs.unlinkSync(row.state_path); } catch (_) { /* already gone is the state we wanted */ }
    }
    db.prepare('DELETE FROM film_instruments WHERE id = ?').run(id);
    return {
        deleted: id, name: row.name,
        kept: row.source === 'nks' ? row.preset_path : null,
        note: 'Tracks that played this instrument keep their arrangement and their takes; they simply have no instrument now.',
    };
}

/**
 * The instrument for an NKS preset, created on FIRST USE.
 *
 * "Are you sure you want to index all sounds into our DB? We'll have hundreds of
 * thousands of entries." Right: a library is browsed live, and Film Engine's own
 * library holds what has actually been played. So a preset becomes a row here
 * the moment somebody renders with it, and never because it exists on a disk.
 */
function instrumentForPreset({ preset_path, plugin, name, library, vendor, tags }) {
    const file = path.resolve(String(preset_path || ''));
    // Only an NKS preset: a path taken as given would read any file the
    // server can reach, for a caller on any origin.
    if (path.extname(file).toLowerCase() !== '.nksf') {
        throw Object.assign(new Error('preset_path must be an .nksf preset'), { status: 400 });
    }
    const existing = db.prepare('SELECT * FROM film_instruments WHERE preset_path = ?').get(file);
    if (existing) return rowToInstrument(existing);
    if (!fs.existsSync(file)) throw Object.assign(new Error(`there is no preset at ${file}`), { status: 400 });
    const read = require('./instrument-presets').readPreset(file);
    const format = formatOf(plugin);
    if (!format) throw Object.assign(new Error(`${plugin} is not a plugin this engine can play`), { status: 400 });
    const id = generateId();
    db.prepare(`INSERT INTO film_instruments
        (id, name, plugin_path, plugin_format, source, preset_path, state_bytes, library, vendor, tags_json, notes, source_file)
        VALUES (?, ?, ?, ?, 'nks', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, String(name || read.name).slice(0, 200), plugin, format, file, read.state_bytes,
            String(library || read.library || '').slice(0, 120), String(vendor || read.vendor || '').slice(0, 120),
            JSON.stringify(tags && tags.length ? tags : (read.tags || [])), String(read.comment || '').slice(0, 2000), file);
    return getInstrument(id);
}

module.exports = {    FORMATS, SOURCES, instrumentForPreset,
    listInstruments, getInstrument, stateOf, createCaptured, updateInstrument, deleteInstrument,
    formatOf, statePath, root,};
