/**
 * WHERE A PROJECT'S FILES LIVE, AND WHAT THE FOLDER LOOKS LIKE.
 *
 * Every file this engine made was stored kind-first:
 * `data/<kind>/<project id>/…`. So one film's frames, plates, clips and score
 * were spread across fifteen folders, each named by a UUID, inside a hidden
 * directory. Finding "the clip for 2B" meant knowing the kind, then finding the
 * UUID. That is storage laid out for the code, not for the person making the
 * film.
 *
 * A project now has ONE folder, chosen when the project is made, and changeable
 * later. Inside it the kinds are laid out in the order the film is made, with
 * names a person reads:
 *
 *   The Glass Harbour/
 *     01 References/Plates/          character, location and prop plates
 *     02 Storyboard/                 frames, with versions/ beside them
 *     03 Previs/Stages/ …            blocking stills, worlds, 3D models
 *     04 Video/Clips/ …              generated and uploaded footage, repairs
 *     05 Edit/                       cuts finished in an editor, every version kept
 *     06 Sound/Dialogue/ …           dialogue, auditions, music and effects
 *     07 Delivery/Exports/ …         NLE exports, provenance
 *
 * THIS MODULE IS PURE: no database. `lib/file-storage.js` asks the database
 * which folder a project has chosen and asks this module what goes where.
 *
 * `folder: null`-style fallbacks do not exist on purpose. A kind of file this
 * registry does not name lands in `Other/<kind>` rather than being refused —
 * refusing would fail a generation that has already been paid for — but the
 * test derives every kind that reaches the storage layer from the source and
 * fails if one would land there. "Other" is a safety net, not a destination.
 *
 * A project whose folder is NULL keeps the old kind-first layout. Every project
 * made before this existed is in that state, and it keeps working unchanged
 * until somebody moves it (`lib/project-storage.js`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.homedir(), '.gridlight', 'film-engine', 'data');

/**
 * Every kind of per-project file, and the folder it goes in.
 *
 * The key is the `subdir` every storage call already passes — and it is ALSO the
 * URL segment the file is served from (`/film/<subdir>/<project>/<file>`), so
 * the serving routes do not change at all. Only the disk moves.
 *
 * No folder here may sit inside another's: a folder's files are found by
 * prefix, and a nested one would make "which kind is this file" ambiguous.
 */
const PROJECT_LAYOUT = Object.freeze({
    refsheets:   Object.freeze({ folder: '01 References/Plates', what: 'character, location and prop plates; mood-board, continuity and marketing images' }),
    'loc-refs':  Object.freeze({ folder: '01 References/Location Views', what: 'extra views generated for a location' }),
    'prop-refs': Object.freeze({ folder: '01 References/Prop Views', what: 'extra views generated for a prop' }),
    storyboards: Object.freeze({ folder: '02 Storyboard', what: 'storyboard frames; earlier attempts in versions/' }),
    previs:      Object.freeze({ folder: '03 Previs/Stages', what: 'previs stills and imported stage images' }),
    worlds:      Object.freeze({ folder: '03 Previs/Worlds', what: 'navigable worlds built from location plates' }),
    '3d':        Object.freeze({ folder: '03 Previs/3D Models', what: 'meshes for characters, props and stages' }),
    video:       Object.freeze({ folder: '04 Video/Clips', what: 'generated, uploaded, lip-synced and finished clips, and the film master' }),
    repairs:     Object.freeze({ folder: '04 Video/Repairs', what: 'frames extracted and made while repairing a clip' }),
    edits:       Object.freeze({ folder: '05 Edit', what: 'cuts finished in an editor (Premiere, Resolve), every version kept, with the XML or EDL each was cut from' }),
    audio:       Object.freeze({ folder: '06 Sound/Dialogue', what: 'generated and uploaded dialogue', formerly: ['05 Sound/Dialogue'] }),
    auditions:   Object.freeze({ folder: '06 Sound/Auditions', what: 'voice auditions and table reads', formerly: ['05 Sound/Auditions'] }),
    music:       Object.freeze({ folder: '06 Sound/Music and Effects', what: 'score, cues, ambience, effects, stems, bounces and packages', formerly: ['05 Sound/Music and Effects'] }),
    exports:     Object.freeze({ folder: '07 Delivery/Exports', what: 'FCPXML, EDL, Premiere and FDX exports and handover packages', formerly: ['06 Delivery/Exports'] }),
    provenance:  Object.freeze({ folder: '07 Delivery/Provenance', what: 'provenance sidecars', formerly: ['06 Delivery/Provenance'] }),
});

/*
 * FOLDERS THAT WERE RENAMED, in the order to apply them — last first, so no
 * rename lands on a folder still waiting to move. `05 Edit` arrived between
 * the clips and the sound, because that is where an edit happens, and pushed
 * Sound and Delivery down one. A project folder made before that is renamed
 * at boot (lib/project-storage.js upgradeLayouts), and every kind still
 * answers to its former name, so a path recorded under it is never orphaned.
 */
