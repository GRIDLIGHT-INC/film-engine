/**
 * Sequences: several shots, ordered, generated as one continuous move.
 *
 *   GET|POST   /film/projects/:id/sequences
 *   GET|PUT|DELETE /film/sequences/:id
 *   GET        /film/sequences/:id/plan       — free: what it would send and cost
 *   POST       /film/sequences/:id/generate   — spends
 *   POST       /film/sequences/:id/import     — a clip made elsewhere
 *
 * The plan is FREE and separate from the generate, on the same reasoning as the
 * run plan and the prompt preview: this is the one control that can spend
 * several generations in a press, and a confirmation that cannot name what it
 * is about to buy teaches people to click past it.
 */

const { db, generateId } = require('../db/database');
const { imageOverride } = require('../lib/generation-override');
// The strip: what a shot's stations are, and what a model documents room for.
const { expandShots } = require('../lib/inbetweens');
const { contractFor } = require('../lib/video-reference');
const { loadShotMotion } = require('../lib/shot-motion');
const { runStrip, stripFingerprint, approvalState } = require('../lib/inbetween-run');

/**
 * The config a sequence generation should resolve against.
 *
 * A sequence buys several clips at once, so which generator makes them is the
 * same per-generation choice a single clip has — read through the one helper
 * every other paid path uses rather than a second reading of the same fields.
 */
function seqConfig(projectId, req) {
    const base = providerConfigFor(projectId);
    const o = imageOverride((req && req.body) || {});
    if (!o || !o.image) return base;
    return { ...base, video: o.image };
}
const { resolve } = require('../lib/providers');
const { providerConfigFor } = require('../lib/provider-config');
const { planSequence } = require('../lib/video-sequence');
const { importMedia } = require('../lib/media-imports');
const { persistProviderMedia } = require('../lib/provider-media');
const { getFileUrl } = require('../lib/file-storage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function parseIds(row) {
    try { const v = JSON.parse(row.shot_ids || '[]'); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}

function sequenceFileName(sequenceId, from, to) {
    const safe = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'shot';
    return `sequence_${safe(String(sequenceId || '').slice(0, 8))}_${safe(from)}_${safe(to)}.mp4`;
}

/** Validate the ordered shot list at the write boundary, before it can drift projects. */
function validShotIds(projectId, input) {
    const ids = Array.isArray(input) ? input.filter(x => typeof x === 'string') : [];
    if (!ids.length) return { error: 'Pick at least one shot for the sequence' };
    if (new Set(ids).size !== ids.length) return { error: 'A shot can appear only once in a sequence' };
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT sh.id
        FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
        WHERE sc.project_id = ? AND sh.id IN (${placeholders})`).all(projectId, ...ids);
    if (rows.length !== ids.length) {
        return { error: 'Every selected shot must exist in this project' };
    }
    return { ids };
}

/**
 * The shots this sequence travels through, IN THE ORDER THE DIRECTOR PUT THEM.
 *
 * Never in table order: a sequence is a statement about play order, and sorting
 * by anything else silently reorders the move. Each carries the picture that is
 * currently SHOWN for that shot — its selected version, not the newest — which
 * is the rule every other surface follows.
 */
function shotsOf(row) {
    const ids = parseIds(row);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
        `SELECT sh.id, sh.shot_code, sh.scene_card_yaml, sh.current_frame_version, sh.duration_ms,
                sc.project_id
           FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
          WHERE sh.id IN (${placeholders})`).all(...ids);
    const byId = new Map(found.map(s => [s.id, s]));

    return ids.map(id => {
        const shot = byId.get(id);
        if (!shot) return { id, shot_code: id.slice(0, 8), keyframe: null, missing: true };
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
        const frame = db.prepare(
            `SELECT file_path, version FROM film_assets
              WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
              ORDER BY version DESC`).all(shot.id);
        const chosen = shot.current_frame_version
            ? frame.find(f => f.version === shot.current_frame_version) || frame[0]
            : frame[0];
        return {
            id: shot.id,
            shot_code: shot.shot_code,
            description: String(card.description || card.action || '').slice(0, 300),
            duration_ms: Number(shot.duration_ms) || Number(card.duration_ms) || 5000,
            keyframe: chosen ? chosen.file_path : null,
        };
    });
}

/**
 * How many stills this project's video provider can be pinned to.
 *
 * The catch here used to swallow EVERYTHING and return 1, which is the failure
 * this whole feature is about: a wiring mistake became "this provider takes one
 * keyframe", the plan silently degraded to a series of stills, and the only
 * symptom was a sequence that produced N segments where it should have produced
 * N-1. A provider that genuinely cannot be resolved is reported as unresolved
 * rather than described as limited.
 */
function keyframeCeiling(projectId, req) {
    let adapter = null;
    try {
        // `req` is optional: the ceiling is also read from paths that have no
        // request in hand. Passing an undefined one resolves against the
        // project's own config, which is the right default.
        adapter = resolve('video', seqConfig(projectId, req));
    } catch (err) {
        return { max: 1, provider: null, unresolved: err.message };
    }
    if (!adapter) return { max: 1, provider: null, unresolved: 'no video provider is configured' };
    return {
        max: Math.max(1, Number(adapter.maxKeyframes) || 1),
        provider: adapter.id,
        // An adapter that declares nothing is held at one, and says so, because
        // silently assuming two sends a destination the endpoint ignores.
        ...(adapter.maxKeyframes ? {} : { undeclared: true }),
    };
}

function listSequences(res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_sequences WHERE project_id = ? ORDER BY created_at').all(projectId);
    return json(res, 200, {
        project_id: projectId,
        sequences: rows.map(r => ({
            ...r, shot_ids: parseIds(r),
            shots: shotsOf(r).map(s => ({ id: s.id, shot_code: s.shot_code, has_keyframe: !!s.keyframe })),
        })),
    });
}

function createSequence(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const body = req.body || {};
    const checked = validShotIds(projectId, body.shot_ids);
    if (checked.error) return json(res, 400, { error: checked.error });
    const ids = checked.ids;

    const id = generateId();
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description)
                VALUES (?, ?, ?, ?, ?)`)
        .run(id, projectId, String(body.name || '').slice(0, 200),
            JSON.stringify(ids), String(body.description || '').slice(0, 2000));
    return json(res, 201, { sequence: db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id) });
}

function updateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const body = req.body || {};
    // Merged, not replaced: renaming a sequence must not silently drop the
    // description someone spent time on, the rule PUT /shots/:id already sets.
    const checked = body.shot_ids !== undefined ? validShotIds(row.project_id, body.shot_ids) : null;
    if (checked && checked.error) return json(res, 400, { error: checked.error });
    const next = {
        name: body.name !== undefined ? String(body.name).slice(0, 200) : row.name,
        shot_ids: checked ? JSON.stringify(checked.ids) : row.shot_ids,
        description: body.description !== undefined
            ? String(body.description).slice(0, 2000) : row.description,
    };
    db.prepare(`UPDATE film_sequences SET name = ?, shot_ids = ?, description = ?,
                updated_at = datetime('now') WHERE id = ?`)
        .run(next.name, next.shot_ids, next.description, id);
    return json(res, 200, { sequence: db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id) });
}

/*
 * -- The strip ---------------------------------------------------------------
 *
 * A shot reaches a provider as ONE picture and a sentence, so on a five-second
 * push-in seconds two, three and four are the model's opinion, and the model's
 * opinion is what drifts. A strip is a station per second, derived from the
 * shot's own camera blocking, reviewable and fixable before any video is bought.
 *
 * There is no second pipeline here. planSequence operates on an ORDERED LIST
 * and does not know its entries are shots, so a denser list flows through
 * buildSegment, the segment loop and the stitch unchanged.
 */

/** The station cap this project's model documents room for. Never a literal. */
function stationCeiling(projectId, req) {
    const ceiling = keyframeCeiling(projectId, req);
    let model = null;
    if (ceiling.provider === 'runway') {
        model = process.env.RUNWAY_VIDEO_MODEL || 'gen4.5';
    }
    const contract = contractFor(model);
    return { max: contract.maxImages, model, contract, why: contract.why };
}

/** Every station of this sequence that has already been generated. */
function stationAssets(projectId, sequenceId) {
    const rows = db.prepare(`
        SELECT id, file_path, metadata FROM film_assets
         WHERE project_id = ?
           AND json_extract(metadata, '$.sequence_id') = ?
           AND json_extract(metadata, '$.station_index') IS NOT NULL
      ORDER BY json_extract(metadata, '$.shot_id'),
               json_extract(metadata, '$.station_index'),
               created_at DESC`).all(projectId, sequenceId);
    const byShot = {};
    for (const r of rows) {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        const shotId = meta.shot_id;
        const idx = Number(meta.station_index);
        if (!shotId || !Number.isFinite(idx)) continue;
        byShot[shotId] = byShot[shotId] || {};
        // Newest first, so the most recent generation of a station wins.
        if (!byShot[shotId][idx]) {
            byShot[shotId][idx] = { asset_id: r.id, image_path: r.file_path, instruction: meta.instruction || null };
        }
    }
    return byShot;
}

/**
 * The strip for a sequence, with what already exists filled in.
 *
 * One reader, used by the plan, the run, the edit and the approval, so those
 * four cannot come to different answers about how many stations a shot has.
 */
