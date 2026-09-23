/**
 * Where a stored file actually is, when the profile can move.
 *
 * Every path column in this database held an ABSOLUTE path, so moving the data
 * directory broke all of them at once: 458 rows across six columns pointed at
 * a directory that no longer held anything, and the app came up with five
 * projects whose every plate, frame and clip was missing. Nothing errored —
 * plates reported "unavailable", takes reported "no longer on disk", and the
 * reference gatherer silently returned less than the shot names.
 *
 * TWO HALVES, AND THE SECOND IS WHY THE FIRST IS SAFE.
 *
 *   `toStored`      — write paths RELATIVE to the data directory, so a move
 *                     costs nothing.
 *   `resolveStored` — read them back, tolerating BOTH shapes. Every row
 *                     written before this exists is absolute and must keep
 *                     working; a resolver that only understood the new shape
 *                     would break every project on the day it shipped.
 *
 * And because tolerance means a missed read site fails only on NEW data —
 * later, on fresh work, which is the worst time to find out — `repairPaths`
 * closes the gap from the other end: at boot, a row that does not resolve but
 * whose tail does is corrected. That runs whatever the storage shape is, so a
 * profile move is survivable even where a read site was missed.
 *
 * A path OUTSIDE the data directory is stored absolute and left alone. Media
 * imported by reference, and anything an operator pointed at deliberately, is
 * not ours to relativise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.homedir(), '.gridlight', 'film-engine', 'data');

/**
 * Every column that stores a filesystem path.
 *
 * Derived work depends on this being complete, so the test enumerates the
 * schema and fails on a path-shaped column that is not listed — the same rule
 * the artefact registry follows. A column added later is covered or it fails.
 */
const PATH_COLUMNS = Object.freeze([
    { table: 'film_assets', column: 'file_path', key: 'id' },
    { table: 'render_ledger', column: 'output_path', key: 'id' },
    { table: 'film_mood_board', column: 'image_path', key: 'id' },
    { table: 'film_continuity_refs', column: 'image_path', key: 'id' },
    { table: 'film_voice_profiles', column: 'sample_path', key: 'id' },
    { table: 'film_color_presets', column: 'lut_path', key: 'id' },

    // Every job table that records where it wrote its output. These were all
    // EMPTY on the install this was written against, which is exactly why the
    // first pass missed them: a scan for rows carrying a stale path can only
    // see columns that already hold data, so a feature not yet used looks like
    // a column that does not exist. They break the first time somebody uses
    // the feature and then moves the profile.
    { table: 'film_voice_jobs', column: 'output_path', key: 'id' },
    { table: 'film_music_jobs', column: 'output_path', key: 'id' },
    { table: 'film_video_jobs', column: 'output_path', key: 'id' },
    { table: 'film_lipsync_jobs', column: 'output_path', key: 'id' },
    { table: 'film_post_jobs', column: 'output_path', key: 'id' },

    // A captured patch: written under our own root, so it moves with the
    // profile exactly as an asset does.
    { table: 'film_instruments', column: 'state_path', key: 'id' },
    { table: 'film_stitch_jobs', column: 'output_path', key: 'id' },
    { table: 'film_audio_mix_jobs', column: 'output_path', key: 'id' },
    { table: 'film_export_packages', column: 'output_path', key: 'id' },
    { table: 'film_3d_jobs', column: 'output_path', key: 'id' },
    { table: 'film_location_image_jobs', column: 'output_path', key: 'id' },
    { table: 'film_prop_image_jobs', column: 'output_path', key: 'id' },

    // Per-version media on a shot. Caller-supplied, so often arbitrary — the
    // repair is still safe for them, because it only acts on a path that has
    // stopped resolving AND whose tail resolves under the data directory.
    { table: 'film_shot_versions', column: 'video_path', key: 'id' },
    { table: 'film_shot_versions', column: 'audio_path', key: 'id' },
    { table: 'film_shot_versions', column: 'thumbnail_path', key: 'id' },
]);

/** Columns that look like paths and deliberately are not, with the reason. */
const NOT_PATHS = Object.freeze({
    'film_characters.voice_profile_id': 'an id, not a path',
    'film_voice_jobs.voice_profile_id': 'an id, not a path',
    'film_consistency_profiles.profile_type': 'a vocabulary value',
    'film_deliverables.profile_id': 'an id',
    'film_assets.file_name': 'a bare filename, resolved against its subdir',
    'film_world_assets.remote_url': 'a provider URL — bytes this engine deliberately does not hold',
    'film_previs_blocking.path_json': 'a sampled camera path, not a filesystem path',
    'film_refsheet_jobs.output_paths': 'a JSON array of filenames',
    // MISCLASSIFIED AT FIRST, and the boot repair reported it: both writers
    // store `imported.file_name` / `fileName`, so this is a filename resolved
    // against the marketing subdir — not a path. Listing it as one made the
    // repair report a healthy row as unresolvable.
    'film_marketing_assets.image_path': 'a bare filename, resolved against the marketing subdir',

    // URLs, not filesystem paths. Nothing here ever opens them.
    'film_budget_line_items.source_url': 'a URL — where a cost figure came from',
    'film_rights.license_url': 'a URL — the licence a piece of music is held under',
    'film_brands.cta_url': 'a URL — where a call to action points',
    'film_style_book_media.source_url': 'a URL — a reference left where it lives',

    // OUTSIDE this engine's data, deliberately. A plugin lives where macOS
    // installs plugins and a preset where Native Access put it; Film Engine
    // points at both and owns neither, so moving the data directory must not
    // rewrite them to somewhere the library is not.
    'film_instruments.plugin_path': 'where macOS installed the plugin \u2014 not ours to move',
    'film_instruments.preset_path': 'where the library installed the preset \u2014 read in place, never copied',

    // These own their own resolution, and rewriting them would fight it.
    'film_backups.file_path': 'resolved by resolveBackupPath in routes/backups.js',
    'film_style_book_media.file_path': 'resolved and contained by stylebookPath in routes/style-book.js',
    'film_provenance_manifests.sidecar_path': 'relative to the data folder in the old layout, whole in a project folder (toStored); a project move rewrites it with every other stored path',
});

