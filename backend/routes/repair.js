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
const { runRepair, repairGenerator } = require('../lib/repair-run');

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

async function handleRepair(req, res, urlParts) {
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