function stripFor(row, opts) {
    const o = opts || {};
    const shots = shotsOf(row);
    const ceiling = stationCeiling(row.project_id, o.req);
    const expanded = expandShots(shots, shot => {
        try { return loadShotMotion(shot.id); } catch (_) { return null; }
    }, { cadenceSeconds: o.cadenceSeconds, maxStations: ceiling.max });

    const have = stationAssets(row.project_id, row.id);
    // Station 0 is the shot's own approved frame; the rest are filled from what
    // has been generated, so an ungenerated station stays honestly empty.
    expanded.stations.forEach(st => {
        if (st.station.index === 0) return;
        const made = (have[st.shot_id] || {})[st.station.index];
        if (made) { st.keyframe = made.image_path; st.asset_id = made.asset_id; }
    });
    return { shots, ceiling, expanded, have };
}

/** Flatten a strip into the ordered station list an approval fingerprints. */
function stationList(expanded) {
    return expanded.stations.map(st => ({
        shot_id: st.shot_id,
        index: st.station.index,
        asset_id: st.asset_id || null,
        instruction: st.station.instruction || null,
    }));
}

/*
 * -- Generating the strip ---------------------------------------------------
 */

/** Where a station's picture lives. Never the shot's own frame. */
function stationPath(projectId, shotCode, index) {
    const path_ = require('path');
    const { ensureStoryboardDir } = require('./storyboard');
    return path_.join(ensureStoryboardDir(projectId), `${shotCode}.s${index}.png`);
}

/**
 * Walk the strips and buy the pictures.
 *
 * Serial by construction: each station is refined from the one before it, so
 * there is nothing to parallelise without breaking the chain that is the whole
 * point. Stops at the first refusal and names what it did not attempt.
 */
async function runInbetweens(req, res, id, opts) {
    const o = opts || {};
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const body = (req && req.body) || {};
    const strip = stripFor(row, { cadenceSeconds: Number(body.cadence_s) || undefined, req });
    const { generateRefinedFrame, registerStoryboardAsset } = require('./storyboard');
    const fs_ = require('fs');

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const shotsById = new Map(strip.shots.map(sh => [sh.id, sh]));

    const results = [];
    for (const stripPlan of strip.expanded.strips) {
        const shot = shotsById.get(stripPlan.shot_id);
        if (!shot) continue;
        if (!shot.keyframe) {
            /*
             * Refused by name, never skipped. A strip built around a shot with
             * no approved frame joins through a moment nobody has seen, which
             * looks exactly like a success.
             */
            results.push({ shot_id: shot.id, shot_code: shot.shot_code, refused: true,
                reason: 'This shot has no generated frame — a strip starts from the picture you approved.' });
            continue;
        }
        const dbShot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shot.id);
        const out = await runStrip(stripPlan, {
            keyframePath: shot.keyframe,
            existing: strip.have[shot.id] || {},
            fromIndex: (o.shotId === shot.id && Number.isFinite(o.fromIndex)) ? o.fromIndex : undefined,
            refine: async ({ instruction, reference, station }) => {
                const { buffer, provider, model } = await generateRefinedFrame({
                    project, shot: dbShot, reference: { uri: null, path: reference, name: shot.shot_code },
                    instruction,
                });
                const file = stationPath(project.id, shot.shot_code, station.index);
                fs_.writeFileSync(file, buffer);
                const asset = registerStoryboardAsset(project.id, shot.id, file,
                    `${shot.shot_code}.s${station.index}.png`, {
                        provider, provider_model: model,
                        instruction,
                        // What this picture IS: a station of this sequence's
                        // strip, at this moment, refined from the one before it.
                        sequence_id: id,
                        shot_id: shot.id,
                        station_index: station.index,
                        t: station.t,
                        at_ms: station.at_ms,
                        refined_from: station.refined_from,
                        transform: station.transform,
                    });
                return { asset_id: asset.id, image_path: file };
            },
        });
        results.push({ shot_id: shot.id, shot_code: shot.shot_code, ...out });
        if (out.stopped_at !== null) break;   // one refusal is the whole run's answer
    }

    // The strip as it now stands, so an approval can be taken against it.
    const after = stripFor(row, { cadenceSeconds: Number(body.cadence_s) || undefined, req });
    const stations = stationList(after.expanded);
    const stopped = results.find(r => r.stopped_at !== null && r.stopped_at !== undefined);
    return json(res, stopped ? 409 : 200, {
        sequence_id: id,
        strips: results,
        ...(stopped ? {
            stopped: true,
            hint: 'A provider that has started refusing will refuse the next one too. '
                + 'Nothing after the named station was attempted, and nothing was charged for it.',
        } : {}),
        fingerprint: stripFingerprint(stations),
        approval: approvalState(row.strip_fingerprint || null, stations),
    });
}

