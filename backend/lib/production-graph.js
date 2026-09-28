/**
 * THE PRODUCTION GRAPH — eight pages read as one picture.
 *
 * Every node here is a view of something that already exists: a shot row and
 * its frames, a sequence row, a music cue, the assets a generation produced.
 * Nothing is stored twice. The graph adds exactly three facts of its own —
 * where a node sits (production_node_layout), how two shots join
 * (film_sequences.joins_json) and which clip plays (the selected_video pointers)
 * — and everything else is read from the tables the old pages already wrote.
 *
 * VERSIONS ARE ASSETS. film_shot_versions was the obvious home and holds no
 * rows: nothing but the render ledger writes it. Every frame, clip and sound
 * this engine has made is a film_assets row, so that is what a version node is,
 * and "selected" is the pointer the player already reads — current_frame_version
 * for a frame, selected_video_asset_id for a clip, generated_asset_id for a cue.
 */

const fs = require('fs');
const path = require('path');

const NODE_SIZE = Object.freeze({
    shot: { w: 200, h: 180 },
    sequence: { w: 240, h: 280 },
    video: { w: 200, h: 178 },
    sound: { w: 200, h: 130 },
    audio: { w: 180, h: 110 },
    link: { w: 200, h: 150 },
});

const VIDEO_TYPES = ['video_final', 'video_synced', 'video_raw'];
const SOUND_KIND = Object.freeze({ sfx: 'sfx', ambient: 'ambient', score: 'music', source: 'music', transition: 'music' });
const LINK_MODES = Object.freeze(['shot_image', 'video_last_frame']);

function parseJson(text, fallback) {
    if (text == null || text === '') return fallback;
    try { const v = JSON.parse(text); return v == null ? fallback : v; } catch (_) { return fallback; }
}

function urlFor(filePath, version) {
    try { return require('./file-storage').urlForPath(filePath, version) || null; } catch (_) { return null; }
}

function metaOf(row) { return parseJson(row && row.metadata, {}) || {}; }

// ── Frames, clips, sounds ──────────────────────────────────────────────────

/** A shot's frames, oldest first, and which one is on the board. */
function shotFrames(db, shot) {
    const rows = db.prepare(
        `SELECT id, version, file_path, created_at, provider, provider_model, metadata FROM film_assets
          WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe')
          ORDER BY version ASC, created_at ASC`).all(shot.id)
        // In-between stations are frames of a STRIP, not attempts at this shot.
        .filter(r => metaOf(r).station_index == null);
    const byVersion = new Map();
    for (const r of rows) byVersion.set(Number(r.version) || 0, r);   // newest row per version wins
    const list = [...byVersion.values()];
    const highest = list.reduce((m, r) => Math.max(m, Number(r.version) || 0), 0);
    const selected = shot.current_frame_version != null ? Number(shot.current_frame_version) : highest;
    return list.map(r => ({
        asset_id: r.id,
        version: Number(r.version) || 0,
        url: urlFor(r.file_path, r.created_at),
        path: r.file_path,
        provider: r.provider || null,
        model: r.provider_model || null,
        selected: (Number(r.version) || 0) === selected,
    }));
}

function videoRow(r, selectedId, extra) {
    const m = metaOf(r);
    return {
        asset_id: r.id,
        kind: 'video',
        asset_type: r.asset_type,
        url: urlFor(r.file_path),
        path: r.file_path,
        duration_ms: Number(r.duration_ms) || 0,
        provider: r.provider || null,
        model: r.provider_model || null,
        created_at: r.created_at,
        prompt: m.prompt || null,
        seed: m.seed != null ? m.seed : null,
        selected: r.id === selectedId,
        ...(extra || {}),
    };
}

/**
 * A shot's OWN clips. Anything a sequence made — a leg, a master, a native
 * multi-shot clip, an upload — belongs to the sequence and is listed there, or
 * the same file would appear as two versions of two different things.
 */
function shotVideos(db, shot, sequenceAssetIds) {
    const rows = db.prepare(
        `SELECT id, asset_type, file_path, duration_ms, provider, provider_model, created_at, metadata
           FROM film_assets WHERE shot_id = ? AND asset_type IN (${VIDEO_TYPES.map(() => '?').join(',')})
          ORDER BY created_at ASC`).all(shot.id, ...VIDEO_TYPES)
        .filter(r => !metaOf(r).sequence_id && !(sequenceAssetIds && sequenceAssetIds.has(r.id)));
    return rows.map((r, i) => videoRow(r, shot.selected_video_asset_id, { version: i + 1 }));
}

