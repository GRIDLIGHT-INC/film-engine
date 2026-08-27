/**
 * ONE CLIP, SEVERAL SHOTS — and the one place every assembly surface asks.
 *
 * "I generated a video that includes 1A-B-C... it shouldn't play any of the
 * images that are part of the video."
 *
 * FOUR things turn shots into a running film and each walks them independently:
 * buildTimeline (playback), planConform (the master file), and the three NLE
 * exporters. Fixing the visible one leaves the others wrong in ways nobody sees
 * until delivery — playback would be right while the conform refuses to build a
 * master because it reports 1B and 1C as missing, and Premiere receives a
 * three-second film with two gaps. So coverage is understood HERE and read
 * there, rather than reimplemented four times.
 */

/**
 * Record which shots a clip contains. Replaces any previous coverage for it.
 *
 * Validation is deliberately strict and refuses rather than repairing: a caller
 * whose list is wrong has a different model of the clip than we do, and quietly
 * fixing it hides that from them until the film is cut.
 */
function setCoverage(db, assetId, shotIds) {
    const asset = db.prepare('SELECT id, project_id, shot_id FROM film_assets WHERE id = ?').get(assetId);
    if (!asset) throw new Error('clip not found');

    const ids = Array.isArray(shotIds) ? shotIds.filter(Boolean) : [];
    if (!ids.length) {
        db.prepare('DELETE FROM film_clip_coverage WHERE asset_id = ?').run(assetId);
        return { asset_id: assetId, covers: [] };
    }

    if (new Set(ids).size !== ids.length) {
        throw new Error('the same shot is listed twice; a clip contains each shot once');
    }

    /*
     * Canonical running order, not the order the array arrived in.
     *
     * A caller listing 1C, 1A, 1B describes a perfectly good run; a caller
     * listing 1A, 1C does not, however it is sorted. Judging consecutiveness on
     * submitted order would accept the second and reject the first.
     */
    const all = db.prepare(
        `SELECT sh.id, sh.shot_code, s.project_id
           FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?
          ORDER BY ${require('./running-order').ORDER_BY_SQL}`).all(asset.project_id);
    const order = new Map(all.map((sh, i) => [sh.id, i]));

    for (const id of ids) {
        if (!order.has(id)) {
            throw new Error('every covered shot must belong to the same project as the clip');
        }
    }

    const positions = ids.map(id => order.get(id)).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i += 1) {
        if (positions[i] !== positions[i - 1] + 1) {
            const gap = all[positions[i - 1] + 1];
            throw new Error(
                `covered shots must be consecutive: ${gap ? gap.shot_code : 'a shot'} lies between `
                + `${all[positions[i - 1]].shot_code} and ${all[positions[i]].shot_code} and is not `
                + 'included. A clip cannot contain a gap the timeline has no way to represent.');
        }
    }

    // The clip has to be inside its own coverage, or the coverage describes a
    // clip that is not where it says it is.
    if (asset.shot_id && !ids.includes(asset.shot_id)) {
        const own = all.find(sh => sh.id === asset.shot_id);
        throw new Error(`the clip's own shot (${own ? own.shot_code : 'lead'}) must be part of what it covers`);
    }

    // A shot already inside another clip: refused, because two clips claiming
    // one shot is a timeline with no answer to "what plays here".
    const taken = db.prepare(
        `SELECT c.shot_id, c.asset_id FROM film_clip_coverage c
          WHERE c.shot_id IN (${ids.map(() => '?').join(',')}) AND c.asset_id != ?`).all(...ids, assetId);
    if (taken.length) {
        const codes = taken.map(t => (all.find(sh => sh.id === t.shot_id) || {}).shot_code).join(', ');
        throw new Error(`${codes} already belongs to another clip. Clear that coverage first.`);
    }

    const ordered = ids.slice().sort((a, b) => order.get(a) - order.get(b));
    const write = db.transaction(() => {
        db.prepare('DELETE FROM film_clip_coverage WHERE asset_id = ?').run(assetId);
        const stmt = db.prepare(
            'INSERT INTO film_clip_coverage (asset_id, shot_id, position) VALUES (?, ?, ?)');
        ordered.forEach((id, i) => stmt.run(assetId, id, i));
    });
    write();

    return {
        asset_id: assetId,
        covers: ordered.map(id => (all.find(sh => sh.id === id) || {}).shot_code).filter(Boolean),
        lead_shot_id: ordered[0],
    };
}

/**
 * shot_id → { asset_id, lead_shot_id, position, covers } for a whole project.
 *
 * One query per assembly rather than one per shot: the timeline repaints on
 * every scrub, and a per-shot lookup would put a query in that loop.
 */