/**
 * The strip as it stands. Free.
 *
 * An agent that can remove a station and cannot list them is one that deletes
 * by guessing — the same gap plate_view_delete shipped with once. This is also
 * how a director reads the strip before correcting it, which is the whole
 * point of having one.
 */
function listStations(res, id, query) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const q = query || {};
    const strip = stripFor(row, { cadenceSeconds: Number(q.cadence_s) || undefined });
    const stations = stationList(strip.expanded);
    return json(res, 200, {
        sequence_id: id,
        cadence_s: (strip.expanded.strips[0] || {}).cadence_s || null,
        station_cap: strip.ceiling.max,
        strips: strip.expanded.strips.map(st => ({
            shot_id: st.shot_id, shot_code: st.shot_code,
            count: st.count, generations: st.generations,
            ...(st.thinned ? { thinned: true, wanted: st.wanted } : {}),
            ...(st.reason ? { reason: st.reason } : {}),
            stations: st.stations.map(station => {
                const made = (strip.have[st.shot_id] || {})[station.index];
                return {
                    index: station.index, at_ms: station.at_ms, t: station.t,
                    instruction: station.instruction,
                    // Station 0 is the approved frame, not something generated
                    // here — said outright so nobody tries to redo it.
                    approved_keyframe: station.index === 0,
                    generated: station.index === 0 ? true : !!made,
                    asset_id: made ? made.asset_id : null,
                };
            }),
        })),
        images_needed: strip.expanded.images_needed,
        fingerprint: stripFingerprint(stations),
        approval: approvalState(row.strip_fingerprint || null, stations),
    });
}

/** Change one station's instruction, and redo it and everything after it. */
async function updateStation(req, res, id, shotId, index) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const at = Number(index);
    if (!Number.isFinite(at) || at < 1) {
        return json(res, 400, { error: 'Station 0 is the approved frame and is not a station you can rewrite.' });
    }
    /*
     * A chain re-inherits from the frame that changed, so everything after this
     * station has to follow. Leaving them would leave a strip whose second half
     * descends from a picture that no longer exists.
     */
    return runInbetweens(req, res, id, { shotId, fromIndex: at });
}

/** Drop a station. The neighbours become adjacent and the strip is one shorter. */
function deleteStation(res, id, shotId, index) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const at = Number(index);
    if (!Number.isFinite(at) || at < 1) {
        return json(res, 400, { error: 'Station 0 is the approved frame; deleting it would delete the shot\'s keyframe.' });
    }
    const found = db.prepare(`SELECT id FROM film_assets
         WHERE project_id = ? AND json_extract(metadata, '$.sequence_id') = ?
           AND json_extract(metadata, '$.shot_id') = ?
           AND json_extract(metadata, '$.station_index') = ?`)
        .all(row.project_id, id, shotId, at);
    if (!found.length) return json(res, 404, { error: 'No such station' });
    for (const a of found) db.prepare('DELETE FROM film_assets WHERE id = ?').run(a.id);
    /*
     * The approval cannot survive the strip changing under it — that is the
     * entire contract. Cleared here rather than left to be caught later,
     * because an approval that no longer describes anything is worse than none.
     */
    db.prepare("UPDATE film_sequences SET strip_fingerprint = '', strip_approved_at = NULL WHERE id = ?").run(id);
    return json(res, 200, {
        deleted: found.map(a => a.id), shot_id: shotId, station_index: at,
        note: 'The neighbours are now adjacent, so the strip is one segment shorter. '
            + 'Any approval was cleared: it described a strip that no longer exists.',
    });
}

/** Sign off the strip, so what shot is provably what was approved. */
function approveStrip(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const strip = stripFor(row, { req });
    const stations = stationList(strip.expanded);
    const ungenerated = stations.filter(st => st.index > 0 && !st.asset_id);
    if (ungenerated.length) {
        return json(res, 409, {
            error: 'STRIP_INCOMPLETE',
            message: `${ungenerated.length} station(s) have not been generated. `
                + 'Approving a strip that does not exist yet would sign off pictures nobody has seen.',
            missing: ungenerated.map(st => `${st.shot_id}#${st.index}`),
        });
    }
    const fingerprint = stripFingerprint(stations);
    db.prepare("UPDATE film_sequences SET strip_fingerprint = ?, strip_approved_at = datetime('now') WHERE id = ?")
        .run(fingerprint, id);
    return json(res, 200, {
        sequence_id: id, approved: true, fingerprint, stations: stations.length,
        note: 'Video generation on this sequence will refuse if the strip changes, so the strip '
            + 'that shot is the strip you signed off.',
    });
}

