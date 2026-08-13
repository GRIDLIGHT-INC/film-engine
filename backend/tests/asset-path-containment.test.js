/**
 * A DB-sourced file_name must never read a file outside its project directory.
 *
 * POST /film/projects/:id/assets accepts file_name from the request body and
 * stores it with no sanitisation beyond a 500-char truncation. Several code
 * paths later read that value off the asset row and hand it to getFilePath():
 *
 *   capability-payloads.loadShotContext  -> base64s the file into init_image
 *   video-gen.loadShotContext            -> same
 *   consistency-context.resolveAssetPath -> resolves reference images
 *   threed                               -> reads a reference image
 *
 * getFilePath() was a bare path.join, so a file_name of ../../../../etc/passwd
 * resolved outside the data directory. The first two paths then base64 whatever
 * they read into a generation payload and send it to an external provider, which
 * turns local file disclosure into exfiltration. The server sets
 * Access-Control-Allow-Origin: * and has no auth, so the asset row can be
 * planted by any page the user visits.
 *
 * threed.js already defended itself with a basename regex; the others did not.
 * Rather than ask every future caller to remember, containment now lives in
 * getFilePath itself — the single function all of them already route through.
 *
 * Two tests by design: a payload table proving the chokepoint refuses, and a
 * set-based scan proving nothing in lib/ builds a data-dir path around it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-paths-' + crypto.randomUUID().slice(0, 8));

const { getFilePath } = require('../lib/file-storage');

const PROJECT = '11111111-2222-3333-4444-555555555555';

const TRAVERSAL = [
    '../../../../etc/passwd',
    '../../../etc/hosts',
    '..%2f..%2fetc%2fpasswd',           // pre-decoded by a router, harmless, still must not escape
    'subdir/../../../../etc/passwd',
    '....//....//etc/passwd',
    '/etc/passwd',                       // absolute: path.join would not escape, but assert anyway
    '..',
    '../',
];

test('getFilePath refuses every traversal payload', () => {
    const escaped = [];
    const projectDir = path.resolve(process.env.FILM_DATA_DIR, 'storyboards', PROJECT);

    for (const name of TRAVERSAL) {
        let resolved = null;
        try {
            resolved = path.resolve(getFilePath(PROJECT, 'storyboards', name));
        } catch (_) {
            continue; // refused — the desired outcome
        }
        // It returned a path: it must still be inside the project directory.
        if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
            escaped.push(`${name} -> ${resolved}`);
        }
    }

    assert.deepStrictEqual(escaped, [], `file_name values that escaped the project directory:\n  ${escaped.join('\n  ')}`);
});

test('getFilePath still resolves ordinary asset filenames', () => {
    // Containment must not break the normal case, which is always a basename.
    for (const name of ['1A.png', 'shot_1A_RAY_0.wav', 'scene-2.final.mp4', 'a.b-c_d.png']) {
        const p = getFilePath(PROJECT, 'storyboards', name);
        assert.ok(
            p.endsWith(path.join(PROJECT, name)),
            `legitimate filename ${name} did not resolve under the project dir: ${p}`
        );
    }
});

test('no DB-sourced file_name is joined into a path outside getFilePath', () => {
    // The chokepoint is only a chokepoint while everyone goes through it.
    //
    // Scoped to joins involving a *filename* rather than every path.join on the
    // data dir: project-bundle.js legitimately composes directory paths from
    // DATA_DIR, subdir and projectId, and a directory join carries none of this
    // risk — the danger is specifically an attacker-supplied file_name becoming
    // the last path component.
    // Keyed on `<row>.file_name` — a property read off a database row — rather
    // than on any variable that happens to be called "filename". Locally
    // constructed names (provenance sidecars, backup files, both built from
    // literals and sanitised titles) carry no attacker influence and are not the
    // invariant; the one that bit us was an asset row's file_name reaching disk.
    const roots = [path.join(__dirname, '..', 'lib'), path.join(__dirname, '..', 'routes')];
    const FILENAME_JOIN = /path\.join\([^)]*\.\s*file_name\b[^)]*\)/;
    const offenders = [];

    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            if (entry.name === 'file-storage.js') continue; // defines the chokepoint

            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
                if (FILENAME_JOIN.test(line)) {
                    offenders.push(`${path.relative(path.join(__dirname, '..'), full)}:${i + 1}: ${trimmed}`);
                }
            });
        }
    };
    roots.forEach(walk);

    assert.deepStrictEqual(offenders, [], `file_name joined into a path outside getFilePath:\n  ${offenders.join('\n  ')}`);
});
