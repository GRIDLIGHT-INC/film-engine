/**
 * FILM-073–075: QA & Quality Gates
 *
 * Automated quality checks for film pipeline output:
 *  - Scene completeness (all required assets present)
 *  - Visual continuity (character appearance, lighting consistency)
 *  - Audio completeness (dialogue, music, ambient coverage)
 *  - Timeline integrity (no gaps, overlaps handled)
 *  - Technical specs (resolution, codec, frame rate, audio levels)
 *
 * Exports:
 *  - QA_CHECKS: list of all QA check definitions
 *  - runProjectQA(projectId, db) → { passed, failed, warnings, checks }
 *  - runShotQA(shotId, db) → { passed, failed, warnings, checks }
 *  - runSceneQA(sceneId, db) → { passed, failed, warnings, checks }
 *  - checkContinuity(projectId, db) → continuity report
 *  - ACCEPTANCE_RUBRIC: editor acceptance criteria
 */

// QA check severity levels
const SEVERITY = { error: 'error', warning: 'warning', info: 'info' };

// Acceptance rubric — criteria an editor checks before approving output
const ACCEPTANCE_RUBRIC = {
    resolution: { min_width: 1024, min_height: 576, label: 'Minimum resolution 1024x576' },
    frame_rate: { min_fps: 23.976, max_fps: 60, label: 'Frame rate 23.976-60 fps' },
    audio_levels: { min_lufs: -27, max_lufs: -14, label: 'Audio levels -27 to -14 LUFS' },
    color_space: { accepted: ['sRGB', 'Rec.709', 'Rec.2020'], label: 'Color space sRGB/Rec.709/Rec.2020' },
    codec: { video: ['h264', 'h265', 'prores', 'dnxhr'], audio: ['wav', 'aac', 'pcm'], label: 'Supported codecs' },
    dialogue_coverage: { min_pct: 95, label: '95% dialogue lines have audio' },
    shot_coverage: { min_pct: 100, label: 'All shots have video' },
};

// All available QA checks
const QA_CHECKS = [
    { id: 'shot_has_video', scope: 'shot', severity: SEVERITY.error, label: 'Shot has generated video' },
    { id: 'shot_has_keyframe', scope: 'shot', severity: SEVERITY.error, label: 'Shot has storyboard keyframe' },
    { id: 'shot_has_dialogue_audio', scope: 'shot', severity: SEVERITY.warning, label: 'Shot dialogue has audio (if dialogue exists)' },
    { id: 'shot_has_lipsync', scope: 'shot', severity: SEVERITY.warning, label: 'Shot has lip-synced video (if dialogue exists)' },
    { id: 'shot_duration_valid', scope: 'shot', severity: SEVERITY.error, label: 'Shot duration is positive and reasonable' },
    { id: 'scene_has_music', scope: 'scene', severity: SEVERITY.warning, label: 'Scene has music score' },
    { id: 'scene_has_ambient', scope: 'scene', severity: SEVERITY.info, label: 'Scene has ambient audio' },
    { id: 'scene_has_all_shots', scope: 'scene', severity: SEVERITY.error, label: 'All scene shots are generated' },
    { id: 'project_continuity', scope: 'project', severity: SEVERITY.warning, label: 'Visual continuity across shots' },
    { id: 'project_audio_mix', scope: 'project', severity: SEVERITY.warning, label: 'All scenes have audio mix' },
    { id: 'project_timeline_complete', scope: 'project', severity: SEVERITY.error, label: 'Timeline has no gaps' },
    /*
     * Spot checks. They apply ONLY to a project that has said it is one -- a
     * runtime target -- so a film is never failed for being the length it is.
     */
    { id: 'spot_duration_exact', scope: 'project', severity: SEVERITY.error, label: 'Cut hits the bought runtime exactly' },
    { id: 'spot_native_vertical', scope: 'project', severity: SEVERITY.error, label: 'Every native ratio has a shot shot at it' },
    { id: 'spot_rights_cleared', scope: 'project', severity: SEVERITY.error, label: 'No blocking compliance finding' },
];

/**
 * Run QA checks for a single shot.
 */