/** What this would send, and what it would cost. Free. */
function planRoute(res, id, query) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const ceiling = keyframeCeiling(row.project_id);
    const q = query || {};
    /*
     * The strip is opt-in, and that is the safety.
     *
     * Without `expand` this route builds byte-identical to what it always has:
     * every sequence that exists keeps planning the way it did, and the denser
     * list only ever arrives because someone asked for it.
     */
    const wantsStrip = String(q.expand || '') === 'inbetweens';
    const shape = String(q.shape || 'legs') === 'bundle' ? 'bundle' : 'legs';
    const runway = ceiling.provider === 'runway' ? require('../lib/providers/runway') : null;
    const model = runway ? (process.env.RUNWAY_VIDEO_MODEL || 'gen4.5') : null;
    let strip = null;
    if (wantsStrip) {
        strip = stripFor(row, { cadenceSeconds: Number(q.cadence_s) || undefined });
    }
    const planInput = strip ? strip.expanded.stations : shotsOf(row);
    const plan = planSequence(planInput, {
        maxKeyframes: ceiling.max, description: row.description,
        modelPolicy: runway && runway.RUNWAY_VIDEO_MODELS[model],
    });
    const shotList = shotsOf(row);
    let native = null;
    if (!plan.refused && runway && shotList.length >= 3 && shotList.length <= 5) {
        try {
            const built = runway.buildMultiShotRequest({ mode: 'custom', ratio: '1280:720',
                shots: shotList.map(s => ({ prompt: `${s.shot_code}: ${s.description || row.description || 'Continue the story.'}`,
                    duration: Math.max(1, Math.round((s.duration_ms || 3000) / 1000)) })) });
            native = { available: true, mode: 'custom-cuts', duration_s: built.body.duration,
                estimated_credits: built.estimatedCredits, estimated_usd: built.estimatedCredits / 100,
                outbound: built.body };
        } catch (err) { native = { available: false, reason: err.message }; }
    }
    return json(res, plan.refused ? 409 : 200, {
        sequence_id: id, provider: ceiling.provider,
        ...(ceiling.unresolved ? { provider_unresolved: ceiling.unresolved } : {}),
        ...plan,
        // The prompts and the frame COUNT travel; the frames themselves do not.
        // A plan is read in a browser and four base64 stills is megabytes spent
        // showing something the page already has thumbnails of.
        segments: (plan.segments || []).map(s => ({
            from: s.from, to: s.to, prompt: s.prompt, keyframes: s.keyframes.length,
            duration_s: s.duration_s, estimated_credits: s.estimated_credits,
            complete: !!db.prepare(`SELECT 1 FROM film_assets WHERE project_id = ?
                AND json_extract(metadata, '$.sequence_id') = ?
                AND json_extract(metadata, '$.from') = ? AND json_extract(metadata, '$.to') = ? LIMIT 1`)
                .get(row.project_id, id, s.from, s.to),
        })),
        generations: (plan.segments || []).length,
        native_multi_shot: native,
        ...(strip ? {
            shape,
            /*
             * The counts travel; the station IMAGES do not. A plan is read in a
             * browser, and thirty base64 stills is megabytes spent showing
             * something the page already has thumbnails of -- the same reason
             * segments carry `keyframes: n` rather than the frames.
             */
            strips: strip.expanded.strips.map(st => ({
                shot_id: st.shot_id, shot_code: st.shot_code,
                count: st.count, generations: st.generations,
                cadence_s: st.cadence_s,
                ...(st.thinned ? { thinned: true, wanted: st.wanted } : {}),
                ...(st.reason ? { reason: st.reason } : {}),
                generated: Object.keys((strip.have[st.shot_id] || {})).length,
            })),
            images_needed: strip.expanded.images_needed,
            /*
             * Free on the model that documents room for them, and that is the
             * whole reason this targets Seedance: 30 images at no cost against
             * video billed per second.
             */
            images_estimated_credits: strip.ceiling.contract.imageCredits
                ? strip.expanded.images_needed * strip.ceiling.contract.imageCredits : 0,
            station_cap: strip.ceiling.max,
            station_cap_why: strip.ceiling.why,
        } : {}),
    });
}

