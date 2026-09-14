/**
 * A cue's NOTES: parts over a harmonic plan, written by the agent or played by the director.
 *
 *   GET    /film/music-cues/:id/midi                     free: the length contract, the GM programs, the current notes
 *   PUT    /film/music-cues/:id/midi                     write the plan and the parts (the agent composes, nothing here does)
 *   POST   /film/music-cues/:id/midi/parts/:part/import  replace ONE part with a .mid the director performed
 *   DELETE /film/music-cues/:id/midi                     remove the note file (performed originals are kept)
 *
 * GRD-3994. No model is called: the connected agent reads `music_brief`, decides
 * the harmony and writes the parts, and this route validates them against the
 * cue's length and prints a Standard MIDI File. No renderer either — that is the
 * next phase; the file is already useful in Ableton.
 *
 * Deliberately NOT a MEDIA_IMPORTS target. That registry is "a file stored where
 * a generated one goes", pinned at eighteen targets by five epic documents; a
 * performed .mid is neither — it replaces one PART of a note list, and the file
 * the cue carries is rebuilt from the whole list. The upload keeps its original
 * bytes beside the rebuilt file, because what somebody played is the source.
 *
 * Registered as film_assets `other` + metadata.kind 'midi', on the 3D precedent:
 * the asset_type CHECK cannot be widened in place. One note file per cue,
 * updated in place, so its asset id — and anything pointing at it — is stable.
 */

