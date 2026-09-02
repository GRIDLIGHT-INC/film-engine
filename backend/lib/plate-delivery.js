/**
 * Filing a plate, from either road that produces one — and adopting the ones
 * that were produced before this existed.
 *
 * A plate arrives one of two ways. The generate route polls the provider and
 * gets bytes back; or the call outruns the host window, the handle is written
 * down, and the bytes are fetched later by `generation_collect`. Only the FIRST
 * road knew how to file one. The second wrote `collected_<job>.png` into the
 * storyboards directory and stopped.
 *
 * The cost of that is not abstract. One afternoon on this production left NINE
 * finished, billed reference pictures on disk named after job ids — including
 * two that were BETTER than the plates actually in use, which nobody could have
 * known, because nothing in the app pointed at them. `has_plate` read false,
 * the gallery showed nothing, the director was told the generation failed, and
 * the obvious response — generate it again — buys the same picture twice.
 *
 * So there are two things here, and the second is the one that was missing:
 *
 *   fileSubjectPlate  — one filing rule, for characters, locations and props,
 *                       called by the live road and the collect road alike.
 *   adoptFile         — take a picture that is already on disk and make it the
 *                       plate it was always meant to be.
 *
 * `sequence-delivery` closes exactly this hole for a sequence leg. A plate is
 * not a lesser artefact and should not have needed a second discovery.
 *
 * Lazily requires the database, because lib modules are loaded by tests that
 * never open one.
 */

const fs = require('fs');
const path = require('path');

/**
 * What `generation_collect` needs to know a job was a plate.
 *
 * Recorded onto the handle at generate time under this key. The adapter
 * contributes the capability — `image` — which is equally true of a keyframe, a
 * mood board and a plate, so it cannot say where the bytes belong. Only the
 * caller knows that, and this is the shape it says it in.
 */
const JOB_META_KEY = 'character_plate';

/** How each kind links to its subject. Mirrors reference-plates.PLATE_KINDS. */
const LINK = {
    character: { fk: 'character_id', assetType: 'character_sheet', stamp: 'character_plate', idKey: 'charId' },
    location:  { fk: 'location_id',  assetType: 'reference_image', stamp: 'location_plate',  idKey: 'locId' },
    prop:      { fk: 'prop_id',      assetType: 'reference_image', stamp: 'prop_plate',      idKey: 'propId' },
};

function jobMeta({ projectId, characterId, characterName, view, styleApplied }) {
    return {
        [JOB_META_KEY]: {
            project_id: projectId || null,
            character_id: characterId || null,
            character_name: characterName || '',
            view: view || '',
            style_applied: styleApplied !== false,
        },
    };
}

/**
 * The name a plate is written to, and overwrites.
 *
 * Deliberately the SAME name the live road uses, per kind — a plate is the
 * current picture of one view of one subject, so a second copy under a second
 * name is a second answer to a question that has one.
 */
function plateFileName(kind, subjectName, view) {
    const safe = String(subjectName || kind).replace(/[^a-zA-Z0-9_-]/g, '_');
    const v = String(view || '').trim();
    if (kind === 'character') return `${safe}_${v || 'front'}.png`;
    if (!v) return `${kind}_${safe}.png`;
    const safeView = v.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48).replace(/_+$/, '');
    return `${kind}_${safe}__${safeView}.png`;
}

/** The subject's row and name, so a caller only has to know its id. */
function subjectOf(kind, subjectId) {
    const { db } = require('../db/database');
    const table = kind === 'character' ? 'film_characters'
        : kind === 'location' ? 'film_locations'
        : kind === 'prop' ? 'film_props' : null;
    if (!table) return null;
    try { return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(subjectId) || null; }
    catch (_) { return null; }
}

/**
 * Store the bytes and register the row.
 *
 * `data` is whatever the adapter handed back — a Buffer, or a result object
 * carrying a URL. `persistProviderMedia` is the one funnel that understands
 * both, which is why it is asked rather than the raw file writer.
 */
