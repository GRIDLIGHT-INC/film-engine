/**
 * A PROJECT'S FOLDER: choosing it, reading it, and moving it.
 *
 * `lib/project-folders.js` says what the folder looks like; this module is the
 * half that touches the database and the disk.
 *
 * MOVING IS FILES FIRST, ROWS SECOND, AND BOTH OR NEITHER.
 *
 * Every table that records a file records it as an absolute path — twenty-odd
 * path columns, plus paths inside JSON (operation params, asset metadata,
 * provenance). A move that relocated the files and missed one of those would
 * leave a row pointing at a folder that no longer holds anything, and the only
 * symptom is a plate "unavailable" weeks later. So the rewrite is not a list of
 * columns — lists are what go stale — it is every TEXT column of every table,
 * replacing the old folder prefix with the new one. The prefixes carry the
 * project's own id (old layout) or the project's own folder (new layout), so
 * they cannot match another project's rows.
 *
 * The files move first and are COUNTED at the destination before any row
 * changes; the rows then change in one transaction; if that fails the files are
 * moved back. A move that half-happened is worse than one that did not.
 */

const fs = require('fs');
const path = require('path');
const folders = require('./project-folders');

function db() { return require('../db/database').db; }

/** Folders other projects already use — a new or moved folder must not overlap them. */
function otherRoots(exceptId) {
    return db().prepare(
        "SELECT assets_dir FROM film_projects WHERE assets_dir IS NOT NULL AND assets_dir <> '' AND id <> ?")
        .all(exceptId || '').map(r => r.assets_dir);
}

function countFiles(dir) {
    let files = 0, bytes = 0;
    const walk = d => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
                if (e.name === '.DS_Store' || e.name === folders.README_NAME) continue;
                files++;
                try { bytes += fs.statSync(p).size; } catch (_) { /* gone mid-walk */ }
            }
        }
    };
    walk(dir);
    return { files, bytes };
}

/**
 * Every folder a project's files live in right now, kind by kind — including a
 * kind the layout does not name, found by looking, so a move leaves nothing
 * behind in the old layout.
 */
function currentDirs(projectId, assetsDir) {
    const out = [];
    const seen = new Set();
    for (const { subdir } of folders.layoutList()) {
        seen.add(subdir);
        out.push({ subdir, dir: assetsDir ? folders.layoutDir(assetsDir, subdir) : folders.legacyDir(projectId, subdir) });
    }
    if (assetsDir) {
        const other = path.join(assetsDir, folders.OTHER_FOLDER);
        let names = [];
        try { names = fs.readdirSync(other); } catch (_) { names = []; }
        for (const n of names) if (!seen.has(n)) out.push({ subdir: n, dir: path.join(other, n) });
    } else {
        let names = [];
        try { names = fs.readdirSync(folders.DATA_DIR); } catch (_) { names = []; }
        for (const n of names) {
            if (seen.has(n)) continue;
            const d = path.join(folders.DATA_DIR, n, projectId);
            try { if (fs.statSync(d).isDirectory()) out.push({ subdir: n, dir: d }); } catch (_) { /* absent */ }
        }
        /*
         * STRAYS: `data/<project>/<kind>/`. Calls that passed their arguments
         * the wrong way round wrote there (gallery inspiration images did, and
         * nothing could serve them). A move gathers them into the kind's own
         * folder, which is the first time they become reachable.
         */
        let strays = [];
        try { strays = fs.readdirSync(path.join(folders.DATA_DIR, projectId), { withFileTypes: true }); } catch (_) { strays = []; }
        for (const e of strays) {
            if (!e.isDirectory() || e.name === 'auditions') continue;
            out.push({ subdir: e.name, dir: path.join(folders.DATA_DIR, projectId, e.name), stray: true });
        }
    }
    return out;
}

