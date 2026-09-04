/**
 * Handing a shot to somebody else.
 *
 * Spec §50. Seven outputs, and the constraint that matters is not the file
 * list — it is that every one of them NAMES THE WORLD VERSION IT CAME FROM.
 *
 * An export that cannot be traced back to the geometry it describes is
 * unreproducible: a camera JSON is a set of coordinates in a space, and
 * without the version it is a set of numbers. This engine has already paid for
 * the general version of that lesson twice — the render ledger exists because
 * "which parameters made this" had no answer, and `graph_snapshot` exists
 * because a flow edited afterwards invalidated the runs made before it.
 *
 * Pure: this builds a MANIFEST — what each output is, where its bytes are, and
 * what it came from. It reads no files and copies nothing; the route does that,
 * the same split `lib/conform.js` keeps between planning and executing, which
 * is what makes the plan testable without an encoder on the machine.
 */

/**
 * The seven initial exports.
 *
 * `kind` is the load-bearing field and there are three, not one:
 *
 *   json      — built here, from rows
 *   file      — bytes this engine holds, copied into the package
 *   reference — bytes it deliberately does NOT hold
 *
 * The third is not a gap, it is the splat decision: `world_splats` defaults off
 * because full_res is 25 MB per world, so the splat travels as the URL Marble
 * serves it from. Calling that a `file` would put a broken path in a manifest
 * handed to another department.
 */
const EXPORT_OUTPUTS = Object.freeze([
    {
        id: 'camera_json', kind: 'json', filename: 'camera.json',
        scope: 'shot',
        why: 'the camera as staged — position, rotation, lens, sensor, stop — in the world version\'s own space',
    },
    {
        id: 'world_metadata_json', kind: 'json', filename: 'world.json',
        scope: 'world',
        why: 'what the world is, how it was made, its bounds, and whether anybody has measured it',
    },
    {
        id: 'collider_glb', kind: 'file', assetKind: 'collider', filename: 'collider.glb',
        scope: 'world',
        why: 'the mesh every distance in this export was computed against',
    },
    {
        id: 'splat_reference', kind: 'reference', assetKind: 'splat_full', filename: 'splat.url.txt',
        scope: 'world',
        why: 'the highest-fidelity representation, left where the provider serves it — '
            + 'a full-resolution splat is ~25 MB and this engine stores the link, not the bytes',
    },
    {
        id: 'plate_png', kind: 'file', assetKind: 'plate_image', filename: 'generation-plate.png',
        scope: 'shot',
        why: 'the geometry the image model was handed, so a frame can be compared against what produced it',
    },
    {
        id: 'depth_png', kind: 'file', assetKind: 'plate_depth', filename: 'depth.png',
        scope: 'shot',
        why: 'the same frame as distance, so another department can relight or composite against it',
    },
    {
        id: 'thumbnail_png', kind: 'file', assetKind: 'storyboard', filename: 'thumbnail.png',
        scope: 'shot',
        why: 'the frame this shot currently shows, so the package can be recognised without opening it',
    },
]);

/** Every export carries this, and the test is that it does. */
function provenanceOf(world, version) {
    return {
        world_id: (world && world.id) || null,
        world_name: (world && world.name) || null,
        world_version_id: (version && version.id) || null,
        world_version: (version && version.version) !== undefined ? version.version : null,
        // Stated per file, because a camera position means nothing without it.
        scale_factor: (version && Number(version.scale_factor) > 0)
            ? Number(version.scale_factor) : null,
        scale_state: (version && Number(version.scale_factor) > 0)
            ? 'SCALE CALIBRATED' : 'APPROXIMATE SCALE',
        exported_at: new Date().toISOString(),
    };
}

/**
 * Build the manifest.
 *
 * `available` is per output and an unavailable one is NAMED with the reason.
 * A package that silently ships five of seven files looks complete to whoever
 * receives it, and they discover the gap at the point they need the file —
 * which is exactly the failure the export preflight already exists to prevent
 * for the NLE handover.
 */
