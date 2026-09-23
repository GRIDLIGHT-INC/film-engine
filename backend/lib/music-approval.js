/**
 * THE APPROVED SCORE: SELECTED ONCE, PLACED ONCE, AND NOTHING UNDER IT.
 *
 * MUS-020. A score session becomes the film's music by an EXPLICIT act: a
 * director selects a bounce (`approveMix`), and a bounce made before the
 * session last changed is refused as stale, because approving a mix that no
 * longer matches the arrangement signs off something nobody is looking at.
 * A plain status write cannot approve (the route refuses it and names this),
 * and the selected mix lands in `film_music_sessions.approved_mix_asset_id`,
 * which a request body can never set.
 *
 * `approvedScores` is the ONE reader every consumer of the film asks. It
 * answers which approved mixes can be consumed and REPORTS the rest by name:
 *   unapproved   a session not yet approved — its music reaches nothing
 *   stale        approved, but the session or its picture moved since; still
 *                the approved mix (a person signed it off), and said so
 *   missing      approved with no mix, or a mix whose file is gone — not
 *                consumed, and the scene music it would have replaced stays
 *   unplaced     the session's picture is not in the film
 *   overlapping  a second approved session over the same shots — only the
 *                newest approval is consumed, so a mix never plays twice
 * `placeScores` puts each at its CANONICAL offset: where the first shot of
 * its picture starts in the consumer's own running order, so the timeline and
 * the master can each place it by their own durations and still agree.
 *
 * Exactly once, and nothing under it: every scene the score's picture touches
 * has its legacy scene MUSIC dropped (ambience and effects are not music and
 * stay). `SCORE_CONSUMERS` is the registry of every surface that assembles
 * the film; the test holds each to consuming the mix once at its offset.
 */

const fs = require('fs');
const crypto = require('crypto');
const { generateId } = require('../db/database');

const SCORE_CONSUMERS = Object.freeze([
    { id: 'timeline', file: 'backend/routes/timeline.js', what: 'The assembled timeline: the approved mix as one bed at its offset, and the scene music it replaces dropped.' },
    { id: 'playback', file: 'src/index.html', what: 'Playback plays the timeline’s beds, one music bed at a time, so the score is heard once.' },
    { id: 'audio_mix', file: 'backend/routes/music-gen.js', what: 'The project mix plan names the score; a per-shot mix takes the score’s slice under that shot instead of the scene music.' },
    { id: 'pipeline', file: 'backend/routes/pipeline.js', what: 'The scene music step is skipped for a scene an approved score covers, so a second score is never generated under it.' },
    { id: 'nle_export', file: 'backend/routes/nle-export.js', what: 'FCPXML, Premiere XML and EDL lay the approved mix once on its first shot’s music lane, spanning its own length.' },
    { id: 'conform', file: 'backend/lib/conform.js', what: 'The conformed master mixes the approved score over the film’s audio at its offset.' },
]);

const REPORT_STATES = Object.freeze(['unapproved', 'stale', 'missing', 'unplaced', 'overlapping', 'shadowed', 'on_edit']);

function refuse(status, code, error) { return { ok: false, status, code, error }; }

function recordOp(db, sessionId, params) {
    db.prepare(`INSERT INTO film_music_operations (id, session_id, kind, status, params_json, started_at, completed_at)
                VALUES (?, ?, 'approve', 'complete', ?, datetime('now'), datetime('now'))`).run(generateId(), sessionId, JSON.stringify(params));
}

function currentFingerprint(db, sessionId) {
    try { return require('./music-renderer').planBounce(db, sessionId).fingerprint || null; } catch (_) { return null; }
}

