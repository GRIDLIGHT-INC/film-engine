/** Persistent, non-generative media imports used by Storyboard and Previs. */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { parseGlb } = require('./glb-parser');

/*
 * What a person can actually hand us. PNG is what this engine generates; JPEG
 * is what a camera, a phone and every hosted image tool produce.
 */
const IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/jpg']);
// Production documentation, deliberately outside the two asset types selected
// by gatherShotReferences. A floor diagram must never condition a movie frame.
const ORIENTATION_ASSET_TYPE = 'other';

/*
 * What a person actually exports. Browsers label these inconsistently and some
 * label nothing at all, so octet-stream is accepted and the BYTES decide — the
 * same allowance the GLB import needed.
 */
const VIDEO_MIMES = Object.freeze([
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'application/octet-stream']);
const AUDIO_MIMES = Object.freeze([
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3',
    'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'application/octet-stream']);

/**
 * One import target per orchestrated media capability, built from the registry
 * the generator itself reads.
 *
 * Scope comes from MEDIA_KINDS (which takes it from PIPELINE_STEPS), so a
 * scene-wide music bed is scene-scoped and a clip is shot-scoped without this
 * file having an opinion — an importer that disagreed would attach a scene bed
 * to a single shot and nothing would report it.
 */
function mediaImportTargets() {
    const { MEDIA_KINDS } = require('./media-kinds');
    const out = {};
    for (const [capability, spec] of Object.entries(MEDIA_KINDS)) {
        if (spec.media === 'image') continue;      // the storyboard frame, already imported
        out[`${capability}-media`] = Object.freeze({
            kind: spec.media,                      // 'video' | 'audio'
            capability,
            shotScoped: spec.scope === 'shot',
            sceneScoped: spec.scope === 'scene',
            subdir: spec.subdir,
            serveDir: spec.serveDir,
            assetType: spec.assetType,
            ext: spec.ext,
            mimes: spec.media === 'video' ? VIDEO_MIMES : AUDIO_MIMES,
        });
    }
    return out;
}

const MEDIA_IMPORTS = Object.freeze({
    'storyboard-image': Object.freeze({
        kind: 'image', shotScoped: true, subdir: 'storyboards', mimes: ['image/png'],
        /*
         * PNG only, and this is the reason rather than an oversight: the live
         * frame lives at a FIXED path, `{project}/{shot_code}.png`, derived
         * independently in thirteen places — the board, the viewer, previs, the
         * version archive and the video pass's init_image among them. Accepting
         * a JPEG means changing every one of those or storing a JPEG under a
         * .png name, and the second is a lie a decoder will eventually call.
         *
         * Stated here so the gap cannot be quietly re-labelled as a decision:
         * a plate accepts JPEG, a storyboard frame does not YET.
         */
        pngOnly: 'the live frame is addressed as {shot_code}.png in thirteen places',
    }),
    // reference_image is already catalogued and served from refsheets by Previs.
    'previs-image': Object.freeze({
        kind: 'image', shotScoped: true, subdir: 'refsheets', mimes: ['image/png'],
        pngOnly: 'stands in the previs stage beside storyboard frames, which are PNG',
    }),
    // Previs's geometry parser and textured viewer both consume GLB. Advertising
    // formats they cannot stage would turn a successful upload into a broken picker.
    'three-d-model': Object.freeze({ kind: 'model', shotScoped: false, subdir: '3d', mimes: ['model/gltf-binary', 'application/octet-stream'] }),

    /*
     * REFERENCE PLATES, from outside.
     *
     * "Everywhere I can generate plates or boards, I should be able to upload
     * one too, say I'm working outside of film engine."
     *
     * Every reference in this pipeline could only be born inside it, which is a
     * strange constraint for a tool whose job is keeping a film consistent with
     * itself: the most authoritative picture of a place is usually a photograph
     * of it, and the most authoritative picture of a character is often the one
     * the art department already made.
     *
     * `subjectKind` links the target back to PLATE_KINDS / the character sheet,
     * so an uploaded plate lands in the same table column, under the same
     * filename, with the same per-view replacement as a generated one — which
     * is what makes gatherShotReferences pick it up without knowing where it
     * came from. A plate that lists and never reaches a payload is a picture in
     * a folder.
     *
     * JPEG as well as PNG. Everything this engine generates is PNG, so PNG was
     * the only thing the validator knew — but "outside Film Engine" means
     * Midjourney exports and phone photographs, and refusing those would make
     * the feature look broken for its most common case.
     */
    'character-plate': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: 'character', mimes: IMAGE_MIMES }),
    'location-plate': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: 'location', mimes: IMAGE_MIMES }),
    'prop-plate': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: 'prop', mimes: IMAGE_MIMES }),
    'orientation-plan': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', mimes: IMAGE_MIMES }),
    // The look has no subject table by design (KIND_SOURCE calls it `project`),
    // so a board image is stored and linked by the mood-board row instead.
    'mood-board-image': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: null, mimes: IMAGE_MIMES }),

    /*
     * THE TWO IMAGE SURFACES THAT COULD ONLY BE POINTED AT, NOT UPLOADED.
     *
     * Both `film_continuity_refs` and `film_marketing_assets` carry an
     * `image_path` column that could only be set by POSTing a STRING — a path
     * on the server's own disk. From a browser that is unusable, so in practice
     * neither surface could hold a picture at all, and both are surfaces whose
     * whole content is a picture.
     *
     * They are also the two where an upload is the NORMAL case rather than the
     * escape hatch. A continuity reference is a photograph of what was actually
     * shot. A poster is made in Photoshop — and `POST /marketing/:id/generate`
     * generates nothing at all: it sets the status to 'generating' and returns
     * a hint telling you to call an image API yourself, which it has done since
     * the day it shipped.
     */
    'continuity-ref': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: null, mimes: IMAGE_MIMES }),

    /*
     * A poster, key art or social card.
     *
     * `film_marketing_assets.image_path` had the same defect the continuity
     * board did — settable only by POSTing a path on the server's own disk —
     * and it stayed unregistered while the SPA had no marketing page at all,
     * because an import target with no control behind it reports a feature as
     * complete when nothing can reach it. The page exists now.
     */
    'marketing-asset': Object.freeze({ kind: 'image', shotScoped: false, subdir: 'refsheets', subjectKind: null, mimes: IMAGE_MIMES }),

    /*
     * FOOTAGE AND SOUND, from outside.
     *
     * "Are we able to upload videos if we generate outside... we need to be
     * able to easily add assets from external sources if we want to."
     *
     * A clip cut in Runway or Kling, dialogue recorded properly, a music bed
     * somebody licensed — every one of these could only be born inside the
     * engine, exactly as every reference could. Derived from MEDIA_KINDS, the
     * same registry the orchestrator uses to decide where a GENERATED file
     * goes, so an uploaded clip lands in the identical directory with the
     * identical asset_type and every reader picks it up unchanged.
     *
     * `image` is excluded because it arrives as the storyboard frame, which had
     * an import already and is addressed at a fixed {shot_code}.png path.
     */
    ...mediaImportTargets(),
});

