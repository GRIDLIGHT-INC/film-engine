'use strict';

/**
 * -- Handing the film to somebody else ---------------------------------------
 *
 * An NLE export references its media by ABSOLUTE PATH. On the machine that made
 * it that works and looks finished; hand it to an editor — a different Mac, a
 * shared drive, a zip — and every clip is offline. The timeline opens, the cuts
 * are right, and there is no picture. Nothing errors, which is why this has
 * survived: the export is a perfectly good file that only works in one place.
 *
 * Two pieces, and the preflight is the more important one:
 *
 *   preflightExport   what is wrong with this export BEFORE it is handed over
 *   packageExport     the XML plus the media it names, paths rewritten
 *
 * The preflight exists because the first real project this was run against
 * exported ZERO clips. Every shot on it has `duration_ms = 0`, so
 * `shootableShots` disqualified all of them and the export was a well-formed
 * file describing nothing. A blank timeline is not something an editor can
 * report back usefully — it just looks like the tool does not work.
 *
 * PACKAGING REFUSES WHAT THE PREFLIGHT BLOCKS. One rule, not two: a package
 * that builds happily from an export the preflight would refuse makes the
 * preflight advisory, and an advisory check is one people skip.
 */

const fs = require('fs');
const path = require('path');

const {
    AUDIO_LANES, generateFCPXML, generatePremiereXML, generateEDL,
    shootableShots, sceneBedsByShot,
} = require('./nle-export');

/** Where media lives inside a package, relative to the XML beside it. */
const RELATIVE_MEDIA_DIR = 'media';

const FORMATS = {
    fcpxml: { build: generateFCPXML, ext: 'fcpxml', carriesMedia: true },
    premiere: { build: generatePremiereXML, ext: 'xml', carriesMedia: true },
    // An EDL names reels rather than files: it is a conform list handed to an
    // assistant who has the footage elsewhere, so packaging media beside it
    // would be answering a question nobody asked.
    edl: { build: generateEDL, ext: 'edl', carriesMedia: false },
};

/** Every asset an export of these shots would actually reference. */
function referencedAssets(shots, assets) {
    const shootable = shootableShots(shots, byShotId(assets)).shots;
    const ids = new Set(shootable.map(s => s.id));
    const beds = sceneBedsByShot(shootable, assets);
    const bedIds = new Set(Object.values(beds).flat().map(a => a.id));
    const wanted = new Set(['video_raw', 'video_synced', 'video_final', ...AUDIO_LANES.map(l => l.type)]);
    return assets.filter(a => wanted.has(a.asset_type) && (ids.has(a.shot_id) || bedIds.has(a.id)));
}

function byShotId(assets) {
    const out = {};
    for (const a of assets || []) {
        if (!a.shot_id) continue;
        (out[a.shot_id] = out[a.shot_id] || []).push(a);
    }
    return out;
}

/**
 * What is wrong with this export, before anyone is given it.
 *
 * `blocking` is what makes the handover pointless; `warnings` are what an
 * editor should be told and can work around. The split matters: blocking on an
 * empty audio lane would make the export unusable for exactly the workflow it
 * exists to serve, since a lane that is empty today is where the sound pass
 * lands tomorrow.
 */
