'use strict';

/**
 * -- The Premiere handoff, planned but not written --------------------------
 *
 * On the `planConform` precedent: planning is pure and separate from executing.
 * Writing a package needs a filesystem, and the decisions — which sequences,
 * which media, what the spec sheet says — are algebra over objects that should
 * be testable without one. This returns a manifest; the route copies.
 *
 * EVERY PATH IS RELATIVE to the package root. An absolute path relinks on
 * exactly one machine, which is the machine it will never be opened on — and
 * that is the single failure this subsystem exists to prevent: a handoff that
 * opens with the cuts right and no picture.
 */

const { frameCount } = require('./deliverables');
const { brandFolder } = require('./brand-kit');
const { AUDIO_LANES } = require('./nle-export');

/** The sections a manifest always declares, even when empty. */
const MANIFEST_SECTIONS = ['sequences', 'markers', 'media', 'captions', 'stems', 'brand'];

/**
 * A folder name from the client and the job.
 *
 * Filesystem-safe by construction rather than by escaping: anything that is not
 * a letter, a digit or an underscore is replaced, so a client called `../..`
 * cannot climb out of the package it names.
 */
function slugFor(project) {
    const p = project || {};
    const raw = `${p.client || ''} ${p.title || ''}`.trim() || 'SPOT';
    const slug = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'SPOT';
}

/** A media filename that cannot collide across shots. */
function mediaName(asset, taken) {
    const base = String(asset.file_name || `${asset.id}.bin`).replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!taken.has(base)) { taken.add(base); return base; }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    const name = `${stem}_${String(asset.id).slice(0, 8)}${ext}`;
    taken.add(name);
    return name;
}

/**
 * What goes where.
 *
 * Refuses an empty deliverable set: a handoff with no sequences is a folder of
 * media and no timeline, which looks like a successful export right up until
 * the editor opens it.
 */