function decodeDataUri(data) {
    const match = String(data || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new Error('invalid import data: expected a base64 data URI');
    return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
}

function validateBytes(spec, mime, bytes) {
    if (!spec.mimes.includes(mime)) throw new Error(`unsupported import type ${mime}`);
    if (!bytes.length) throw new Error('invalid import: empty file');
    const isPng = spec.kind === 'image'
        && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const isJpeg = spec.kind === 'image'
        && bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    if (spec.kind === 'image' && !isPng && !isJpeg) {
        throw new Error('This file is not a PNG or a JPEG. Export it as one and try again.');
    }
    /*
     * A JPEG is walked by its segment markers the way a PNG is walked by its
     * chunks. Checking only the two-byte SOI would accept any file that happens
     * to start 0xFFD8FF, and the point of validating at all is that a plate
     * which cannot be decoded later is a shot that generates with no reference
     * and no error.
     */
    if (isJpeg) {
        let offset = 2, sawFrame = false, sawScan = false;
        while (offset + 4 <= bytes.length) {
            if (bytes[offset] !== 0xFF) throw new Error('invalid JPEG: expected a segment marker');
            const marker = bytes[offset + 1];
            if (marker === 0xD9) break;                       // end of image
            if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) { offset += 2; continue; }
            const length = bytes.readUInt16BE(offset + 2);
            if (length < 2 || offset + 2 + length > bytes.length) throw new Error('invalid JPEG segment length');
            // SOF0..SOF15, skipping the four markers in that range that are not
            // start-of-frame.
            if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
                const height = bytes.readUInt16BE(offset + 5);
                const width = bytes.readUInt16BE(offset + 7);
                if (!width || !height || width * height > 100_000_000) throw new Error('invalid JPEG dimensions');
                sawFrame = true;
            }
            if (marker === 0xDA) { sawScan = true; break; }   // entropy-coded data follows
            offset += 2 + length;
        }
        if (!sawFrame || !sawScan) throw new Error('invalid or incomplete JPEG');
    }
    if (isPng) {
        let offset = 8, sawIhdr = false, sawIdat = false, sawIend = false;
        while (offset + 12 <= bytes.length) {
            const length = bytes.readUInt32BE(offset);
            const end = offset + 12 + length;
            if (end > bytes.length) throw new Error('invalid PNG chunk length');
            const type = bytes.toString('ascii', offset + 4, offset + 8);
            if (type === 'IHDR') {
                if (sawIhdr || length !== 13) throw new Error('invalid PNG header');
                const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
                if (!width || !height || width * height > 100_000_000) throw new Error('invalid PNG dimensions');
                sawIhdr = true;
            } else if (type === 'IDAT') sawIdat = true;
            else if (type === 'IEND') { sawIend = length === 0; offset = end; break; }
            offset = end;
        }
        if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) throw new Error('invalid or incomplete PNG');
    }
    /*
     * A clip and a bed are told apart by their BYTES, never their extension.
     *
     * A renamed file passes any name check, and a clip that cannot be decoded
     * is a shot that plays black in the cut — with no error anywhere, because
     * nothing downstream opens it until an editor does. Browsers also label
     * these inconsistently and sometimes not at all, which is why the mime list
     * allows octet-stream and this is what actually decides.
     */
    if (spec.kind === 'video' || spec.kind === 'audio') {
        const ascii = (from, len) => bytes.toString('ascii', from, from + len);
        const isMp4 = bytes.length > 12 && ascii(4, 4) === 'ftyp';
        const isMatroska = bytes.length > 4 && bytes[0] === 0x1A && bytes[1] === 0x45
            && bytes[2] === 0xDF && bytes[3] === 0xA3;                       // WebM / MKV
        const isRiff = bytes.length > 12 && ascii(0, 4) === 'RIFF';
        const isWav = isRiff && ascii(8, 4) === 'WAVE';
        const isMp3 = bytes.length > 3
            && (ascii(0, 3) === 'ID3' || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0));
        const isFlac = bytes.length > 4 && ascii(0, 4) === 'fLaC';
        const isOgg = bytes.length > 4 && ascii(0, 4) === 'OggS';

        if (spec.kind === 'video') {
            // An .mp4 container carries audio-only files too, but every one we
            // could receive here is meant to be a picture; a bare WAV or MP3 is
            // refused outright because attaching one as a clip is silent
            // failure at the worst possible moment.
            if (isWav || isMp3 || isFlac) {
                throw new Error('This is an audio file, not a video. Upload it where the sound goes.');
            }
            if (!isMp4 && !isMatroska) {
                throw new Error('This is not a video file. MP4, MOV, WebM and MKV are accepted — '
                    + 're-export it as one of those.');
            }
        } else {
            if (isMatroska) throw new Error('This is a video file, not audio. Upload it where the picture goes.');
            /*
             * An MP4 container holds audio-only files too, and telling them
             * apart properly means walking the moov atom for track types. The
             * brand is the cheap discriminator: .m4a and .m4b declare `M4A `
             * and `M4B `, while `isom`, `mp42`, `mp41` and `avc1` are the video
             * brands. Accepting those as audio — which an earlier version did,
             * on `mp42` — attaches a silent video file as a music bed and the
             * failure surfaces as a scene with no score.
             *
             * An audio-only `isom` file is rare and gets a clear message rather
             * than being guessed at; re-exporting as WAV or M4A is one step,
             * and a wrong guess here is a bed nobody hears.
             */
            const isM4a = isMp4 && /^(M4A|M4B)/.test(ascii(8, 4));
            if (!isWav && !isMp3 && !isFlac && !isOgg && !isM4a) {
                throw new Error('This is not an audio file. WAV, MP3, M4A, FLAC and OGG are accepted — '
                    + 're-export it as one of those.');
            }
        }
    }
    if (spec.kind === 'model') {
        if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
            || bytes.readUInt32LE(8) !== bytes.length) throw new Error('invalid GLB signature or length');
        // Validate with the same parser Previs uses. A header-only GLB or a
        // scene without drawable triangles is an upload that succeeds and a
        // stage object that can never render.
        let geometry;
        try { geometry = parseGlb(bytes); }
        catch (err) {
            /*
             * The parser's reason, kept and made actionable.
             *
             * "invalid GLB" alone is why two imports read as a broken importer:
             * the file was refused for a nameable reason (compression, an
             * external .bin, an extension) and the user was told only that it
             * did not work, on a status bar at the bottom of the screen.
             */
            throw new Error(`This GLB could not be read — ${String(err.message).replace(/^glb:\s*/, '')}.`);
        }
        if (!geometry.vertices.length || !geometry.triangles.length) {
            throw new Error('This GLB has no drawable triangle geometry — it may be a points or lines '
                + 'export, or contain only cameras and lights. Re-export it as a triangle mesh.');
        }
    }
}