/** Where a project's files are, and what is in each folder. Free; reads only. */
function storageReport(projectId) {
    const p = db().prepare('SELECT id, title, assets_dir FROM film_projects WHERE id = ?').get(projectId);
    if (!p) return null;
    const layout = p.assets_dir ? 'project' : 'legacy';
    const dirs = currentDirs(p.id, p.assets_dir).map(d => {
        const spec = folders.PROJECT_LAYOUT[d.subdir];
        const c = countFiles(d.dir);
        return {
            subdir: d.subdir,
            folder: spec ? spec.folder : `${folders.OTHER_FOLDER}/${d.subdir}`,
            what: spec ? spec.what : 'files of a kind this version has no folder for',
            path: d.dir,
            files: c.files,
            bytes: c.bytes,
        };
    });
    const totals = dirs.reduce((a, d) => ({ files: a.files + d.files, bytes: a.bytes + d.bytes }), { files: 0, bytes: 0 });
    return {
        project_id: p.id,
        title: p.title,
        assets_dir: p.assets_dir || null,
        layout,
        exists: p.assets_dir ? fs.existsSync(p.assets_dir) : true,
        note: layout === 'legacy'
            ? 'This project is in the old layout: its files are spread across Film Engine\'s data folder by kind. Move it to a project folder to keep everything in one place.'
            : 'Everything this film makes is kept in this folder, laid out in the order the film is made.',
        folders: dirs,
        totals,
        suggestion: folders.suggestAssetsDir(defaultParent(), p.title, otherRoots(p.id)),
    };
}

/** The parent folder new projects are offered: the person's setting, else the default. */
function defaultParent() {
    try {
        const row = db().prepare("SELECT value FROM film_app_settings WHERE key = 'projects_root'").get();
        if (row && row.value) return folders.expandHome(row.value);
    } catch (_) { /* no settings table in an older schema */ }
    return folders.defaultProjectsRoot();
}

/**
 * Resolve what a caller asked for into a folder: an exact `assets_dir`, or a
 * `parent` the project's own folder is made inside. Neither means the default.
 */
function resolveRequested(body, title, exceptId) {
    const b = body || {};
    if (b.assets_dir) return folders.validateAssetsDir(b.assets_dir, { others: otherRoots(exceptId), requireEmpty: !!b.requireEmpty });
    const parent = b.parent || b.assets_parent || defaultParent();
    const candidate = folders.suggestAssetsDir(parent, title, otherRoots(exceptId));
    return folders.validateAssetsDir(candidate, { others: otherRoots(exceptId), requireEmpty: !!b.requireEmpty });
}

/**
 * Give a new project its folder: validated, created, and recorded. Throws a
 * 400-shaped error for a folder that cannot be used — a project created with a
 * folder it cannot write to fails its first generation, after the money.
 */
function assignOnCreate(projectId, title, body) {
    const v = resolveRequested(body, title, projectId);
    if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
    folders.scaffold(v.dir, title);
    db().prepare('UPDATE film_projects SET assets_dir = ? WHERE id = ?').run(v.dir, projectId);
    return v.dir;
}

/* Moves in progress, so two presses cannot move one project twice at once. */
const MOVING = new Set();

async function moveDir(from, to) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    /*
     * INTO A FOLDER THAT ALREADY HOLDS FILES — two sources of one kind (a
     * stray and the real folder) — merge entry by entry, and never overwrite:
     * a name that exists on both sides is refused, which undoes the move.
     */
    if (fs.existsSync(to) && !folders.isEmptyDir(to) && fs.statSync(from).isDirectory()) {
        let how = 'rename';
        for (const name of await fs.promises.readdir(from)) {
            const src = path.join(from, name), dst = path.join(to, name);
            if (fs.existsSync(dst) && !fs.statSync(src).isDirectory()) {
                throw new Error(`${dst} already exists — nothing was overwritten`);
            }
            if ((await moveDir(src, dst)) === 'copy') how = 'copy';
        }
        await fs.promises.rm(from, { recursive: true, force: true });
        return how;
    }
    // An empty directory already at the target (a scaffolded folder) is replaced.
    try { if (folders.isEmptyDir(to)) await fs.promises.rm(to, { recursive: true, force: true }); } catch (_) { /* absent */ }
    try {
        await fs.promises.rename(from, to);
        return 'rename';
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        // Another disk: copy, then remove the original only once the copy is whole.
        await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        const a = countFiles(from), b = countFiles(to);
        if (a.files !== b.files || a.bytes !== b.bytes) {
            await fs.promises.rm(to, { recursive: true, force: true });
            throw new Error(`copy to ${to} came out incomplete (${b.files}/${a.files} files)`);
        }
        await fs.promises.rm(from, { recursive: true, force: true });
        return 'copy';
    }
}

