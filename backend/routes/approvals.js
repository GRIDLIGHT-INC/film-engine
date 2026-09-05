/**
 * Decision packets: everything a person needs to decide, as free data.
 *
 *   GET /film/shots/:id/approval-envelope   — may I run this?
 *   GET /film/shots/:id/take-candidates     — which of these is the take?
 *
 * BOTH ARE FREE AND SIDE-EFFECT-FREE, and that is not a detail. A decision
 * packet that spent money to produce itself could not be raised speculatively,
 * which is the only way anybody would use it.
 *
 * The pre-spend envelope is ASSEMBLED FROM THE ROUTES THAT ALREADY ANSWER
 * THESE QUESTIONS rather than recomputing them. `shot_prompt` already reports
 * the composed prompt and its ceiling; `video_preview` already reports the
 * model, the length and an itemised estimate. Recomputing either here would
 * produce a packet that eventually disagrees with the tool it claims to
 * summarise — and the packet is what somebody says yes to.
 *
 * Nothing in this file is shaped for a particular consumer. If a field is not
 * useful in the CLI and on the page, it does not belong in the envelope.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');
const envelope = require('../lib/approval-envelope');
const reviewProxy = require('../lib/review-proxy');
const { fingerprintFor, staleInputs } = require('../lib/artefact-fingerprint');
const { getFilePath } = require('../lib/file-storage');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * What a pre-spend decision can be about.
 *
 * A registry, so an action nobody wired reports as unknown rather than
 * producing an envelope with an empty cost — which reads as free.
 */
const ACTIONS = Object.freeze({
    image: {
        kind: 'keyframe',
        tool: 'storyboard_regenerate',
        source: (id) => ({ method: 'GET', url: `/film/shots/${id}/prompt` }),
    },
    video: {
        kind: 'video',
        tool: 'node_gen_video',
        source: (id, q) => ({
            method: 'GET',
            url: `/film/shots/${id}/video/preview${q.tier ? `?tier=${encodeURIComponent(q.tier)}` : ''}`,
        }),
    },
});

/** The in-process shim the MCP layer already uses. Required lazily: this
 *  module is reachable from it, and a top-level require would close the loop. */
function callRoute(method, url, handler) {
    return require('../lib/mcp-tools').callRoute(method, url, {}, handler);
}

/**
 * What repairing this range would do, and what it would cost.
 *
 * FREE, like every other packet in this file. It resolves no provider and
 * generates nothing — `planRepair` is synchronous precisely so it cannot — and
 * that is what lets a director try three different ranges before committing to
 * one. A plan that spent could not be raised speculatively, and one that cannot
 * be raised speculatively does not get raised.
 *
 * It takes CLIP-RELATIVE seconds. Converting the timeline's absolute
 * milliseconds is `resolveMarks`' job, shared with the page, because doing it
 * in two places is how a mark at 00:41 of the film becomes 41 seconds into a
 * six-second shot.
 */
function repairPlan(req, res, shotId, q) {
    const { planRepair } = require('../lib/repair-plan');
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });

    const clip = db.prepare(
        `SELECT * FROM film_assets WHERE shot_id = ?
            AND asset_type IN ('video_final','video_synced','video_raw')
          ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 ELSE 2 END,
                   created_at DESC LIMIT 1`).get(shotId);
    if (!clip) {
        return json(res, 200, {
            refused: true, code: 'no_source',
            reason: 'This shot has no footage yet, so there is nothing to repair. Generate the clip first.',
        });
    }

    const plan = planRepair({
        sourcePath: getFilePath(shot.project_id, 'video', clip.file_name),
        startSec: Number(q.start_sec),
        endSec: Number(q.end_sec),
        ...(q.resolution ? { resolution: String(q.resolution) } : {}),
    });
    // A refusal is a 200 carrying a reason, not an error: "this range is too
    // short" is an ANSWER to the question that was asked, and a 4xx would make
    // the page report it as a failure to reach the engine.
    return json(res, 200, { shot_id: shotId, shot_code: shot.shot_code, ...plan });
}

async function handleApprovals(req, res, urlParts, query) {
    const q = query || {};

    if (urlParts[1] === 'shots' && urlParts[3] === 'approval-envelope') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return preSpend(req, res, urlParts[2], q);
    }

    if (urlParts[1] === 'shots' && urlParts[3] === 'take-candidates') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return takeCandidates(req, res, urlParts[2], q);
    }

    if (urlParts[1] === 'shots' && urlParts[3] === 'repair-plan') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return repairPlan(req, res, urlParts[2], q);
    }

    return json(res, 404, { error: 'Unknown approvals route' });
}