/** Where a subject-scoped import belongs: its project, and the row to link to. */
function subjectOwnerFor(spec, input) {
    const { PLATE_KINDS } = require('./reference-plates');
    // Characters are not in PLATE_KINDS — they have their own three-view route —
    // so the table and link column are named here for that one kind only, and
    // read from the shared registry for the rest.
    const TABLES = {
        character: { table: 'film_characters', fkColumn: 'character_id', assetType: 'character_sheet' },
        location: PLATE_KINDS.location,
        prop: PLATE_KINDS.prop,
    };
    const t = TABLES[spec.subjectKind];
    if (!t) throw new Error(`unsupported subject kind ${spec.subjectKind}`);
    const row = require('../db/database').db
        .prepare(`SELECT id, project_id, name FROM ${t.table} WHERE id = ?`).get(input.subjectId);
    if (!row) throw new Error(`${spec.subjectKind} not found`);
    return { projectId: row.project_id, subject: row, ...t };
}

/** A scene-scoped import (a music bed, an ambient bed) belongs to a scene. */
function sceneOwnerFor(input) {
    const row = db.prepare(
        'SELECT id, project_id, scene_number FROM film_scenes WHERE id = ?').get(input.sceneId);
    if (!row) throw new Error('Scene not found');
    return { projectId: row.project_id, sceneId: row.id, sceneNumber: row.scene_number };
}