/** Select a bounce as the session's approved mix. */
function approveMix(db, sessionId, opts) {
    const o = opts || {};
    const s = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!s) return refuse(404, 'NOT_FOUND', 'Score session not found');
    if (!['review', 'approved'].includes(s.status)) {
        return refuse(409, 'LIFECYCLE', `a session is approved from review, and this one is ${s.status} — move it to review first`);
    }
    const renderer = require('./music-renderer');
    const bounces = renderer.listBounces(db, sessionId).filter(b => b.status === 'complete');
    const chosen = o.bounce_operation_id ? bounces.find(b => b.operation_id === o.bounce_operation_id) : bounces[0];
    if (!chosen) {
        return refuse(409, 'NO_BOUNCE', o.bounce_operation_id
            ? `no complete bounce ${o.bounce_operation_id} on this session` : 'there is no bounce to approve: render the session first (music_bounce)');
    }
    const master = chosen.master && db.prepare('SELECT id, file_path FROM film_assets WHERE id = ?').get(chosen.master.asset_id);
    if (!master || !master.file_path || !fs.existsSync(master.file_path)) return refuse(409, 'MISSING_MIX', `bounce v${chosen.version} has no master on disk to approve`);
    const now = currentFingerprint(db, sessionId);
    const stale = !!(now && chosen.fingerprint && now !== chosen.fingerprint);
    if (stale && o.ignore_stale !== true) {
        return refuse(409, 'STALE_MIX', `bounce v${chosen.version} was rendered before the session last changed, so it is not the mix on the lanes — bounce again and approve that, or pass ignore_stale to approve this one anyway`);
    }
    // The rights policy at approval (MUS-022): a block refuses with the items; a warning travels with the approval.
    const rightsCheck = require('./music-rights').evaluate(db, [master.id], 'approval');
    if (!rightsCheck.ok && o.ignore_rights !== true) {
        return { ...refuse(409, 'RIGHTS_BLOCKED', `the rights policy blocks approving this mix: ${rightsCheck.blocked.map(i => `${i.name} (${i.status})`).join('; ')} — clear them in the rights register, or pass ignore_rights to approve anyway (recorded)`), items: rightsCheck.blocked, policy_note: rightsCheck.note };
    }
    const warnings = rightsCheck.warned.map(i => `${i.name}: ${i.reason}`);
    if (!rightsCheck.ok) warnings.push(`approved over a rights block at the director's request: ${rightsCheck.blocked.map(i => `${i.name} (${i.status})`).join('; ')}`);
    try {
        const d = require('./music-context').sessionDrift(db, sessionId);
        if (d && d.drifted) warnings.push('the picture or the screenplay moved since this session was written; the score may no longer fit the cut');
    } catch (_) { /* drift is advisory */ }
    if (stale) warnings.push(`approved over a stale bounce (v${chosen.version}) at the director's request`);
    db.transaction(() => {
        db.prepare("UPDATE film_music_sessions SET status = 'approved', approved_mix_asset_id = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(master.id, sessionId);
        recordOp(db, sessionId, { action: 'approve', bounce_operation_id: chosen.operation_id, version: chosen.version, asset_id: master.id, fingerprint: chosen.fingerprint, stale, previous_asset_id: s.approved_mix_asset_id || null,
            rights: { blocked: rightsCheck.blocked.map(i => ({ asset_id: i.asset_id, status: i.status })), warned: rightsCheck.warned.map(i => ({ asset_id: i.asset_id, status: i.status })), ignore_rights: !rightsCheck.ok && o.ignore_rights === true } });
    })();
    return { ok: true, session_id: sessionId, asset_id: master.id, bounce_operation_id: chosen.operation_id, version: chosen.version, stale, warnings };
}

/** Take the approval back: the session returns to review and no consumer reads its mix. */
function revokeApproval(db, sessionId) {
    const s = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!s) return refuse(404, 'NOT_FOUND', 'Score session not found');
    if (s.status !== 'approved') return refuse(409, 'LIFECYCLE', `the session is ${s.status}, not approved`);
    db.transaction(() => {
        db.prepare("UPDATE film_music_sessions SET status = 'review', approved_mix_asset_id = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(sessionId);
        recordOp(db, sessionId, { action: 'revoke', asset_id: s.approved_mix_asset_id || null });
    })();
    return { ok: true, session_id: sessionId, revoked_asset_id: s.approved_mix_asset_id || null };
}

