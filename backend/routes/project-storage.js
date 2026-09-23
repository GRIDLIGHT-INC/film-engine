/**
 * Project folders over HTTP.
 *
 *   GET  /film/storage/layout                what a project folder looks like, and where new ones go
 *   GET  /film/storage/suggest?title=&parent= the folder a new project would get (free, writes nothing)
 *   GET  /film/storage/browse?path=          the folders inside a folder, for choosing one
 *   POST /film/storage/choose                the Mac's own "Choose Folder" dialog, on this Mac
 *   GET  /film/projects/:id/storage          where this project's files are, folder by folder
 *   POST /film/projects/:id/storage/move     move them to a new folder, and repoint every record
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const folders = require('../lib/project-folders');
const storage = require('../lib/project-storage');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/*
 * Browsing is bounded to the home folder and mounted drives. The server
 * answers anyone who can reach it, and a folder picker that lists the whole
 * disk is a directory listing of the machine handed to the network.
 */
function browsable(dir) {
    const roots = [os.homedir(), '/Volumes', folders.defaultProjectsRoot()];
    return roots.some(r => dir === path.resolve(r) || dir.startsWith(path.resolve(r) + path.sep));
}

function browse(req, res, query) {
    const asked = folders.expandHome((query && query.path) || os.homedir());
    const dir = path.resolve(asked);
    if (!browsable(dir)) return json(res, 403, { error: 'only folders inside your home folder or on a mounted drive can be browsed' });
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return json(res, 404, { error: `cannot open ${dir}: ${e.code || e.message}` }); }
    const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    return json(res, 200, {
        path: dir,
        parent: parent !== dir && browsable(parent) ? parent : null,
        is_project: fs.existsSync(path.join(dir, folders.README_NAME)),
        dirs,
    });
}

/*
 * THE MAC'S OWN FOLDER DIALOG.
 *
 * A web page cannot learn a folder's path: the browser's directory picker
 * hands back a handle, never "/Users/…". The server can, because it is a
 * process on the Mac — `osascript` opens Finder's "Choose Folder" sheet and
 * prints the POSIX path chosen.
 *
 * Only for a request that comes from THIS machine. The dialog opens on the
 * Mac's screen, so a phone on the LAN asking for one would put a dialog in
 * front of nobody and hang its own request until the timeout. Judged on the
 * socket's address, never X-Forwarded-For, which anyone can write. Anything
 * else answers 501 with the reason, and the page falls back to its own list.
 *
 * The prompt and the starting folder travel as ARGUMENTS to the script, never
 * spliced into its text — a folder name with a quote in it is not AppleScript.
 */
const CHOOSE_SCRIPT = [
    'on run argv',
    '  activate',
    '  set p to item 1 of argv',
    '  if (count of argv) > 1 then',
    '    set f to choose folder with prompt p default location (POSIX file (item 2 of argv))',
    '  else',
    '    set f to choose folder with prompt p',
    '  end if',
    '  return POSIX path of f',
    'end run',
];

function osascriptChooser(promptText, start) {
    const { execFile } = require('child_process');
    const args = [];
    for (const line of CHOOSE_SCRIPT) args.push('-e', line);
    args.push(promptText);
    if (start) args.push(start);
    return new Promise(resolve => {
        // Ten minutes: a person is choosing, and nothing is waiting on them but this.
        execFile('osascript', args, { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
            if (err) {
                if (/-128|User cancell?ed/i.test(String(stderr) + String(err.message))) return resolve({ cancelled: true });
                return resolve({ error: String(stderr || err.message).trim() || 'the folder dialog failed' });
            }
            const chosen = String(stdout).trim().replace(/\/$/, '');
            resolve(chosen ? { path: chosen } : { cancelled: true });
        });
    });
}

// Replaceable so the route can be tested without a person at a dialog.
let chooser = osascriptChooser;
function setChooser(fn) { chooser = fn || osascriptChooser; }

function isLoopback(req) {
    const a = String((req && req.socket && req.socket.remoteAddress) || '');
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

async function chooseNative(req, res) {
    if (process.platform !== 'darwin' && chooser === osascriptChooser) {
        return json(res, 501, { native: false, reason: 'the Mac folder dialog is only available when Film Engine runs on a Mac' });
    }
    if (!isLoopback(req)) {
        return json(res, 501, { native: false, reason: 'the folder dialog opens on the Mac running Film Engine, so it is only offered to a page open on that Mac' });
    }
    const b = req.body || {};
    const promptText = String(b.prompt || 'Choose a folder for your Film Engine projects').slice(0, 200);
    let start = b.start ? path.resolve(folders.expandHome(String(b.start))) : '';
    // Start from the nearest folder that exists: a default location that is
    // not there makes the dialog fail rather than open.
    while (start && !fs.existsSync(start) && path.dirname(start) !== start) start = path.dirname(start);
    const out = await chooser(promptText, start && fs.existsSync(start) ? start : '');
    if (out.error) return json(res, 500, { native: true, error: out.error });
    return json(res, 200, { native: true, ...out });
}

function suggest(req, res, query) {
    const q = query || {};
    const title = q.title || 'Untitled Film';
    const v = storage.resolveRequested({ parent: q.parent || undefined, assets_dir: q.assets_dir || undefined }, title, q.project_id);
    return json(res, 200, {
        assets_dir: v.ok ? v.dir : null,
        valid: v.ok,
        error: v.ok ? null : v.error,
        parent: q.parent ? folders.expandHome(q.parent) : storage.defaultParent(),
    });
}

function layout(req, res) {
    return json(res, 200, {
        layout: folders.layoutList(),
        default_parent: storage.defaultParent(),
        readme: folders.README_NAME,
    });
}

async function handleProjectStorage(req, res, parts, query) {
    // /film/storage/:action
    if (parts[1] === 'storage') {
        if (parts[2] === 'choose' && req.method === 'POST') return chooseNative(req, res);
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        if (parts[2] === 'layout') return layout(req, res);
        if (parts[2] === 'suggest') return suggest(req, res, query);
        if (parts[2] === 'browse') return browse(req, res, query);
        return json(res, 404, { error: 'Unknown storage route' });
    }

    // /film/projects/:id/storage[/move]
    const id = parts[2];
    if (req.method === 'GET' && !parts[4]) {
        const report = storage.storageReport(id);
        if (!report) return json(res, 404, { error: 'Project not found' });
        return json(res, 200, report);
    }
    if (req.method === 'POST' && parts[4] === 'move') {
        try {
            const result = await storage.moveProject(id, req.body || {});
            return json(res, 200, { ...result, storage: storage.storageReport(id) });
        } catch (e) {
            return json(res, e.status || 500, { error: e.message });
        }
    }
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleProjectStorage, setChooser, CHOOSE_SCRIPT };