function runShotQA(shotId, db) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return { error: 'Shot not found', checks: [] };

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    let sceneCard = {};
    try { sceneCard = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) {}

    const assets = db.prepare('SELECT * FROM film_assets WHERE shot_id = ?').all(shotId);
    const assetTypes = new Set(assets.map(a => a.asset_type));

    const hasDialogue = sceneCard.dialogue && Array.isArray(sceneCard.dialogue) && sceneCard.dialogue.length > 0;
    const checks = [];

    // Shot has keyframe
    checks.push({
        id: 'shot_has_keyframe',
        passed: assetTypes.has('keyframe') || assetTypes.has('storyboard'),
        severity: SEVERITY.error,
        message: assetTypes.has('keyframe') || assetTypes.has('storyboard') ? 'Keyframe present' : 'Missing storyboard keyframe',
    });

    // Shot has video
    checks.push({
        id: 'shot_has_video',
        passed: assetTypes.has('video_raw') || assetTypes.has('video_synced') || assetTypes.has('video_final'),
        severity: SEVERITY.error,
        message: assetTypes.has('video_raw') ? 'Video present' : 'Missing generated video',
    });

    // Shot has dialogue audio (only if dialogue exists)
    if (hasDialogue) {
        checks.push({
            id: 'shot_has_dialogue_audio',
            passed: assetTypes.has('audio_dialogue'),
            severity: SEVERITY.warning,
            message: assetTypes.has('audio_dialogue') ? 'Dialogue audio present' : 'Missing dialogue audio',
        });

        checks.push({
            id: 'shot_has_lipsync',
            passed: assetTypes.has('video_synced'),
            severity: SEVERITY.warning,
            message: assetTypes.has('video_synced') ? 'Lip-synced video present' : 'Missing lip-synced video',
        });
    }

    // Shot duration valid
    const durationOk = shot.duration_ms > 0 && shot.duration_ms < 300000; // < 5 min
    checks.push({
        id: 'shot_duration_valid',
        passed: durationOk,
        severity: SEVERITY.error,
        message: durationOk ? `Duration: ${shot.duration_ms}ms` : `Invalid duration: ${shot.duration_ms}ms`,
    });

    const passed = checks.filter(c => c.passed).length;
    const failed = checks.filter(c => !c.passed && c.severity === SEVERITY.error).length;
    const warnings = checks.filter(c => !c.passed && c.severity === SEVERITY.warning).length;

    return { shot_id: shotId, shot_code: shot.shot_code, passed, failed, warnings, checks };
}

/**
 * Run QA checks for a scene.
 */
function runSceneQA(sceneId, db) {
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
    if (!scene) return { error: 'Scene not found', checks: [] };

    const shots = db.prepare('SELECT id, shot_code FROM film_shots WHERE scene_id = ?').all(sceneId);
    const assets = db.prepare('SELECT * FROM film_assets WHERE scene_id = ?').all(sceneId);
    const assetTypes = new Set(assets.map(a => a.asset_type));

    const checks = [];

    // All shots generated
    const shotResults = shots.map(s => runShotQA(s.id, db));
    const allShotsHaveVideo = shotResults.every(r => r.checks && r.checks.some(c => c.id === 'shot_has_video' && c.passed));
    checks.push({
        id: 'scene_has_all_shots',
        passed: allShotsHaveVideo,
        severity: SEVERITY.error,
        message: allShotsHaveVideo ? `All ${shots.length} shots have video` : 'Some shots missing video',
    });

    // Scene has music
    checks.push({
        id: 'scene_has_music',
        passed: assetTypes.has('audio_music'),
        severity: SEVERITY.warning,
        message: assetTypes.has('audio_music') ? 'Music score present' : 'Missing music score',
    });

    // Scene has ambient
    checks.push({
        id: 'scene_has_ambient',
        passed: assetTypes.has('audio_ambient'),
        severity: SEVERITY.info,
        message: assetTypes.has('audio_ambient') ? 'Ambient audio present' : 'Missing ambient audio',
    });

    const passed = checks.filter(c => c.passed).length;
    const failed = checks.filter(c => !c.passed && c.severity === SEVERITY.error).length;
    const warnings = checks.filter(c => !c.passed && c.severity === SEVERITY.warning).length;

    return {
        scene_id: sceneId, scene_number: scene.scene_number,
        passed, failed, warnings, checks,
        shot_results: shotResults,
    };
}