const LAYOUT_RENAMES = Object.freeze([
    Object.freeze({ from: '06 Delivery', to: '07 Delivery' }),
    Object.freeze({ from: '05 Sound', to: '06 Sound' }),
]);

/** Every name a kind's folder answers to: its folder, then any it was renamed from. */
function namesOf(spec) { return [spec.folder, ...(spec.formerly || [])]; }

/** Where a kind this registry does not name ends up. Never a destination by design. */
const OTHER_FOLDER = 'Other';

/** The file that says "this folder is a Film Engine project". */
const README_NAME = 'About this folder.txt';

/**
 * Where the OLD layout kept a kind. `auditions` was always the other way round
 * (`data/<project>/auditions`) — every caller passed its arguments swapped —
 * so a move must know to look there, or every audition already paid for would
 * be left behind.
 */
function legacyDir(projectId, subdir) {
    if (subdir === 'auditions') return path.join(DATA_DIR, String(projectId), 'auditions');
    return path.join(DATA_DIR, String(subdir), String(projectId));
}

/** Where a kind goes inside a chosen project folder. */
function layoutDir(root, subdir) {
    const spec = PROJECT_LAYOUT[subdir];
    const rel = spec ? spec.folder : path.join(OTHER_FOLDER, String(subdir));
    return path.join(root, ...rel.split('/'));
}

/** Every kind, with its folder, ordered as the film is made. */
function layoutList() {
    return Object.entries(PROJECT_LAYOUT)
        .map(([subdir, s]) => ({ subdir, folder: s.folder, what: s.what }))
        .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Which kind a path INSIDE a project folder belongs to, and the rest of it.
 * Longest folder first, so a future nested folder cannot be misread as its
 * parent. Returns null for a path in no known folder.
 */
function kindInRoot(root, filePath) {
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const relPosix = rel.split(path.sep).join('/');
    const entries = Object.entries(PROJECT_LAYOUT)
        .flatMap(([subdir, s]) => namesOf(s).map(folder => ({ subdir, folder })))
        .sort((a, b) => b.folder.length - a.folder.length);
    for (const e of entries) {
        if (relPosix.startsWith(e.folder + '/')) {
            return { subdir: e.subdir, rest: relPosix.slice(e.folder.length + 1) };
        }
    }
    const other = new RegExp(`^${OTHER_FOLDER}/([^/]+)/(.+)$`).exec(relPosix);
    if (other) return { subdir: other[1], rest: other[2] };
    return null;
}

/**
 * Read a path in the OLD layout: `<data>/<subdir>/<project>/<rest>`, or the
 * swapped `<data>/<project>/auditions/<rest>`. Lexical — the project may not
 * exist on this machine (a bundle from somewhere else).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseLegacy(filePath) {
    const parts = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 2; i++) {
        if (PROJECT_LAYOUT[parts[i]] && parts[i] !== 'auditions' && UUID.test(parts[i + 1])) {
            return { subdir: parts[i], projectId: parts[i + 1], rest: parts.slice(i + 2).join('/') };
        }
        if (UUID.test(parts[i]) && parts[i + 1] === 'auditions') {
            return { subdir: 'auditions', projectId: parts[i], rest: parts.slice(i + 2).join('/') };
        }
    }
    return null;
}

/**
 * Read ANY stored path lexically — old layout, or a project folder on some
 * other machine — into `{ subdir, rest }`. What a bundle import needs: the
 * source's folder does not exist here, but the kind folder names inside it
 * are this registry's own.
 */
function parseStored(filePath) {
    const legacy = parseLegacy(filePath);
    if (legacy) return { subdir: legacy.subdir, rest: legacy.rest, projectId: legacy.projectId };
    const posix = String(filePath || '').replace(/\\/g, '/');
    const entries = Object.entries(PROJECT_LAYOUT)
        .flatMap(([subdir, s]) => namesOf(s).map(folder => ({ subdir, folder })))
        .sort((a, b) => b.folder.length - a.folder.length);
    for (const e of entries) {
        const at = posix.lastIndexOf('/' + e.folder + '/');
        if (at >= 0) return { subdir: e.subdir, rest: posix.slice(at + e.folder.length + 2) };
    }
    return null;
}

/** A title as a folder name: readable, and safe on every filesystem a film goes to. */
function folderNameFor(title) {
    const clean = String(title || '')
        .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim();
    return clean || 'Untitled Film';
}

function expandHome(p) {
    const s = String(p || '').trim();
    if (s === '~') return os.homedir();
    if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
    return s;
}

/**
 * Where new projects go when nobody has said.
 *
 * `~/Film Engine` — somewhere a person looks, not the hidden data directory.
 * An install whose data directory was set explicitly (a second profile, a test
 * run) keeps its projects beside that data instead, so an isolated instance
 * never writes into the person's real Film Engine folder.
 */
function defaultProjectsRoot() {
    if (process.env.FILM_PROJECTS_DIR) return path.resolve(expandHome(process.env.FILM_PROJECTS_DIR));
    if (process.env.FILM_DATA_DIR) return path.join(DATA_DIR, 'projects');
    return path.join(os.homedir(), 'Film Engine');
}

/** Is there anything in this directory at all (ignoring .DS_Store)? */
function isEmptyDir(dir) {
    try {
        return fs.readdirSync(dir).filter(n => n !== '.DS_Store').length === 0;
    } catch (_) { return true; }   // absent counts as empty: it will be created
}

/**
 * `<parent>/<title>`, made unique: ` (2)`, ` (3)` … when that folder already
 * holds something. Never an existing non-empty folder — a project folder that
 * is already somebody else's is how two films end up writing over each other.
 */
function suggestAssetsDir(parent, title, taken) {
    const base = path.resolve(expandHome(parent || defaultProjectsRoot()));
    const name = folderNameFor(title);
    const takenSet = new Set((taken || []).map(t => path.resolve(t)));
    for (let n = 1; n < 1000; n++) {
        const candidate = path.join(base, n === 1 ? name : `${name} (${n})`);
        if (takenSet.has(candidate)) continue;
        if (isEmptyDir(candidate)) return candidate;
    }
    return path.join(base, `${name} ${Date.now()}`);
}

/** Does one of these two directories contain the other (or are they the same)? */
function overlaps(a, b) {
    const ra = path.resolve(a), rb = path.resolve(b);
    if (ra === rb) return true;
    return ra.startsWith(rb + path.sep) || rb.startsWith(ra + path.sep);
}

/**
 * Can this be a project's folder? Returns `{ ok, dir, error }`.
 *
 * `others` are the folders other projects already use. `requireEmpty` is set
 * for a move — moving INTO a folder that already has files would mix two sets
 * of work with no way to tell them apart afterwards.
 */
function validateAssetsDir(input, opts) {
    const o = opts || {};
    if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'a folder is required' };
    const expanded = expandHome(input);
    if (!path.isAbsolute(expanded)) {
        return { ok: false, error: `"${input}" is not a full path — start it with / or ~/` };
    }
    const dir = path.resolve(expanded);
    const home = os.homedir();
    if (dir === path.parse(dir).root) return { ok: false, error: 'a project cannot be the whole disk' };
    if (dir === home) return { ok: false, error: 'a project cannot be your whole home folder — pick a folder inside it' };
    if (overlaps(dir, DATA_DIR) && !dir.startsWith(path.resolve(DATA_DIR) + path.sep + 'projects' + path.sep)) {
        return { ok: false, error: 'that is inside Film Engine\'s own data folder — pick somewhere you look' };
    }
    for (const other of o.others || []) {
        if (other && overlaps(dir, other)) {
            return { ok: false, error: `that folder overlaps another project's folder (${other})` };
        }
    }
    if (fs.existsSync(dir)) {
        let st;
        try { st = fs.statSync(dir); } catch (e) { return { ok: false, error: `cannot read ${dir}: ${e.code || e.message}` }; }
        if (!st.isDirectory()) return { ok: false, error: `${dir} is a file, not a folder` };
        if (o.requireEmpty && !isEmptyDir(dir)) {
            return { ok: false, error: `${dir} already has files in it — pick an empty or new folder` };
        }
    }
    // Writable: the nearest existing ancestor must accept a file.
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    try { fs.accessSync(probe, fs.constants.W_OK); }
    catch (_) { return { ok: false, error: `cannot write to ${probe}` }; }
    return { ok: true, dir };
}

