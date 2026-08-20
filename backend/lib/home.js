/**
 * What a director sees on opening the app.
 *
 * The dashboard reported on the project: counts, a status bar, a milestone
 * list. That is a summary, and a summary makes you work out what to do next and
 * then go and find where it lives. The home page answers four questions
 * instead — what was I doing, what needs me, where is the film, what is running
 * — and every answer carries the way into it.
 *
 * Everything here is DERIVED. Nothing is stored, nothing is a second copy of
 * state that can disagree with the pages it summarises: the phase fractions
 * count real shots, "needs you" is assembled from the reports that already
 * exist, and "running" reads the job tables the queue page reads.
 */

const PHASES = [
    { id: 'write', label: 'Write', page: 'screenplay' },
    { id: 'plan', label: 'Plan', page: 'shotboard' },
    { id: 'look', label: 'Look', page: 'storyboard' },
    { id: 'make', label: 'Make', page: 'pipeline' },
    { id: 'edit', label: 'Edit', page: 'playback' },
    { id: 'deliver', label: 'Deliver', page: 'exportpage' },
];

function safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
}

/** "2 hours ago", "just now" — a duration a person reads without subtracting. */
function ago(iso) {
    if (!iso) return null;
    const then = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('Z') ? '' : 'Z'));
    if (!Number.isFinite(then)) return null;
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 90) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} minutes ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

function greetingWord(now) {
    const h = (now || new Date()).getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
}

function buildHome(db, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;

    const shots = safe(() => db.prepare(
        `SELECT s.*, sc.scene_number FROM film_shots s
           JOIN film_scenes sc ON sc.id = s.scene_id
          WHERE sc.project_id = ? AND sc.status != 'removed'
          ORDER BY CAST(sc.scene_number AS INTEGER), s.sort_order, s.shot_code`).all(projectId), []);
    const scenes = safe(() => db.prepare(
        "SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed'").all(projectId), []);

    return {
        greeting: buildGreeting(db, project, shots, scenes),
        resume: buildResume(db, projectId, shots),
        needs: buildNeeds(db, projectId, shots, scenes),
        phases: buildPhases(db, projectId, shots, scenes),
        activity: buildActivity(db, projectId),
        running: buildRunning(db, projectId),
    };
}

/** Who is here, which film, and how big it is. */
function buildGreeting(db, project, shots, scenes) {
    // The author from app settings — the one place a name is recorded — rather
    // than a per-project field nobody fills.
    const author = safe(() => {
        const row = db.prepare("SELECT value FROM film_app_settings WHERE key = 'author'").get();
        return (row && row.value) || '';
    }, '');
    return {
        salutation: greetingWord(),
        name: author || null,
        project_title: project.title,
        shot_count: shots.length,
        scene_count: scenes.length,
        last_opened: ago(project.updated_at),
    };
}

/**
 * The last thing that was worked on, and what state it was left in.
 *
 * Ordered by what actually changed most recently rather than by shot order,
 * because "where you left off" is a fact about time. A shot with a card and no
 * keyframe is reported as unstarted work rather than as finished, since the two
 * lead to different next actions.
 */
function buildResume(db, projectId, shots) {
    const asset = safe(() => db.prepare(
        `SELECT a.shot_id, a.artefact_kind, a.file_name, a.created_at
           FROM film_assets a WHERE a.project_id = ? AND a.shot_id IS NOT NULL
          ORDER BY a.created_at DESC LIMIT 1`).get(projectId), null);

    const shot = asset ? shots.find(s => s.id === asset.shot_id) : shots.find(s => s.status !== 'complete');
    if (!shot) return null;

    const hasKeyframe = safe(() => !!db.prepare(
        "SELECT 1 FROM film_assets WHERE shot_id = ? AND artefact_kind = 'keyframe' LIMIT 1").get(shot.id), false);
    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }

    return {
        shot_id: shot.id,
        shot_code: shot.shot_code,
        scene_number: String(shot.scene_number),
        headline: `Shot ${shot.shot_code}`,
        summary: String(card.description || '').slice(0, 160) || 'No description on this card yet.',
        state: hasKeyframe ? 'has a keyframe' : 'nothing has been generated from it yet',
        has_keyframe: hasKeyframe,
        when: ago(asset && asset.created_at),
    };
}

/**
 * What is actually blocking the film, each with the page that fixes it.
 *
 * Assembled from the reports that already exist rather than recomputed, so an
 * item can never disagree with the page it links to. An item names a COUNT and
 * a destination: "7 shots have no keyframe" sends you somewhere; "storyboard
 * incomplete" does not.
 */
