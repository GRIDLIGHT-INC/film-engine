/**
 * Run a repair.
 *
 *   POST /film/shots/:id/repair   — extract, generate, splice, register
 *
 * SEPARATE FROM `routes/approvals.js`, WHICH HOLDS THE PLAN. That file is
 * documented as free decision packets, and the plan is one: raise it as often
 * as you like, it spends nothing. This SPENDS. Splitting them by whether money
 * moves is the distinction this codebase already draws everywhere between a
 * free preview and the generation it previews.
 *
 * Everything below is orchestration the runner already owns. This resolves the
 * shot, finds its footage, and hands over — a second implementation of the
 * stage order is how the route and the agent surface come to do different
 * things with the same request.
 */

const { db } = require('../db/database');
const { getFilePath } = require('../lib/file-storage');
const { runRepair, runBridge, repairGenerator } = require('../lib/repair-run');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    });
}

/**
 * Every bridge this project has, and where each one goes.
 *
 * FREE, and a read. It exists because a bridge is deliberately NOT in the cut —
 * the editor takes it to Premiere — and a deliverable nobody can list is one
 * nobody receives. Selected by `metadata.kind`, never by asset_type, so it
 * stays invisible to the timeline, the conform and the three exporters, which
 * is the property that keeps it from appearing in the film twice.
 */
function listBridges(req, res, projectId) {
    const { bridgeRow } = require('../lib/repair-bridge');
    const rows = db.prepare(
        `SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other'
          ORDER BY created_at DESC`).all(projectId);
    const bridges = rows.map(r => bridgeRow({ ...r, project_id: projectId })).filter(Boolean);
    return json(res, 200, {
        project_id: projectId,
        bridges,
        note: bridges.length
            ? 'A bridge replaces the tail of one shot and the head of the next. It is deliberately '
              + 'not in the timeline or the exports — trim the two shots as each row says and lay '
              + 'the bridge between them in your editor.'
            : 'No bridges yet. Mark across a cut in Playback and press Bridge this cut.',
    });
}

async function handleRepair(req, res, urlParts) {
    if (urlParts[1] === 'projects' && urlParts[3] === 'bridges') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return listBridges(req, res, urlParts[2]);
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const shotId = urlParts[2];
    /*
     * JOINED TO THE SCENE. `film_shots` HAS NO project_id — a shot belongs to a
     * scene and the scene belongs to the project. A bare SELECT * reads
     * undefined, which then resolves a file path under the directory "undefined"
     * and fails as a missing clip rather than as the schema mistake it is.
     * Every other handler in this file already joins; these two did not, and
     * only running against a real database found it.
     */
    const shot = db.prepare(`SELECT s.*, sc.project_id
        FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const body = await readBody(req);
    const clip = db.prepare(
        `SELECT * FROM film_assets WHERE shot_id = ?
            AND asset_type IN ('video_final','video_synced','video_raw')
          ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 ELSE 2 END,
                   created_at DESC LIMIT 1`).get(shotId);
    if (!clip) {
        return json(res, 200, {
            ok: false, stage: 'plan',
            reason: 'This shot has no footage yet, so there is nothing to repair.',
        });
    }

    /*
     * A BRIDGE IS DISPATCHED BEFORE THE SPLICE, and that order is the fix.
     * The page has been sending `bridge: true` since the marking surface
     * shipped and this route never read it, so "Bridge this cut" ran a
     * WITHIN-CLIP repair: it succeeded, returned a version, spliced generated
     * footage into the first shot and left the second untouched. Nothing
     * errored. That is the expensive shape — a plausible paid result that is
     * not the operation the editor asked for.
     */
    if (body.bridge && body.next_shot_id) {
        const next = db.prepare(`SELECT s.*, sc.project_id FROM film_shots s
            JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(String(body.next_shot_id));
        if (!next) return json(res, 404, { error: 'The shot on the far side of the cut was not found' });
        const nextClip = db.prepare(
            `SELECT * FROM film_assets WHERE shot_id = ?
                AND asset_type IN ('video_final','video_synced','video_raw')
              ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 ELSE 2 END,
                       created_at DESC LIMIT 1`).get(next.id);
        if (!nextClip) {
            return json(res, 200, { ok: false, stage: 'plan',
                reason: `${next.shot_code} has no footage yet, so there is nothing to bridge to.` });
        }
        const firstPath = getFilePath(shot.project_id, 'video', clip.file_name);
        const secondPath = getFilePath(next.project_id, 'video', nextClip.file_name);
        const dur = (p2) => { const m = inspectMedia(p2); return m.ok ? m.durationSeconds : 0; };
        const bridged = await runBridge({
            db,
            projectId: shot.project_id,
            spans: [
                { shotId, shotCode: shot.shot_code, sourcePath: firstPath,
                  startSec: Number(body.start_sec), endSec: dur(firstPath), durationSeconds: dur(firstPath) },
                { shotId: next.id, shotCode: next.shot_code, sourcePath: secondPath,
                  startSec: 0, endSec: Number(body.end_sec), durationSeconds: dur(secondPath) },
            ],
            ...(body.resolution ? { resolution: String(body.resolution) } : {}),
            ignoreBudget: !!body.ignore_budget,
            generate: repairGenerator,
        });
        if (!bridged.ok && bridged.code === 'over_budget') return json(res, 402, bridged);
        return json(res, 200, bridged);
    }

    const result = await runRepair({
        db,
        projectId: shot.project_id,
        shotId,
        shotCode: shot.shot_code,
        sourcePath: getFilePath(shot.project_id, 'video', clip.file_name),
        startSec: Number(body.start_sec),
        endSec: Number(body.end_sec),
        ...(body.resolution ? { resolution: String(body.resolution) } : {}),
        ignoreBudget: !!body.ignore_budget,
        generate: repairGenerator,
    });

    /*
     * A refusal is a 200 carrying its stage and reason, except over budget.
     * "This range is under the four-second floor" is an ANSWER to the request,
     * and a 4xx would have the caller report it as a failure to reach the
     * engine. Over budget is the exception because 402 is what every other gate
     * here answers, and an agent branches on it.
     */
    if (!result.ok && result.code === 'over_budget') return json(res, 402, result);
    return json(res, 200, result);
}

module.exports = { handleRepair };