/** A sequence's own clips: the stitched master, a native clip, an upload. */
function sequenceVideos(db, seq) {
    const rows = db.prepare(
        `SELECT id, asset_type, file_path, duration_ms, provider, provider_model, created_at, metadata
           FROM film_assets
          WHERE project_id = ? AND asset_type IN (${VIDEO_TYPES.map(() => '?').join(',')})
            AND (json_extract(metadata, '$.sequence_id') = ? OR id = ?)
          ORDER BY created_at ASC`).all(seq.project_id, ...VIDEO_TYPES, seq.id, seq.output_asset_id || '');
    const legs = [], versions = [];
    for (const r of rows) {
        const m = metaOf(r);
        if (m.station_index != null) continue;
        // A LEG is part of a leg-by-leg version, not a version on its own.
        if (m.from && m.to && m.kind !== 'sequence_master' && m.kind !== 'native_multi_shot') legs.push(r);
        else versions.push(r);
    }
    return {
        versions: versions.map((r, i) => videoRow(r, seq.selected_video_asset_id, {
            version: i + 1, mode: metaOf(r).kind || 'upload',
        })),
        legs: legs.map(r => ({ asset_id: r.id, from: metaOf(r).from, to: metaOf(r).to,
            url: urlFor(r.file_path), duration_ms: Number(r.duration_ms) || 0 })),
    };
}

/**
 * A cue's generations. Written with `metadata.cue_id` from the production graph
 * on; the one it currently links (`generated_asset_id`) is always included, so a
 * cue generated before that still shows the version it has.
 */
function cueVersions(db, cue) {
    const rows = db.prepare(
        `SELECT id, asset_type, file_path, duration_ms, provider, provider_model, created_at, metadata
           FROM film_assets WHERE project_id = ?
            AND (json_extract(metadata, '$.cue_id') = ? OR id = ?)
          ORDER BY created_at ASC`).all(cue.project_id, cue.id, cue.generated_asset_id || '');
    return rows.map((r, i) => ({
        asset_id: r.id,
        kind: 'audio',
        version: i + 1,
        asset_type: r.asset_type,
        url: urlFor(r.file_path),
        path: r.file_path,
        duration_ms: Number(r.duration_ms) || 0,
        provider: r.provider || null,
        model: r.provider_model || null,
        created_at: r.created_at,
        prompt: metaOf(r).prompt || null,
        selected: r.id === cue.generated_asset_id,
    }));
}

// ── Linked frames ──────────────────────────────────────────────────────────

/**
 * What a borrowed frame is RIGHT NOW. Resolved at generate time to the source's
 * selected version, never to the version it was when it was linked — the
 * director's latest choice is the one the next clip should start on.
 *
 * `side` decides which end of the source is borrowed: a sequence that STARTS on
 * another takes that sequence's LAST picture (it hands off), and one that ENDS
 * on another takes its FIRST.
 */
function resolveLinkedFrame(db, ref, side) {
    if (!ref || !ref.sequence_id) return { ok: false, reason: 'no frame is linked' };
    const src = db.prepare('SELECT * FROM film_sequences WHERE id = ?').get(ref.sequence_id);
    if (!src) return { ok: false, reason: 'the sequence this frame is borrowed from has been deleted' };
    const mode = LINK_MODES.includes(ref.mode) ? ref.mode : 'shot_image';

    if (mode === 'video_last_frame') {
        const assetId = src.selected_video_asset_id || src.output_asset_id;
        const asset = assetId ? db.prepare('SELECT id, file_path, project_id FROM film_assets WHERE id = ?').get(assetId) : null;
        if (!asset || !asset.file_path) {
            return { ok: false, reason: `${src.name || 'That sequence'} has no selected video to borrow a frame from` };
        }
        const { extractFrame, inspectMedia } = require('./ffmpeg');
        const fsDir = require('./file-storage').ensureDir(asset.project_id, 'storyboards');
        const out = path.join(fsDir, `linked_${src.id.slice(0, 8)}_${asset.id.slice(0, 8)}_${side === 'end' ? 'first' : 'last'}.png`);
        if (!fs.existsSync(out)) {
            let at = 0;
            if (side !== 'end') {
                const info = (() => { try { return inspectMedia(asset.file_path); } catch (_) { return null; } })();
                const secs = info && info.ok !== false ? Number(info.durationSeconds) || 0 : 0;
                at = secs > 0.1 ? secs - 0.05 : 0;
            }
            const got = extractFrame(asset.file_path, { out, atSeconds: at });
            if (!got.ok) return { ok: false, reason: `could not take a frame from ${src.name || 'that sequence'}'s video: ${got.reason}` };
        }
        return {
            ok: true, mode, side, path: out, url: urlFor(out),
            source_sequence_id: src.id, source_name: src.name,
            label: `${side === 'end' ? 'first' : 'last'} frame of ${src.name || 'sequence'} video`,
            fingerprint: `${src.id}:video:${asset.id}:${side}`,
        };
    }

    const ids = parseJson(src.shot_ids, []);
    const shotId = ref.shot_id && ids.includes(ref.shot_id) ? ref.shot_id
        : (side === 'end' ? ids[0] : ids[ids.length - 1]);
    const shot = shotId ? db.prepare('SELECT id, shot_code, current_frame_version FROM film_shots WHERE id = ?').get(shotId) : null;
    if (!shot) return { ok: false, reason: `${src.name || 'That sequence'} has no shot to borrow a frame from` };
    const frame = shotFrames(db, shot).find(f => f.selected);
    if (!frame) return { ok: false, reason: `${shot.shot_code} has no frame yet` };
    return {
        ok: true, mode, side, path: frame.path, url: frame.url,
        source_sequence_id: src.id, source_name: src.name,
        shot_id: shot.id, shot_code: shot.shot_code, version: frame.version,
        label: `${shot.shot_code} · v${frame.version}`,
        fingerprint: `${src.id}:shot:${shot.id}:v${frame.version}`,
    };
}