/**
 * Every TEXT column of every ordinary table — where a path can be stored.
 * Virtual tables and their shadow tables are left alone: rewriting an FTS
 * index's internals corrupts it.
 */
function textColumns() {
    const tables = db().prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_film_migrations'").all();
    const virtual = tables.filter(t => /^\s*CREATE\s+VIRTUAL/i.test(t.sql || '')).map(t => t.name);
    const out = [];
    for (const t of tables) {
        if (virtual.includes(t.name) || virtual.some(v => t.name.startsWith(v + '_'))) continue;
        const cols = db().prepare(`PRAGMA table_info("${t.name}")`).all();
        for (const c of cols) {
            const type = String(c.type || '').toUpperCase();
            if (type === '' || type.includes('TEXT') || type.includes('CHAR') || type.includes('CLOB') || type.includes('JSON')) {
                out.push({ table: t.name, column: c.name });
            }
        }
    }
    return out;
}

/** Rewrite every stored occurrence of each `from/` prefix to `to/`. Returns rows changed. */
function rewritePrefixes(pairs) {
    let changed = 0;
    const cols = textColumns();
    for (const { from, to } of pairs) {
        const a = from.endsWith(path.sep) ? from : from + path.sep;
        const b = to.endsWith(path.sep) ? to : to + path.sep;
        for (const { table, column } of cols) {
            const info = db().prepare(
                `UPDATE "${table}" SET "${column}" = REPLACE("${column}", ?, ?) WHERE instr("${column}", ?) > 0`)
                .run(a, b, a);
            changed += info.changes;
        }
    }
    return changed;
}

/**
 * Move a project's files to a new folder and repoint every row at them.
 *
 * `target` is `{ assets_dir }` (exact) or `{ parent }` (a folder the project's
 * own folder is made inside). The destination must be empty or new.
 */
async function moveProject(projectId, target) {
    const p = db().prepare('SELECT id, title, assets_dir FROM film_projects WHERE id = ?').get(projectId);
    if (!p) { const e = new Error('Project not found'); e.status = 404; throw e; }
    if (MOVING.has(projectId)) { const e = new Error('this project is already being moved'); e.status = 409; throw e; }

    const v = resolveRequested({ ...(target || {}), requireEmpty: true }, p.title, p.id);
    if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
    const dest = v.dir;
    if (p.assets_dir && path.resolve(p.assets_dir) === dest) {
        const e = new Error('the project is already in that folder'); e.status = 400; throw e;
    }

    MOVING.add(projectId);
    const done = [];          // { from, to } in the order they happened, for undoing
    try {
        const before = storageReport(projectId);
        const plan = [];
        if (p.assets_dir) {
            // One folder to one folder: the whole thing, including anything a
            // person put in it themselves.
            if (fs.existsSync(p.assets_dir)) plan.push({ subdir: '*', from: p.assets_dir, to: dest });
        } else {
            for (const d of currentDirs(p.id, null)) {
                if (!fs.existsSync(d.dir)) continue;
                plan.push({ subdir: d.subdir, from: d.dir, to: folders.layoutDir(dest, d.subdir) });
            }
        }

        const expected = plan.reduce((n, m) => n + countFiles(m.from).files, 0);
        let method = 'rename';
        for (const m of plan) {
            const how = await moveDir(m.from, m.to);
            if (how === 'copy') method = 'copy';
            done.push(m);
        }
        // Each destination once: two sources of one kind land in one folder.
        const arrived = [...new Set(plan.map(m => m.to))].reduce((n, to) => n + countFiles(to).files, 0);
        if (arrived !== expected) throw new Error(`${arrived} of ${expected} files arrived — nothing was changed`);

        folders.scaffold(dest, p.title);

        const rows = db().transaction(() => {
            const n = rewritePrefixes(plan.map(m => ({ from: m.from, to: m.to })));
            db().prepare('UPDATE film_projects SET assets_dir = ?, updated_at = ? WHERE id = ?')
                .run(dest, new Date().toISOString(), projectId);
            return n;
        })();

        // The old layout leaves an empty `data/<project>/` behind for auditions.
        if (!p.assets_dir) {
            const stray = path.join(folders.DATA_DIR, p.id);
            try { if (folders.isEmptyDir(stray)) fs.rmdirSync(stray); } catch (_) { /* not ours to force */ }
        }

        return {
            project_id: p.id,
            from: p.assets_dir || null,
            from_layout: p.assets_dir ? 'project' : 'legacy',
            to: dest,
            method,
            files_moved: arrived,
            rows_rewritten: rows,
            moved: plan.map(m => ({ subdir: m.subdir, from: m.from, to: m.to })),
            before: before && before.totals,
        };
    } catch (err) {
        // Put back whatever moved, newest first, so the project is where it was.
        for (const m of done.reverse()) {
            try { await moveDir(m.to, m.from); } catch (_) { /* reported below */ }
        }
        if (!err.status) err.status = 500;
        throw err;
    } finally {
        MOVING.delete(projectId);
    }
}

