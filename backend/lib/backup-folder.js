/**
 * BACKUPS TO A FOLDER THE PERSON CHOOSES.
 *
 * "What if I share this to other users — how can they set their projects to a
 * folder that saves backup?"
 *
 * Everything a film is lives in two places: its project folder (the media,
 * which each person already chooses — `projects_root`, or a folder per project)
 * and this machine's database (every row that says what the media IS). The
 * database was backed up only by a script outside the app. Now each person sets
 * `backup_dir` in Settings — a Dropbox, Google Drive or NAS folder works — and
 * the server writes there on a schedule:
 *
 *   <backup_dir>/Film Engine Backups/<user>@<host>/
 *     film-engine_<stamp>.db        the whole database, as a consistent snapshot
 *     projects/<title>_<id8>.json   each project's rows (optional), newest only
 *     latest.json                   what was written, when, and how to restore it
 *
 * Per user AND machine, so two people pointing at one shared folder never
 * overwrite each other. The snapshot is `VACUUM INTO`, never a file copy: the
 * database runs in WAL mode, and a copy of the main file alone misses whatever
 * is still in the write-ahead log. Only snapshots this module wrote are pruned.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'film-engine_';
const DEFAULTS = { every_hours: 6, keep: 28 };

function expandHome(p) {
    return require('./project-folders').expandHome(String(p || ''));
}

/** The folder this person's backups go in, or null when none is set. */
function machineDir(backupDir) {
    if (!backupDir) return null;
    const who = `${(os.userInfo().username || 'user').replace(/[^\w.-]+/g, '_')}@${os.hostname().replace(/[^\w.-]+/g, '_')}`;
    return path.join(expandHome(backupDir), 'Film Engine Backups', who);
}

function settings() {
    let s = {};
    try { s = require('../routes/app-settings').readSettings(); } catch (_) { /* before migrations */ }
    const num = (v, d) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? d : n; };
    return {
        dir: s.backup_dir || '',
        every_hours: num(s.backup_every_hours, DEFAULTS.every_hours),
        keep: Math.max(1, Math.round(num(s.backup_keep, DEFAULTS.keep))),
        projects: !!s.backup_projects,
    };
}

function snapshots(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(n => n.startsWith(PREFIX) && n.endsWith('.db'))
        .map(n => { const st = fs.statSync(path.join(dir, n)); return { file: n, path: path.join(dir, n), bytes: st.size, at: st.mtime.toISOString() }; })
        .sort((a, b) => b.file.localeCompare(a.file));
}

const RESTORE_STEPS = [
    'Stop Film Engine (the API on port 3100 and any MCP host using it).',
    'Keep a copy of the current database: ~/.gridlight/film-engine/data/film-engine.db (and its -wal and -shm files).',
    'Copy the snapshot you want over film-engine.db and delete film-engine.db-wal and film-engine.db-shm.',
    'Start Film Engine. Project media is in each project’s own folder and is not in the snapshot.',
];

/** What is set, what is in the folder, and when the next one is due. FREE. */
function backupStatus() {
    const s = settings();
    const dir = machineDir(s.dir);
    const list = snapshots(dir);
    const last = list[0] || null;
    const dueAt = last && s.every_hours > 0 ? new Date(new Date(last.at).getTime() + s.every_hours * 3600e3).toISOString() : null;
    return {
        configured: !!s.dir, backup_dir: s.dir || null, folder: dir, every_hours: s.every_hours, keep: s.keep,
        projects: s.projects, scheduled: !!s.dir && s.every_hours > 0,
        last, next_due: s.dir && s.every_hours > 0 ? (dueAt || 'now') : null,
        snapshots: list.slice(0, 50), count: list.length,
        restore: RESTORE_STEPS,
        ...(s.dir ? {} : { why: 'No backup folder is set. Choose one in Settings (backup_dir); a Dropbox, Google Drive or NAS folder works.' }),
    };
}

/**
 * Write one backup now. `opts.dir` overrides the setting (tests, a one-off).
 * Returns what was written; throws with `code` when there is no folder.
 */
function runBackup(db, opts = {}) {
    const s = { ...settings(), ...(opts.dir ? { dir: opts.dir } : {}), ...(opts.keep ? { keep: opts.keep } : {}),
        ...(opts.projects !== undefined ? { projects: !!opts.projects } : {}) };
    if (!s.dir) { const e = new Error('No backup folder is set (backup_dir in Settings).'); e.code = 'NO_BACKUP_DIR'; throw e; }
    const dir = machineDir(s.dir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${PREFIX}${stamp}.db`);
    const tmp = file + '.part';
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* nothing there */ }
    db.prepare('VACUUM INTO ?').run(tmp);                 // consistent, WAL included
    fs.renameSync(tmp, file);                              // a half-written snapshot never carries the name

    const projects = [];
    if (s.projects) {
        const pdir = path.join(dir, 'projects');
        fs.mkdirSync(pdir, { recursive: true });
        const { exportProjectData } = require('./backup');
        for (const p of db.prepare('SELECT id, title FROM film_projects').all()) {
            try {
                const data = exportProjectData(p.id);
                const name = `${String(p.title || 'untitled').replace(/[^\w.-]+/g, '_').slice(0, 50)}_${p.id.slice(0, 8)}.json`;
                fs.writeFileSync(path.join(pdir, name), JSON.stringify(data));
                projects.push(name);
            } catch (err) { projects.push(`${p.id}: ${err.message}`); }
        }
    }

    // Keep the newest N of OUR snapshots; never touch anything else in the folder.
    const pruned = [];
    for (const old of snapshots(dir).slice(s.keep)) {
        try { fs.unlinkSync(old.path); pruned.push(old.file); } catch (_) { /* someone else has it open */ }
    }
    const out = { ok: true, folder: dir, file: path.basename(file), bytes: fs.statSync(file).size, at: new Date().toISOString(),
        projects, pruned, keep: s.keep, restore: RESTORE_STEPS };
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(out, null, 2));
    return out;
}

/** Is a backup due? Pure, so the schedule is testable without a clock. */
function isDue(status, now = Date.now()) {
    if (!status.scheduled) return false;
    if (!status.last) return true;
    return now >= new Date(status.last.at).getTime() + status.every_hours * 3600e3;
}

let timer = null;
/**
 * Check every ten minutes whether a backup is due, and write one if so. The
 * setting is read each time, so choosing a folder or changing the interval
 * takes effect without a restart. Never throws; unref'd so it never holds the
 * process open.
 */
function startBackupSchedule(db, { everyMs = 10 * 60 * 1000, log = console } = {}) {
    if (timer) return timer;
    const tick = () => {
        try {
            if (isDue(backupStatus())) {
                const r = runBackup(db);
                log.log && log.log(`Backup written: ${path.join(r.folder, r.file)}`);
            }
        } catch (err) { log.error && log.error(`Scheduled backup failed: ${err.message}`); }
    };
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
    setTimeout(tick, 30 * 1000).unref();
    return timer;
}

module.exports = { backupStatus, runBackup, isDue, startBackupSchedule, machineDir, RESTORE_STEPS, PREFIX };