async function generateNativeSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const shots = shotsOf(row);
    if (shots.length < 3 || shots.length > 5) return json(res, 409, { error: 'Native multi-shot requires 3–5 shots' });
    if (shots.some(s => !s.keyframe)) return json(res, 409, { error: 'Every native multi-shot sequence needs an approved frame' });
    const provider = resolve('video', seqConfig(row.project_id, req));
    if (!provider || provider.id !== 'runway') return json(res, 409, { error: 'Native multi-shot requires the Runway provider' });
    const { toDataUri } = require('../lib/reference-images');
    const payload = {
        runway_recipe: 'multi_shot_video', mode: 'custom', ratio: (req.body && req.body.ratio) || '1280:720',
        promptImage: toDataUri(shots[0].keyframe),
        shots: shots.map(s => ({ prompt: `${s.shot_code}: ${s.description || row.description || 'Continue the story.'}`,
            duration: Math.max(1, Math.round((s.duration_ms || 3000) / 1000)) })),
    };
    const result = await provider.generate('video', payload, { timeout: 600000 });
    if (!result.ok) return json(res, 502, { error: result.error });
    const fileName = sequenceFileName(id, shots[0].shot_code, 'multi-shot');
    const saved = await persistProviderMedia(row.project_id, 'video', fileName, result.data, { serveDir: 'videos' });
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata, provider, provider_model, provider_job_id)
        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?, 'runway', ?, ?)`)
        .run(assetId, row.project_id, shots[0].id, typeof saved === 'string' ? saved : saved.path, fileName,
            JSON.stringify({ sequence_id: id, kind: 'native_multi_shot' }), result.provider_model || 'multi_shot_video', result.provider_job_id || null);
    db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?").run(assetId, id);
    return json(res, 200, { sequence_id: id, asset_id: assetId, url: getFileUrl('video', row.project_id, fileName), mode: 'native_multi_shot' });
}

async function generateSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const ceiling = keyframeCeiling(row.project_id, req);
    const runway = ceiling.provider === 'runway' ? require('../lib/providers/runway') : null;
    const model = runway ? (process.env.RUNWAY_VIDEO_MODEL || 'gen4.5') : null;

    const body_ = req.body || {};
    const wantsStrip_ = String(body_.expand || '') === 'inbetweens' || !!row.strip_fingerprint;
    const shape_ = String(body_.shape || 'legs') === 'bundle' ? 'bundle' : 'legs';
    const strip_ = wantsStrip_
        ? stripFor(row, { cadenceSeconds: Number(body_.cadence_s) || undefined, req })
        : null;

    /*
     * THE STRIP THAT SHOT IS THE STRIP THAT WAS SIGNED OFF.
     *
     * The same contract previs_approve carries: an approval means nothing if
     * the thing it described can change underneath it. A sequence with no
     * approval is unaffected, which is what every sequence that exists today
     * is — treating an absent fingerprint as stale would refuse all of them on
     * the day this ships.
     */
    if (strip_ && row.strip_fingerprint && !body_.ignore_approval) {
        const state = approvalState(row.strip_fingerprint, stationList(strip_.expanded));
        if (state.stale) {
            return json(res, 409, {
                error: 'STALE_APPROVAL',
                message: 'This sequence\'s in-between strip was approved and has changed since. '
                    + 'Generating now would shoot a strip nobody signed off.',
                approved_fingerprint: state.approved_fingerprint,
                current_fingerprint: state.current,
                hint: 'Re-approve the strip, or send ignore_approval to generate from it as it stands.',
            });
        }
    }

    const planInput_ = (strip_ && shape_ === 'legs') ? strip_.expanded.stations : shotsOf(row);
    const plan = planSequence(planInput_, { maxKeyframes: ceiling.max, description: row.description,
        modelPolicy: runway && runway.RUNWAY_VIDEO_MODELS[model] });
    if (plan.refused) return json(res, 409, { sequence_id: id, ...plan });

    const provider = resolve('video', seqConfig(row.project_id, req));
    if (!provider || typeof provider.generate !== 'function') {
        return json(res, 502, { error: 'no video provider resolved' });
    }

    const { toDataUri } = require('../lib/reference-images');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(row.project_id);
    const results = [];

    db.prepare("UPDATE film_sequences SET status = 'generating', updated_at = datetime('now') WHERE id = ?").run(id);

    const requestedIndex = req.body && req.body.segment_index;
    const selected = requestedIndex === undefined ? plan.segments
        : plan.segments.filter((_, i) => i === Number(requestedIndex));
    if (!selected.length) return json(res, 400, { error: 'segment_index is outside this sequence plan' });
    for (const segment of selected) {
        const keyframes = segment.keyframes
            .map(k => ({ uri: toDataUri(k.uri), position: k.position }))
            .filter(k => k.uri);
        // eslint-disable-next-line no-await-in-loop
        const result = await provider.generate('video', {
            prompt: segment.prompt,
            keyframes,
            duration_s: segment.duration_s,
            width: 1280, height: 720,
            ...(project && project.target_fps ? { target_fps: project.target_fps } : {}),
        }, { timeout: 600000 });

        if (!result.ok) {
            results.push({ from: segment.from, to: segment.to, ok: false, error: result.error });
            // A provider that has started refusing will refuse the rest; stop
            // rather than buying the same failure N times.
            break;
        }

        const fileName = sequenceFileName(id, segment.from, segment.to);
        // eslint-disable-next-line no-await-in-loop
        const saved = await persistProviderMedia(row.project_id, 'video', fileName, result.data,
            { serveDir: 'videos' });
        const assetId = generateId();
        db.prepare(`INSERT INTO film_assets
            (id, project_id, shot_id, asset_type, file_path, file_name, format, version, metadata)
            VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 1, ?)`)
            .run(assetId, row.project_id, segment.from_shot_id,
                typeof saved === 'string' ? saved : (saved && saved.path) || '',
                fileName, JSON.stringify({ sequence_id: id, from: segment.from, to: segment.to }));
        results.push({
            from: segment.from, to: segment.to, ok: true, asset_id: assetId,
            url: getFileUrl('video', row.project_id, fileName),
        });
    }

    const failed = results.filter(r => !r.ok);
    db.prepare("UPDATE film_sequences SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(failed.length ? 'failed' : 'complete', id);

    return json(res, failed.length && !results.some(r => r.ok) ? 502 : 200, {
        sequence_id: id, segments: results,
        not_attempted: selected.slice(results.length).map(s => `${s.from}→${s.to}`),
        needs_stitching: plan.needs_stitching,
        note: plan.needs_stitching && !failed.length
            ? 'Each segment is a separate clip. Stitch them in the timeline or your NLE.'
            : undefined,
    });
}

/**
 * The clips this sequence has produced, in play order.
 *
 * Ordered by the SEQUENCE, never by created_at: a director who regenerated the
 * middle segment would otherwise get it last, and a film assembled in the wrong
 * order plays perfectly and is wrong.
 */
function clipsOf(row) {
    const id = row.id;
    const shots = shotsOf(row);
    const out = [];
    for (let i = 0; i < shots.length; i += 1) {
        const from = shots[i];
        const to = shots[i + 1] || shots[i];
        const clip = db.prepare(
            `SELECT id, file_path, file_name FROM film_assets
              WHERE project_id = ? AND json_extract(metadata, '$.sequence_id') = ?
                AND json_extract(metadata, '$.from') = ?
              ORDER BY created_at DESC LIMIT 1`).get(row.project_id, id, from.shot_code);
        if (clip) out.push({ ...clip, from: from.shot_code, to: to.shot_code });
        if (shots.length === 1) break;
        if (i === shots.length - 2) break;
    }
    return out;
}

/**
 * Join the sequence's clips into ONE file.
 *
 * The sequence produced N-1 clips and asked the director to join them
 * elsewhere, which makes the last step of the pipeline happen outside it.
 *
 * Free: no provider is called and nothing is generated. It re-encodes what has
 * already been paid for.
 */
async function stitchSequence(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });

    const clips = clipsOf(row);
    if (!clips.length) {
        return json(res, 409, {
            error: 'NOTHING_TO_JOIN',
            reason: 'This sequence has no clips yet. Generate it, or upload a clip, first.',
        });
    }

    const shots = shotsOf(row);
    const expected = Math.max(1, shots.length - 1);
    if (clips.length < expected) {
        /*
         * Joining what is there would produce a shorter film that plays fine —
         * the failure nobody notices until they watch all of it. Named per
         * missing segment, because "3 of 4 clips" sends the director to the
         * database to work out which.
         */
        const have = new Set(clips.map(c => `${c.from}`));
        const missing = shots.slice(0, expected)
            .filter(s => !have.has(s.shot_code))
            .map((s, i) => `${s.shot_code}\u2192${(shots[shots.indexOf(s) + 1] || s).shot_code}`);
        return json(res, 409, {
            error: 'INCOMPLETE',
            reason: `${clips.length} of ${expected} clips exist. Missing: ${missing.join(', ')}. `
                + 'Generate the rest before joining, or the film is short and plays as though it is whole.',
            have: clips.length, expected, missing,
        });
    }

    const { stitchClips, resolveFfmpeg } = require('../lib/ffmpeg');
    const encoder = resolveFfmpeg();
    if (!encoder.available) {
        return json(res, 503, { error: 'NO_ENCODER', reason: encoder.reason });
    }

    /*
     * The project's delivery rate, from the column that exists. This read
     * `frame_rate`, which film_projects does not have — so every join silently
     * fell back to 24 and a 25fps production would have been conformed at the
     * wrong rate, which surfaces as drift in a cut long after delivery.
     */
    const project = db.prepare('SELECT target_fps FROM film_projects WHERE id = ?').get(row.project_id);
    const fileName = `sequence_${String(row.name || id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || id.slice(0, 8)}.mp4`;
    const outputPath = require('path').join(
        require('../lib/file-storage').DATA_DIR, 'video', row.project_id, fileName);

    const result = await stitchClips(clips, outputPath, {
        fps: Number(project && project.target_fps) || 24,
    });
    if (!result.ok) return json(res, result.state === 'no_executor' ? 503 : 502, { ...result });

    // Replace the previous join rather than accumulating one per press: this is
    // derived output, and a folder of near-identical masters is how the wrong
    // one gets delivered.
    const prior = db.prepare(
        `SELECT id FROM film_assets WHERE project_id = ? AND file_name = ? AND asset_type = 'video_final'`)
        .all(row.project_id, fileName);
    for (const p of prior) db.prepare('DELETE FROM film_assets WHERE id = ?').run(p.id);

    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version, metadata)
        VALUES (?, ?, ?, 'video_final', ?, ?, 'mp4', 'video/mp4', ?, 1, ?)`)
        .run(assetId, row.project_id, shotsOf(row)[0].id, outputPath, fileName, result.bytes,
            JSON.stringify({ kind: 'sequence_master', sequence_id: id, clips: result.clips }));
    db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?")
        .run(assetId, id);

    return json(res, 200, {
        sequence_id: id, asset_id: assetId, clips: result.clips,
        file_name: fileName, bytes: result.bytes,
        url: getFileUrl('video', row.project_id, fileName),
        encoder: result.encoder,
        note: 'One file, joined from the clips this sequence generated. Nothing was generated and '
            + 'nothing was spent.',
    });
}