function ownerFor(target, input) {
    if (MEDIA_IMPORTS[target].shotScoped) {
        const row = db.prepare(`SELECT sh.id AS shot_id, sh.shot_code, sc.project_id
            FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id WHERE sh.id = ?`).get(input.shotId);
        if (!row) throw new Error('Shot not found');
        return { projectId: row.project_id, shotId: row.shot_id, shotCode: row.shot_code };
    }
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(input.projectId);
    if (!project) throw new Error('Project not found');
    return { projectId: project.id, shotId: null, shotCode: null };
}

function archiveCurrentStoryboard(projectId, shotId, shotCode, currentPath) {
    if (!fs.existsSync(currentPath)) return;
    const latest = db.prepare("SELECT id, version FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC LIMIT 1")
        .get(shotId);
    if (!latest) return;
    const dir = path.join(path.dirname(currentPath), 'versions');
    fs.mkdirSync(dir, { recursive: true });
    const archived = path.join(dir, `${shotCode}_v${latest.version}.png`);
    fs.copyFileSync(currentPath, archived);
    db.prepare('UPDATE film_assets SET file_path = ?, file_name = ? WHERE id = ?')
        .run(archived, path.basename(archived), latest.id);
}

function safeStem(name) {
    return path.basename(String(name || 'import'), path.extname(String(name || '')))
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'import';
}