function coverageFor(db, projectId) {
    const rows = db.prepare(
        `SELECT c.asset_id, c.shot_id, c.position, a.duration_ms, a.file_path, a.file_name,
                a.asset_type, a.shot_id AS lead_shot_id, sh.shot_code
           FROM film_clip_coverage c
           JOIN film_assets a ON a.id = c.asset_id
           JOIN film_shots sh ON sh.id = c.shot_id
           JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ?
          ORDER BY c.asset_id, c.position`).all(projectId);

    const byAsset = new Map();
    for (const r of rows) {
        if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
        byAsset.get(r.asset_id).push(r);
    }

    const map = new Map();
    for (const [assetId, group] of byAsset) {
        // The LEAD is position 0 — the shot the clip is laid down at. Preferred
        // over the asset's own shot_id so a clip whose anchor shot was deleted
        // still has a defined place on the timeline.
        const lead = group[0];
        const covers = group.map(g => g.shot_code);
        for (const r of group) {
            map.set(r.shot_id, {
                asset_id: assetId,
                lead_shot_id: lead.shot_id,
                is_lead: r.shot_id === lead.shot_id,
                position: r.position,
                covers,
                duration_ms: Number(lead.duration_ms) || 0,
                file_path: lead.file_path,
                file_name: lead.file_name,
                asset_type: lead.asset_type,
            });
        }
    }
    return map;
}

/**
 * How long each shot's clip ACTUALLY is, by shot id.
 *
 * The card's duration_ms is what a shot ASKS for and is 0 on every real shot
 * here — nothing writes it. So an assembly reading it lays a ten-second clip
 * into a zero-length slot: present in the XML, invisible on the timeline, and
 * every later cut wrong.
 *
 * This was fixed in buildTimeline alone, and the three exporters plus the
 * conform kept reading the card — so playback was right while Premiere received
 * zero-length items, which is exactly the split the running-order work cost a
 * round. One query, one map, read by all of them.
 */
function measuredDurations(db, projectId) {
    const rows = db.prepare(
        `SELECT a.shot_id, a.asset_type, a.duration_ms
           FROM film_assets a
          WHERE a.project_id = ? AND a.shot_id IS NOT NULL
            AND a.asset_type IN ('video_final', 'video_synced', 'video_raw')
            AND a.duration_ms > 0`).all(projectId);

    // The cut that would SHIP, on the same precedence the conform uses: a
    // graded shot is never measured from its raw clip.
    const RANK = { video_final: 0, video_synced: 1, video_raw: 2 };
    const best = new Map();
    for (const r of rows) {
        const held = best.get(r.shot_id);
        if (!held || RANK[r.asset_type] < RANK[held.asset_type]) best.set(r.shot_id, r);
    }
    const out = new Map();
    for (const [shotId, r] of best) out.set(shotId, Number(r.duration_ms) || 0);
    return out;
}

/**
 * The shot list an assembly should actually walk.
 *
 * Covered shots after the lead are dropped, and the lead carries the clip's
 * MEASURED duration plus the codes it contains. Dropping the covered shots
 * without moving the duration would lay a nine-second clip into a three-second
 * slot, and every cut after it would be six seconds early — a worse bug than
 * the one being fixed, because it is invisible until the film is watched.
 */
function foldShots(shots, coverage, measured) {
    const cov = coverage || new Map();
    const lengths = measured || new Map();

    /*
     * The measured length applies to EVERY retained shot, not only a covered
     * lead. Applying it only to the fold is how a plain uploaded clip exported
     * at zero length while a covered one exported correctly — the same feature
     * appearing to work and not work on two shots of the same project.
     */
    const withLength = shot => {
        const ms = lengths.get(shot.id);
        return (ms > 0 && ms !== shot.duration_ms) ? { ...shot, duration_ms: ms } : shot;
    };

    if (!cov.size) return { shots: shots.map(withLength), folded: [] };

    const out = [], folded = [];
    for (const shot of shots) {
        const entry = cov.get(shot.id);
        if (!entry) { out.push(withLength(shot)); continue; }
        if (!entry.is_lead) { folded.push(shot.shot_code); continue; }
        out.push({
            ...shot,
            // The covering clip's own length, which is the whole run.
            duration_ms: entry.duration_ms || lengths.get(shot.id) || shot.duration_ms,
            covers: entry.covers,
            covers_asset_id: entry.asset_id,
        });
    }
    return { shots: out, folded };
}


/**
 * How long a scene actually RUNS, measured from the clips that exist.
 *
 * Music was written to `cue.duration_ms || scene.estimated_duration || 30000`,
 * and `estimated_duration` is 0 on every scene in both real projects — 0 is
 * falsy, so every cue fell through to a hardcoded thirty seconds. Wingfall
 * scene 1 holds 22.08s of footage and scene 2 holds 10.05s; both would have
 * been scored at 30.
 *
 * The engine already knew the right number: `measuredDurations` reads the real
 * length of every clip off disk, and the conform and all three NLE exporters
 * build the film with it. Music was the one thing still guessing.
 *
 * Returns NULL when nothing has been shot, never 0. "No footage" and "a
 * zero-length scene" are different answers, and conflating them is exactly
 * what let a 0 fall through to a default nobody chose.
 *
 * @returns {number|null} milliseconds, or null if no clip has been measured
 */
function sceneCutLength(db, sceneId) {
    const scene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return null;

    const measured = measuredDurations(db, scene.project_id);
    const shots = db.prepare('SELECT id FROM film_shots WHERE scene_id = ?').all(sceneId);

    let total = 0;
    let any = false;
    for (const shot of shots) {
        const ms = measured.get(shot.id);
        if (ms > 0) { total += ms; any = true; }
    }
    return any ? total : null;
}

module.exports = { setCoverage, coverageFor, foldShots, measuredDurations, sceneCutLength };