function buildNeeds(db, projectId, shots, scenes) {
    const items = [];
    const push = (count, label, page, phase) => {
        if (count > 0) items.push({ count, label, page, phase });
    };

    const withKeyframe = new Set(safe(() => db.prepare(
        `SELECT DISTINCT a.shot_id FROM film_assets a
           WHERE a.project_id = ? AND a.artefact_kind = 'keyframe' AND a.shot_id IS NOT NULL`)
        .all(projectId).map(r => r.shot_id), []));
    const noKeyframe = shots.filter(s => !withKeyframe.has(s.id)).length;
    push(noKeyframe, `${noKeyframe} shot${noKeyframe === 1 ? ' has' : 's have'} no keyframe`, 'storyboard', 'look');

    const notes = safe(() => db.prepare(
        `SELECT COUNT(*) c FROM film_shot_notes n JOIN film_shots s ON s.id = n.shot_id
           JOIN film_scenes sc ON sc.id = s.scene_id
          WHERE sc.project_id = ? AND n.resolved = 0`).get(projectId).c, 0);
    push(notes, `${notes} unresolved note${notes === 1 ? '' : 's'}`, 'notes', 'write');

    const bare = scenes.filter(sc => !shots.some(s => s.scene_id === sc.id)).length;
    push(bare, `${bare} scene${bare === 1 ? '' : 's'} never broken down`, 'scenes', 'write');

    // Subjects with no declared size: an image model has no sense of scale, and
    // this is the gap that produces an object the wrong size in every frame.
    const noSize = safe(() => require('./subject-scale').missingSizes(db, projectId).length, 0);
    push(noSize, `${noSize} subject${noSize === 1 ? '' : 's'} without a size`, 'props', 'plan');

    const behind = safe(() => require('./screenplay-drift').drift(projectId)
        .reduce((n, s) => n + s.shots_behind.length, 0), 0);
    push(behind, `${behind} shot card${behind === 1 ? '' : 's'} behind the screenplay`, 'shotboard', 'write');

    return items;
}

/** The whole film, phase by phase, counted from real shots. */
function buildPhases(db, projectId, shots, scenes) {
    const total = shots.length;
    const countAssets = kind => safe(() => new Set(db.prepare(
        `SELECT DISTINCT shot_id FROM film_assets
           WHERE project_id = ? AND artefact_kind = ? AND shot_id IS NOT NULL`)
        .all(projectId, kind).map(r => r.shot_id)).size, 0);

    const brokenDown = scenes.filter(sc => shots.some(s => s.scene_id === sc.id)).length;
    const keyframed = countAssets('keyframe');
    const filmed = countAssets('video');
    const approved = shots.filter(s => s.status === 'approved').length;

    const by = {
        write: { done: brokenDown, of: scenes.length, note: `${brokenDown} of ${scenes.length} scenes broken down` },
        plan: { done: total, of: total, note: total ? `${total} shots carded` : 'No shots yet' },
        look: { done: keyframed, of: total, note: `${keyframed} of ${total} keyframed` },
        make: { done: filmed, of: total, note: filmed ? `${filmed} filmed` : 'Not started' },
        edit: { done: approved, of: total, note: approved ? `${approved} approved` : 'No takes circled' },
        deliver: { done: 0, of: total, note: 'Not started' },
    };

    return PHASES.map(p => ({
        id: p.id, label: p.label, page: p.page,
        done: by[p.id].done, of: by[p.id].of, note: by[p.id].note,
    }));
}

/** What happened, most recent first, from what was actually written. */
function buildActivity(db, projectId, limit) {
    const rows = safe(() => db.prepare(
        `SELECT a.artefact_kind, a.asset_type, a.file_name, a.created_at, s.shot_code
           FROM film_assets a LEFT JOIN film_shots s ON s.id = a.shot_id
          WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT ?`).all(projectId, limit || 6), []);
    return rows.map(r => ({
        at: r.created_at,
        when: ago(r.created_at),
        what: `${label(r.artefact_kind || r.asset_type)}${r.shot_code ? ` for ${r.shot_code}` : ''}`,
    }));
}

function label(kind) {
    const words = {
        keyframe: 'Keyframe generated', video: 'Clip generated', voice: 'Voice rendered',
        character_plate: 'Character plate generated', location_plate: 'Location plate generated',
        prop_plate: 'Prop plate generated', storyboard: 'Keyframe generated',
        character_sheet: 'Reference sheet generated', reference_image: 'Reference plate generated',
    };
    return words[kind] || String(kind || 'Asset').replace(/_/g, ' ');
}

/** What is generating right now. Empty is a real answer, not a missing one. */
function buildRunning(db, projectId) {
    const out = [];
    const TABLES = [
        { table: 'film_video_jobs', label: 'Video' },
        { table: 'film_voice_jobs', label: 'Voice' },
        { table: 'film_music_jobs', label: 'Score' },
        { table: 'film_post_jobs', label: 'Post' },
    ];
    for (const t of TABLES) {
        const rows = safe(() => db.prepare(
            `SELECT * FROM ${t.table} WHERE project_id = ? AND status IN ('running','pending','queued')
              ORDER BY created_at DESC LIMIT 5`).all(projectId), []);
        for (const r of rows) {
            out.push({ kind: t.label, shot_code: r.shot_code || null, status: r.status, at: r.created_at });
        }
    }
    return out;
}

module.exports = { buildHome, PHASES, ago, greetingWord, buildPhases, buildNeeds };