/**
 * A reference plate supplied from outside, stored exactly where a generated one
 * would be.
 *
 * Same table column, same filename from plateFileName, same per-view
 * replacement — so gatherShotReferences picks it up without knowing where it
 * came from, and a shot naming a view gets the uploaded one for that view.
 * Anything else would be a picture that lists and never reaches a prompt.
 *
 * Deliberately NOT fingerprinted. artefact-fingerprint stamps a plate with the
 * payload it was generated from; this one was not generated from anything, so
 * stamping it would mark it stale the moment somebody edits the subject's
 * description and ask the director to regenerate over their own photograph.
 * NULL means "outside the workflow", which is precisely what an upload is —
 * the same explicit exception a recomposed frame documents.
 */
function importSubjectPlate(spec, target, input) {
    const { plateFileName } = require('./reference-plates');
    const owner = subjectOwnerFor(spec, input);
    const { mime, bytes } = decodeDataUri(input.data);
    validateBytes(spec, mime, bytes);

    const view = String(input.view || '').trim();
    const kindForName = spec.subjectKind === 'character' ? 'character' : spec.subjectKind;
    /*
     * A character sheet is named per VIEW (front/side/back) by its own route,
     * and a plate is named per view by plateFileName. One naming rule for both,
     * or an uploaded front view lands beside the generated one instead of
     * replacing it and the gather picks whichever is newest.
     */
    const generatedName = spec.subjectKind === 'character'
        ? `${String(owner.subject.name || 'character').replace(/[^a-zA-Z0-9_-]/g, '_')}_${view || 'front'}.png`
        : plateFileName(kindForName, owner.subject.name, view);

    /*
     * The extension follows the BYTES.
     *
     * plateFileName always ends `.png` because everything this engine generates
     * is a PNG. Writing an uploaded JPEG under that name is the same lie the
     * storyboard target refuses to tell: the file decodes by sniffing and fails
     * anywhere that trusts the name.
     */
    const stem = generatedName.replace(/\.png$/i, '');
    const fileName = `${stem}.${mime === 'image/png' ? 'png' : 'jpg'}`;

    /*
     * Replace THIS view, never the whole set — the reason a location could only
     * ever have one plate in the first place — and replace it across
     * EXTENSIONS. Scoped to the exact filename, an uploaded JPEG would land
     * beside the generated PNG of the same view rather than replacing it, and
     * the gather would pick whichever row came back first.
     */
    const stale = db.prepare(
        `SELECT id, file_path FROM film_assets
          WHERE project_id = ? AND ${owner.fkColumn} = ? AND asset_type = ?
            AND (file_name = ? OR file_name = ? OR file_name = ?)`)
        .all(owner.projectId, owner.subject.id, owner.assetType,
            `${stem}.png`, `${stem}.jpg`, `${stem}.jpeg`);

    const filePath = saveFile(owner.projectId, spec.subdir, fileName, bytes);

    for (const row of stale) {
        // Never unlink the file we have just written — a re-upload of the same
        // format resolves to the same path.
        if (row.file_path && path.resolve(row.file_path) !== path.resolve(filePath)) {
            try { fs.unlinkSync(row.file_path); } catch (_) { /* already gone is fine */ }
        }
        db.prepare('DELETE FROM film_assets WHERE id = ?').run(row.id);
    }

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, ${owner.fkColumn}, asset_type, file_path, file_name, format, mime_type,
         size_bytes, version, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(assetId, owner.projectId, owner.subject.id, owner.assetType,
            filePath, fileName, mime === 'image/png' ? 'png' : 'jpg', mime, bytes.length,
            JSON.stringify({
                kind: `${kindForName}_plate`,
                imported: true,           // so it never looks generated
                style_applied: false,     // the film's look was not applied to it
                ...(view ? { view } : {}),
            }));

    return {
        target, asset_id: assetId, project_id: owner.projectId,
        subject_id: owner.subject.id, subject: owner.subject.name,
        view: view || null, file_name: fileName, file_path: filePath, version: 1,
        // NOT busted: this url is resolved back to a path on disk by the
        // import contract, and a query string makes that lookup fail. An
        // import lands under a new name anyway, so there is no stale copy.
        url: getFileUrl(spec.subdir, owner.projectId, fileName),
        note: 'Uploaded, not generated: the film\u2019s style preset was not applied to it, and it is '
            + 'not tracked against the description, so editing that description will not mark it stale.',
    };
}