async function fileSubjectPlate({
    kind, projectId, subjectId, subjectName, view,
    data, provider, providerModel, providerJobId, styleApplied,
    collectedFromJob,
}) {
    const link = LINK[kind];
    if (!link) return { ok: false, error: `unknown plate kind '${kind}'` };
    if (!projectId || !subjectId) return { ok: false, error: `a ${kind} plate needs a project and a subject` };

    const { db, generateId } = require('../db/database');
    const { persistProviderMedia } = require('./provider-media');
    const { getFileUrl, ensureDir } = require('./file-storage');

    if (!subjectName) {
        const row = subjectOf(kind, subjectId);
        subjectName = (row && row.name) || kind;
    }
    const v = kind === 'character' ? String(view || 'front') : String(view || '');
    const fileName = plateFileName(kind, subjectName, v);

    ensureDir(projectId, 'refsheets');
    let filePath;
    try {
        filePath = await persistProviderMedia(projectId, 'refsheets', fileName, data, { serveDir: 'images' });
    } catch (err) {
        return { ok: false, error: `plate arrived and could not be stored: ${err.message}` };
    }

    /*
     * A REGENERATED VIEW REPLACES ITS ROW — the rule the live road already
     * follows, restated here rather than skipped, because a collected plate
     * that appends instead of replacing leaves two rows for one file and "the
     * plate" becomes whichever the query returns first.
     */
    const stale = kind === 'character'
        ? db.prepare(
            `SELECT id FROM film_assets
              WHERE project_id = ? AND character_id = ?
                AND asset_type IN ('character_sheet', 'reference_image')
                AND COALESCE(json_extract(metadata, '$.view'), 'front') = ?`).all(projectId, subjectId, v)
        : db.prepare(
            `SELECT id FROM film_assets
              WHERE project_id = ? AND ${link.fk} = ? AND asset_type = ?
                AND file_name = ?`).all(projectId, subjectId, link.assetType, fileName);
    for (const old of stale) db.prepare('DELETE FROM film_assets WHERE id = ?').run(old.id);

    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (
            id, project_id, ${link.fk}, asset_type, file_path, file_name, format, mime_type,
            version, metadata, provider, provider_model, provider_job_id, license_source, license_status
         )
         VALUES (?, ?, ?, ?, ?, ?, 'png', 'image/png', 1, ?, ?, ?, ?, 'generated', 'generated')`
    ).run(
        assetId, projectId, subjectId, link.assetType,
        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '',
        fileName,
        JSON.stringify({
            ...(kind === 'character' ? { character_id: subjectId } : { kind: `${kind}_plate` }),
            ...(v ? { view: v } : {}),
            ...(styleApplied === false ? { style_applied: false } : {}),
            // A plate that came back late is worth being able to trace to the
            // handle it came back on.
            ...(collectedFromJob ? { collected_from_job: collectedFromJob } : {}),
        }),
        provider || '', providerModel || '', providerJobId || ''
    );

    // Stamped, or a plate made from a description that has since changed looks
    // valid forever and nothing says otherwise.
    try {
        require('./artefact-fingerprint').stampAsset(assetId, link.stamp, { [link.idKey]: subjectId });
    } catch (_) { /* bookkeeping never fails the delivery it is keeping books on */ }

    return {
        ok: true,
        kind,
        subject_id: subjectId,
        view: v || null,
        asset_id: assetId,
        file_name: fileName,
        file_path: typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '',
        // Busted, because a plate overwrites its own filename: without this the
        // page shows the picture that was just replaced.
        image_url: getFileUrl('refsheets', projectId, fileName, Date.now()),
    };
}

/** The character-only shape the refsheet route calls. */
function fileCharacterPlate(args) {
    return fileSubjectPlate(Object.assign({ kind: 'character' }, args, {
        subjectId: args.characterId || args.subjectId,
        subjectName: args.characterName || args.subjectName,
    }));
}

/**
 * Adopt a picture that is ALREADY ON DISK.
 *
 * The recovery path, and deliberately not a re-poll: a handle collected hours
 * ago has bytes sitting in `storyboards/collected_<job>.png`, and asking the
 * provider for them again depends on a retention window nobody here controls.
 * The file is the evidence. Read it, file it, and the orphan stops being one.
 *
 * Used by `generation_collect` when a caller names what an untagged job was
 * for, and callable directly for a file that has no handle at all.
 */
async function adoptFile({ filePath, kind, projectId, subjectId, view, provider, providerModel, providerJobId, collectedFromJob }) {
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: `no file at ${filePath}` };
    }
    let data;
    try { data = fs.readFileSync(filePath); }
    catch (err) { return { ok: false, error: `could not read ${path.basename(filePath)}: ${err.message}` }; }

    return fileSubjectPlate({
        kind, projectId, subjectId, view, data,
        provider, providerModel, providerJobId, collectedFromJob,
    });
}

module.exports = {
    JOB_META_KEY, LINK, jobMeta, plateFileName, subjectOf,
    fileSubjectPlate, fileCharacterPlate, adoptFile,
};