/** The shots a session's picture is: its sequence in order, else its scene's shots. */
function sessionShots(db, s) {
    let ids = [];
    if (s.sequence_id) {
        const q = db.prepare('SELECT shot_ids FROM film_sequences WHERE id = ?').get(s.sequence_id);
        try { ids = JSON.parse((q && q.shot_ids) || '[]'); } catch (_) { ids = []; }
    } else if (s.scene_id) {
        ids = db.prepare('SELECT id FROM film_shots WHERE scene_id = ?').all(s.scene_id).map(r => r.id);
    }
    if (!ids.length) return { shot_ids: [], shot_codes: [], scene_ids: [] };
    const rows = db.prepare(`SELECT id, shot_code, scene_id FROM film_shots WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return { shot_ids: rows.map(r => r.id), shot_codes: rows.map(r => r.shot_code), scene_ids: [...new Set(rows.map(r => r.scene_id).filter(Boolean))] };
}

function bounceOf(db, sessionId, assetId) {
    try { return require('./music-renderer').listBounces(db, sessionId).find(b => b.master && b.master.asset_id === assetId) || null; } catch (_) { return null; }
}

/** Every approved mix that can be consumed, and every session that cannot, by name. */
function approvedScores(db, projectId) {
    const sessions = db.prepare("SELECT * FROM film_music_sessions WHERE project_id = ? AND status != 'archived' ORDER BY approved_at DESC, updated_at DESC").all(projectId);
    const scores = [], reports = [], taken = new Map();
    for (const s of sessions) {
        const who = { session_id: s.id, name: s.name || 'untitled' };
        if (s.status !== 'approved') { reports.push({ ...who, state: 'unapproved', reason: `${s.status}: its music reaches nothing until a bounce is approved` }); continue; }
        const asset = s.approved_mix_asset_id ? db.prepare('SELECT id, file_path, duration_ms FROM film_assets WHERE id = ?').get(s.approved_mix_asset_id) : null;
        if (!asset) { reports.push({ ...who, state: 'missing', reason: 'approved with no mix selected; approve a bounce' }); continue; }
        if (!asset.file_path || !fs.existsSync(asset.file_path)) { reports.push({ ...who, state: 'missing', reason: `the approved mix is not on disk (${asset.file_path || 'no path'}); the scene music it would have replaced stays` }); continue; }
        /*
         * SCORED TO AN EDIT: delivered with that edit, never laid on the
         * assembly. The score's zero is the edit's first frame and its timing
         * is the editor's cut — placing it at the first shot of Film Engine's
         * own running order would put every hit point in the wrong place,
         * silently, in a film that plays. Its stems and package go to the
         * editor, where the cut it was written for lives.
         */
        if (s.edit_id) {
            const e = db.prepare('SELECT version FROM film_edits WHERE id = ?').get(s.edit_id);
            reports.push({ ...who, state: 'on_edit', edit_id: s.edit_id, asset_id: asset.id,
                reason: `scored to edit v${e ? e.version : '?'} made in an editor; it is delivered with that edit (bounce stems or a score package into the editor at 00:00), not laid on Film Engine's assembly, whose timing is different` });
            continue;
        }
        const pic = sessionShots(db, s);
        if (!pic.shot_ids.length) { reports.push({ ...who, state: 'unplaced', reason: 'the session has no picture in this film to sit under' }); continue; }
        const clash = pic.shot_ids.map(id => taken.get(id)).find(Boolean);
        if (clash) { reports.push({ ...who, state: 'overlapping', reason: `its picture overlaps ${clash.name}, approved later; only that one is consumed, so no mix plays twice` }); continue; }
        const reasons = [];
        const b = bounceOf(db, s.id, asset.id);
        const now = currentFingerprint(db, s.id);
        if (b && b.fingerprint && now && b.fingerprint !== now) reasons.push('the session changed since the approved bounce');
        try { const d = require('./music-context').sessionDrift(db, s.id); if (d && d.drifted) reasons.push('the picture or the screenplay moved since the session was written'); } catch (_) { /* advisory */ }
        const score = { ...who, asset_id: asset.id, file_path: asset.file_path, duration_ms: Number(asset.duration_ms) || 0, approved_at: s.approved_at,
            shot_ids: pic.shot_ids, shot_codes: pic.shot_codes, scene_ids: pic.scene_ids, state: reasons.length ? 'stale' : 'ok', reasons };
        if (reasons.length) reports.push({ ...who, state: 'stale', reason: `${reasons.join('; ')} — still the approved mix; approve a new bounce to replace it` });
        for (const id of pic.shot_ids) taken.set(id, score);
        scores.push(score);
    }
    return { scores, reports };
}

/**
 * Place each score at the start of its picture's first shot in THIS running
 * order. `entries` are the consumer's own, in play order: { shot_id,
 * shot_code?, start_ms, covers? } (covers holds shot codes).
 */
function placeScores(entries, scores) {
    const placements = [], reports = [];
    for (const sc of scores || []) {
        const ids = new Set(sc.shot_ids), codes = new Set(sc.shot_codes || []);
        const first = (entries || []).find(e => ids.has(e.shot_id) || (e.covers || []).some(c => codes.has(c)));
        if (!first) { reports.push({ session_id: sc.session_id, name: sc.name, state: 'unplaced', reason: 'none of its shots is in this assembly' }); continue; }
        placements.push({ session_id: sc.session_id, name: sc.name, asset_id: sc.asset_id, file_path: sc.file_path, duration_ms: sc.duration_ms,
            offset_ms: Number(first.start_ms) || 0, first_shot_id: first.shot_id, scene_ids: sc.scene_ids, state: sc.state });
    }
    return { placements, reports };
}

/** A finished project mix is the whole soundtrack: a score under it is taken to be inside it, and reported rather than laid again. */
function shadowedByProjectMix(placements) {
    return (placements || []).map(p => ({ session_id: p.session_id, name: p.name, state: 'shadowed',
        reason: 'the project audio mix is the master soundtrack; the approved score is taken to be inside it and is not laid again' }));
}