function preflightExport(project, shots, assets = [], opts = {}) {
    const blocking = [];
    const warnings = [];
    // The rights policy at final export, over the approved score (MUS-022; evaluated by the caller).
    if (opts.rights) {
        if (opts.rights.blocked.length) blocking.push({ code: 'SCORE_RIGHTS', message: `The rights policy blocks the score: ${opts.rights.blocked.map(i => `${i.name} (${i.status})`).join('; ')}`, items: opts.rights.blocked });
        if (opts.rights.warned.length) warnings.push({ code: 'SCORE_RIGHTS', message: `Score rights to settle before delivery: ${opts.rights.warned.map(i => `${i.name} (${i.status})`).join('; ')}`, items: opts.rights.warned });
    }
    /*
     * CLIPS BELOW THE DELIVERY SIZE, measured from the files (the delivery
     * check). A warning, not a block: the editor may upscale in the NLE, but
     * handing over a 720p clip on a 4K delivery without saying so is how a
     * soft shot reaches the grade unnoticed.
     */
    if (opts.deliveryCheck && Array.isArray(opts.deliveryCheck.shots)) {
        const below = opts.deliveryCheck.shots.filter(s => s.status === 'below');
        if (below.length) warnings.push({ code: 'SHOTS_BELOW_DELIVERY',
            message: `${below.length} shot(s) are smaller than the ${opts.deliveryCheck.asked} delivery: `
                + below.map(s => `${s.shot_code} (${s.measured})`).join(', ') + '. Upscale them before handing over.',
            items: below });
    }
    const all = shots || [];
    const { shots: shootable } = shootableShots(all, byShotId(assets));

    if (!shootable.length) {
        blocking.push({
            code: 'NO_SHOOTABLE_SHOTS',
            detail: all.length
                ? `None of the ${all.length} shot(s) can be laid on a timeline: a shot with no `
                  + 'duration is invalid in every format, and nothing has measured one. Generate or '
                  + 'import footage, or set a duration on the cards.'
                : 'This project has no shots.',
        });
    }

    const referenced = referencedAssets(all, assets);
    const missing = referenced.filter(a => a.file_path && !fs.existsSync(a.file_path));
    if (missing.length) {
        blocking.push({
            code: 'MEDIA_MISSING',
            detail: `${missing.length} file(s) the export names are not on disk. The timeline would `
                + 'open with them offline.',
            files: missing.map(a => ({ id: a.id, asset_type: a.asset_type, file_name: a.file_name, file_path: a.file_path })),
        });
    }

    // Every lane, named individually. "3 lanes are empty" sends you to the
    // database; naming them says which pass has not happened.
    for (const lane of AUDIO_LANES) {
        if (!referenced.some(a => a.asset_type === lane.type)) {
            warnings.push({
                code: 'LANE_EMPTY', lane: lane.type,
                detail: `No ${lane.label.toLowerCase()} in this export. The lane still leaves, so the `
                    + 'pass can be done in the NLE.',
            });
        }
    }

    /*
     * Shots that do not reach the timeline AT ALL. Measured on a real project:
     * 13 shots, 2 shootable, `ready: true` — a two-clip film with eleven shots
     * silently absent, which is worse than the blocked case because it looks
     * like it worked. Named individually: a count sends you to the database.
     */
    const droppedShots = all.filter(s2 => !shootable.some(k => k.id === s2.id));
    if (droppedShots.length && shootable.length) {
        warnings.push({
            code: 'SHOTS_DROPPED',
            detail: `${droppedShots.length} of ${all.length} shot(s) will not appear in this export `
                + 'at all — they have no duration, so no format can lay them. Exporting the part of a '
                + 'film that exists is legitimate; this is so nobody discovers it in the NLE.',
            shots: droppedShots.map(s2 => s2.shot_code),
        });
    }

    // A shot with no picture becomes a gap in FCPXML and is omitted from
    // Premiere. Both are correct and both are worth saying out loud.
    const noMedia = shootable.filter(s => !(byShotId(assets)[s.id] || [])
        .some(a => a.asset_type && a.asset_type.startsWith('video_')));
    if (noMedia.length) {
        warnings.push({
            code: 'SHOTS_WITHOUT_PICTURE',
            detail: `${noMedia.length} shot(s) have no footage and will arrive as gaps.`,
            shots: noMedia.map(s => s.shot_code),
        });
    }

    // A bed whose scene has no shootable shot has nowhere to be laid, and is
    // dropped. Silent, that is a score the editor never receives.
    const laid = new Set(Object.values(sceneBedsByShot(shootable, assets)).flat().map(a => a.id));
    const orphanBeds = (assets || []).filter(a => !a.shot_id && a.scene_id
        && AUDIO_LANES.some(l => l.type === a.asset_type) && !laid.has(a.id));
    if (orphanBeds.length) {
        warnings.push({
            code: 'BED_NOT_LAID',
            detail: `${orphanBeds.length} scene-scoped bed(s) belong to a scene with no shootable `
                + 'shot, so they are not in the export.',
            files: orphanBeds.map(a => a.file_name),
        });
    }

    return {
        ready: blocking.length === 0,
        blocking,
        warnings,
        counts: {
            shots: all.length,
            shootable: shootable.length,
            media: referenced.length,
            bytes: referenced.reduce((n, a) => n + (a.size_bytes || 0), 0),
        },
    };
}

