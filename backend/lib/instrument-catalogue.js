/**
 * THE DIRECTOR'S OWN SOUNDS, BY NAME — read out of Kontakt's catalogue.
 *
 * "You should dynamically have the library name and the patch name when we load
 * it into Film Engine so I know the source of the file in the future."
 *
 * A captured patch is compressed binary: the name is not in it, the plugin's
 * 4145 parameters do not carry it, Kontakt writes no log of what it loaded, and
 * access times are stamped by NI's own scan rather than by loading. Every route
 * to "detect what you just picked" is a guess.
 *
 * Kontakt itself has the answer. `komplete.db3` indexes every sound it can play
 * — 844 on this machine — with its name, the product it came from, its bank,
 * what kind of sound it is, and the file it lives in. So an instrument is
 * created FROM that row: the name and the library are facts NI recorded, not
 * something typed or inferred.
 *
 * Read-only, always. This is another application's database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Where Kontakt keeps its index. Newest first: a machine may have several. */
const DEFAULT_PATHS = [
    'Kontakt 8', 'Kontakt 7', 'Kontakt',
].map(v => path.join(os.homedir(), 'Library', 'Application Support', 'Native Instruments', v, 'komplete.db3'));

function cataloguePath() {
    const declared = String(process.env.KONTAKT_DB || '').trim();
    if (declared) return declared;
    return DEFAULT_PATHS.find(p => fs.existsSync(p)) || DEFAULT_PATHS[0];
}

/** Opened read-only, and never held: Kontakt owns this file. */
function open() {
    const file = cataloguePath();
    if (!fs.existsSync(file)) {
        const err = new Error(`no Kontakt catalogue at ${file}. Install Kontakt, or set KONTAKT_DB to its komplete.db3.`);
        err.status = 503;
        throw err;
    }
    const Database = require('better-sqlite3');
    return new Database(file, { readonly: true, fileMustExist: true });
}

/** Is there a catalogue, and how much is in it? Never throws. */
function availability() {
    const file = cataloguePath();
    if (!fs.existsSync(file)) {
        return { available: false, path: file, sounds: 0,
            reason: 'Kontakt keeps this index; install Kontakt (or set KONTAKT_DB) and it appears' };
    }
    try {
        const db = open();
        try {
            const sounds = db.prepare('SELECT COUNT(*) AS n FROM k_sound_info').get().n;
            const products = db.prepare(`SELECT product AS name, COUNT(*) AS sounds FROM v_sound_info
                                          WHERE product IS NOT NULL AND product <> ''
                                          GROUP BY product ORDER BY sounds DESC`).all();
            return { available: true, path: file, sounds, products };
        } finally { db.close(); }
    } catch (err) {
        return { available: false, path: file, sounds: 0, reason: `the catalogue could not be read: ${err.message}` };
    }
}

const clean = v => (v == null ? '' : String(v));

function rowToSound(r) {
    const tags = [...new Set(`${clean(r.type)},${clean(r.character)}`.split(',').map(s => s.trim()).filter(Boolean))];
    return {
        id: `kontakt:${r.id}`,
        name: clean(r.name),
        library: clean(r.product) || clean(r.brand),
        bank: clean(r.bank),
        vendor: clean(r.vendor) || clean(r.author) || clean(r.brand),
        tags,
        kind: clean(r.file_ext),
        file: clean(r.file_name),
        // A sound whose file is gone is listed and marked, never silently offered:
        // a library can be uninstalled while its index stays behind.
        available: !!clean(r.file_name) && fs.existsSync(clean(r.file_name)),
        comment: clean(r.comment).slice(0, 300),
    };
}

const SELECT = `SELECT v.id, v.name, v.product, v.brand, v.bank, v.type, v.character, v.author,
                       v.comment, v.file_ext, s.file_name, s.vendor
                  FROM v_sound_info v JOIN k_sound_info s ON s.id = v.id`;

/** Search the director's sounds. `q` matches the name, the library or a tag. */
function searchSounds({ q, library, kind, limit = 100 } = {}) {
    const db = open();
    try {
        const where = [], args = [];
        if (q) {
            where.push('(v.name LIKE ? OR v.product LIKE ? OR v.bank LIKE ? OR v.type LIKE ? OR v.character LIKE ?)');
            args.push(...Array(5).fill(`%${q}%`));
        }
        if (library) { where.push('v.product = ?'); args.push(library); }
        if (kind) { where.push('v.file_ext = ?'); args.push(kind); }
        const rows = db.prepare(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                 ORDER BY v.product, v.name LIMIT ?`)
            .all(...args, Math.min(Number(limit) || 100, 1000));
        return rows.map(rowToSound);
    } finally { db.close(); }
}

/** One sound, by the id this module hands out (`kontakt:<n>`). */
function soundById(id) {
    const n = Number(String(id || '').replace(/^kontakt:/, ''));
    if (!Number.isInteger(n)) return null;
    const db = open();
    try {
        const row = db.prepare(`${SELECT} WHERE v.id = ?`).get(n);
        return row ? rowToSound(row) : null;
    } finally { db.close(); }
}

/**
 * Which catalogued sound a file is, for a path the plugin was seen holding open.
 * Exact match only — a guess about what somebody loaded is worse than no answer.
 */
function soundByFile(file) {
    const full = String(file || '');
    if (!full) return null;
    const db = open();
    try {
        const row = db.prepare(`${SELECT} WHERE s.file_name = ?`).get(full);
        return row ? rowToSound(row) : null;
    } finally { db.close(); }
}

module.exports = { cataloguePath, availability, searchSounds, soundById, soundByFile };