/** Scene ids whose legacy music an approved, consumable score replaces. */
function coveredScenes(db, projectId) {
    const out = new Map();
    for (const sc of approvedScores(db, projectId).scores) for (const id of sc.scene_ids) out.set(id, sc);
    return out;
}

/** Entries in play order from clips laid end to end (the conform's own durations). */
function entriesFromClips(clips) {
    let at = 0;
    return (clips || []).map(c => { const e = { shot_id: c.shot_id, shot_code: c.shot_code, start_ms: at, covers: c.covers }; at += Number(c.duration_ms) || 0; return e; });
}

/** The timeline's beds with the approved score laid in and the music under it taken out. */
function applyToTimeline(db, projectId, timeline) {
    const rep = approvedScores(db, projectId);
    const placed = placeScores(timeline.entries, rep.scores);
    const covered = new Set(placed.placements.flatMap(p => p.scene_ids));
    const beds = (timeline.beds || []).filter(b => !(b.kind === 'music' && covered.has(b.scene_id)));
    for (const p of placed.placements) {
        beds.push({ kind: 'music', source: 'score_session', session_id: p.session_id, scene_id: null, type: 'audio_music', path: p.file_path,
            asset_duration_ms: p.duration_ms, start_ms: p.offset_ms, end_ms: p.offset_ms + p.duration_ms,
            // The approved mix IS the mix: its level is the director's, not a default.
            gain_db: 0, fade_in_ms: 0, fade_out_ms: 0, cue_id: null });
    }
    timeline.beds = beds.sort((a, b) => a.start_ms - b.start_ms);
    timeline.score = { placements: placed.placements, reports: [...rep.reports, ...placed.reports] };
    return timeline;
}

/**
 * Mix the placed scores over a finished film's audio, in one ffmpeg pass:
 * each delayed to its offset, summed with nothing normalised, the film's
 * length kept. Returns an argument array, never a shell string.
 */
function scoreMixArgs(input, placements, output, opts) {
    const o = opts || {};
    const args = ['-y', '-loglevel', 'error', '-i', input];
    for (const p of placements) args.push('-i', p.file_path);
    const fmt = 'aformat=sample_rates=48000:channel_layouts=stereo';
    // A film with no audio stream (silent clips, joined) gets the score over silence of the film's own length.
    if (o.silentBaseSeconds) args.push('-f', 'lavfi', '-t', String(o.silentBaseSeconds), '-i', 'anullsrc=r=48000:cl=stereo');
    const base = o.silentBaseSeconds ? `[${placements.length + 1}:a]` : '[0:a]';
    const parts = [`${base}${fmt}[f]`];
    placements.forEach((p, i) => parts.push(`[${i + 1}:a]${fmt},adelay=${Math.round(p.offset_ms)}|${Math.round(p.offset_ms)}[s${i}]`));
    parts.push(`[f]${placements.map((_, i) => `[s${i}]`).join('')}amix=inputs=${placements.length + 1}:normalize=0:duration=first:dropout_transition=0[a]`);
    args.push('-filter_complex', parts.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output);
    return args;
}

function mixScoreIntoFilm(filmPath, placements, opts) {
    const o = opts || {};
    const { resolveFfmpeg } = require('./ffmpeg');
    const found = resolveFfmpeg();
    if (!found.available) return { ok: false, error: `no encoder to mix the score with: ${found.reason}` };
    const tmp = `${filmPath}.score-${crypto.randomUUID().slice(0, 8)}.mp4`;
    const seen = require('./ffmpeg').inspectMedia(filmPath);
    const silentBaseSeconds = seen.ok && !seen.hasAudio ? Math.max(0.1, seen.durationSeconds) : null;
    const r = require('child_process').spawnSync(found.bin, scoreMixArgs(filmPath, placements, tmp, { silentBaseSeconds }), { encoding: 'utf8', timeout: o.timeoutMs || 600000 });
    if (r.status !== 0 || !fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing written */ }
        return { ok: false, error: `mixing the approved score into the film failed: ${String(r.stderr || r.error || '').trim().split('\n').slice(-2).join(' ')}` };
    }
    fs.renameSync(tmp, filmPath);
    return { ok: true };
}

module.exports = {
    SCORE_CONSUMERS, REPORT_STATES, approveMix, revokeApproval, approvedScores, placeScores, coveredScenes,
    entriesFromClips, applyToTimeline, scoreMixArgs, mixScoreIntoFilm, sessionShots, shadowedByProjectMix,
};