async function preSpend(req, res, shotId, q) {
    const action = String(q.action || 'image');
    const spec = ACTIONS[action];
    if (!spec) {
        return json(res, 400, {
            error: `unknown action '${action}'`,
            known: Object.keys(ACTIONS),
        });
    }

    const shot = db.prepare(`SELECT s.*, sc.project_id, sc.location, sc.time_of_day, sc.scene_number
        FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(shot.project_id);

    const src = spec.source(shotId, q);
    const { handleStoryboard } = require('./storyboard');
    const { handleVideoGen } = require('./video-gen');
    const handler = action === 'video' ? handleVideoGen : handleStoryboard;

    let answer = null;
    try {
        const r = await callRoute(src.method, src.url, handler);
        answer = (r && r.body) || null;
        // A source that refused is reported AS the refusal rather than folded
        // into an envelope with empty fields: an envelope that looks complete
        // and describes nothing is the worst possible input to a decision.
        if (r && r._status >= 400) {
            return json(res, r._status, {
                error: 'the free preview this envelope is built from refused',
                detail: answer, action,
            });
        }
    } catch (err) {
        return json(res, 500, { error: 'could not assemble the envelope', detail: String(err.message || err) });
    }

    const built = action === 'video'
        ? fromVideoPreview(answer)
        : fromPromptPreview(answer);

    let fingerprint = null;
    try { fingerprint = fingerprintFor(spec.kind, { shotId }); } catch (_) { fingerprint = null; }

    let stale = [];
    try {
        const out = staleInputs(spec.kind, { shotId });
        stale = Array.isArray(out) ? out : (out && out.stale) || [];
    } catch (_) { stale = []; }

    return json(res, 200, envelope.preSpendEnvelope(Object.assign({
        project: project ? { id: project.id, title: project.title } : null,
        subject: {
            shot_code: shot.shot_code,
            scene: shot.scene_number !== undefined ? String(shot.scene_number) : null,
            location: shot.location || null,
            time_of_day: shot.time_of_day || null,
        },
        fingerprint,
        staleInputs: stale.map(s => (typeof s === 'string' ? s : (s && s.kind) || 'an input')),
    }, built, { action: Object.assign({ tool: spec.tool }, built.action || {}) })));
}

/** The image path: the prompt preview already carries everything but the cost. */
function fromPromptPreview(p) {
    const b = p || {};
    const contributors = b.budget && b.budget.contributors ? b.budget.contributors : [];
    const trimmed = contributors.filter(c => c.trimmed > 0);
    return {
        prompt: {
            text: b.prompt || '',
            chars: b.prompt_chars || (b.prompt ? b.prompt.length : 0),
            ceiling: b.ceiling !== undefined ? b.ceiling : null,
            // What will NOT be sent, quoted from the contributors that were cut.
            truncated_tail: trimmed.length
                ? trimmed.map(c => `${c.subject || c.kind}: ${c.trimmed} chars`).join('; ')
                : null,
        },
        references: (b.references || []).map(r => ({
            role: r.kind || null, subject_name: r.subject || null,
            weight: null, path: null,
        })),
        // The image path prices at generation time through the provider chain,
        // so an estimate here would be a second, disagreeing number.
        cost: { credits: null, usd: null, minimum_applies: false },
        media: [],
        missingPlates: (b.references || []).filter(r => r.kind === 'character' && !r.subject)
            .map(r => r.subject).filter(Boolean),
    };
}

/**
 * The video path: the preview already prices it and names what is attached.
 *
 * MAPPED AGAINST THE ROUTE'S REAL SHAPE, not a plausible one. The first
 * version read `cost`, `keyframe_attached`, `minimum_applies` and treated
 * `references` as an array — the route returns `estimate`, a boolean
 * `init_image`, `minimumApplied`, and `references` as an OBJECT. Every one of
 * those produced a field that was quietly null, which on a decision packet is
 * worse than an error: it reads as "no cost" and "nothing attached".
 */
function fromVideoPreview(p) {
    const b = p || {};
    const est = b.estimate || {};
    const refs = b.references || {};
    const dropped = Array.isArray(refs.dropped) ? refs.dropped : [];

    return {
        action: {
            tier: b.tier || null,
            model: b.model || est.model || null,
            provider: b.provider || null,
        },
        prompt: {
            text: b.prompt || '',
            chars: (b.prompt || '').length,
            ceiling: b.prompt_limit !== undefined ? b.prompt_limit : null,
            truncated_tail: b.prompt_truncated || null,
        },
        /*
         * `roles` is a list of role NAMES — the preview does not carry a
         * subject or a path per reference. Reported as what it is rather than
         * padded with nulls that look like missing data.
         */
        references: (refs.roles || []).map(role => ({
            role, subject_name: null, weight: null, path: null,
        })),
        cost: {
            credits: est.credits !== undefined ? est.credits
                : (b.estimated_credits !== undefined ? b.estimated_credits : null),
            usd: est.usd !== undefined ? est.usd
                : (b.estimated_usd !== undefined ? b.estimated_usd : null),
            minimum_applies: est.minimumApplied === true,
        },
        // The preview reports whether the keyframe is attached, not where it
        // is; the path comes from the asset row so the packet can carry bytes.
        keyframeAttached: b.init_image === undefined ? undefined : !!b.init_image,
        styleApplied: b.style_applied,
        // A reference the provider would not take is REPORTED. It is exactly
        // the kind of thing that is invisible in a picture and changes the
        // answer, which is what the warnings array is for.
        droppedReferences: dropped.map(d => `${d.role || 'a reference'}${d.subject ? ` (${d.subject})` : ''}: ${d.reason || 'dropped'}`),
        previewWarnings: Array.isArray(b.warnings) ? b.warnings : [],
    };
}

/**
 * Which archived attempt is the take.
 *
 * Reads what `shot_frames` already keeps — this invents no second history —
 * and hands each candidate out with the metadata that says WHY it exists,
 * which is most of what separates two near-identical frames.
 */
async function takeCandidates(req, res, shotId, q) {
    const shot = db.prepare(`SELECT s.*, sc.project_id, sc.location
        FROM film_shots s JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(shot.project_id);

    const limit = Math.max(1, Math.min(50, Number(q.limit) || 6));

    let frames = null;
    try {
        const r = await callRoute('GET', `/film/shots/${shotId}/frames`, require('./storyboard').handleStoryboard);
        frames = (r && r.body) || null;
        if (r && r._status >= 400) return json(res, r._status, frames);
    } catch (err) {
        return json(res, 500, { error: 'could not read this shot\'s attempts', detail: String(err.message || err) });
    }

    const rows = db.prepare(
        `SELECT version, file_path, metadata FROM film_assets
          WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC`).all(shotId);
    const byVersion = new Map();
    for (const r of rows) {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        byVersion.set(r.version, { file_path: r.file_path, meta });
    }

    const maxBytes = Number(q.proxy_max_bytes) > 0 ? Number(q.proxy_max_bytes) : null;

    const versions = (frames.versions || []).slice(0, limit).map((v) => {
        const row = byVersion.get(v.version) || { file_path: null, meta: {} };
        const m = row.meta;
        const item = {
            version: v.version,
            is_current: v.is_current,
            created_at: v.created_at,
            source: v.origin || null,
            instruction: m.instruction || null,
            refined_from: m.refined_from || null,
            path: row.file_path || null,
            selectable: v.restorable || v.is_current,
            reason: v.reason || null,
            proxy_path: null,
            still_path: null,
        };
        /*
         * A still is only made when a caller asked for a ceiling — deriving
         * review files for every candidate on every listing would spend real
         * encoder time on a question nobody asked.
         */
        if (maxBytes && row.file_path && /\.(mp4|mov|webm|mkv)$/i.test(row.file_path)) {
            const proxy = reviewProxy.proxyFor(row.file_path, { maxBytes });
            item.proxy_path = proxy.ok ? proxy.path : null;
            if (!proxy.ok) item.proxy_reason = proxy.reason;
            const still = reviewProxy.stillFor(row.file_path);
            item.still_path = still.ok ? still.path : null;
        }
        return item;
    });

    let fingerprint = null;
    try { fingerprint = fingerprintFor('keyframe', { shotId }); } catch (_) { fingerprint = null; }

    return json(res, 200, envelope.takeEnvelope({
        project: project ? { id: project.id, title: project.title } : null,
        subject: { shot_code: shot.shot_code, location: shot.location || null },
        currentVersion: frames.current_version,
        versions,
        fingerprint,
    }));
}

module.exports = { handleApprovals, ACTIONS };