/**
 * A clip or a bed made outside Film Engine, stored where a generated one goes.
 *
 * Same directory, same asset_type, same filename convention as the
 * orchestrator's own output — read from MEDIA_KINDS rather than restated — so
 * the timeline, the conform, the NLE export and the QA checks all pick it up
 * without knowing it was uploaded.
 *
 * NOT fingerprinted, for the reason an uploaded plate is not: a fingerprint
 * says "generated from that payload", and this was not. Stamping it would mark
 * it stale the moment the scene card changes and tell the director to
 * regenerate over footage they shot.
 */
function importCapabilityMedia(spec, target, input) {
    const owner = spec.sceneScoped ? sceneOwnerFor(input) : ownerFor(target, input);
    const { mime, bytes } = decodeDataUri(input.data);
    validateBytes(spec, mime, bytes);

    /*
     * The extension follows the BYTES, not the registry's default.
     *
     * MEDIA_KINDS says a clip is written as .mp4 because that is what the
     * generators return. A director uploading a .mov or a .webm must not have
     * it stored under a name that lies about it — the mistake the plate upload
     * made with JPEG, and the one the storyboard target refuses to make.
     */
    const ext = extensionFor(spec, mime, bytes) || spec.ext;
    const label = spec.shotScoped
        ? owner.shotCode
        : `scene_${String(owner.sceneNumber || 'x').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const stem = `${label}_${spec.capability}`;
    const fileName = `${stem}.${ext}`;

    /*
     * Replace the same slot across extensions, exactly as a plate does: an
     * uploaded .mov landing beside a generated .mp4 leaves two current clips
     * for one shot and the readers pick whichever row comes back first.
     */
    const scopeColumn = spec.shotScoped ? 'shot_id' : 'scene_id';
    const scopeValue = spec.shotScoped ? owner.shotId : owner.sceneId;
    const stale = db.prepare(
        `SELECT id, file_path, file_name FROM film_assets
          WHERE project_id = ? AND ${scopeColumn} = ? AND asset_type = ?`)
        .all(owner.projectId, scopeValue, spec.assetType)
        .filter(r => String(r.file_name || '').startsWith(`${stem}.`)
            || String(r.file_path || '').includes(`${path.sep}${stem}.`));

    const filePath = saveFile(owner.projectId, spec.subdir, fileName, bytes);
    for (const row of stale) {
        if (row.file_path && path.resolve(row.file_path) !== path.resolve(filePath)) {
            try { fs.unlinkSync(row.file_path); } catch (_) { /* already gone is fine */ }
        }
        db.prepare('DELETE FROM film_assets WHERE id = ?').run(row.id);
    }

    /*
     * How long it actually is, measured once, here.
     *
     * The timeline held every clip for the duration its CARD asked for, so a
     * ten-second upload played for four seconds and cut to the next still.
     * Measured at import rather than probed at assembly, because the timeline
     * repaints on every scrub and a subprocess in that loop is not a fix.
     *
     * Failure is silent BY DESIGN: a clip that will not probe is still a clip
     * the director paid for and wants on the board, and it falls back to the
     * card's duration exactly as before. The same rule stampAsset documents.
     */
    let durationMs = 0;
    if (spec.kind === 'video' || spec.kind === 'audio') {
        try { durationMs = measureDurationMs(filePath); } catch (_) { durationMs = 0; }
    }

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, format, mime_type,
         size_bytes, duration_ms, version, license_source, license_status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'external', 'unknown', ?)`)
        .run(assetId, owner.projectId,
            spec.shotScoped ? owner.shotId : null,
            spec.sceneScoped ? owner.sceneId : (owner.sceneId || null),
            spec.assetType, filePath, fileName, ext, mime, bytes.length, durationMs,
            JSON.stringify({
                capability: spec.capability,
                imported: true,
                source: 'external',
                original_name: String(input.name || '').slice(0, 200) || null,
            }));

    return {
        target, asset_id: assetId, project_id: owner.projectId,
        shot_id: spec.shotScoped ? owner.shotId : null,
        scene_id: spec.sceneScoped ? owner.sceneId : null,
        asset_type: spec.assetType, capability: spec.capability,
        duration_ms: durationMs,
        file_name: fileName, file_path: filePath, version: 1,
        /*
         * The SERVING subdir, which is `subdir` and not `serveDir`.
         *
         * `serveDir` is what persistProviderMedia calls the gateway's own
         * directory ('videos', 'audio', 'music'); the HTTP route is
         * /film/{subdir}/... — /film/video/, singular. Built from serveDir this
         * returned /film/videos/... which is a perfectly good string and a 404,
         * so the upload succeeded and the clip would not play. Exactly the
         * mistake servedUrlFor made once already, which is why the test now
         * FETCHES this URL rather than asserting it is non-null.
         */
        // NOT busted: this url is resolved back to a path on disk by the
        // import contract, and a query string makes that lookup fail. An
        // import lands under a new name anyway, so there is no stale copy.
        url: getFileUrl(spec.subdir, owner.projectId, fileName),
        note: `Stored as ${spec.assetType}, exactly where a generated one goes. It is marked as `
            + 'coming from outside, so editing the scene card will not tell you to regenerate over it. '
            + "Its rights are recorded as unknown \u2014 set them before you deliver.",
    };
}