/** A clip generated somewhere else, dropped straight onto the sequence. */
function importSequenceClip(req, res, id) {
    const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Sequence not found' });
    const body = req.body || {};
    if (!body.data) return json(res, 400, { error: 'no file supplied' });

    // Attached to the sequence's FIRST shot, because a clip has to belong to a
    // shot for the timeline and the export to find it — and the first shot is
    // where the sequence starts playing.
    const first = shotsOf(row)[0];
    if (!first || first.missing) return json(res, 409, { error: 'This sequence has no shots to attach a clip to' });

    try {
        const imported = importMedia('video-media', {
            shotId: first.id, data: body.data, name: body.name,
        });
        db.prepare("UPDATE film_sequences SET output_asset_id = ?, status = 'complete', updated_at = datetime('now') WHERE id = ?")
            .run(imported.asset_id, id);
        return json(res, 201, {
            sequence_id: id, attached_to: first.shot_code, ...imported,
        });
    } catch (err) {
        return json(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

/*
 * `query` is a parameter now.
 *
 * The plan and the station list read `?expand`, `?cadence_s` and `?shape` from
 * it, and reaching for an undefined binding is a 500 that reads as "query is
 * not defined" — which is what the integration suite caught within a minute of
 * the strip being wired in.
 */
async function handleSequences(req, res, urlParts, query) {
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'sequences') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') return listSequences(res, urlParts[2]);
        if (req.method === 'POST') return createSequence(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'sequences' && urlParts[2]) {
        const id = urlParts[2];
        if (!UUID_RE.test(id)) return json(res, 400, { error: 'Invalid sequence ID' });
        const sub = urlParts[3];
        if (sub === 'plan' && req.method === 'GET') return planRoute(res, id, query);
        if (sub === 'generate' && req.method === 'POST') return generateSequence(req, res, id);
        if (sub === 'generate-native' && req.method === 'POST') return generateNativeSequence(req, res, id);
        if (sub === 'import' && req.method === 'POST') return importSequenceClip(req, res, id);
        // Free: joins clips already paid for into one file.
        if (sub === 'stitch' && req.method === 'POST') return stitchSequence(req, res, id);
        // The strip: generate it, correct one station, sign it off.
        if (sub === 'inbetweens') {
            if (urlParts[4] === 'approve' && req.method === 'POST') return approveStrip(req, res, id);
            if (!urlParts[4] && req.method === 'POST') return runInbetweens(req, res, id, {});
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (sub === 'stations' && !urlParts[4] && req.method === 'GET') return listStations(res, id, query);
        if (sub === 'stations' && urlParts[4] && urlParts[5] !== undefined) {
            if (req.method === 'PUT') return updateStation(req, res, id, urlParts[4], urlParts[5]);
            if (req.method === 'DELETE') return deleteStation(res, id, urlParts[4], urlParts[5]);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (!sub) {
            if (req.method === 'GET') {
                const row = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(id);
                if (!row) return json(res, 404, { error: 'Sequence not found' });
                return json(res, 200, { sequence: { ...row, shot_ids: parseIds(row) }, shots: shotsOf(row) });
            }
            if (req.method === 'PUT') return updateSequence(req, res, id);
            if (req.method === 'DELETE') {
                const row = db.prepare('SELECT id FROM film_sequences WHERE id = ?').get(id);
                if (!row) return json(res, 404, { error: 'Sequence not found' });
                db.prepare('DELETE FROM film_sequences WHERE id = ?').run(id);
                // The clips survive: they are on their shots, they cost money,
                // and deleting a plan must not delete the footage it produced.
                return json(res, 200, { deleted: id, note: 'Clips generated for this sequence are kept on their shots.' });
            }
        }
    }
    return false;
}

module.exports = { handleSequences, shotsOf, sequenceFileName };
