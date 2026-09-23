/**
 * A project's files live in ONE folder, chosen when it is made, laid out in the
 * order the film is made — and it can be moved.
 *
 * Set-based over the thing that fails partially: the KINDS of file. Every kind
 * that reaches the storage layer is derived from the source (every
 * `saveFile`/`ensureDir`/`getFilePath`/`persistProviderMedia` call, every
 * declared `subdir`), and each is held to having its own folder, to landing in
 * it, to being found again (`locate`), to being served, and to arriving at the
 * right place when a project is moved. A layout that covered the storyboard and
 * forgot the auditions would pass any test written against frames.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-folders-' + crypto.randomUUID().slice(0, 8));
delete process.env.FILM_PROJECTS_DIR;

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const folders = require('../lib/project-folders');
const fileStorage = require('../lib/file-storage');
const storage = require('../lib/project-storage');
const { callTool, listTools } = require('../lib/mcp-tools');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = folders.DATA_DIR;

// ── The denominator: every kind of file that reaches storage ────────────────

function sourceFiles() {
    const out = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
            else if (e.name.endsWith('.js')) out.push(p);
        }
    };
    walk(path.join(ROOT, 'lib'));
    walk(path.join(ROOT, 'routes'));
    out.push(path.join(ROOT, 'server.js'), path.join(ROOT, 'mcp-server.js'));
    return out;
}

/*
 * Kinds that are NOT per-project, by name with the reason. A kind reaching the
 * storage layer that is in neither set fails.
 */
const GLOBAL_KINDS = Object.freeze({});