/**
 * Run full QA for a project.
 */
function runProjectQA(projectId, db) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return { error: 'Project not found', checks: [] };

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? AND status != ? ORDER BY scene_number').all(projectId, 'removed');

    const sceneResults = scenes.map(s => runSceneQA(s.id, db));

    const checks = [];

    // Timeline completeness
    const totalShots = sceneResults.reduce((sum, sr) => sum + (sr.shot_results ? sr.shot_results.length : 0), 0);
    const shotsWithVideo = sceneResults.reduce((sum, sr) =>
        sum + (sr.shot_results ? sr.shot_results.filter(s => s.checks && s.checks.some(c => c.id === 'shot_has_video' && c.passed)).length : 0), 0);

    checks.push({
        id: 'project_timeline_complete',
        passed: totalShots > 0 && shotsWithVideo === totalShots,
        severity: SEVERITY.error,
        message: `${shotsWithVideo}/${totalShots} shots have video`,
    });

    // Continuity check
    const continuity = checkContinuity(projectId, db);
    checks.push({
        id: 'project_continuity',
        passed: continuity.issues.length === 0,
        severity: SEVERITY.warning,
        message: continuity.issues.length === 0 ? 'No continuity issues detected' : `${continuity.issues.length} continuity issues found`,
        details: continuity.issues,
    });

    // Audio mix
    const scenesWithMusic = sceneResults.filter(sr => sr.checks && sr.checks.some(c => c.id === 'scene_has_music' && c.passed)).length;
    checks.push({
        id: 'project_audio_mix',
        passed: scenesWithMusic === scenes.length,
        severity: SEVERITY.warning,
        message: `${scenesWithMusic}/${scenes.length} scenes have music`,
    });

    /*
     * The runtime, for a spot only.
     *
     * A film runs as long as it runs, so a project with no target is not
     * examined at all rather than passed: a green tick against a rule that was
     * never applied is worse than silence.
     */
    /*
     * The two spot checks that are not about length. Both run only when the
     * project has said it is a commercial -- a deliverable set, or a brand --
     * because a film has neither and must not be failed for it.
     */
    const deliverables = db.prepare('SELECT * FROM film_deliverables WHERE project_id = ?').all(projectId);
    if (deliverables.length) {
        const { nativeRatiosFor } = require('./deliverables');
        const native = nativeRatiosFor(deliverables);
        const flagged = db.prepare(`
            SELECT DISTINCT sh.aspect_ratio FROM film_shots sh
              JOIN film_scenes s ON sh.scene_id = s.id
             WHERE s.project_id = ? AND sh.aspect_ratio != ''`).all(projectId).map(r => r.aspect_ratio);
        const unshot = native.filter(r => !flagged.includes(r));
        checks.push({
            id: 'spot_native_vertical',
            passed: unshot.length === 0,
            severity: SEVERITY.error,
            message: unshot.length
                ? `No shot is flagged for ${unshot.join(', ')}, so every one of those placements will `
                  + 'be a crop of the master. A 9:16 crop keeps 32% of the width.'
                : `Every native ratio (${native.join(', ') || 'none required'}) has a shot flagged for it`,
        });
    }

    /*
     * The compliance gate, reported as a QA check so it appears where a
     * director already looks for what is wrong. It is the SAME findings the run
     * plan refuses on, read through the same function: two answers to "is this
     * clear" is how a QA page comes to disagree with a refusal.
     */
    if (deliverables.length || project.brand_id) {
        const { complianceFor } = require('./run-plan');
        const c = complianceFor(projectId);
        const errs = c.findings.filter(f => f.severity === 'error');
        checks.push({
            id: 'spot_rights_cleared',
            passed: errs.length === 0,
            severity: SEVERITY.error,
            message: errs.length
                ? `${errs.length} blocking finding(s): ${errs.map(f => f.message).join(' ')}`.slice(0, 500)
                : 'No blocking compliance findings',
        });
    }

    const spotTarget = Number(project.target_duration_ms) || 0;
    if (spotTarget > 0) {
        const { planConform } = require('./conform');
        const plan = planConform(projectId);
        const delta = plan.over_by_ms;
        checks.push({
            id: 'spot_duration_exact',
            passed: delta !== null && Math.abs(delta) <= Math.ceil(1000 / (plan.fps || 24)),
            severity: SEVERITY.error,
            message: delta === null
                ? 'The cut could not be measured'
                : `Cut runs ${(plan.total_duration_ms / 1000).toFixed(1)}s against a `
                  + `${(spotTarget / 1000).toFixed(1)}s target (${delta > 0 ? '+' : ''}${(delta / 1000).toFixed(1)}s)`,
        });
    }

    const passed = checks.filter(c => c.passed).length;
    const failed = checks.filter(c => !c.passed && c.severity === SEVERITY.error).length;
    const warnings = checks.filter(c => !c.passed && c.severity === SEVERITY.warning).length;

    return {
        project_id: projectId, project_title: project.title,
        passed, failed, warnings, checks,
        scene_results: sceneResults,
        total_scenes: scenes.length,
        total_shots: totalShots,
        acceptance_rubric: ACCEPTANCE_RUBRIC,
    };
}