/** A filename that cannot collide or escape the package. */
function safeName(asset, taken) {
    const base = path.basename(asset.file_name || asset.file_path || asset.id).replace(/[/\\]/g, '_');
    if (!taken.has(base)) { taken.add(base); return base; }
    // Two assets can legitimately share a name across shots; the id keeps them
    // apart rather than one silently overwriting the other.
    const ext = path.extname(base);
    const name = `${path.basename(base, ext)}_${String(asset.id).slice(0, 8)}${ext}`;
    taken.add(name);
    return name;
}

/**
 * Write the XML and the media it names into one folder.
 *
 * The media is COPIED, never moved: the project's own files have to survive
 * being handed over, and a move would empty the library the moment somebody
 * packages a cut.
 */
async function packageExport(project, shots, assets = [], opts = {}) {
    const format = FORMATS[opts.format] ? opts.format : 'premiere';
    const spec = FORMATS[format];
    const dest = opts.dest;
    if (!dest) throw new Error('packageExport needs a destination folder');

    const pre = preflightExport(project, shots, assets, opts);
    if (!pre.ready) {
        const err = new Error(`There is nothing to hand over: ${pre.blocking.map(b => b.code).join(', ')}`);
        err.code = pre.blocking[0].code;
        err.preflight = pre;
        throw err;
    }

    fs.mkdirSync(dest, { recursive: true });
    const copied = [];
    let rewritten = assets;

    if (spec.carriesMedia) {
        const mediaDir = path.join(dest, RELATIVE_MEDIA_DIR);
        fs.mkdirSync(mediaDir, { recursive: true });
        const referenced = new Map(referencedAssets(shots, assets).map(a => [a.id, a]));
        const taken = new Set();
        const newPath = new Map();
        for (const a of referenced.values()) {
            if (!a.file_path || !fs.existsSync(a.file_path)) continue;
            const name = safeName(a, taken);
            fs.copyFileSync(a.file_path, path.join(mediaDir, name));
            newPath.set(a.id, `${RELATIVE_MEDIA_DIR}/${name}`);
            copied.push(name);
        }
        /*
         * The generators turn `file_path` into a file:// URL, and a RELATIVE
         * path is left alone by that conversion — `toFileUrl` only prefixes
         * something that starts with a slash. So the rewrite happens here, on
         * the asset list, rather than by editing the XML afterwards: a
         * find-and-replace over generated XML is how one of the three formats
         * ends up missed.
         */
        rewritten = assets.map(a => (newPath.has(a.id) ? { ...a, file_path: newPath.get(a.id) } : a));
    }

    /*
     * The format spec's function is called `build` rather than the obvious
     * name. The spend audit scans this codebase for provider-adapter calls, to
     * make sure a paid generation cannot escape the meter; a format spec that
     * borrowed that method name was reported as spending money outside it. The
     * audit is right to be blunt — a check that has to reason about which
     * lookalike is real is one that eventually excuses the real thing — so the
     * name moved instead.
     */
    const content = spec.build(project, shots, rewritten, opts.settings || {}, opts.deliverables || null);
    const stem = (project.title || 'export').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'export';
    const xmlPath = path.join(dest, `${stem}.${spec.ext}`);
    fs.writeFileSync(xmlPath, content, 'utf8');

    // The preflight travels WITH the package, so whoever opens it can read what
    // was known to be missing at the moment it was made.
    const manifest = {
        project: { id: project.id, title: project.title },
        format,
        xml: path.basename(xmlPath),
        media_dir: spec.carriesMedia ? RELATIVE_MEDIA_DIR : null,
        media: copied,
        preflight: pre,
    };
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    return { dest, xml_path: xmlPath, copied, manifest, preflight: pre, format };
}

module.exports = { preflightExport, packageExport, RELATIVE_MEDIA_DIR, FORMATS };
