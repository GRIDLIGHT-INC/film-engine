'use strict';

/**
 * A sequence motion board: the selected storyboard frames remain fixed anchors
 * and no more than MAX_FRAMES review images describe everything between them.
 * This module is deliberately pure. Routes persist and generate; this file
 * decides what the director should see before any paid request is made.
 */

const MAX_FRAMES = 10;

function durationOf(shot) {
    return Math.max(1000, Number(shot && shot.duration_ms) || 5000);
}

function planSequenceFrames(shots, opts) {
    const list = Array.isArray(shots) ? shots.filter(Boolean) : [];
    const maxFrames = Math.max(2, Math.min(MAX_FRAMES, Number(opts && opts.maxFrames) || MAX_FRAMES));
    if (!list.length) return { refused: true, reason: 'No shots selected.', frames: [] };
    if (list.length > maxFrames) {
        return {
            refused: true,
            reason: `A motion board can carry at most ${maxFrames} selected storyboard anchors. Split this into smaller sequences.`,
            frames: [],
        };
    }
    const missing = list.filter(s => !s.keyframe).map(s => s.shot_code || s.id);
    if (missing.length) {
        return {
            refused: true,
            reason: `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no storyboard frame.`,
            missing,
            frames: [],
        };
    }

    // Each shot except the last describes the travel to the next selected shot.
    // A one-shot sequence instead uses that shot's own declared duration.
    const durationMs = list.length === 1
        ? durationOf(list[0])
        : list.slice(0, -1).reduce((sum, s) => sum + durationOf(s), 0);
    const wanted = Math.max(list.length, Math.ceil(durationMs / 1000));
    const count = Math.max(list.length === 1 ? 2 : list.length, Math.min(maxFrames, wanted));
    const intervalMs = count > 1 ? durationMs / (count - 1) : durationMs;

    // Put anchors near their actual edit times, while reserving a unique slot
    // for every selected storyboard when short shots cluster together.
    const cumulative = [0];
    for (let i = 0; i < list.length - 1; i += 1) {
        cumulative.push(cumulative.at(-1) + durationOf(list[i]));
    }
    const anchorIndexes = [];
    for (let i = 0; i < cumulative.length; i += 1) {
        if (list.length === 1) { anchorIndexes.push(0); continue; }
        if (i === list.length - 1) { anchorIndexes.push(count - 1); continue; }
        const ideal = Math.round((cumulative[i] / durationMs) * (count - 1));
        const previous = i ? anchorIndexes[i - 1] : -1;
        const latest = count - (list.length - i);
        anchorIndexes.push(Math.max(previous + 1, Math.min(latest, ideal)));
    }
    const anchorByIndex = new Map(anchorIndexes.map((index, i) => [index, i]));

    const frames = [];
    for (let index = 0; index < count; index += 1) {
        const exactAnchor = anchorByIndex.get(index);
        let before = 0;
        for (let i = 0; i < anchorIndexes.length; i += 1) {
            if (anchorIndexes[i] <= index) before = i;
        }
        const after = Math.min(list.length - 1, before + 1);
        const startIndex = anchorIndexes[before];
        const endIndex = anchorIndexes[after];
        const localProgress = endIndex === startIndex ? 0 : (index - startIndex) / (endIndex - startIndex);
        const source = exactAnchor !== undefined ? list[exactAnchor] : null;
        frames.push({
            index,
            time_ms: index === count - 1 ? durationMs : Math.round(index * intervalMs),
            progress: Number(localProgress.toFixed(4)),
            kind: source ? 'anchor' : 'inbetween',
            source_shot_id: source ? source.id : null,
            source_shot_code: source ? source.shot_code : null,
            source_path: source ? source.keyframe : null,
            from_shot_id: list[before].id,
            to_shot_id: list[after].id,
            from_shot_code: list[before].shot_code,
            to_shot_code: list[after].shot_code,
        });
    }

    return {
        refused: false,
        duration_ms: durationMs,
        frame_count: frames.length,
        interval_ms: intervalMs,
        capped: wanted > maxFrames,
        frames,
    };
}

function cameraText(shot) {
    const camera = (shot && shot.camera) || {};
    return [camera.shot_type || camera.shotType, camera.angle, camera.lens,
        camera.movement || camera.camera_movement, camera.note]
        .filter(Boolean).join(', ');
}

function inbetweenPrompt({ sequenceDescription, frame, from, to }) {
    const f = frame || {};
    const progress = Math.round((Number(f.progress) || 0) * 100);
    const parts = [
        String(sequenceDescription || '').trim(),
        'Create one cinematic in-between frame from the same continuous filmed take.',
        `This is the moment at ${(Number(f.time_ms) / 1000).toFixed(1)} seconds, ${progress}% of the travel from ${from.shot_code} to ${to.shot_code}.`,
        `It begins from ${from.shot_code}: ${from.description || 'the first supplied frame'}.`,
        `It moves toward ${to.shot_code}: ${to.description || 'the second supplied frame'}.`,
        cameraText(from) ? `Camera at the start: ${cameraText(from)}.` : '',
        cameraText(to) ? `Camera at the destination: ${cameraText(to)}.` : '',
        from.direction ? `Start direction: ${from.direction}.` : '',
        to.direction ? `Destination direction: ${to.direction}.` : '',
        f.direction ? `Director correction for this frame: ${f.direction}.` : '',
        'Preserve the same characters, faces, wardrobe, props, location, geography, lighting and screen direction. Interpolate pose and camera position; do not invent a cut, new subject or new setting.',
    ];
    return parts.filter(Boolean).join(' ');
}

module.exports = { MAX_FRAMES, planSequenceFrames, inbetweenPrompt };
