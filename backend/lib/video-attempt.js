/**
 * Record what was tried, so the router is eventually built from this film.
 *
 * "Which model is best" is not the question — "which model gives ME an
 * acceptable shot for the lowest expected cost, on MY shots" is, and no
 * external benchmark answers it. Recording every attempt WITH the shape of the
 * shot turns the next ten real shots into the dataset: "H3 is strong on
 * single-character wides and weak on two-character interaction" is what routes
 * a shot, and it cannot be recovered later if nobody wrote down what the shot
 * was at the time.
 *
 * Never throws. By the time this runs the generation has happened and the money
 * is gone; turning a paid, successful generation into a failed request because
 * bookkeeping went wrong is the worst trade available — the trap `stampAsset()`
 * already documents.
 */
function recordVideoAttempt(db, fields) {
    try {
        const f = fields || {};
        const card = f.sceneCard || {};
        const camera = card.camera || {};
        const prior = db.prepare(
            'SELECT COUNT(*) c FROM film_video_attempts WHERE shot_id = ?').get(f.shotId || '').c;

        db.prepare(
            `INSERT INTO film_video_attempts (
                id, shot_id, project_id, shot_version, provider, model, tier,
                duration, resolution,
                reference_images, reference_videos, reference_audio, reference_roles,
                shot_type, camera_movement, character_count, prop_count,
                estimated_credits, actual_credits, generation_ms,
                validation_score, accepted, rejection_reason, attempt_number, asset_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', ?, ?)`
        ).run(
            f.id || require('crypto').randomUUID(),
            f.shotId || null, f.projectId || null, f.shotVersion || null,
            f.provider || '', f.model || '', f.tier || '',
            Number(f.durationSeconds) || null, f.resolution || '',
            Number(f.referenceImages) || 0, Number(f.referenceVideos) || 0,
            Number(f.referenceAudio) || 0, (f.referenceRoles || []).join(','),
            camera.shot_type || '', camera.movement || '',
            Array.isArray(card.characters) ? card.characters.length : 0,
            Array.isArray(card.props) ? card.props.length : 0,
            Number(f.estimatedCredits) || null, Number(f.actualCredits) || null,
            Number(f.generationMs) || null,
            prior + 1, f.assetId || null,
        );
    } catch (_) { /* bookkeeping must never fail a generation that already cost money */ }
}

/** A director's verdict, applied later — the half only a person can supply. */
function judgeVideoAttempt(db, attemptId, { accepted, score, reason } = {}) {
    try {
        db.prepare(
            `UPDATE film_video_attempts
                SET accepted = ?, validation_score = ?, rejection_reason = ?
              WHERE id = ?`
        ).run(accepted === undefined || accepted === null ? null : (accepted ? 1 : 0),
            score === undefined ? null : Number(score), String(reason || ''), attemptId);
        return true;
    } catch (_) { return false; }
}

module.exports = { recordVideoAttempt, judgeVideoAttempt };