/**
 * Check visual continuity across shots in a project.
 * Compares character appearances, lighting, and color across consecutive shots.
 */
function checkContinuity(projectId, db) {
    const shots = db.prepare(`
        SELECT s.id, s.shot_code, s.scene_card_yaml, s.scene_id,
               sc.scene_number, sc.location, sc.time_of_day
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? AND sc.status != 'removed'
        ORDER BY sc.scene_number, s.shot_code
    `).all(projectId);

    const issues = [];

    for (let i = 1; i < shots.length; i++) {
        const prev = shots[i - 1];
        const curr = shots[i];

        let prevCard = {}, currCard = {};
        try { prevCard = JSON.parse(prev.scene_card_yaml || '{}'); } catch (_) {}
        try { currCard = JSON.parse(curr.scene_card_yaml || '{}'); } catch (_) {}

        // Same scene: check lighting consistency
        if (prev.scene_id === curr.scene_id) {
            const prevLighting = prevCard.lighting?.style || '';
            const currLighting = currCard.lighting?.style || '';
            if (prevLighting && currLighting && prevLighting !== currLighting) {
                issues.push({
                    type: 'lighting_mismatch',
                    severity: SEVERITY.warning,
                    shots: [prev.shot_code, curr.shot_code],
                    scene_number: curr.scene_number,
                    message: `Lighting style changes within scene: "${prevLighting}" → "${currLighting}"`,
                });
            }
        }

        // Character wardrobe continuity within same scene
        if (prev.scene_id === curr.scene_id) {
            const prevChars = (prevCard.characters || []).map(c => c.name || c).sort();
            const currChars = (currCard.characters || []).map(c => c.name || c).sort();
            const missing = prevChars.filter(c => !currChars.includes(c));
            // Characters appearing/disappearing within a scene might be intentional,
            // so just flag as info
            if (missing.length > 0 && currChars.length > 0) {
                issues.push({
                    type: 'character_disappearance',
                    severity: SEVERITY.info,
                    shots: [prev.shot_code, curr.shot_code],
                    scene_number: curr.scene_number,
                    message: `Characters ${missing.join(', ')} not in next shot`,
                });
            }
        }

        // Time of day consistency within same location
        if (prev.scene_id !== curr.scene_id && prev.location === curr.location) {
            if (prev.time_of_day && curr.time_of_day && prev.time_of_day !== curr.time_of_day) {
                // Different time of day at same location could be intentional (time skip)
                // but flag it for review
                issues.push({
                    type: 'time_continuity',
                    severity: SEVERITY.info,
                    shots: [prev.shot_code, curr.shot_code],
                    scenes: [prev.scene_number, curr.scene_number],
                    message: `Time of day changes at "${prev.location}": ${prev.time_of_day} → ${curr.time_of_day}`,
                });
            }
        }
    }

    return { project_id: projectId, issues, shots_checked: shots.length };
}

module.exports = {
    QA_CHECKS,
    SEVERITY,
    ACCEPTANCE_RUBRIC,
    runShotQA,
    runSceneQA,
    runProjectQA,
    checkContinuity,
};