/**
 * Bring every project folder up to the current layout.
 *
 * `05 Edit` arrived between the clips and the sound, so `05 Sound` became
 * `06 Sound` and `06 Delivery` became `07 Delivery`. A folder made before that
 * is renamed here, at boot, and every row that recorded a path under the old
 * name is rewritten the way a move rewrites them — one transaction, and the
 * folder is renamed back if the rows cannot follow.
 *
 * Never destructive: a rename whose destination already holds something is
 * skipped and reported, because two folders of one kind merged silently is
 * two sets of work nobody can tell apart. Paths under a former name still
 * resolve (`namesOf`), so a skipped upgrade costs tidiness, not files.
 */
function upgradeLayouts() {
    const report = { projects: 0, renamed: [], skipped: [] };
    let rows = [];
    try {
        rows = db().prepare("SELECT id, title, assets_dir FROM film_projects WHERE assets_dir IS NOT NULL AND assets_dir <> ''").all();
    } catch (_) { return report; }
    for (const p of rows) {
        report.projects++;
        if (!fs.existsSync(p.assets_dir)) continue;
        for (const r of folders.LAYOUT_RENAMES) {
            const from = path.join(p.assets_dir, r.from), to = path.join(p.assets_dir, r.to);
            if (!fs.existsSync(from)) continue;
            if (fs.existsSync(to) && !folders.isEmptyDir(to)) {
                report.skipped.push({ project_id: p.id, from, to, reason: `${r.to} already holds files` });
                continue;
            }
            try {
                if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
                fs.renameSync(from, to);
            } catch (e) {
                report.skipped.push({ project_id: p.id, from, to, reason: e.message });
                continue;
            }
            try {
                db().transaction(() => rewritePrefixes([{ from, to }]))();
                report.renamed.push({ project_id: p.id, from, to });
            } catch (e) {
                try { fs.renameSync(to, from); } catch (_) { /* reported below */ }
                report.skipped.push({ project_id: p.id, from, to, reason: `records could not follow: ${e.message}` });
            }
        }
        // The note at the top describes the layout, so it follows it. Only
        // ours is rewritten — a file a person wrote there is theirs.
        const readme = path.join(p.assets_dir, folders.README_NAME);
        try {
            if (fs.existsSync(readme) && /a Film Engine project folder\./.test(fs.readFileSync(readme, 'utf8'))) {
                fs.writeFileSync(readme, folders.readmeText(p.title));
            }
            folders.scaffold(p.assets_dir, p.title);
        } catch (_) { /* a read-only folder keeps its old note */ }
    }
    return report;
}

module.exports = {    upgradeLayouts,
    storageReport, assignOnCreate, moveProject, defaultParent, resolveRequested,};