const { db, generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('../lib/file-storage');
const midi = require('../lib/midi');
const fs = require('fs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** The cue, its scene, and the length every note must fit inside — from the same walk the score uses. */
function cueContext(cueId) {
    const cue = db.prepare('SELECT * FROM film_music_cues WHERE id = ?').get(cueId);
    if (!cue) return null;
    const scene = cue.scene_id ? db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(cue.scene_id) : null;
    const project = db.prepare('SELECT id, target_fps FROM film_projects WHERE id = ?').get(cue.project_id) || {};
    const fps = Number(project.target_fps) > 0 ? Number(project.target_fps) : 24;

    /*
     * The precedence is cueSeconds' — an explicit cue length, then the measured
     * cut, then the measured dialogue — but kept in MILLISECONDS. cueSeconds
     * rounds to whole seconds for a prompt, and a note list checked against a
     * rounded length refuses a note that ends inside the real cut.
     */
    let cutMs = 0, dialogueMs = 0;
    if (scene) {
        const { sceneScoreContext } = require('./music-gen')._internal;
        const c = sceneScoreContext(scene);
        cutMs = Number(c.cut_ms) || 0;
        dialogueMs = Number(c.dialogue_ms) || 0;
    }
    const [ms, source] = Number(cue.duration_ms) > 0 ? [Number(cue.duration_ms), 'cue']
        : cutMs > 0 ? [cutMs, 'footage']
            : dialogueMs > 0 ? [dialogueMs, 'dialogue']
                : [null, 'nothing measured'];
    return { cue, scene, projectId: cue.project_id, fps, frame_ms: 1000 / fps, length: { ms, source } };
}

function currentAsset(cueId) {
    return db.prepare(
        `SELECT * FROM film_assets
          WHERE asset_type = 'other' AND json_valid(metadata)
            AND json_extract(metadata, '$.kind') = 'midi'
            AND json_extract(metadata, '$.cue_id') = ?
          ORDER BY created_at DESC LIMIT 1`).get(cueId);
}

function scoreOf(asset) {
    try { return (JSON.parse(asset.metadata || '{}') || {}).score || null; } catch (_) { return null; }
}

function describe(asset, ctx) {
    if (!asset) return null;
    let meta = {};
    try { meta = JSON.parse(asset.metadata || '{}') || {}; } catch (_) { meta = {}; }
    return {
        asset_id: asset.id,
        version: asset.version,
        url: getFileUrl('music', ctx.projectId, asset.file_name, asset.created_at + ':' + asset.version),
        length_ms: asset.duration_ms,
        parts: ((meta.score && meta.score.parts) || []).map(p => ({
            name: p.name, instrument: p.instrument, program: p.program, drums: !!p.drums,
            source: p.source, notes: p.notes.length,
        })),
        performed_originals: meta.performed_originals || [],
    };
}

const CONTRACT = Object.freeze({
    times: 'milliseconds from the start of the cue, never beats',
    note: '{ start_ms, duration_ms, pitch 0-127, velocity 1-127 }',
    part: '{ name, instrument, program 0-127 (General MIDI) or drums: true, notes: [...] }',
    plan: '{ tempo_bpm 20-300, meter "4/4", key "D minor", chords: [{ start_ms, symbol }], sections: [{ name, start_ms, end_ms }] }',
    length: 'every note must end inside the cue; plan.length_ms, if given, must match the cue within one frame',
    performed: 'a part imported from a played .mid is kept through a rewrite unless it is named in replace_performed',
});

function getMidi(res, ctx) {
    const asset = currentAsset(ctx.cue.id);
    return json(res, 200, {
        cue: { id: ctx.cue.id, title: ctx.cue.title, cue_type: ctx.cue.cue_type, scene_id: ctx.cue.scene_id },
        length: { ms: ctx.length.ms, seconds: ctx.length.ms ? Math.round(ctx.length.ms / 100) / 10 : null, source: ctx.length.source },
        frame_ms: Math.round(ctx.frame_ms * 1000) / 1000,
        contract: CONTRACT,
        gm_programs: midi.GM_PROGRAMS,
        notes: describe(asset, ctx),
        score: asset ? scoreOf(asset) : null,
        spends: 'nothing',
        note: 'Read music_brief first for what the scene is. Write the plan (tempo, meter, key, chords, '
            + 'sections) and then one part per instrument against it. A part the director played '
            + 'replaces yours and is kept through a rewrite.',
    });
}

/**
 * Validate, print, read back, register. The read-back is not ceremony: a file
 * whose notes or length differ from the list it was printed from is refused
 * here rather than handed to a DAW.
 */
function storeScore(ctx, score, extra = {}) {
    const bytes = midi.writeSmf(score);
    const back = midi.parseSmf(bytes);
    const wanted = score.parts.reduce((n, p) => n + p.notes.length, 0);
    const got = back.tracks.reduce((n, t) => n + t.notes.length, 0);
    if (got !== wanted) throw new Error(`the written file holds ${got} notes and the list has ${wanted}`);
    if (Math.abs(back.length_ms - score.plan.length_ms) > ctx.frame_ms) {
        throw new Error(`the written file is ${back.length_ms}ms and the cue is ${score.plan.length_ms}ms`);
    }

    const prior = currentAsset(ctx.cue.id);
    let priorMeta = {};
    try { priorMeta = prior ? JSON.parse(prior.metadata || '{}') || {} : {}; } catch (_) { priorMeta = {}; }
    const fileName = `cue_${ctx.cue.id.slice(0, 8)}_notes.mid`;
    const filePath = saveFile(ctx.projectId, 'music', fileName, bytes);
    const originals = [...(priorMeta.performed_originals || []), ...(extra.performed_original ? [extra.performed_original] : [])]
        // A performed original belongs to a part that still exists, or it is history nobody can use.
        .filter(o => score.parts.some(p => p.name === o.part && p.source === 'performed'));
    const metadata = JSON.stringify({
        kind: 'midi', cue_id: ctx.cue.id, score, performed_originals: originals,
        written_by: extra.written_by || 'agent',
    });
    const anyAgent = score.parts.some(p => p.source === 'agent');

    if (prior) {
        db.prepare(`UPDATE film_assets SET file_path = ?, file_name = ?, size_bytes = ?, duration_ms = ?,
                        version = version + 1, license_source = ?, metadata = ?, created_at = datetime('now')
                     WHERE id = ?`)
            .run(filePath, fileName, bytes.length, score.plan.length_ms, anyAgent ? 'generated' : 'external', metadata, prior.id);
    } else {
        db.prepare(`INSERT INTO film_assets
            (id, project_id, scene_id, asset_type, file_path, file_name, format, mime_type,
             size_bytes, duration_ms, version, license_source, license_status, metadata)
            VALUES (?, ?, ?, 'other', ?, ?, 'mid', 'audio/midi', ?, ?, 1, ?, 'unknown', ?)`)
            .run(generateId(), ctx.projectId, ctx.cue.scene_id || null, filePath, fileName, bytes.length,
                score.plan.length_ms, anyAgent ? 'generated' : 'external', metadata);
    }
    return describe(currentAsset(ctx.cue.id), ctx);
}

function refuseNoLength(res, ctx) {
    return json(res, 409, {
        error: 'this cue has no length to write notes against',
        reason: ctx.cue.scene_id
            ? 'the scene has no measured footage or dialogue yet, and the cue sets no duration_ms'
            : 'the cue belongs to no scene and sets no duration_ms',
        fix: 'set duration_ms on the cue with music_cue_update, or give the scene footage or dialogue',
    });
}

function writeMidi(req, res, ctx) {
    if (!ctx.length.ms) return refuseNoLength(res, ctx);
    const body = req.body || {};
    const prior = currentAsset(ctx.cue.id);
    const priorScore = prior ? scoreOf(prior) : null;
    const replace = new Set((Array.isArray(body.replace_performed) ? body.replace_performed : []).map(n => String(n).toLowerCase()));

    /*
     * A rewrite never silently drops what somebody PLAYED. A performed part
     * named in the new list is kept unless it is named in replace_performed; one
     * the new list does not mention is kept as it is. Agent parts are the
     * agent's to rewrite, so the new list replaces them.
     */
    const incoming = (Array.isArray(body.parts) ? body.parts : []).map(p => ({ ...p, source: 'agent' }));
    const kept = [];
    const parts = [];
    const performed = ((priorScore && priorScore.parts) || []).filter(p => p.source === 'performed');
    for (const p of incoming) {
        const played = performed.find(x => x.name.toLowerCase() === String(p.name || '').toLowerCase());
        if (played && !replace.has(played.name.toLowerCase())) { parts.push(played); kept.push(played.name); }
        else parts.push(p);
    }
    for (const played of performed) {
        const named = incoming.some(p => String(p.name || '').toLowerCase() === played.name.toLowerCase());
        if (!named) { parts.push(played); kept.push(played.name); }
    }

    const checked = midi.validateScore({ plan: body.plan, parts }, { length_ms: ctx.length.ms, frame_ms: ctx.frame_ms });
    if (!checked.ok) return json(res, 400, { error: checked.errors[0], errors: checked.errors, written: false });
    try {
        const notes = storeScore(ctx, checked.score, { written_by: 'agent' });
        return json(res, 200, {
            notes, kept_performed: kept,
            length: { ms: ctx.length.ms, source: ctx.length.source },
            note: kept.length
                ? `Kept ${kept.join(', ')} as played. Name them in replace_performed to write over them.`
                : 'Written. Open the .mid in a DAW, or play a part yourself and import it onto that part.',
        });
    } catch (err) {
        return json(res, 500, { error: err.message, written: false });
    }
}

function importPart(req, res, ctx, partName) {
    if (!ctx.length.ms) return refuseNoLength(res, ctx);
    const body = req.body || {};
    let bytes = Buffer.isBuffer(body.__raw) ? body.__raw : null;
    if (!bytes) {
        const m = String(body.data || '').match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/);
        if (!m) return json(res, 400, { error: 'no file supplied: send the .mid as a base64 data URI in `data`' });
        bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    }
    if (!midi.isMidi(bytes)) {
        return json(res, 400, { error: 'This file is not a Standard MIDI File (.mid). Export the clip as MIDI and try again.' });
    }
    let parsed;
    try { parsed = midi.parseSmf(bytes); } catch (err) { return json(res, 400, { error: err.message }); }

    const withNotes = parsed.tracks.filter(t => t.notes.length);
    if (!withNotes.length) return json(res, 400, { error: 'that MIDI file has no notes in it' });
    let chosen = withNotes;
    if (body.track != null && body.track !== '') {
        const want = String(body.track);
        chosen = withNotes.filter(t => String(t.index) === want || (t.name || '').toLowerCase() === want.toLowerCase());
        if (!chosen.length) {
            return json(res, 400, {
                error: `no track called "${want}" has notes`,
                tracks: withNotes.map(t => ({ index: t.index, name: t.name, notes: t.notes.length })),
            });
        }
    }
    const offset = Number(body.offset_ms) || 0;
    const notes = chosen.flatMap(t => t.notes).map(n => ({ ...n, start_ms: n.start_ms + offset }))
        .filter(n => n.start_ms >= 0);

    const prior = currentAsset(ctx.cue.id);
    const priorScore = prior ? scoreOf(prior) : null;
    const plan = priorScore ? priorScore.plan : {
        // A director may skip the agent entirely: the plan then comes from what they played.
        tempo_bpm: parsed.tempo_bpm, meter: parsed.time_signature,
        key: null, chords: [], sections: [],
    };
    const existing = ((priorScore && priorScore.parts) || []);
    const same = existing.find(p => p.name.toLowerCase() === partName.toLowerCase());
    const first = chosen[0];
    const drums = body.drums != null ? !!body.drums : same ? !!same.drums : !!first.drums;
    const program = body.program != null ? Number(body.program)
        : first.program != null ? first.program : same ? same.program : 0;
    const part = {
        name: same ? same.name : partName,
        instrument: body.instrument || first.instrument || (same && same.instrument) || undefined,
        program, drums, source: 'performed', notes,
    };
    const parts = same ? existing.map(p => (p === same ? part : p)) : [...existing, part];

    const checked = midi.validateScore({ plan: { ...plan, length_ms: undefined }, parts },
        { length_ms: ctx.length.ms, frame_ms: ctx.frame_ms });
    if (!checked.ok) {
        return json(res, 400, {
            error: checked.errors[0], errors: checked.errors, written: false,
            hint: 'a played take longer than the cue can be trimmed in the DAW, or shifted with offset_ms',
        });
    }

    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const slug = part.name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'part';
    const originalName = `cue_${ctx.cue.id.slice(0, 8)}_performed_${slug}_${stamp}.mid`;
    saveFile(ctx.projectId, 'music', originalName, bytes);

    try {
        const stored = storeScore(ctx, checked.score, {
            written_by: 'performed',
            performed_original: { part: part.name, file_name: originalName, name: String(body.name || '').slice(0, 200) || null, tracks: chosen.map(t => t.index) },
        });
        return json(res, 201, {
            notes: stored, part: part.name, replaced: !!same, note_count: notes.length,
            tempo_in_file: parsed.tempo_bpm, tempo_of_plan: checked.score.plan.tempo_bpm,
            note: (same ? `Replaced ${part.name} with what you played.` : `Added ${part.name} as played.`)
                + ' The original file is kept beside the rebuilt one.',
        });
    } catch (err) {
        return json(res, 500, { error: err.message, written: false });
    }
}

function deleteMidi(res, ctx) {
    const asset = currentAsset(ctx.cue.id);
    if (!asset) return json(res, 404, { error: 'this cue has no notes' });
    try { if (asset.file_path && fs.existsSync(asset.file_path)) fs.unlinkSync(asset.file_path); } catch (_) { /* gone is fine */ }
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(asset.id);
    return json(res, 200, {
        deleted: asset.id,
        note: 'The note file is gone. Files the director played are kept in the project’s music folder.',
    });
}

function handleMusicMidi(req, res, parts) {
    const cueId = parts[2];
    if (!UUID_RE.test(String(cueId || ''))) return json(res, 400, { error: 'Invalid cue ID' });
    if (parts[3] !== 'midi') return json(res, 404, { error: 'Not found' });
    const ctx = cueContext(cueId);
    if (!ctx) return json(res, 404, { error: 'Cue not found' });

    if (!parts[4]) {
        if (req.method === 'GET') return getMidi(res, ctx);
        if (req.method === 'PUT') return writeMidi(req, res, ctx);
        if (req.method === 'DELETE') return deleteMidi(res, ctx);
    }
    if (parts[4] === 'parts' && parts[5] && parts[6] === 'import' && req.method === 'POST') {
        let name;
        try { name = decodeURIComponent(parts[5]).trim(); } catch (_) { name = ''; }
        if (!name) return json(res, 400, { error: 'name the part this take replaces' });
        return importPart(req, res, ctx, name);
    }
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleMusicMidi, _internal: { cueContext, currentAsset } };