/** Turn an absolute path into what should be stored. */
function toStored(absolute) {
    const p = String(absolute || '');
    if (!p) return p;
    const rel = path.relative(DATA_DIR, p);
    // Outside the data directory — `..` or an absolute result — is stored as
    // it is. Relativising it would invent a path that means something else.
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
    return rel;
}

/** Turn a stored value into an absolute path. Tolerates both shapes. */
function resolveStored(stored) {
    const p = String(stored || '');
    if (!p) return p;
    return path.isAbsolute(p) ? p : path.join(DATA_DIR, p);
}

/** Does the file a row names exist, whichever shape it is stored in? */
function storedExists(stored) {
    if (!stored) return false;
    try { return fs.existsSync(resolveStored(stored)); } catch (_) { return false; }
}

/**
 * Correct rows whose file moved with the profile.
 *
 * ONLY where the stored path does NOT resolve and a reconstruction from the
 * current data directory DOES. That rule is what makes this safe to run on
 * every boot: it can never touch a working path, and it can never invent one —
 * a row that resolves nowhere is left exactly as it was, because rewriting it
 * would trade a wrong pointer for a different wrong pointer.
 *
 * The tail is found by locating the data-directory-shaped segment of the old
 * path: everything from a known subdir onwards. A path with no recognisable
 * tail is not guessed at.
 */
const SUBDIRS = Object.freeze(['storyboards', 'refsheets', 'audio', 'video', 'music',
                               '3d', 'exports', 'backups', 'bundles', 'moodboard',
                               'marketing', 'continuity', 'stylebook', 'worlds', 'previs']);

function tailOf(stored) {
    const p = String(stored || '').replace(/\\/g, '/');
    const parts = p.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        if (SUBDIRS.includes(parts[i])) return parts.slice(i).join(path.sep);
    }
    return null;
}

function repairPaths(db, opts) {
    const o = opts || {};
    const report = { checked: 0, repaired: 0, unresolvable: 0, byColumn: {} };

    for (const spec of PATH_COLUMNS) {
        let rows = [];
        try {
            rows = db.prepare(
                `SELECT ${spec.key} AS k, ${spec.column} AS p FROM ${spec.table}
                  WHERE ${spec.column} IS NOT NULL AND ${spec.column} <> ''`).all();
        } catch (_) { continue; }          // table absent in an older schema

        let repaired = 0, bad = 0;
        const upd = db.prepare(`UPDATE ${spec.table} SET ${spec.column} = ? WHERE ${spec.key} = ?`);
        for (const r of rows) {
            report.checked++;
            if (storedExists(r.p)) continue;             // resolves: never touched
            const tail = tailOf(r.p);
            if (!tail) { bad++; continue; }
            const candidate = path.join(DATA_DIR, tail);
            if (!fs.existsSync(candidate)) { bad++; continue; }
            /*
             * REPAIRED TO AN ABSOLUTE PATH, DELIBERATELY.
             *
             * Relative storage is the more principled form and it is NOT what
             * ships here, because it only works if every read resolves it —
             * and 49 sites read these columns, 24 of them handing the value
             * straight to `fs`. Measured: rewriting to relative repaired all
             * 458 rows and then reported every plate as unavailable, because a
             * relative path checked with `existsSync` resolves against the
             * process's working directory. A half-done migration is worse than
             * no migration.
             *
             * Absolute plus this repair delivers the same guarantee — a moved
             * profile fixes itself at boot — with no read site to miss. Going
             * relative is a separate, larger change: route every read through
             * `resolveStored` first, prove it with a detector, then flip this.
             */
            if (!o.dryRun) upd.run(o.relative === true ? tail : candidate, r.k);
            repaired++;
        }
        if (repaired || bad) report.byColumn[`${spec.table}.${spec.column}`] = { repaired, unresolvable: bad };
        report.repaired += repaired;
        report.unresolvable += bad;
    }
    return report;
}

module.exports = {
    DATA_DIR, PATH_COLUMNS, NOT_PATHS, SUBDIRS,
    toStored, resolveStored, storedExists, repairPaths, tailOf,
};
