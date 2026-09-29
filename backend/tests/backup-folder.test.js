/**
 * Backups to a folder the person chooses — so an app shared with other people
 * lets each of them keep their own.
 *
 * "What if I share this to other users, how can they set their projects to a
 * folder that saves backup?"
 *
 *   - a backup is a real, openable snapshot of the WHOLE database, including a
 *     write still sitting in the WAL (VACUUM INTO, never a file copy);
 *   - it lands in a sub-folder named for this user and machine, so people
 *     sharing one folder never overwrite each other;
 *   - pruning keeps the newest N and never touches a file Film Engine did not write;
 *   - no folder set is refused by name; the schedule is a pure function of the
 *     status; each setting is validated;
 *   - a person (Settings) and an agent (three tools) can both reach it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-bf-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const Database = require('better-sqlite3');
const bf = require('../lib/backup-folder');
const { handleBackups } = require('../routes/backups');
const { handleAppSettings } = require('../routes/app-settings');

const SHARED = path.join(process.env.FILM_DATA_DIR, 'shared-drive');

function call(handler, method, parts, body) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: this.code, json: j }); } };
        const r = handler({ method, headers: {}, body: body || {} }, res, parts, {});
        if (r && r.then) r.catch(() => {});
    });
}
const settings = body => call(handleAppSettings, 'PUT', ['film', 'settings'], body);

test('with no folder set, a backup is refused by name and nothing is scheduled', async () => {
    const st = bf.backupStatus();
    assert.equal(st.configured, false);
    assert.equal(st.scheduled, false);
    assert.equal(bf.isDue(st), false);
    const r = await call(handleBackups, 'POST', ['film', 'backups', 'folder', 'run']);
    assert.equal(r.code, 409);
    assert.equal(r.json.error, 'NO_BACKUP_DIR');
});

test('each setting is validated before anything is written', async () => {
    for (const [k, v] of [['backup_dir', 'relative/folder'], ['backup_every_hours', '-1'], ['backup_keep', '0'], ['backup_keep', '2.5']]) {
        const r = await settings({ [k]: v });
        assert.equal(r.code, 400, `${k}=${v} is refused`);
    }
});

test('a backup is a whole, openable snapshot in this person\'s own sub-folder, WAL included', async () => {
    assert.equal((await settings({ backup_dir: SHARED, backup_keep: 3, backup_projects: true })).code, 200);
    const pid = generateId();
    db.prepare(`INSERT INTO film_projects (id, title) VALUES (?, 'Glass Harbour')`).run(pid);   // still in the WAL

    const r = await call(handleBackups, 'POST', ['film', 'backups', 'folder', 'run']);
    assert.equal(r.code, 200, JSON.stringify(r.json));
    const who = `${os.userInfo().username.replace(/[^\w.-]+/g, '_')}@${os.hostname().replace(/[^\w.-]+/g, '_')}`;
    assert.equal(r.json.folder, path.join(SHARED, 'Film Engine Backups', who), 'a sub-folder per user and machine');
    const snap = new Database(path.join(r.json.folder, r.json.file), { readonly: true });
    assert.equal(snap.prepare('SELECT title FROM film_projects WHERE id = ?').get(pid).title, 'Glass Harbour');
    assert.equal(snap.pragma('integrity_check', { simple: true }), 'ok');
    snap.close();
    assert.ok(r.json.projects.some(n => n.startsWith('Glass_Harbour_')), 'the project JSON is written');
    assert.ok(fs.existsSync(path.join(r.json.folder, 'latest.json')));
    assert.ok(r.json.restore.length >= 3, 'the restore steps travel with it');
});

test('pruning keeps the newest N and never deletes a file Film Engine did not write', async () => {
    const dir = bf.machineDir(SHARED);
    const foreign = path.join(dir, 'my-notes.db');
    fs.writeFileSync(foreign, 'not ours');
    for (let i = 0; i < 4; i++) { bf.runBackup(db); await new Promise(r => setTimeout(r, 5)); }
    const ours = fs.readdirSync(dir).filter(n => n.startsWith(bf.PREFIX) && n.endsWith('.db'));
    assert.equal(ours.length, 3, 'keep is 3');
    assert.ok(fs.existsSync(foreign), 'a foreign file survives');
    assert.ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), 'no half-written snapshot is left');
    const st = bf.backupStatus();
    assert.equal(st.count, 3);
    assert.equal(st.snapshots[0].file, ours.sort().reverse()[0], 'newest first');
});

test('the schedule is due exactly when the interval has passed, and 0 means only when asked', async () => {
    const st = bf.backupStatus();
    const last = new Date(st.last.at).getTime();
    assert.equal(bf.isDue(st, last + 5 * 3600e3), false);
    assert.equal(bf.isDue(st, last + 6 * 3600e3 + 1), true, 'blank is every 6 hours');
    assert.equal(bf.isDue({ ...st, last: null }), true, 'a folder with nothing in it is due now');
    await settings({ backup_every_hours: 0 });
    assert.equal(bf.backupStatus().scheduled, false);
    assert.equal(bf.isDue(bf.backupStatus(), Date.now() + 1e12), false);
});

test('a throwaway test database never starts the schedule', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(src, /if \(!tmpData\) require\('\.\/lib\/backup-folder'\)\.startBackupSchedule/);
});

test('a person and an agent can both reach it', () => {
    const names = new Set(require('../lib/mcp-tools').listTools().map(t => t.name));
    for (const n of ['backup_folder_status', 'backup_folder_set', 'backup_folder_run']) assert.ok(names.has(n), n);
    const src = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    for (const id of ['settingsBackupDir', 'settingsBackupEvery', 'settingsBackupKeep', 'settingsBackupProjects']) assert.ok(src.includes(`id="${id}"`), id);
    const fn = name => { const at = src.indexOf(`async function ${name}(`); return src.slice(at, src.indexOf('\n    }\n', at)); };
    for (const k of ['backup_dir', 'backup_every_hours', 'backup_keep', 'backup_projects']) assert.ok(fn('saveBackupSettings').includes(k), `${k} is saved`);
    assert.match(fn('runBackupNow'), /\/backups\/folder\/run/);
    assert.match(src, /openFolderPicker\('settingsBackupDir'/, 'the folder can be browsed for');
});
