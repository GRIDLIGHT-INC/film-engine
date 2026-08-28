/**
 * THE PAGE, SERVED SO THAT AN EDIT IS VISIBLE.
 *
 * The SPA was served by `python -m http.server`, which sends Last-Modified and
 * no Cache-Control. A browser reads that as licence to reuse its stored copy
 * without asking, so every change to index.html needed a forced reload.
 *
 * The failure mode is what makes it worth replacing rather than remembering: it
 * is silent and it is misleading. A new control is in the file on disk and
 * absent from the page that is loaded, so pressing it calls a function that
 * does not exist and NOTHING HAPPENS — which reads as a broken feature rather
 * than a stale page. That cost a round trip today and had been costing one
 * after nearly every change.
 *
 * No dependency. Node's own http and fs, which is precisely what ADR-002 is
 * about: the backend still has exactly one.
 *
 *   node backend/dev-server.js [port] [dir]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.woff2': 'font/woff2',
};

function createDevServer(rootDir) {
    const root = path.resolve(rootDir);

    return http.createServer((req, res) => {
        const send = (status, body, type) => {
            res.writeHead(status, {
                'Content-Type': type || 'text/plain; charset=utf-8',
                /*
                 * no-store, not no-cache. no-cache still permits a stored copy
                 * revalidated by ETag, and a revalidation answering 304 is
                 * exactly the stale page this exists to prevent. No validator
                 * is sent either, so there is nothing to revalidate against.
                 */
                'Cache-Control': 'no-store, must-revalidate',
                Pragma: 'no-cache',
                Expires: '0',
            });
            res.end(body);
        };

        let pathname;
        try {
            // Decoded before resolving: %2e%2e is the same escape as .. and a
            // check that runs on the raw string misses it entirely.
            pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        } catch (_) {
            return send(400, 'Bad request');
        }
        if (pathname === '/' || pathname === '') pathname = '/index.html';

        /*
         * Containment by RESOLVED PATH, never by inspecting the request.
         *
         * A dev server binds to localhost and is still a server: the database,
         * the git directory and every provider credential sit one level above
         * the directory being served. The same rule file-storage already
         * follows — compare what the path resolves to, and refuse rather than
         * silently correcting.
         */
        const target = path.resolve(root, '.' + pathname);
        if (target !== root && !target.startsWith(root + path.sep)) {
            return send(403, 'Forbidden');
        }

        let stat;
        try { stat = fs.statSync(target); }
        catch (_) { return send(404, 'Not found'); }
        if (stat.isDirectory()) {
            const index = path.join(target, 'index.html');
            try { return send(200, fs.readFileSync(index), TYPES['.html']); }
            catch (_) { return send(404, 'Not found'); }
        }

        try {
            // Read on every request. Holding the file in memory would
            // reintroduce, one layer down, the exact staleness this replaces.
            const body = fs.readFileSync(target);
            send(200, body, TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
        } catch (_) {
            send(404, 'Not found');
        }
    });
}

/*
 * Which interface the page is served on.
 *
 * Loopback by default and deliberately so: this server has no authentication
 * of any kind, and the API beside it already binds every interface — putting
 * the page on the LAN is what makes the whole app reachable from another
 * device, which is the machine owner's decision and not a default anyone
 * should acquire by upgrading.
 *
 * FILM_ENGINE_HOST=0.0.0.0 opts in. It is an env var rather than a stored
 * setting because this file deliberately has no database import and no
 * dependency (ADR-002), and a setting that a server cannot read at bind time
 * would be one more thing declared and never consumed.
 */
function bindHost(env) {
    const host = String((env || {}).FILM_ENGINE_HOST || '').trim();
    return host || '127.0.0.1';
}

function isLoopback(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** The addresses another device on the network could actually reach. */
function lanAddresses() {
    const nets = require('os').networkInterfaces();
    const out = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family === 'IPv4' && !net.internal) out.push(net.address);
        }
    }
    return out;
}

if (require.main === module) {
    const port = Number(process.argv[2]) || Number(process.env.PORT) || 3200;
    const dir = process.argv[3] || path.join(__dirname, '..', 'src');
    const host = bindHost(process.env);
    createDevServer(dir).listen(port, host, () => {
        console.log(`Film Engine page on http://localhost:${port}`);
        console.log(`  serving ${path.resolve(dir)}`);
        console.log('  Cache-Control: no-store — an edit shows on an ordinary refresh.');
        if (isLoopback(host)) {
            console.log('  This machine only. To open it on a phone on the same network:');
            console.log(`    FILM_ENGINE_HOST=0.0.0.0 node backend/dev-server.js ${port}`);
        } else {
            for (const address of lanAddresses())
                console.log(`  On this network: http://${address}:${port}`);
            console.log('  WARNING: served to the whole network and UNAUTHENTICATED — anyone');
            console.log('  who can reach this machine can read and change the project.');
        }
    });
}

module.exports = { createDevServer, bindHost, isLoopback, lanAddresses };