function buildExport(ctx) {
    const o = ctx || {};
    const world = o.world || null;
    const version = o.version || null;
    const shot = o.shot || null;
    const assets = o.assets || {};              // assetKind -> { file_path, url }
    const prov = provenanceOf(world, version);

    const outputs = EXPORT_OUTPUTS.map((spec) => {
        const base = {
            id: spec.id, kind: spec.kind, filename: spec.filename,
            scope: spec.scope, why: spec.why,
            // THE RULE THIS MODULE EXISTS FOR.
            provenance: prov,
        };

        if (spec.kind === 'json') {
            const body = spec.id === 'camera_json'
                ? cameraDocument(o, prov)
                : worldDocument(o, prov);
            return Object.assign(base, { available: true, body });
        }

        const found = assets[spec.assetKind] || null;
        if (!found) {
            return Object.assign(base, {
                available: false,
                reason: reasonMissing(spec, o),
            });
        }
        if (spec.kind === 'reference') {
            return Object.assign(base, {
                available: true,
                url: found.url || found.file_path || null,
                body: { url: found.url || null, provenance: prov },
            });
        }
        return Object.assign(base, { available: true, file_path: found.file_path || null });
    });

    return {
        outputs,
        provenance: prov,
        shot_code: shot ? (shot.shot_code || null) : null,
        // Counted rather than left to the reader, and the missing ones NAMED:
        // "5 of 7" with no list is a sentence that sends somebody to a folder.
        complete: outputs.every(x => x.available),
        missing: outputs.filter(x => !x.available).map(x => x.id),
    };
}

/** Why a file is not in the package, said in terms of what to do about it. */
function reasonMissing(spec, ctx) {
    if (!ctx.version) return 'this shot has no world pinned, so there is no geometry to export';
    switch (spec.assetKind) {
        case 'plate_image': return 'no generation plate has been rendered for this shot yet';
        case 'plate_depth': return 'no depth pass has been rendered for this shot yet';
        case 'storyboard':  return 'this shot has no storyboard frame yet';
        case 'splat_full':  return 'this world version records no splat — it may predate splat capture';
        case 'collider':    return 'this world version has no collider mesh, so it was never ingested';
        default:            return 'not produced for this shot';
    }
}

/** The camera, said completely enough to be rebuilt somewhere else. */
function cameraDocument(ctx, prov) {
    const cam = (ctx.blocking && ctx.blocking.camera) || {};
    return {
        provenance: prov,
        shot_code: ctx.shot ? ctx.shot.shot_code : null,
        /*
         * IN THE WORLD VERSION'S OWN UNITS, said outright.
         *
         * A saved camera is stored in the reconstruction's units while
         * `/geometry` hands out metres, and an importer that guesses wrong
         * places the camera by a factor. The metre twin is given alongside
         * when the world has been calibrated, and is NULL — never the same
         * number — when it has not.
         */
        units: 'world units of this reconstruction',
        position: cam.position || null,
        rotation_deg: cam.rotation || null,
        focal_mm: cam.focalMm !== undefined ? cam.focalMm : null,
        sensor: cam.sensorId || null,
        f_stop: cam.fStop !== undefined ? cam.fStop : null,
        focus_distance_m: cam.focusDistanceM !== undefined ? cam.focusDistanceM : null,
        position_m: (prov.scale_factor && Array.isArray(cam.position))
            ? cam.position.map(n => n * prov.scale_factor) : null,
        movement: (ctx.blocking && ctx.blocking.moves) || null,
    };
}

/** What the world is, for whoever receives it without this database. */
function worldDocument(ctx, prov) {
    const v = ctx.version || {};
    return {
        provenance: prov,
        bounds: ctx.bounds || null,
        size: ctx.size || null,
        model: v.model || null,
        status: v.status || null,
        scale_source: v.scale_source || null,
        scale_known_m: v.scale_known_m !== undefined ? v.scale_known_m : null,
        scale_measured: v.scale_measured !== undefined ? v.scale_measured : null,
        caption: v.caption || null,
        note: prov.scale_factor
            ? 'Distances in this export are in the reconstruction\'s own units; multiply by scale_factor for metres.'
            : 'THIS WORLD HAS NO SCALE. Every distance here is in arbitrary units — nobody has measured '
              + 'a known object inside it, so none of these numbers is metres.',
    };
}

module.exports = { EXPORT_OUTPUTS, buildExport, provenanceOf, cameraDocument, worldDocument };