/** Both links of a sequence, and whether they moved since it last generated. */
function linkState(db, seq) {
    const start = parseJson(seq.start_frame_ref, null);
    const end = parseJson(seq.end_frame_ref, null);
    const out = {
        start: start ? { ref: start, ...resolveLinkedFrame(db, start, 'start') } : null,
        end: end ? { ref: end, ...resolveLinkedFrame(db, end, 'end') } : null,
    };
    out.fingerprint = linkFingerprintOf(out);
    // Never generated with a link = nothing to be stale against, the rule every
    // fingerprint here follows: NULL means "outside the workflow".
    out.stale = !!(seq.link_fingerprint && out.fingerprint && seq.link_fingerprint !== out.fingerprint);
    return out;
}

function linkFingerprintOf(state) {
    const parts = [];
    for (const side of ['start', 'end']) {
        const s = state && state[side];
        if (s) parts.push(`${side}=${s.ok ? s.fingerprint : 'unresolved'}`);
    }
    return parts.length ? parts.join('|') : null;
}

/**
 * Validate a frame reference before it is stored. A reference to the sequence
 * itself, to another project, or to a shot outside the source is refused rather
 * than kept and resolved to something nobody chose.
 */
function checkFrameRef(db, seq, ref) {
    if (ref === null) return { ok: true, value: null };
    if (!ref || typeof ref !== 'object') return { ok: false, error: 'a frame reference is { sequence_id, mode }' };
    if (ref.sequence_id === seq.id) return { ok: false, error: 'a sequence cannot borrow a frame from itself' };
    const src = db.prepare('SELECT id, project_id, shot_ids FROM film_sequences WHERE id = ?').get(ref.sequence_id);
    if (!src || src.project_id !== seq.project_id) return { ok: false, error: 'the linked sequence is not in this project' };
    const mode = ref.mode || 'shot_image';
    if (!LINK_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${LINK_MODES.join(', ')}` };
    if (ref.shot_id && !parseJson(src.shot_ids, []).includes(ref.shot_id)) {
        return { ok: false, error: 'that shot is not in the linked sequence' };
    }
    return { ok: true, value: JSON.stringify({ sequence_id: src.id, mode, ...(ref.shot_id ? { shot_id: ref.shot_id } : {}) }) };
}

// ── Layout ─────────────────────────────────────────────────────────────────

const GAP = 24;

/**
 * Where every node goes if nobody has moved it: one group per sequence, shots in
 * a column, the sequence to their right, versions right of their parent, sound
 * under the sequence. Unsequenced shots group by scene. Deterministic, so a
 * reload places an untouched node exactly where it was.
 */
function autoLayout(graph) {
    const pos = {};
    const groups = [];
    let ox = 20;
    const put = (key, x, y) => { pos[key] = { x, y }; };
    const nodeOf = new Map(graph.nodes.map(n => [n.key, n]));
    const h = key => (NODE_SIZE[(nodeOf.get(key) || {}).type] || { h: 120 }).h;

    for (const g of graph.groups) {
        const x0 = ox, y0 = 44;
        let colY = y0;
        const shotX = x0 + 20;
        for (const key of g.links_start || []) { put(key, shotX, colY); colY += h(key) + GAP; }
        for (const key of g.shots) { put(key, shotX, colY); colY += h(key) + GAP; }
        let bottom = colY;

        let nextX = shotX + 220 + 40;
        if (g.sequence) {
            put(g.sequence, nextX, y0 + 20);
            let ly = y0 + 20 + h(g.sequence) + GAP;
            for (const key of g.links_end || []) { put(key, nextX, ly); ly += h(key) + GAP; }
            bottom = Math.max(bottom, ly);
            nextX += 260 + 40;
        }
        // Versions and sounds share the next column; each sound's own versions
        // sit to its right, on its row.
        let vy = y0;
        for (const key of g.versions) { put(key, nextX, vy); vy += h(key) + GAP; }
        let widest = 200;
        for (const s of g.sounds) {
            put(s.key, nextX, vy);
            let sx = nextX + 200 + 40;
            for (const v of s.versions) { put(v, sx, vy); sx += 180 + 20; }
            widest = Math.max(widest, sx - nextX - 20);
            vy += Math.max(h(s.key), s.versions.length ? NODE_SIZE.audio.h : 0) + GAP;
        }
        bottom = Math.max(bottom, vy);
        const width = (nextX + widest + 20) - x0;
        groups.push({ id: g.id, label: g.label, x: x0, y: 8, w: width, h: bottom - 8 + 12 });
        ox = x0 + width + 20;
    }
    return { positions: pos, groups };
}

function readLayout(db, projectId) {
    const rows = db.prepare('SELECT node_key, x, y, pinned FROM production_node_layout WHERE project_id = ?').all(projectId);
    return new Map(rows.map(r => [r.node_key, { x: r.x, y: r.y, pinned: !!r.pinned }]));
}

// ── The graph ──────────────────────────────────────────────────────────────

/**
 * Everything the page draws, in one read.
 * @returns {{ nodes, edges, groups, running_order, meta }}
 */
function buildGraph(db, projectId) {
    const { ORDER_BY_SQL } = require('./running-order');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return null;
    const shots = db.prepare(
        `SELECT sh.*, s.scene_number, s.location, s.int_ext, s.time_of_day
           FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
          WHERE s.project_id = ? ORDER BY ${ORDER_BY_SQL}`).all(projectId);
    const sequences = db.prepare('SELECT * FROM film_sequences WHERE project_id = ? ORDER BY created_at').all(projectId);
    const cues = db.prepare('SELECT * FROM film_music_cues WHERE project_id = ? ORDER BY created_at, id').all(projectId);

    const nodes = [], edges = [];
    const edge = (from, fromPort, to, toPort, type, style) =>
        edges.push({ from, from_port: fromPort, to, to_port: toPort, type, style: style || 'solid' });

    // Which sequence owns each shot. First claim wins: a shot belongs to ONE.
    const owner = new Map();
    for (const q of sequences) for (const id of parseJson(q.shot_ids, [])) if (!owner.has(id)) owner.set(id, q.id);

    const seqAssets = new Set();
    const seqData = new Map();
    for (const q of sequences) {
        const vids = sequenceVideos(db, q);
        vids.versions.forEach(v => seqAssets.add(v.asset_id));
        vids.legs.forEach(l => seqAssets.add(l.asset_id));
        seqData.set(q.id, vids);
    }

    // Previs decisions the director locked — shown on the node, read-only.
    const previs = new Map();
    try {
        for (const r of db.prepare(`SELECT b.shot_id, b.locked_parts_json, b.approved_fingerprint FROM film_previs_blocking b
                JOIN film_shots sh ON sh.id = b.shot_id JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`).all(projectId)) {
            const locked = parseJson(r.locked_parts_json, []) || [];
            previs.set(r.shot_id, { locked: locked.length, approved: !!r.approved_fingerprint });
        }
    } catch (_) { /* a database before migration 116 has no locks to show */ }

    const shotNode = new Map();
    for (const sh of shots) {
        const card = parseJson(sh.scene_card_yaml, {}) || {};
        const frames = shotFrames(db, sh);
        const videos = shotVideos(db, sh, seqAssets);
        const sel = frames.find(f => f.selected) || null;
        const n = {
            key: `shot:${sh.id}`, type: 'shot', id: sh.id,
            shot_code: sh.shot_code, scene_id: sh.scene_id, scene_number: sh.scene_number,
            scene_label: `Sc ${sh.scene_number} · ${sh.location || ''}`.trim(),
            framing: (card.camera && card.camera.shot_type) || card.shot_type || '',
            duration_ms: Number(sh.duration_ms) || Number(card.duration_ms) || Math.round((Number(card.duration_seconds) || 0) * 1000) || 0,
            description: card.action || card.description || '',
            dialogue_lines: Array.isArray(card.dialogue) ? card.dialogue.length : 0,
            status: sh.status,
            sequence_id: owner.get(sh.id) || null,
            frames, selected_frame: sel,
            videos, selected_video_asset_id: sh.selected_video_asset_id || null,
            state: frames.length ? 'ok' : 'no_frame',
            previs: previs.get(sh.id) || { locked: 0, approved: false },
            held: !!sh.held_at, held_at: sh.held_at || null,
        };
        nodes.push(n); shotNode.set(sh.id, n);
        for (const v of videos) {
            const vk = `ver:${v.asset_id}`;
            nodes.push({ key: vk, type: 'video', parent: n.key, parent_label: sh.shot_code, ...v });
            edge(n.key, 'video', vk, 'in', 'video', 'solid');
        }
    }

    const seqNode = new Map();
    for (const q of sequences) {
        const ids = parseJson(q.shot_ids, []).filter(id => owner.get(id) === q.id);
        const vids = seqData.get(q.id);
        const links = linkState(db, q);
        const members = ids.map(id => shotNode.get(id)).filter(Boolean);
        const n = {
            key: `seq:${q.id}`, type: 'sequence', id: q.id, name: q.name || 'Sequence',
            description: q.description || '',
            shot_ids: ids,
            shot_codes: members.map(m => m.shot_code),
            joins: parseJson(q.joins_json, []),
            duration_ms: members.reduce((t, m) => t + (m.duration_ms || 0), 0),
            links, videos: vids.versions, legs: vids.legs,
            selected_video_asset_id: q.selected_video_asset_id || null,
            ready: members.length > 0 && members.every(m => m.frames.length),
            status: q.status,
            held: !!q.held_at, held_at: q.held_at || null,
        };
        nodes.push(n); seqNode.set(q.id, n);
        members.forEach((m, i) => edge(m.key, 'image', n.key, `slot:${i}`, 'image', m.frames.length ? 'solid' : 'dotted'));
        for (const v of vids.versions) {
            const vk = `ver:${v.asset_id}`;
            nodes.push({ key: vk, type: 'video', parent: n.key, parent_label: n.name, ...v });
            edge(n.key, 'video', vk, 'in', 'video', 'solid');
        }
        for (const side of ['start', 'end']) {
            const l = links[side];
            if (!l) continue;
            const lk = `link:${q.id}:${side}`;
            nodes.push({ key: lk, type: 'link', sequence_id: q.id, side, ...l, stale: !!links.stale });
            edge(lk, 'frame', n.key, side === 'start' ? 'start' : 'endlink', 'image', 'dashed');
            if (l.source_sequence_id && seqNode.has(l.source_sequence_id)) {
                edge(`seq:${l.source_sequence_id}`, 'end', lk, 'in', 'image', 'dashed');
            }
        }
    }
    // Links to a sequence declared later in the list are wired now that it exists.
    for (const q of sequences) {
        for (const side of ['start', 'end']) {
            const l = seqNode.get(q.id).links[side];
            if (l && l.source_sequence_id && !edges.some(e => e.to === `link:${q.id}:${side}` && e.to_port === 'in')) {
                if (seqNode.has(l.source_sequence_id)) edge(`seq:${l.source_sequence_id}`, 'end', `link:${q.id}:${side}`, 'in', 'image', 'dashed');
            }
        }
    }

    for (const c of cues) {
        const kind = SOUND_KIND[c.cue_type] || 'music';
        const versions = cueVersions(db, c);
        const parentKey = c.sequence_id && seqNode.has(c.sequence_id) ? `seq:${c.sequence_id}`
            : c.shot_id && shotNode.has(c.shot_id) ? `shot:${c.shot_id}` : null;
        const n = {
            key: `sound:${c.id}`, type: 'sound', id: c.id, kind, cue_type: c.cue_type,
            title: c.title || '', description: c.description || '', mood: c.mood || '', genre: c.genre || '',
            negative_prompt: c.negative_prompt || '', duration_ms: Number(c.duration_ms) || 0,
            scene_id: c.scene_id, shot_id: c.shot_id, sequence_id: c.sequence_id,
            parent: parentKey, versions, selected_asset_id: c.generated_asset_id || null,
            held: !!c.held_at, held_at: c.held_at || null,
        };
        nodes.push(n);
        if (parentKey) edge(parentKey, 'scene', n.key, 'scene', 'scene', 'dashed');
        for (const v of versions) {
            const vk = `ver:${v.asset_id}`;
            nodes.push({ key: vk, type: 'audio', parent: n.key, parent_label: n.title || kind, ...v });
            edge(n.key, 'audio', vk, 'in', 'audio', 'solid');
        }
        if (!versions.length) edge(n.key, 'audio', null, null, 'audio', 'dotted');
    }

    // ── Groups: one per sequence, then unsequenced shots by scene ─────────
    const groups = [];
    const shotsOfSeq = q => seqNode.get(q.id).shot_ids.map(id => `shot:${id}`);
    const soundGroup = parentKeys => cues
        .filter(c => parentKeys.includes(c.sequence_id ? `seq:${c.sequence_id}` : c.shot_id ? `shot:${c.shot_id}` : ''))
        .map(c => ({ key: `sound:${c.id}`, versions: cueVersions(db, c).map(v => `ver:${v.asset_id}`) }));
    const placedSound = new Set();

    // Where a shot plays in the film; a missing shot (an empty sequence) plays nowhere.
    const filmIndex = id => { const i = shots.findIndex(sh => sh.id === id); return i < 0 ? Infinity : i; };
    const orderedSeqs = sequences.slice().sort((a, b) => {
        const fa = shots.findIndex(s => seqNode.get(a.id).shot_ids[0] === s.id);
        const fb = shots.findIndex(s => seqNode.get(b.id).shot_ids[0] === s.id);
        return (fa < 0 ? 1e9 : fa) - (fb < 0 ? 1e9 : fb);
    });
    for (const q of orderedSeqs) {
        const sn = seqNode.get(q.id);
        const shotKeys = shotsOfSeq(q);
        const firstShot = shotNode.get(sn.shot_ids[0]);
        // A sound that scores its whole scene sits under the first sequence of
        // that scene, rather than drifting into a group of its own.
        const sceneWide = firstShot ? cues
            .filter(c => !c.sequence_id && !c.shot_id && c.scene_id === firstShot.scene_id && !placedSound.has(`sound:${c.id}`))
            .map(c => ({ key: `sound:${c.id}`, versions: cueVersions(db, c).map(v => `ver:${v.asset_id}`) })) : [];
        const sounds = soundGroup([sn.key, ...shotKeys]).concat(sceneWide);
        sounds.forEach(s => placedSound.add(s.key));
        const first = shotNode.get(sn.shot_ids[0]);
        groups.push({
            order: filmIndex(sn.shot_ids[0]),
            id: `seq:${q.id}`,
            label: `${first ? `SC ${first.scene_number} · ` : ''}${(sn.name || 'SEQUENCE').toUpperCase()}`,
            shots: shotKeys, sequence: sn.key,
            links_start: sn.links.start ? [`link:${q.id}:start`] : [],
            links_end: sn.links.end ? [`link:${q.id}:end`] : [],
            versions: [...sn.videos.map(v => `ver:${v.asset_id}`),
                ...shotKeys.flatMap(k => ((nodes.find(n => n.key === k) || {}).videos || []).map(v => `ver:${v.asset_id}`))],
            sounds,
        });
    }
    const byScene = new Map();
    for (const sh of shots) {
        if (owner.has(sh.id)) continue;
        if (!byScene.has(sh.scene_id)) byScene.set(sh.scene_id, { scene_number: sh.scene_number, location: sh.location, shots: [] });
        byScene.get(sh.scene_id).shots.push(`shot:${sh.id}`);
    }
    for (const [sceneId, s] of byScene) {
        const sounds = soundGroup(s.shots).concat(cues
            .filter(c => !c.sequence_id && !c.shot_id && c.scene_id === sceneId && !placedSound.has(`sound:${c.id}`))
            .map(c => ({ key: `sound:${c.id}`, versions: cueVersions(db, c).map(v => `ver:${v.asset_id}`) })));
        sounds.forEach(x => placedSound.add(x.key));
        groups.push({
            order: filmIndex(s.shots[0] && s.shots[0].slice('shot:'.length)),
            id: `scene:${sceneId}`, label: `SC ${s.scene_number} · ${(s.location || '').toUpperCase()}`,
            shots: s.shots, sequence: null, links_start: [], links_end: [],
            versions: s.shots.flatMap(k => ((nodes.find(n => n.key === k) || {}).videos || []).map(v => `ver:${v.asset_id}`)),
            sounds,
        });
    }
    /*
     * THE BOXES READ IN FILM ORDER.
     *
     * Groups were laid out as every sequence first and then every scene of
     * loose shots, so a new sequence landed in front of scene 1's loose shots
     * even though nothing in it comes before them. Sequence boxes and scene
     * boxes are one list ordered by where their first shot plays; a sequence
     * with no shots yet has no place in the film, so it goes at the END —
     * after everything, in the order it was made — until shots are added.
     * Sorted after they are built, because which box claims a scene-wide
     * sound is decided above and must not change with the order.
     */
    groups.sort((a, b) => (a.order === b.order ? 0 : a.order - b.order));
    const loose = nodes.filter(n => n.type === 'sound' && !placedSound.has(n.key));
    if (loose.length) {
        groups.push({ id: 'sounds', label: 'SOUNDS', shots: [], sequence: null, links_start: [], links_end: [], versions: [],
            sounds: loose.map(n => ({ key: n.key, versions: n.versions.map(v => `ver:${v.asset_id}`) })) });
    }

    const graph = { nodes, edges: edges.filter(e => e.to), groups };
    const auto = autoLayout(graph);
    const stored = readLayout(db, projectId);
    for (const n of nodes) {
        const s = stored.get(n.key);
        const a = auto.positions[n.key] || { x: 40, y: 40 };
        n.x = s ? s.x : a.x; n.y = s ? s.y : a.y;
        n.pinned = !!(s && s.pinned);
        n.w = (NODE_SIZE[n.type] || {}).w; n.h = (NODE_SIZE[n.type] || {}).h;
    }

    attachImpact(nodes, projectId);
    const framed = nodes.filter(n => n.type === 'shot' && n.frames.length).length;
    const withVideo = nodes.filter(n => n.type === 'shot'
        && (n.videos.length || (n.sequence_id && seqNode.get(n.sequence_id).videos.length))).length;
    return {
        project_id: projectId,
        board_locked: !!project.board_locked_at,
        nodes, edges: graph.edges, groups: auto.groups.map((g, i) => ({ ...g, key: graph.groups[i].id })),
        running_order: shots.map(s => s.id),
        running: runningWork(db, projectId),
        meta: {
            shots: shots.length, framed, with_video: withVideo, need_frame: shots.length - framed,
            sequences: sequences.length, sounds: cues.length,
        },
    };
}

/**
 * IS THIS NODE BEHIND? (PGN-004)
 *
 * One rule per node type, all reading lib/impact.js graphStates — the same
 * walk the impact report makes, so the graph and the report cannot disagree.
 * `untracked` is said out loud: a file made outside the workflow has no input
 * fingerprint, and calling it current would be a guess dressed as a fact.
 */
const IMPACT_STATES = Object.freeze(['current', 'redo', 'waiting', 'never', 'untracked']);

const IMPACT_WHY = Object.freeze({
    card: 'The screenplay was revised after this shot\'s card was written.',
    redo: 'What it was generated from has changed, and everything above it is current.',
    waiting: 'Something it is built from is being redone; redo that first.',
    never: 'Nothing has been generated yet.',
    untracked: 'Made outside the workflow, so whether it is behind cannot be known.',
    link: 'The frame it borrows from another sequence has changed.',
    member: 'A shot in this sequence is behind; redo its frame first.',
});
/** What to DO about each state — shown beside the why, on the node and in the drawer (PGN-005). */
const IMPACT_ACTION = Object.freeze({
    redo: 'Regenerate this now.',
    waiting: 'Wait: redo what it is built from first, then this.',
    never: 'Generate it when you are ready.',
    untracked: 'Regenerate it through Film Engine if you want it tracked.',
});
const BADGE_STAGES = ['voice', 'lipsync', 'sfx', 'post'];
const out_ = (state, why, extra) => Object.assign({ state, why: why || IMPACT_WHY[state] || '', action: IMPACT_ACTION[state] || '' }, extra || {});
const stageState = s => (s === 'redo' || s === 'waiting' || s === 'current') ? s : null;
const assetOf = (id, ctx) => (id && ctx.assets && ctx.assets[id]) || null;
const SOUND_STAGE = { score: 'music', source: 'music', transition: 'music', ambient: 'ambient', sfx: 'sfx' };

const NODE_IMPACT = Object.freeze({
    shot(n, ctx) {
        const st = (ctx.shots && ctx.shots[n.id]) || {};
        const badges = BADGE_STAGES.map(stage => ({ stage, state: stageState(st[stage]) }))
            .filter(b => b.state === 'redo' || b.state === 'waiting');
        if (!n.frames || !n.frames.length) return out_('never', null, { badges });
        if (st.scene_card === 'redo') return out_('redo', IMPACT_WHY.card, { badges, cause: 'card' });
        const kf = stageState(st.keyframe);
        return out_(kf || 'untracked', null, { badges });
    },
    video(n, ctx) { return out_(assetOf(n.asset_id, ctx) || 'untracked'); },
    audio(n, ctx) { return out_(assetOf(n.asset_id, ctx) || 'untracked'); },
    sequence(n, ctx) {
        const links = n.links || {};
        if (links.stale) return out_('redo', IMPACT_WHY.link);
        const behind = (n.shot_ids || []).some(id => {
            const st = (ctx.shots && ctx.shots[id]) || {};
            return st.scene_card === 'redo' || st.keyframe === 'redo' || st.keyframe === 'waiting';
        });
        if (behind) return out_('waiting', IMPACT_WHY.member);
        if (!n.videos || !n.videos.length) return out_('never');
        return out_('current');
    },
    link(n) { return n.stale ? out_('redo', IMPACT_WHY.link) : out_('current'); },
    sound(n, ctx) {
        if (!n.selected_asset_id) return out_('never');
        const own = assetOf(n.selected_asset_id, ctx);
        if (own) return out_(own);
        const stage = SOUND_STAGE[n.cue_type];
        const sc = stage && ctx.scenes && ctx.scenes[n.scene_id] && stageState(ctx.scenes[n.scene_id][stage]);
        if (sc === 'waiting' || sc === 'redo') return out_(sc);
        return out_('untracked');
    },
});

/** Attach `impact` to every node. Never throws: a graph with no states is still a graph. */
function attachImpact(nodes, projectId) {
    let ctx = { shots: {}, scenes: {}, assets: {} };
    try { ctx = require('./impact').graphStates(projectId); } catch (_) { /* states unavailable */ }
    for (const n of nodes) {
        const rule = NODE_IMPACT[n.type];
        try { n.impact = rule ? rule(n, ctx) : out_('untracked'); } catch (_) { n.impact = out_('untracked'); }
    }
}

/**
 * WHAT IS RUNNING, AND ON WHICH NODE (PGN-003).
 *
 * A job row already says what it was for; these rules read that attribution
 * into a graph key, most specific first — a sequence leg is generated FOR a
 * shot, but the node that is running is the sequence. A job no rule places is
 * still listed, with no key, so nothing running is hidden.
 */
const RUNNING_RULES = Object.freeze([
    { id: 'music_cue', key: (j, m) => m.music_cue_id ? 'sound:' + m.music_cue_id : null },
    { id: 'sequence', key: (j, m) => m.sequence_id ? 'seq:' + m.sequence_id : null },
    { id: 'storyboard_frame', key: (j, m) => m.storyboard_frame && m.storyboard_frame.shot_id ? 'shot:' + m.storyboard_frame.shot_id : null },
    { id: 'shot', key: j => j.shot_id ? 'shot:' + j.shot_id : null },
]);

/**
 * A pending row is RUNNING only while something is still heard from it. A row
 * silent for longer than this is a job the caller stopped waiting for — that
 * belongs to the queue's "awaiting collection", not to a spinner that never
 * stops.
 */
const RUNNING_SILENCE_SEC = 180;

/** Which graph node a job row belongs to, by the attribution it carries (or null). */
function jobNodeKey(j) {
    let meta = {};
    try { meta = JSON.parse((j && j.meta) || '{}') || {}; } catch (_) { meta = {}; }
    for (const r of RUNNING_RULES) { const key = r.key(j || {}, meta); if (key) return key; }
    return null;
}

function runningWork(db, projectId) {
    try {
        if (!db || !projectId) return [];
        const rows = db.prepare(`SELECT * FROM film_generation_jobs
            WHERE project_id = ? AND status = 'pending'
              AND COALESCE(heartbeat_at, started_at, created_at) >= datetime('now', ?)
              AND NOT (json_valid(meta) AND COALESCE(json_extract(meta, '$.stopped_waiting'), 0))
            ORDER BY COALESCE(started_at, created_at)`).all(projectId, `-${RUNNING_SILENCE_SEC} seconds`);
        let registry = null;
        try { registry = require('./providers'); } catch (_) { registry = null; }
        return rows.map(j => {
            const key = jobNodeKey(j);
            const adapter = registry && registry.get(j.provider);
            return {
                job_id: j.id, key, provider: j.provider, capability: j.capability,
                percent: j.percent === null || j.percent === undefined ? null : Number(j.percent),
                phase: j.phase || null,
                started_at: j.started_at || j.created_at,
                heartbeat_at: j.heartbeat_at || null,
                reports: (adapter && adapter.reportsProgress) || 'none',
            };
        });
    } catch (_) { return []; }
}

/** Every node that has no selected output yet — what "Run pending" would make. */
function pendingWork(graph) {
    const out = [];
    for (const n of graph.nodes) {
        if (n.type === 'shot' && !n.frames.length) out.push({ key: n.key, action: 'frame', label: n.shot_code });
        if (n.type === 'sound' && !n.selected_asset_id) out.push({ key: n.key, action: 'sound', label: n.title || n.kind });
    }
    return out;
}

module.exports = {    NODE_SIZE, LINK_MODES, SOUND_KIND,
    buildGraph, autoLayout, readLayout, pendingWork, runningWork, jobNodeKey, IMPACT_STATES, IMPACT_WHY, IMPACT_ACTION, NODE_IMPACT, attachImpact, RUNNING_RULES, RUNNING_SILENCE_SEC,
    shotFrames, shotVideos, sequenceVideos, cueVersions,
    resolveLinkedFrame, linkState, linkFingerprintOf, checkFrameRef,};
