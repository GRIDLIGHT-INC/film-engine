/**
 * The score brief: everything the engine knows about a picture unit, compiled
 * once, fingerprinted per field, with every field saying where it came from.
 *
 * `music_brief` (lib/scene-score.js) is scene-scoped and reads a handful of
 * facts. A score session is written against an ORDERED SEQUENCE — the exact
 * screenplay version and passage, the shots in play order with their real
 * timings and the camera each is generated with, the cast and how much they
 * talk, the film's look, the cues already written and the themes already made,
 * and the emotional arc a director accepted. This module gathers all of it
 * into one neutral `ScoreBrief` and never decides what it should sound like:
 * the connected agent is the model, and a brief is facts.
 *
 * THE FINGERPRINT IS WHAT MAKES DRIFT SAYABLE. Every field is hashed on its
 * own and the drift-bearing ones are hashed together; a session stores what
 * it was compiled against, and `sessionDrift` reports which side moved —
 * script, picture, or a named field — without touching the music. Rebasing
 * is `stampSessionContext`, an explicit act, the way `screenplay-drift`'s
 * baseline is explicit. A change that reaches no music (a project rename, a
 * scene's status, a proposal nobody accepted) must NOT move it: a warning
 * that fires on work nobody needs to redo is one people learn to dismiss.
 */

const { hash } = require('./artefact-fingerprint');
const { sceneSpans } = require('./scene-splice');
const { measuredDurations } = require('./clip-coverage');
const { orderShots } = require('./running-order');
const { dialogueWeight } = require('./scene-score');
const { effectiveCamera } = require('./previs-blocking');
const { filmOptics } = require('./look-development');

/**
 * The brief's fields, what each is, where it comes from, and whether a
 * change to it means the score was written against something that no longer
 * exists. Consumers and tests read this rather than a list of their own.
 */
const BRIEF_FIELDS = Object.freeze({
    picture: {
        from: ['film_sequences', 'film_shots', 'film_assets', 'film_previs_blocking'], drift: true,
        what: 'The ordered shots with their measured or written timings and the camera each is generated with.',
    },
    screenplay: {
        from: ['film_scripts'], drift: true,
        what: 'The exact version and the exact passage of every scene the picture unit covers.',
    },
    scenes: {
        from: ['film_scenes'], drift: true,
        what: 'Where and when each scene happens, in the writer\'s own words, with any delivery direction.',
    },
    characters: {
        from: ['film_shots'], drift: true,
        what: 'Who is in the picture, from the scene cards: two people alone is a duet, a crowd is not.',
    },
    dialogue: {
        from: ['film_shots', 'film_assets'], drift: true,
        what: 'How much talking there is, which decides whether the cue is underscore or carries the scene.',
    },
    look: {
        from: ['film_projects', 'film_mood_board'], drift: true,
        what: 'The film\'s own look, genre and optics, so the score belongs to the same picture.',
    },
    cues: {
        from: ['film_music_cues'], drift: true,
        what: 'The musical direction already written for these scenes, sections included.',
    },
    emotion: {
        from: ['film_music_emotion_ranges'], drift: true,
        what: 'The accepted emotional arc. Proposals are excluded: nothing paid rests on a curve nobody reviewed.',
    },
    motifs: {
        from: ['film_music_cues', 'film_assets'], drift: false,
        what: 'Themes already made anywhere in the project, so a composer can reuse rather than reinvent. Informational.',
    },
    length: {
        from: ['film_assets', 'film_shots'], drift: false,
        what: 'How long the score has to be and where that number came from. Derived from picture, which bears the drift.',
    },
});

const DRIFT_FIELDS = Object.freeze(Object.entries(BRIEF_FIELDS).filter(([, s]) => s.drift).map(([k]) => k));

function parseJson(text, fallback) {
    try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; } catch (_) { return undefined; }
}

function fail(error) { return { ok: false, error, brief: null, fingerprints: null, provenance: null, warnings: [] }; }