function planPackage(input) {
    const i = input || {};
    const project = i.project || {};
    const deliverables = Array.isArray(i.deliverables) ? i.deliverables : [];
    const shots = Array.isArray(i.shots) ? i.shots : [];
    const assets = Array.isArray(i.assets) ? i.assets : [];
    const brand = i.brand || null;

    const errors = [];
    if (!deliverables.length) {
        errors.push('This job has no deliverables, so the package would contain no sequences — '
            + 'a folder of media and no timeline. Apply a package preset on the Deliverables page first.');
    }

    const root = slugFor(project);

    const sequences = deliverables.map(d => ({
        name: d.key || d.label || '',
        label: d.label || '',
        width: d.width,
        height: d.height,
        fps: d.fps,
        duration_ms: d.duration_ms,
        duration_frames: frameCount(d.duration_ms, d.fps),
        platform: d.platform || '',
        loudness_target: d.loudness_target || '',
        caption_mode: d.caption_mode || 'none',
        native: !!d.native,
    }));

    /*
     * Markers the editor works to. The engine knows exactly two things about
     * where graphics go — that the brand has a legal line and a CTA, and that
     * the last frame is the last frame — so it marks those and says nothing
     * about the rest. Placing a super is a timeline operation and belongs to
     * Premiere; guessing at it here would put a marker where nobody asked for
     * one, which is worse than none.
     */
    const markers = [];
    for (const seq of sequences) {
        markers.push({ sequence: seq.name, frame: Math.max(0, seq.duration_frames - 1), name: 'LAST FRAME' });
        if (brand && String(brand.cta || '').trim()) {
            markers.push({ sequence: seq.name, frame: Math.max(0, seq.duration_frames - 1), name: 'CTA / end card' });
        }
        if (brand && String(brand.legal_line || '').trim()) {
            markers.push({ sequence: seq.name, frame: 0, name: 'LEGAL super — placement TBC' });
        }
    }

    /*
     * Media, captions and stems, split by what an editor does with them. The
     * audio LANES are the registry's, not a list here: a lane that never arrives
     * is a pass that cannot be done, which is what AUDIO_LANES exists to state.
     */
    const shotIds = new Set(shots.map(s => s.id));
    const wantVideo = new Set(['video_final', 'video_synced', 'video_raw']);
    const laneTypes = new Set(AUDIO_LANES.map(l => l.type));
    const taken = new Set();
    const media = [];
    const stems = [];

    for (const a of assets) {
        if (!a || !a.file_path) continue;
        const belongs = a.shot_id ? shotIds.has(a.shot_id) : !!a.scene_id;
        if (!belongs) continue;
        if (wantVideo.has(a.asset_type)) {
            media.push({ from: a.file_path, to: `media/${mediaName(a, taken)}`, asset_id: a.id });
        } else if (laneTypes.has(a.asset_type)) {
            // Audio travels as a STEM as well as media: the mix happens in the
            // NLE against the lanes, so they have to arrive separately.
            const name = mediaName(a, taken);
            media.push({ from: a.file_path, to: `media/${name}`, asset_id: a.id });
            stems.push({ from: a.file_path, to: `stems/${a.asset_type.replace(/^audio_/, '')}_${name}`, asset_id: a.id });
        }
    }

    const captions = deliverables
        .filter(d => d.caption_mode && d.caption_mode !== 'none')
        .map(d => ({ to: `captions/${d.key}.srt`, deliverable: d.key, mode: d.caption_mode }));

    const brandFiles = brandFolder(brand, assets);

    /*
     * The spec sheet. Not engine behaviour — it is what Premiere exports to and
     * what the editor matches, so it states every number rather than assuming
     * the sequence carries it: rate, raster, exact frame count and the loudness
     * target Media Encoder normalises to.
     */
    /*
     * The EXPORT spec, not merely the match spec.
     *
     * The engine cannot do the finishing: `post` is served only by Gridlight,
     * which does not implement it, so the upscale and the mix happen in Media
     * Encoder — which is what preflight has reported as "finished in the NLE"
     * from the start. So the codec and the audio layout have to be stated here
     * or the question "what do I export?" has no answer anywhere, and a spec
     * sheet giving a raster and a rate while leaving the codec to memory is how
     * a broadcast delivery is rejected.
     */
    const codecFor = s2 => (s2.platform === 'broadcast' ? 'ProRes 422 HQ' : 'H.264 High');
    const audioFor = s2 => (s2.platform === 'broadcast'
        ? 'stereo mix 1/2 + M&E 3/4'
        : 'stereo AAC 320k');

    const lines = [
        `# ${project.title || 'Spot'}`,
        '',
        `Client: ${project.client || '—'}`,
        `Campaign: ${project.campaign || '—'}`,
        '',
        '## Export these from Premiere',
        '',
        '| Sequence | Raster | Rate | Frames | Codec | Audio | Loudness | Captions |',
        '|---|---|---|---|---|---|---|---|',
        ...sequences.map(s2 => `| ${s2.name} | ${s2.width}x${s2.height} | ${s2.fps} | `
            + `${s2.duration_frames} | ${codecFor(s2)} | ${audioFor(s2)} | `
            + `${s2.loudness_target || '—'} | ${s2.caption_mode} |`),
        '',
        'Frame counts are EXACT. NTSC rates are nominal — a :30 at 29.97 is 900 frames, not 899 —',
        'and a spot that arrives one frame short is rejected by the station.',
        '',
        '## What the engine did NOT do',
        '',
        'The upscale, the grade, the lip-sync and the audio mix all happen in **Premiere and Media',
        'Encoder**. Nothing in this package has been upscaled, graded or loudness-normalised, and the',
        'footage here is DRAFT resolution — generated small on purpose, because most clips are thrown',
        'away while a cut is being found.',
        '',
        'So the export above is where the finishing happens: set the raster and rate from the table,',
        'let Media Encoder normalise to the loudness target, and burn or attach captions as the last',
        'column says. An editor who assumes the upscale already happened delivers a draft-resolution',
        'master against a full-size spec — which plays perfectly, and is wrong.',
    ];

    return {
        ok: errors.length === 0,
        errors,
        root,
        xml: `${root}.xml`,
        sequences,
        markers,
        media,
        captions,
        stems,
        brand: brandFiles,
        spec_sheet: 'spec.md',
        spec_sheet_content: lines.join('\n'),
    };
}

module.exports = { planPackage, slugFor, mediaName, MANIFEST_SECTIONS };