/**
 * The real length of a media file, in milliseconds.
 *
 * Read from the encoder rather than from any header we parse ourselves: a
 * duration decoded from an MP4 header we wrote a reader for would be wrong for
 * exactly the containers we did not anticipate, and a wrong duration is worse
 * than none — it silently truncates a clip in the cut.
 */
function measureDurationMs(filePath) {
    const { resolveFfmpeg } = require('./ffmpeg');
    const found = resolveFfmpeg();
    if (!found.available) return 0;
    /*
     * spawnSync, and stderr read on BOTH paths.
     *
     * The first version ran `-f null -` inside a try/catch and read stderr only
     * from the thrown error — but that command SUCCEEDS, exits 0, and never
     * throws, so the duration was silently 0 every time and every clip fell
     * back to the card's guess: the exact fault this function exists to fix.
     * It passed the suite because no test measured a real file.
     *
     * `-i <file>` with no output is the idiom: ffmpeg prints the container's
     * duration and exits non-zero for want of an output file. Reading stderr
     * regardless of the exit code means neither outcome can hide it again.
     */
    const { spawnSync } = require('child_process');

    /*
     * A FAILED SPAWN IS NOT A DURATION OF ZERO.
     *
     * Under load — several imports at once, or a machine already running
     * encodes — spawnSync can come back with an error and no output at all
     * (EAGAIN when the process table is under pressure). Reading stderr from
     * that gives '', the regex finds nothing, and the clip silently falls back
     * to the card's guess: exactly the fault this function exists to fix,
     * reappearing only when the machine is busy.
     *
     * Found because the test passed alone and failed roughly one run in two in
     * the full suite. Retried rather than trusted, and the two outcomes are
     * kept distinct: a file with genuinely no duration measures 0 on the first
     * try, while a spawn that did not happen is tried again.
     */
    const probeOnce = () => spawnSync(found.bin, ['-hide_banner', '-i', filePath], {
        encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    let run = probeOnce();
    for (let attempt = 0; attempt < 2 && run && run.error && !run.stderr; attempt += 1) {
        // A short synchronous pause: this runs during an import, not in a loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        run = probeOnce();
    }
    const out = String((run && run.stderr) || '');
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    if (!m) return 0;
    return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** The extension the bytes actually justify. */
function extensionFor(spec, mime, bytes) {
    const ascii = (from, len) => bytes.toString('ascii', from, from + len);
    if (spec.kind === 'video') {
        // WebM and Matroska share the EBML header; the browser's declared MIME
        // is the only distinction available without walking the whole header.
        // Saving an MKV as .webm asks browsers/editors to use the wrong demuxer.
        if (bytes.length > 4 && bytes[0] === 0x1A && bytes[1] === 0x45) {
            return mime === 'video/x-matroska' ? 'mkv' : 'webm';
        }
        if (bytes.length > 12 && ascii(4, 4) === 'ftyp') {
            return /^qt/.test(ascii(8, 4)) ? 'mov' : 'mp4';
        }
        return null;
    }
    if (spec.kind === 'audio') {
        if (bytes.length > 12 && ascii(0, 4) === 'RIFF') return 'wav';
        if (bytes.length > 4 && ascii(0, 4) === 'fLaC') return 'flac';
        if (bytes.length > 4 && ascii(0, 4) === 'OggS') return 'ogg';
        if (bytes.length > 12 && ascii(4, 4) === 'ftyp') return 'm4a';
        if (bytes.length > 3 && (ascii(0, 3) === 'ID3' || bytes[0] === 0xFF)) return 'mp3';
        return null;
    }
    return null;
}

function importMedia(target, input) {
    const spec = MEDIA_IMPORTS[target];
    if (!spec) throw new Error(`unsupported import target ${target}`);
    // A board image belongs to the PROJECT — the look has no subject table by
    // design (KIND_SOURCE calls it `project`) — so it falls through to the
    // ordinary project-scoped path below.
    if (spec.subjectKind) return importSubjectPlate(spec, target, input || {});
    // Footage and sound, landing where the orchestrator would have written it.
    if (spec.capability) return importCapabilityMedia(spec, target, input || {});
    const owner = ownerFor(target, input || {});
    const { mime, bytes } = decodeDataUri(input && input.data);
    validateBytes(spec, mime, bytes);

    const imageFormat = /^image\/jpe?g$/i.test(mime) ? 'jpg' : 'png';
    const storedFormat = spec.kind === 'model' ? 'glb' : spec.kind === 'image' ? imageFormat : spec.kind;
    let filename;
    if (target === 'storyboard-image') filename = `${owner.shotCode}.png`;
    else filename = `${safeStem(input.name)}_${generateId().slice(0, 8)}.${storedFormat}`;

    const prospective = path.join(require('./file-storage').DATA_DIR, spec.subdir, owner.projectId, filename);
    if (target === 'storyboard-image') archiveCurrentStoryboard(owner.projectId, owner.shotId, owner.shotCode, prospective);
    const filePath = saveFile(owner.projectId, spec.subdir, filename, bytes);

    const prior = target === 'storyboard-image'
        ? db.prepare("SELECT MAX(version) AS version FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'").get(owner.shotId)
        : null;
    const version = prior && prior.version ? prior.version + 1 : 1;
    const assetId = generateId();
    const assetType = target === 'storyboard-image' ? 'storyboard'
        : target === 'previs-image' ? 'reference_image'
        : target === 'orientation-plan' ? ORIENTATION_ASSET_TYPE : 'other';
    const metadata = target === 'three-d-model'
        ? { kind: 'model_3d', subject_kind: 'imported', subject_name: safeStem(input.name), imported: true }
        : target === 'orientation-plan'
            ? { kind: 'orientation_plan', location_id: input.locationId, imported: true }
        : { kind: target === 'previs-image' ? 'previs_image' : 'storyboard_import', imported: true };
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, location_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(assetId, owner.projectId, owner.shotId,
            target === 'orientation-plan' ? input.locationId : null,
            assetType, filePath, filename,
            storedFormat, mime, bytes.length, version, JSON.stringify(metadata));

    if (target === 'orientation-plan') {
        // The new row/file is durable before the prior scan is archived. A
        // failed upload can therefore never destroy the only plan somebody had.
        require('./orientation-plans').replaceOrientationPlan(input.locationId, assetId);
    }

    if (target === 'storyboard-image') {
        db.prepare('UPDATE film_shots SET current_frame_version = NULL WHERE id = ?').run(owner.shotId);
    }
    return {
        target, asset_id: assetId, project_id: owner.projectId, shot_id: owner.shotId,
        file_name: filename, file_path: filePath, version,
        url: getFileUrl(spec.subdir, owner.projectId, filename),
    };
}

module.exports = { MEDIA_IMPORTS, ORIENTATION_ASSET_TYPE, importMedia, decodeDataUri, validateBytes, measureDurationMs };