function derivedKinds() {
    const kinds = new Map();              // kind → first place seen
    const note = (k, where) => { if (!kinds.has(k)) kinds.set(k, where); };
    const CALL = /\b(ensureDir|saveFile|getFilePath|serveFile|fileExists|dirFor|persistProviderMedia)\(\s*[^,()]+,\s*['"]([a-z0-9_-]+)['"]/g;
    const URL = /\bgetFileUrl\(\s*['"]([a-z0-9_-]+)['"]/g;
    const DECL = /\b(?:subdir|SUBDIR)\s*[:=]\s*['"]([a-z0-9_-]+)['"]/g;
    for (const f of sourceFiles()) {
        const rel = path.relative(ROOT, f);
        if (rel === path.join('lib', 'project-folders.js')) continue;
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(CALL)) note(m[2], `${rel} ${m[1]}()`);
        for (const m of src.matchAll(URL)) note(m[1], `${rel} getFileUrl()`);
        for (const m of src.matchAll(DECL)) note(m[1], `${rel} subdir declaration`);
    }
    // The registries, read at run time rather than grepped.
    for (const v of Object.values(require('../lib/media-kinds').SUBDIR)) note(v, 'media-kinds SUBDIR');
    for (const [t, spec] of Object.entries(require('../lib/media-imports').MEDIA_IMPORTS || {})) {
        if (spec.subdir) note(spec.subdir, `media-imports ${t}`);
        for (const v of Object.values(spec.subdirByKind || {})) note(v, `media-imports ${t}`);
    }
    return kinds;
}

test('the derived set of storage kinds is not empty (the scan is really scanning)', () => {
    const kinds = derivedKinds();
    assert.ok(kinds.size >= 12, `only ${kinds.size} kinds found: ${[...kinds.keys()].join(', ')}`);
    for (const k of ['storyboards', 'refsheets', 'video', 'music', 'auditions', 'worlds', '3d']) {
        assert.ok(kinds.has(k), `the scan missed ${k} — it would pass over a layout that forgot it`);
    }
});

test('every kind of file that reaches storage has its own folder in the layout (none lands in "Other")', () => {
    const missing = [];
    for (const [k, where] of derivedKinds()) {
        if (GLOBAL_KINDS[k]) continue;
        if (!folders.PROJECT_LAYOUT[k]) missing.push(`${k} (from ${where})`);
    }
    assert.deepStrictEqual(missing, [], `kinds with no folder in PROJECT_LAYOUT:\n  ${missing.join('\n  ')}`);
});

test('layout folders are distinct and none sits inside another (a file\'s kind is unambiguous)', () => {
    const list = folders.layoutList();
    const names = list.map(e => e.folder);
    assert.strictEqual(new Set(names).size, names.length, 'two kinds share a folder');
    for (const a of names) for (const b of names) {
        if (a !== b) assert.ok(!b.startsWith(a + '/'), `${b} is inside ${a}`);
    }
    assert.ok(list.every(e => e.what && e.what.length > 8), 'every folder says what goes in it');
});

// ── One place decides ────────────────────────────────────────────────────────

test('no module rebuilds a project path from the data directory itself', () => {
    const KINDS = Object.keys(folders.PROJECT_LAYOUT).map(k => k.replace(/[-]/g, '\\-')).join('|');
    const JOIN = new RegExp(`join\\([^)]*DATA_DIR[^)]*['"](${KINDS})['"]`);
    const POSITIONAL = /basename\(path\.dirname\(path\.dirname\(|parts\[parts\.length - 3\]/;
    // A kind passed where the PROJECT goes: the audition calls did this, which
    // put every audition outside any project folder and made shot_review read
    // frames from a path that never existed.
    const SWAPPED = new RegExp(`\\b(ensureDir|saveFile|getFilePath|serveFile|fileExists|dirFor|persistProviderMedia)\\(\\s*['"](${KINDS})['"]`);
    const offenders = [];
    for (const f of sourceFiles()) {
        const rel = path.relative(ROOT, f);
        if (['lib/project-folders.js', 'lib/file-storage.js', 'lib/data-paths.js'].includes(rel)) continue;
        const src = fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
        if (JOIN.test(src)) offenders.push(`${rel}: joins DATA_DIR with a project kind — ask file-storage.dirFor`);
        if (POSITIONAL.test(src)) offenders.push(`${rel}: reads a file's kind off its folder names — ask file-storage.locate`);
        const sw = SWAPPED.exec(src);
        if (sw) offenders.push(`${rel}: ${sw[1]}('${sw[2]}', …) passes a kind where the project id goes`);
    }
    assert.deepStrictEqual(offenders, [], offenders.join('\n'));
});

// ── Creating a project asks where ────────────────────────────────────────────

function mkTmp(name) {
    const d = path.join(os.tmpdir(), `fe-folders-${name}-${crypto.randomUUID().slice(0, 6)}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
}

async function create(args) {
    const r = await callTool('project_create', args);
    return r;
}

test('project_create saves into the chosen folder, scaffolded in pipeline order', async () => {
    const parent = mkTmp('parent');
    const r = await create({ title: 'The Glass Harbour', assets_parent: parent });
    assert.strictEqual(r._status, 201, JSON.stringify(r.body));
    const dir = r.body.assets_dir;
    assert.strictEqual(dir, path.join(parent, 'The Glass Harbour'));
    assert.ok(fs.existsSync(path.join(dir, folders.README_NAME)), 'the folder says what it is');
    for (const e of folders.layoutList()) {
        assert.ok(fs.existsSync(path.join(dir, ...e.folder.split('/'))), `${e.folder} was not made`);
    }
    // A second film of the same name gets its own folder, never the first one's.
    const again = await create({ title: 'The Glass Harbour', assets_parent: parent });
    assert.strictEqual(again.body.assets_dir, path.join(parent, 'The Glass Harbour (2)'));
});

test('with no answer, a new project gets a folder named after it in the default place', async () => {
    const r = await create({ title: 'Default Place Film' });
    assert.strictEqual(r._status, 201);
    assert.strictEqual(r.body.assets_dir, path.join(folders.defaultProjectsRoot(), 'Default Place Film'));
    assert.ok(!r.body.assets_dir.startsWith(os.homedir() + path.sep + 'Film Engine'),
        'an isolated instance must never write into the person\'s real Film Engine folder');
});

test('a folder that cannot be a project folder is refused before the project exists', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM film_projects').get().n;
    const cases = [
        { assets_dir: 'relative/folder' },
        { assets_dir: os.homedir() },
        { assets_dir: '/' },
        { assets_dir: path.join(DATA_DIR, 'video') },
    ];
    const taken = await create({ title: 'Owner Of A Folder', assets_parent: mkTmp('owner') });
    cases.push({ assets_dir: path.join(taken.body.assets_dir, 'nested') });
    const file = path.join(mkTmp('file'), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    cases.push({ assets_dir: file });
    for (const c of cases) {
        const r = await create({ title: 'Refused Film', ...c });
        assert.strictEqual(r._status, 400, `${JSON.stringify(c)} was accepted`);
        assert.match(r.body.error, /Project folder/);
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM film_projects').get().n, before + 1,
        'a refused folder must leave no project behind');
});

test('the folder cannot be changed by editing a field — only by moving', async () => {
    const r = await create({ title: 'Field Edit Film', assets_parent: mkTmp('fe') });
    const u = await callTool('project_update', { project_id: r.body.id, assets_dir: '/tmp/elsewhere' });
    assert.strictEqual(u._status, 400);
    assert.match(u.body.error, /move/i);
    assert.strictEqual(db.prepare('SELECT assets_dir FROM film_projects WHERE id = ?').get(r.body.id).assets_dir,
        r.body.assets_dir);
});

// ── Every kind lands in its folder, is found again, and is served ────────────

function legacyProject(title) {
    const id = generateId();
    db.prepare("INSERT INTO film_projects (id, title, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))")
        .run(id, title);
    return id;
}

function fakeRes() {
    const r = { status: null, headers: null, req: { headers: {} } };
    r.writeHead = (s, h) => { r.status = s; r.headers = h; };
    r.end = () => {};
    r.on = r.once = r.emit = r.write = () => true;
    return r;
}

test('every kind lands in its own folder of a project folder, round-trips through locate, and is served', async () => {
    const r = await create({ title: 'Every Kind Film', assets_parent: mkTmp('kinds') });
    const pid = r.body.id, root = r.body.assets_dir;
    for (const { subdir, folder } of folders.layoutList()) {
        const p = fileStorage.saveFile(pid, subdir, 'probe.png', Buffer.from('x'));
        assert.strictEqual(p, path.join(root, ...folder.split('/'), 'probe.png'), `${subdir} landed at ${p}`);
        assert.strictEqual(fileStorage.getFilePath(pid, subdir, 'probe.png'), p);
        const where = fileStorage.locate(p);
        assert.deepStrictEqual(where && [where.projectId, where.subdir, where.rest], [pid, subdir, 'probe.png'],
            `${subdir}: locate could not say what ${p} is`);
        assert.strictEqual(fileStorage.urlForPath(p), fileStorage.getFileUrl(subdir, pid, 'probe.png'));
        assert.ok(fileStorage.isOwnedPath(p), `${subdir}: a project-folder file must count as ours`);
        const res = fakeRes();
        fileStorage.serveFile(res, pid, subdir, 'probe.png');
        assert.strictEqual(res.status, 200, `${subdir}: not served from the project folder`);
        assert.throws(() => fileStorage.getFilePath(pid, subdir, '../../../escape.png'), /outside/);
    }
});

test('a project with no folder keeps the old layout for every kind, unchanged', () => {
    const pid = legacyProject('Old Layout Film');
    for (const { subdir } of folders.layoutList()) {
        const want = subdir === 'auditions'
            ? path.join(DATA_DIR, pid, 'auditions')
            : path.join(DATA_DIR, subdir, pid);
        assert.strictEqual(fileStorage.dirFor(pid, subdir), want, subdir);
        const p = fileStorage.saveFile(pid, subdir, 'old.png', Buffer.from('y'));
        const where = fileStorage.locate(p);
        assert.deepStrictEqual(where && [where.projectId, where.subdir, where.rest], [pid, subdir, 'old.png'], subdir);
    }
});

// ── Moving ───────────────────────────────────────────────────────────────────

function seedEveryKind(pid) {
    const rows = [];
    for (const { subdir } of folders.layoutList()) {
        const p = fileStorage.saveFile(pid, subdir, `${subdir}-file.bin`, Buffer.from(subdir));
        const id = generateId();
        db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, metadata, created_at)
                    VALUES (?, ?, 'other', ?, ?, ?, datetime('now'))`)
            .run(id, pid, `${subdir}-file.bin`, p, JSON.stringify({ source_file: p, kind: subdir }));
        rows.push({ id, subdir });
    }
    // Nested files move with their folder (a storyboard version).
    fileStorage.saveFile(pid, 'storyboards', 'versions/1A_v1.png', Buffer.from('v1'));
    return rows;
}

function assertRowsResolve(rows, root) {
    for (const r of rows) {
        const a = db.prepare('SELECT file_path, metadata FROM film_assets WHERE id = ?').get(r.id);
        assert.ok(fs.existsSync(a.file_path), `${r.subdir}: row points at a file that is not there: ${a.file_path}`);
        assert.ok(a.file_path.startsWith(root + path.sep), `${r.subdir}: row not repointed: ${a.file_path}`);
        assert.strictEqual(JSON.parse(a.metadata).source_file, a.file_path,
            `${r.subdir}: a path inside JSON was left pointing at the old place`);
    }
}

test('an old-layout project moves into a structured folder: every kind, every row, nothing left behind', async () => {
    const pid = legacyProject('Moving Picture');
    const rows = seedEveryKind(pid);
    // A kind the layout does not name still travels (to Other/), never stranded.
    fs.mkdirSync(path.join(DATA_DIR, 'oddkind', pid), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'oddkind', pid, 'odd.bin'), 'odd');
    // A stray written by a swapped call (data/<project>/refsheets/) is gathered
    // into the plates folder — the first time it becomes servable.
    fs.mkdirSync(path.join(DATA_DIR, pid, 'refsheets'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, pid, 'refsheets', 'inspiration_x.png'), 'stray');

    const parent = mkTmp('move1');
    const r = await callTool('project_storage_move', { project_id: pid, parent });
    assert.strictEqual(r._status, 200, JSON.stringify(r.body));
    const root = path.join(parent, 'Moving Picture');
    assert.strictEqual(r.body.to, root);
    assert.strictEqual(r.body.files_moved, folders.layoutList().length + 3);
    assert.ok(fs.existsSync(path.join(root, '01 References', 'Plates', 'inspiration_x.png')), 'a stray was left behind');
    assert.ok(!fs.existsSync(path.join(DATA_DIR, pid)), 'the stray folder was left behind');
    for (const { subdir } of folders.layoutList()) {
        assert.ok(!fs.existsSync(folders.legacyDir(pid, subdir)), `${subdir}: old folder left behind`);
        assert.ok(fs.existsSync(path.join(folders.layoutDir(root, subdir), `${subdir}-file.bin`)), `${subdir} did not arrive`);
    }
    assert.ok(fs.existsSync(path.join(root, '02 Storyboard', 'versions', '1A_v1.png')), 'a nested version was lost');
    assert.ok(fs.existsSync(path.join(root, 'Other', 'oddkind', 'odd.bin')), 'an unnamed kind was stranded');
    assertRowsResolve(rows, root);
    assert.strictEqual(fileStorage.dirFor(pid, 'video'), path.join(root, '04 Video', 'Clips'));

    // …and on to another folder, whole.
    const next = path.join(mkTmp('move2'), 'Renamed Picture');
    const r2 = await callTool('project_storage_move', { project_id: pid, assets_dir: next });
    assert.strictEqual(r2._status, 200, JSON.stringify(r2.body));
    assert.ok(!fs.existsSync(root), 'the previous folder is gone');
    assertRowsResolve(rows, next);

    const report = (await callTool('project_storage_get', { project_id: pid })).body;
    assert.strictEqual(report.layout, 'project');
    assert.strictEqual(report.totals.files, folders.layoutList().length + 3);
});

test('a move into a folder that already holds files is refused, and nothing changes', async () => {
    const r = await create({ title: 'Stays Put', assets_parent: mkTmp('stay') });
    const busy = mkTmp('busy');
    fs.writeFileSync(path.join(busy, 'someone-elses.txt'), 'mine');
    const m = await callTool('project_storage_move', { project_id: r.body.id, assets_dir: busy });
    assert.strictEqual(m._status, 400);
    assert.match(m.body.error, /already has files/);
    assert.strictEqual(fileStorage.projectRoot(r.body.id), r.body.assets_dir);
});

test('a move whose records cannot be rewritten puts every file back', async () => {
    const pid = legacyProject('Rollback Film');
    const rows = seedEveryKind(pid);
    const dest = path.join(mkTmp('rb'), 'Rollback Film');
    db.exec(`CREATE TRIGGER fe_folders_boom BEFORE UPDATE ON film_assets
             WHEN NEW.file_path LIKE '${dest.replace(/'/g, "''")}%'
             BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
        const m = await callTool('project_storage_move', { project_id: pid, assets_dir: dest });
        assert.notStrictEqual(m._status, 200);
    } finally {
        db.exec('DROP TRIGGER fe_folders_boom');
    }
    for (const r of rows) {
        const a = db.prepare('SELECT file_path FROM film_assets WHERE id = ?').get(r.id);
        assert.ok(fs.existsSync(a.file_path), `${r.subdir}: the file is not where its row says after a failed move`);
    }
    assert.strictEqual(fileStorage.projectRoot(pid), null, 'a failed move must not record the new folder');
});

// ── The rest of the surface ──────────────────────────────────────────────────

test('storage_suggest, storage_layout and storage_browse answer for free', async () => {
    const parent = mkTmp('sug');
    const s = await callTool('storage_suggest', { title: 'A: Bad/Name?', parent });
    assert.strictEqual(s.body.valid, true);
    assert.strictEqual(s.body.assets_dir, path.join(parent, 'A Bad Name'));
    assert.ok(!fs.existsSync(s.body.assets_dir), 'a suggestion must create nothing');
    const l = await callTool('storage_layout', {});
    assert.deepStrictEqual(l.body.layout.map(e => e.subdir).sort(), Object.keys(folders.PROJECT_LAYOUT).sort());
    const b = await callTool('storage_browse', {});
    assert.strictEqual(b._status, 200);
    const outside = await callTool('storage_browse', { path: '/etc' });
    assert.strictEqual(outside._status, 403, 'browsing is bounded to the home folder and mounted drives');
});

test('project_create tells an agent to ask where, and every storage tool is listed', () => {
    const tools = new Map(listTools().map(t => [t.name, t]));
    for (const n of ['project_storage_get', 'project_storage_move', 'storage_suggest', 'storage_layout', 'storage_browse']) {
        assert.ok(tools.has(n), `${n} is not an MCP tool`);
    }
    const pc = tools.get('project_create').inputSchema.properties;
    assert.ok(pc.assets_dir && /ASK/.test(pc.assets_dir.description));
    assert.ok(pc.assets_parent);
});

test('a bundle imported here lands in its own structured folder', async () => {
    const r = await create({ title: 'Bundled Film', assets_parent: mkTmp('bsrc') });
    const pid = r.body.id;
    const p = fileStorage.saveFile(pid, 'storyboards', '1A.png', Buffer.from('frame'));
    db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, created_at)
                VALUES (?, ?, 'storyboard', '1A.png', ?, datetime('now'))`).run(generateId(), pid, p);
    const bundle = require('../lib/project-bundle');
    const { archivePath } = bundle.exportProject(pid);
    const imported = bundle.importProject(fs.readFileSync(archivePath));
    const np = imported.project;
    assert.ok(np.assets_dir && np.assets_dir !== r.body.assets_dir, 'an import must never claim the source folder');
    const a = db.prepare("SELECT file_path FROM film_assets WHERE project_id = ? AND file_name = '1A.png'").get(np.id);
    assert.strictEqual(a.file_path, path.join(np.assets_dir, '02 Storyboard', '1A.png'));
    assert.ok(fs.existsSync(a.file_path));
});

test('the page asks where on every new project, and the Settings card can move one', () => {
    const page = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.ok(!/onclick="showModal\('newProjectModal'\)"/.test(page), 'a New Project button skips the folder question');
    assert.ok(/onclick="openNewProject\(\)"/.test(page));
    assert.ok(/id="newProjectLocation"/.test(page) && /data\.assets_parent = location/.test(page),
        'the dialog must send where to save');
    for (const id of ['folderPickerModal', 'settingsFolderCard', 'settingsFolderMoveTo', 'settingsProjectsRoot']) {
        assert.ok(page.includes(`id="${id}"`), `${id} is missing`);
    }
    for (const fn of ['openNewProject', 'previewProjectFolder', 'openFolderPicker', 'loadFolderPicker',
        'folderPickerChoose', 'loadProjectFolder', 'moveProjectFolder', 'saveProjectsRoot']) {
        assert.ok(new RegExp(`function ${fn}\\(`).test(page), `${fn} is not defined`);
    }
    assert.ok(/\/storage\/move/.test(page) && /loadProjectFolder\(\);\n    \}/.test(page),
        'Settings must paint the folder card and reach the move route');
});