/**
 * Compile the brief for a session, a sequence, or a scene.
 *
 * `{ sessionId }` reads the session's own picture pointer (sequence, else
 * scene) and its accepted emotion ranges; `{ sequenceId }` or `{ sceneId }`
 * brief a picture unit that has no session yet. Never throws: a broken card,
 * a missing screenplay or a deleted sequence is NAMED in `warnings`.
 */
function compileScoreContext(db, target) {
    const t = target || {};
    const warnings = [];
    let session = null, projectId = null, sequence = null, scene = null, edit = null;

    if (t.sessionId) {
        session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(t.sessionId);
        if (!session) return fail(`no score session ${t.sessionId}`);
        projectId = session.project_id;
        if (session.edit_id) {
            edit = db.prepare('SELECT * FROM film_edits WHERE id = ?').get(session.edit_id);
            if (!edit) warnings.push('the session names an edit that no longer exists');
        }
        if (!edit && session.sequence_id) {
            sequence = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(session.sequence_id);
            if (!sequence) warnings.push('the session names a sequence that no longer exists');
        }
        if (!sequence && session.scene_id) {
            scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(session.scene_id);
            if (!scene) warnings.push('the session names a scene that no longer exists');
        }
        if (!edit && !sequence && !scene) return fail('the session is attached to no edit, no sequence and no scene, so there is no picture to brief');
    } else if (t.editId) {
        edit = db.prepare('SELECT * FROM film_edits WHERE id = ?').get(t.editId);
        if (!edit) return fail(`no edit ${t.editId}`);
        projectId = edit.project_id;
    } else if (t.sequenceId) {
        sequence = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(t.sequenceId);
        if (!sequence) return fail(`no sequence ${t.sequenceId}`);
        projectId = sequence.project_id;
    } else if (t.sceneId) {
        scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(t.sceneId);
        if (!scene) return fail(`no scene ${t.sceneId}`);
        projectId = scene.project_id;
    } else {
        return fail('name a sessionId, an editId, a sequenceId or a sceneId');
    }

    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId) || {};
    const provenance = {};

    // ── Picture: the shots, in the order the picture plays ──────────────────
    let shotRows;
    // An edit's picture is its CUT: events in the edit's own time, each a
    // Film Engine shot or not. Rows are fetched per matched shot; the timing
    // comes from the edit, never from the assembly.
    let cutEvents = null;
    if (edit) {
        try { cutEvents = edit.cut_json ? (JSON.parse(edit.cut_json).events || []) : null; } catch (_) { cutEvents = null; }
        if (!cutEvents) warnings.push(`edit v${edit.version} has no cut imported, so the brief knows its length but not which shots play where — import the XML or EDL it was cut from`);
        const ids = [...new Set((cutEvents || []).map(e => e.shot_id).filter(Boolean))];
        shotRows = ids.map(id => db.prepare(
            `SELECT sh.*, s.scene_number, s.project_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE sh.id = ?`).get(id)).filter(Boolean);
    } else if (sequence) {
        const ids = parseJson(sequence.shot_ids, []) || [];
        if (!Array.isArray(ids)) warnings.push('the sequence\'s shot list is not readable');
        const byId = new Map();
        for (const id of (Array.isArray(ids) ? ids : [])) {
            const r = db.prepare(
                `SELECT sh.*, s.scene_number, s.project_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE sh.id = ?`).get(id);
            if (r) byId.set(id, r); else warnings.push(`the sequence names a shot that no longer exists (${id})`);
        }
        shotRows = [...byId.values()];
    } else {
        shotRows = orderShots(db.prepare(
            `SELECT sh.*, s.scene_number, s.project_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE sh.scene_id = ?`).all(scene.id));
    }

    const measured = measuredDurations(db, projectId);
    const optics = filmOptics(db, projectId) || {};
    const cast = new Set();
    let dialogueLines = 0;
    let cursor = 0;
    const describe = r => {
        let card = parseJson(r.scene_card_yaml || '{}', {});
        if (card === undefined || typeof card !== 'object') {
            warnings.push(`shot ${r.shot_code}: its scene card is not valid JSON and was read as empty`);
            card = {};
        }
        const characters = (card.characters || []).map(c => String(typeof c === 'string' ? c : (c && c.name) || '').toUpperCase()).filter(Boolean);
        const dialogue = (card.dialogue || []).map(d => ({ character: String((d && d.character) || '').toUpperCase(), line: String((d && d.line) || '') }));
        for (const c of characters) cast.add(c);
        for (const d of dialogue) { dialogueLines++; if (d.character) cast.add(d.character); }

        let previs = null;
        try {
            const row = db.prepare('SELECT camera_json, rig, movement, applied_fingerprint FROM film_previs_blocking WHERE shot_id = ?').get(r.id);
            // Durable generation reads APPLIED blocking only; an experiment on
            // the stage is not what the shot will be generated with.
            if (row && row.applied_fingerprint) previs = { camera: parseJson(row.camera_json, {}) || {}, rig: row.rig, movement: row.movement };
        } catch (_) { previs = null; }
        let camera = {};
        try {
            const eff = effectiveCamera(card.camera || {}, previs, optics) || {};
            for (const [k, v] of Object.entries(eff)) camera[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
        } catch (_) { camera = { ...(card.camera || {}) }; }

        return {
            id: r.id, shot_code: r.shot_code, scene_id: r.scene_id, scene_number: String(r.scene_number),
            action: String(card.description || card.action || ''),
            characters, dialogue, camera,
        };
    };
    let shots;
    if (edit) {
        const rowById = new Map(shotRows.map(r => [r.id, r]));
        const described = new Map();
        shots = (cutEvents || []).map(ev => {
            const r = ev.shot_id ? rowById.get(ev.shot_id) : null;
            if (r && !described.has(r.id)) described.set(r.id, describe(r));
            const base = r ? described.get(r.id) : {
                // Part of the cut Film Engine did not make: a title, a stock
                // shot. It is still time the score has to cover.
                id: null, shot_code: null, scene_id: null, scene_number: null,
                action: '', characters: [], dialogue: [], camera: {},
            };
            return { ...base, name: ev.name || ev.file_name || '', start_ms: ev.start_ms, duration_ms: ev.end_ms - ev.start_ms,
                duration_source: 'edit', source_in_ms: ev.source_in_ms || 0, matched_by: ev.matched_by || null };
        });
        // Cast and dialogue counted once per event, the way the cut plays.
        cast.clear(); dialogueLines = 0;
        for (const sh of shots) {
            for (const c of sh.characters) cast.add(c);
            for (const d of sh.dialogue) { dialogueLines++; if (d.character) cast.add(d.character); }
        }
        cursor = Number(edit.duration_ms) || Math.max(0, ...shots.map(x => x.start_ms + x.duration_ms));
    } else {
        shots = shotRows.map(r => {
            const shot = describe(r);
            const m = measured.get(r.id);
            const written = Number(r.duration_ms) || 0;
            const duration = m > 0 ? m : written;
            const source = m > 0 ? 'measured' : written > 0 ? 'card' : 'none';
            const out = { ...shot, start_ms: cursor, duration_ms: duration, duration_source: source };
            cursor += duration;
            return out;
        });
    }
    const measuredCount = shots.filter(s => s.duration_source === 'measured').length;
    const cardCount = shots.filter(s => s.duration_source === 'card').length;
    const picture = {
        kind: edit ? 'edit' : sequence ? 'sequence' : 'scene',
        id: edit ? edit.id : sequence ? sequence.id : scene.id,
        name: edit ? `edit v${edit.version}${edit.name ? ' — ' + edit.name : ''}` : sequence ? sequence.name : `scene ${scene.scene_number}`,
        ...(edit ? { version: edit.version, has_cut: !!cutEvents } : {}),
        shot_count: shots.length,
        total_ms: cursor,
        shots,
    };
    provenance.picture = {
        from: edit ? ['film_edits', ...BRIEF_FIELDS.picture.from] : BRIEF_FIELDS.picture.from,
        ids: [picture.id, ...shots.map(s => s.id).filter(Boolean)],
        timing: edit
            ? `the cut of edit v${edit.version}: ${shots.length} event(s), ${shots.filter(x => x.id).length} of them Film Engine shots, timed by the edit`
            : `${measuredCount} shot(s) measured from footage, ${cardCount} from the card, ${shots.length - measuredCount - cardCount} with no length`,
    };

    // ── Scenes the picture covers, in play order ────────────────────────────
    const sceneIds = [...new Set(shots.map(s => s.scene_id).filter(Boolean))];
    if (scene && !sceneIds.includes(scene.id)) sceneIds.push(scene.id);
    const sceneRows = sceneIds.map(id => db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(id)).filter(Boolean);
    const scenes = sceneRows.map(s => ({
        id: s.id, scene_number: String(s.scene_number), int_ext: s.int_ext || null, location: s.location || null,
        time_of_day: s.time_of_day || null, description: s.description || '', delivery_direction: s.delivery_direction || '',
    }));
    provenance.scenes = { from: BRIEF_FIELDS.scenes.from, ids: scenes.map(s => s.id) };

    // ── The screenplay: exact version, exact passages ───────────────────────
    const script = db.prepare(
        'SELECT id, version, fountain_content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    const passages = [];
    if (!script || !script.fountain_content) {
        warnings.push('this project has no Fountain screenplay, so the brief carries no passages');
    } else {
        const ordered = db.prepare(
            `SELECT id FROM film_scenes WHERE project_id = ? AND status != 'removed'
              ORDER BY CAST(scene_number AS INTEGER), scene_number`).all(projectId).map(r => r.id);
        const spans = sceneSpans(script.fountain_content);
        const lines = script.fountain_content.split('\n');
        for (const s of scenes) {
            const index = ordered.indexOf(s.id);
            const span = index >= 0 ? spans[index] : null;
            if (!span) { warnings.push(`scene ${s.scene_number} is not in screenplay v${script.version}`); continue; }
            passages.push({ scene_id: s.id, scene_number: s.scene_number, heading: span.heading, text: lines.slice(span.start, span.end + 1).join('\n') });
        }
    }
    const screenplay = { script_id: script ? script.id : null, version: script ? script.version : null, passages };
    provenance.screenplay = { from: BRIEF_FIELDS.screenplay.from, ids: script ? [script.id] : [], version: screenplay.version };

    // ── Cast and dialogue ───────────────────────────────────────────────────
    cast.delete('');
    const characters = [...cast].sort();
    provenance.characters = { from: BRIEF_FIELDS.characters.from, ids: shots.map(s => s.id) };
    const shotIdsHere = [...new Set(shots.map(s => s.id).filter(Boolean))];
    const dialogueMs = shotIdsHere.length ? db.prepare(
        `SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM film_assets
          WHERE asset_type = 'audio_dialogue' AND shot_id IN (${shotIdsHere.map(() => '?').join(',')})`).get(...shotIdsHere).ms || 0 : 0;
    const weight = dialogueWeight(dialogueLines);
    const dialogue = { lines: dialogueLines, measured_ms: dialogueMs, band: weight.band, note: weight.note };
    provenance.dialogue = { from: BRIEF_FIELDS.dialogue.from, ids: shots.map(s => s.id) };

    // ── The look ────────────────────────────────────────────────────────────
    const look = { style_preset: project.style_preset || '', genre: project.genre || '', optics };
    provenance.look = { from: BRIEF_FIELDS.look.from, ids: [projectId] };

    // ── Cues written for these scenes, and motifs made anywhere ─────────────
    const cueRows = sceneIds.length ? db.prepare(
        `SELECT * FROM film_music_cues WHERE scene_id IN (${sceneIds.map(() => '?').join(',')})
          ORDER BY CASE cue_type WHEN 'score' THEN 0 ELSE 1 END, start_ms, created_at, id`).all(...sceneIds) : [];
    const cues = cueRows.map(c => {
        const sections = parseJson(c.sections_json || '[]', []);
        if (sections === undefined) warnings.push(`cue ${c.title || c.id}: its sections are not valid JSON`);
        return {
            id: c.id, scene_id: c.scene_id, cue_type: c.cue_type, title: c.title || '', description: c.description || '',
            mood: c.mood || '', genre: c.genre || '', tempo_bpm: Number(c.tempo_bpm) || 0, key_signature: c.key_signature || '',
            instruments: parseJson(c.instruments || '[]', []) || [], reference_track: c.reference_track || '',
            start_ms: Number(c.start_ms) || 0, duration_ms: Number(c.duration_ms) || 0,
            sections: Array.isArray(sections) ? sections : [], negative_prompt: c.negative_prompt || '',
            generated_asset_id: c.generated_asset_id || null,
        };
    });
    provenance.cues = { from: BRIEF_FIELDS.cues.from, ids: cues.map(c => c.id) };

    const motifs = db.prepare(
        `SELECT c.id AS cue_id, c.title, c.scene_id, s.scene_number, c.generated_asset_id AS asset_id, a.duration_ms, a.file_name
           FROM film_music_cues c JOIN film_assets a ON a.id = c.generated_asset_id
      LEFT JOIN film_scenes s ON s.id = c.scene_id
          WHERE c.project_id = ? AND c.cue_type = 'score' ORDER BY c.created_at, c.id`).all(projectId)
        .map(m => ({ cue_id: m.cue_id, title: m.title || '', scene_id: m.scene_id, scene_number: m.scene_number === null ? null : String(m.scene_number),
            asset_id: m.asset_id, duration_ms: Number(m.duration_ms) || 0, file_name: m.file_name, in_this_picture: sceneIds.includes(m.scene_id) }));
    provenance.motifs = { from: BRIEF_FIELDS.motifs.from, ids: motifs.map(m => m.asset_id) };

    // ── The accepted emotional arc ──────────────────────────────────────────
    const emotion = session ? db.prepare(
        `SELECT id, start_ms, end_ms, label, valence, arousal, intensity, source FROM film_music_emotion_ranges
          WHERE session_id = ? AND status = 'accepted' ORDER BY start_ms, id`).all(session.id) : [];
    provenance.emotion = { from: BRIEF_FIELDS.emotion.from, ids: emotion.map(e => e.id) };

    // ── Length ──────────────────────────────────────────────────────────────
    const length = edit && cursor > 0
        ? { ms: cursor, source: `edit v${edit.version}, measured from the exported picture` }
        : cursor > 0
        ? { ms: cursor, source: `${measuredCount} shot(s) measured from footage and ${cardCount} from the card` }
        : dialogueMs > 0
            ? { ms: dialogueMs, source: 'the measured dialogue, because no shot has a length yet' }
            : { ms: null, source: 'nothing measured: no footage, no card length, no dialogue' };
    provenance.length = { from: BRIEF_FIELDS.length.from, ids: [] };

    const brief = { picture, screenplay, scenes, characters, dialogue, look, cues, emotion, motifs, length };

    // ── Fingerprints: per field, and the drift-bearing ones together ────────
    const field_fingerprints = {};
    for (const field of Object.keys(BRIEF_FIELDS)) field_fingerprints[field] = hash(driftView(field, brief[field]));
    const fingerprints = {
        script: field_fingerprints.screenplay,
        picture: field_fingerprints.picture,
        context: hash(Object.fromEntries(DRIFT_FIELDS.map(f => [f, field_fingerprints[f]]))),
    };

    return { ok: true, brief, fingerprints, field_fingerprints, provenance, warnings };
}

/**
 * What of a field counts for drift. Ids and file names are identity, not
 * content: a motif re-registered under a new asset id is the same music.
 */
function driftView(field, value) {
    if (field === 'picture') {
        return {
            kind: value.kind, id: value.id,
            // An edit's timing IS its picture: a trim that moves a cut moves where the music must turn.
            ...(value.kind === 'edit' ? { total_ms: value.total_ms, starts: value.shots.map(s => s.start_ms) } : {}),
            shots: value.shots.map(s => ({ id: s.id, code: s.shot_code, duration_ms: s.duration_ms, action: s.action, characters: s.characters, dialogue: s.dialogue, camera: s.camera })),
        };
    }
    if (field === 'screenplay') return { version: value.version, passages: value.passages.map(p => ({ scene_id: p.scene_id, text: p.text })) };
    if (field === 'motifs') return value.map(m => ({ cue_id: m.cue_id, title: m.title, duration_ms: m.duration_ms }));
    if (field === 'emotion') return value.map(e => ({ start_ms: e.start_ms, end_ms: e.end_ms, label: e.label, valence: e.valence, arousal: e.arousal, intensity: e.intensity }));
    return value;
}

/** Which fields moved between two compiles. */
function compareContext(before, after) {
    const changed = [];
    for (const field of Object.keys(BRIEF_FIELDS)) {
        const a = before && before.field_fingerprints ? before.field_fingerprints[field] : null;
        const b = after && after.field_fingerprints ? after.field_fingerprints[field] : null;
        if (a !== b) changed.push({ field, before: a, after: b, drift: BRIEF_FIELDS[field].drift });
    }
    return { drifted: changed.some(c => c.drift), changed };
}

/**
 * Has the picture or the script moved since the session was stamped?
 *
 * Reports. Never writes. A session with no fingerprints is `tracked: false`
 * and NOT drifted — reading it as drifted would fire on every session on the
 * day this shipped, which is the fastest route to the warning being ignored.
 */
function sessionDrift(db, sessionId) {
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return { ok: false, error: `no score session ${sessionId}`, tracked: false, drifted: false };
    const tracked = !!(session.context_fingerprint || session.script_fingerprint || session.picture_fingerprint);
    const now = compileScoreContext(db, { sessionId });
    if (!now.ok) return { ok: false, error: now.error, tracked, drifted: false };
    const cmp = (stored, current) => ({ stored: stored || null, current, changed: !!stored && stored !== current });
    const script = cmp(session.script_fingerprint, now.fingerprints.script);
    const picture = cmp(session.picture_fingerprint, now.fingerprints.picture);
    const context = cmp(session.context_fingerprint, now.fingerprints.context);
    // Which fields: recompile against the stored per-field record when there
    // is one; otherwise the two coarse answers are all that can be said.
    let fields = [];
    if (context.changed) {
        fields = DRIFT_FIELDS.filter(f => (f === 'screenplay' && script.changed) || (f === 'picture' && picture.changed));
        if (!fields.length) fields = ['context'];
    }
    /*
     * A NEWER CUT. A session is pinned to the edit version it was written
     * against, so a v3 arriving changes nothing about v2 — and that is exactly
     * why it has to be said: the film is now v3 and the score is timed to v2.
     * Reported, never applied; moving the session to v3 is the rebase.
     */
    let newer_edit = null;
    if (session.edit_id) {
        const mine = db.prepare('SELECT project_id, version FROM film_edits WHERE id = ?').get(session.edit_id);
        const latest = mine && db.prepare('SELECT id, version, name FROM film_edits WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(mine.project_id);
        if (latest && latest.version > mine.version) newer_edit = { id: latest.id, version: latest.version, name: latest.name, written_against: mine.version };
    }
    return { ok: true, tracked, drifted: tracked && context.changed, script, picture, context, fields, newer_edit, warnings: now.warnings };
}

/**
 * Adopt the current brief as what the session is written against. The
 * explicit rebase — never done by a read, never done by a save.
 */
function stampSessionContext(db, sessionId) {
    const now = compileScoreContext(db, { sessionId });
    if (!now.ok) return { ok: false, error: now.error };
    db.prepare(
        `UPDATE film_music_sessions SET script_fingerprint = ?, picture_fingerprint = ?, context_fingerprint = ?,
                script_id = COALESCE(?, script_id), updated_at = datetime('now') WHERE id = ?`)
        .run(now.fingerprints.script, now.fingerprints.picture, now.fingerprints.context, now.brief.screenplay.script_id, sessionId);
    return { ok: true, fingerprints: now.fingerprints, warnings: now.warnings };
}

module.exports = { BRIEF_FIELDS, DRIFT_FIELDS, compileScoreContext, compareContext, sessionDrift, stampSessionContext };