/** The note left at the top of a project folder, so a person knows what it is. */
function readmeText(title) {
    const lines = [
        `${title || 'This film'} — a Film Engine project folder.`,
        '',
        'Everything Film Engine makes or imports for this film is kept here,',
        'in the order the film is made:',
        '',
        ...layoutList().map(e => `  ${e.folder.padEnd(32)} ${e.what}`),
        '',
        'Film Engine keeps a record of every file in this folder. Rename or move',
        'files from inside Film Engine (Settings → Project folder → Move) rather',
        'than in the Finder, or it will lose track of them.',
        '',
    ];
    return lines.join('\n');
}

/** Create the folder skeleton and its note. Idempotent; never overwrites a file. */
function scaffold(root, title) {
    fs.mkdirSync(root, { recursive: true });
    for (const { subdir } of layoutList()) fs.mkdirSync(layoutDir(root, subdir), { recursive: true });
    const readme = path.join(root, README_NAME);
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, readmeText(title));
    return root;
}

module.exports = {
    DATA_DIR, PROJECT_LAYOUT, LAYOUT_RENAMES, OTHER_FOLDER, README_NAME, namesOf,
    legacyDir, layoutDir, layoutList, kindInRoot, parseLegacy, parseStored,
    folderNameFor, expandHome, defaultProjectsRoot, suggestAssetsDir,
    validateAssetsDir, overlaps, isEmptyDir, readmeText, scaffold,
};
