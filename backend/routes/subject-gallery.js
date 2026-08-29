/**
 * The workspace a concept artist actually needs.
 *
 *   GET    /film/{characters,locations,props}/:id/gallery      — everything, by role
 *   POST   /film/{...}/:id/explore                             — N looks, as concepts (PAID)
 *   GET    /film/{...}/:id/explore/preview                     — what it would send, FREE
 *   POST   /film/{...}/:id/inspiration                         — gather an image or a link
 *   PUT    /film/gallery/:assetId/role                          — promote / demote
 *   DELETE /film/gallery/:assetId                               — remove one image
 *
 * One module for all three subject kinds. Characters, locations and props
 * differ only in which foreign key holds them, and three near-identical routes
 * is how one of them ends up with the promotion rule and the others do not —
 * the fault `lib/reference-plates.js` was created to close for plate generation.
 */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const G = require('../lib/subject-gallery');
const { generatePlate, buildPlatePrompt, plateImageSize } = require('../lib/reference-plates');

/**
 * The prompt for a subject, whichever kind it is.
 *
 * A character is not in PLATE_KINDS: it has its own builder, because a
 * character plate is a TURNAROUND — a named view of a person — while a location
 * or prop plate is a single establishing image. Resolving that here rather than
 * at each call site, so the explore preview and the explore run cannot describe
 * the same generation differently.
 */
function subjectPrompt(kind, subject, stylePreset, view) {
    if (kind === 'character') {
        const { buildRefSheetPrompt } = require('./characters');
        return buildRefSheetPrompt(subject, view || 'front', stylePreset, subject.project_id);
    }
    return buildPlatePrompt(kind, subject, stylePreset, view, null);
}
const { resolveGenerator } = require('../lib/providers');
const { providerConfigOf } = require('../lib/provider-config');
const { getFileUrl, saveFile } = require('../lib/file-storage');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** The URL segment each kind is reached by. */
const SEGMENT = { characters: 'character', locations: 'location', props: 'prop' };

function loadSubject(kind, id) {
    const spec = G.SUBJECT_SPEC[kind];
    if (!spec) return null;
    return db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) || null;
}

/** A gallery item as a surface needs it: a picture, a role, and where it came from. */
function present(item, projectId) {
    const meta = item.metadata || {};
    return {
        id: item.id,
        role: item.role,
        sendable: item.sendable,
        view: item.view,
        file_name: item.file_name,
        // A link-only inspiration has no file: it is a URL somebody pasted.
        image_url: meta.source_url || (item.file_name
            ? getFileUrl(subdirFor(item), projectId, item.file_name, item.created_at)
            : null),
        source_url: meta.source_url || null,
        note: meta.note || null,
        provider: item.provider || null,
        created_at: item.created_at,
        style_applied: meta.style_applied !== false,
    };
}

function subdirFor(item) {
    return (item.asset_type === 'character_sheet') ? 'refsheets' : 'refsheets';
}

/* ── read ──────────────────────────────────────────────────────────────── */

function getGallery(req, res, kind, subjectId) {
    const subject = loadSubject(kind, subjectId);
    if (!subject) return json(res, 404, { error: `${kind} not found` });

    const items = G.loadGallery(db, kind, subjectId).map(i => present(i, subject.project_id));
    const grouped = {};
    for (const role of G.ROLES) grouped[role.id] = items.filter(i => i.role === role.id);

    /*
     * The roles travel WITH the gallery.
     *
     * A picture in a list with no statement of what it does is the thing this
     * feature exists to fix: a director looking at four images needs to know
     * which one is conditioning every frame, and which are notes to self.
     */
    return json(res, 200, {
        kind,
        subject: { id: subject.id, name: subject.name, project_id: subject.project_id },
        roles: G.ROLES,
        total: items.length,
        by_role: grouped,
        items,
        // The approved plates, per view — what generation will actually send.
        references: items.filter(i => i.sendable),
    });
}

/* ── explore ───────────────────────────────────────────────────────────── */

function exploreContext(kind, subjectId) {
    const subject = loadSubject(kind, subjectId);
    if (!subject) return { error: `${kind} not found` };
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(subject.project_id);
    return { subject, project };
}

/**
 * Generate ONE exploration and register it as a concept.
 *
 * Locations and props go through `generatePlate` in explore mode, which carries
 * the style, the look-board image, the size rules and the provider fallback
 * chain. A character has no PLATE_KINDS entry — its plate is a turnaround built
 * by its own prompt builder — so it takes the same image call directly with the
 * same explore filename and the same concept role. Two paths, one destination
 * and one role, decided here rather than at the call site.
 */
async function generateExploration({ kind, subject, project, provider, view, token, prompt }) {
    if (kind !== 'character') {
        return generatePlate({
            projectId: project.id, kind, subject,
            stylePreset: project.style_preset,
            provider, project, db, view,
            explore: true, exploreToken: token,
            promptOverride: prompt,
        });
    }

    const { callImageGen } = require('../lib/image-fallback');
    const size = plateImageSize(project, provider.maxImagePixels, 'prop', provider);
    let out;
    try {
        out = await callImageGen({
            projectId: project.id,
            payload: { prompt, ...(size ? { width: size.width, height: size.height } : {}) },
            provider,
        });
    } catch (err) {
        return { ok: false, error: err.message };
    }
    if (!out || !out.ok) return { ok: false, error: (out && out.error) || 'generation failed' };

    const { persistProviderMedia } = require('../lib/provider-media');
    const fileName = G.explorationFileName('character', subject.name, view, token);
    let filePath;
    try {
        filePath = await persistProviderMedia(out, 'refsheets', project.id, fileName);
    } catch (err) {
        return { ok: false, error: 'could not save the exploration: ' + err.message };
    }

    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, character_id, asset_type, file_path, file_name,
            format, mime_type, version, metadata, provider, provider_model)
         VALUES (?, ?, ?, 'character_sheet', ?, ?, 'png', 'image/png', 1, ?, ?, ?)`
    ).run(assetId, project.id, subject.id,
        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '', fileName,
        JSON.stringify(G.explorationMetadata({ kind: 'character', view: view || 'front' })),
        out.provider || provider.id || null, out.provider_model || null);

    return { ok: true, asset_id: assetId,
        image_url: getFileUrl('refsheets', project.id, fileName) };
}

/** What an exploration would send, and what it would cost. Spends nothing. */
function explorePreview(req, res, kind, subjectId, query) {
    const ctx = exploreContext(kind, subjectId);
    if (ctx.error) return json(res, 404, { error: ctx.error });
    const { subject, project } = ctx;

    const config = providerConfigOf(project);
    let provider = null;
    try { provider = resolveGenerator('image', config); } catch (_) { /* reported below */ }

    const view = (query && query.view) || '';
    const instruction = (query && query.instruction) || '';
    const prompt = subjectPrompt(kind, subject, project && project.style_preset, view);

    const count = Math.max(1, Math.min(Number((query && query.count) || 3), 6));

    return json(res, 200, {
        free: true,
        kind,
        subject: subject.name,
        count,
        view: view || null,
        instruction: instruction || null,
        provider: provider ? provider.id : null,
        prompt: instruction ? `${prompt}\n\nDirection for this look: ${instruction}` : prompt,
        size: provider ? plateImageSize(project, provider.maxImagePixels,
            kind === 'character' ? 'prop' : kind, provider) : null,
        note: `${count} image(s) will be generated as CONCEPTS. They are kept side by side and `
            + 'reach no prompt until one is promoted — the approved plate is untouched.',
        ...(provider ? {} : { error: 'No image provider is configured for this project.' }),
    });
}

/**
 * Generate several looks at once.
 *
 * Sequentially, not concurrently: several image calls at one provider is how a
 * queue earns a 429, and the retry costs more than the wait — the same
 * reasoning the compass sweep is built on. A provider that starts refusing
 * stops the run rather than being asked five more times, and what was not
 * attempted is NAMED, because a partial exploration reported as success is how
 * somebody compares three looks believing they saw five.
 */
async function explore(req, res, kind, subjectId) {
    const ctx = exploreContext(kind, subjectId);
    if (ctx.error) return json(res, 404, { error: ctx.error });
    const { subject, project } = ctx;

    const body = req.body || {};
    const count = Math.max(1, Math.min(Number(body.count) || 3, 6));
    const view = body.view || '';
    const instruction = String(body.instruction || '').trim();

    const config = providerConfigOf(project);
    let provider;
    try { provider = resolveGenerator('image', config); }
    catch (err) { return json(res, 400, { error: 'No image provider: ' + err.message }); }

    const made = [];
    const notAttempted = [];
    let refusal = null;

    for (let i = 0; i < count; i++) {
        if (refusal) { notAttempted.push(i + 1); continue; }
        const base = subjectPrompt(kind, subject, project.style_preset, view);
        const result = await generateExploration({
            kind, subject, project, provider, view,
            token: `${Date.now().toString(36)}${i}`,
            prompt: instruction ? `${base}\n\nDirection for this look: ${instruction}` : base,
        });
        if (result.ok) {
            made.push({ asset_id: result.asset_id, image_url: result.image_url, role: 'concept' });
        } else {
            refusal = result.error || 'generation failed';
            notAttempted.push(i + 1);
        }
    }

    return json(res, made.length ? 200 : 502, {
        kind, subject: subject.name,
        requested: count,
        made: made.length,
        concepts: made,
        ...(refusal ? {
            stopped_after: made.length,
            error: refusal,
            not_attempted: notAttempted,
            note: 'The provider refused, so the remaining looks were not attempted rather than '
                + 'asked for again — a refusal repeated is a refusal paid for.',
        } : {}),
        note: 'These are CONCEPTS. Nothing is conditioned on them until one is promoted.',
    });
}

/* ── gather an inspiration ─────────────────────────────────────────────── */

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * An image somebody found, not one this engine made.
 *
 * Two ways in, because a reference genuinely lives in both places: a frame grab
 * on this machine, and a link to something online. A link is stored as a URL
 * and given NO file_path — inventing one would make the serving route 404 on
 * something that was never a file, which the style book already paid for once.
 */
function addInspiration(req, res, kind, subjectId) {
    const subject = loadSubject(kind, subjectId);
    if (!subject) return json(res, 404, { error: `${kind} not found` });
    const spec = G.SUBJECT_SPEC[kind];
    const body = req.body || {};

    const note = String(body.note || '').slice(0, 500);
    const assetId = generateId();
    let fileName = null, filePath = null, sourceUrl = null;

    if (body.source_url) {
        const url = String(body.source_url);
        // http(s) only: a javascript: URL in something the page renders is a
        // script injection with extra steps.
        if (!/^https?:\/\//i.test(url)) {
            return json(res, 400, { error: 'source_url must be an http(s) link' });
        }
        sourceUrl = url;
    } else if (body.data) {
        const m = String(body.data).match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
        if (!m) return json(res, 400, { error: 'data must be a PNG, JPEG or WebP data URI' });
        const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
        fileName = `inspiration_${assetId}.${ext === 'jpeg' ? 'jpg' : ext}`;
        const saved = saveFile('refsheets', subject.project_id, fileName, Buffer.from(m[2], 'base64'));
        filePath = typeof saved === 'string' ? saved : (saved && saved.path) || '';
    } else {
        return json(res, 400, { error: 'Provide either data (a data URI) or source_url (a link)' });
    }

    db.prepare(
        `INSERT INTO film_assets (id, project_id, ${spec.column}, asset_type, file_path, file_name,
            format, mime_type, version, metadata, license_source, license_status)
         VALUES (?, ?, ?, 'reference_image', ?, ?, ?, ?, 1, ?, 'external', 'unknown')`
    ).run(assetId, subject.project_id, subject.id, filePath || '', fileName || '',
        fileName ? path.extname(fileName).slice(1) : 'link',
        fileName ? (IMAGE_MIME[path.extname(fileName).slice(1)] || 'image/png') : 'text/uri-list',
        JSON.stringify(G.inspirationMetadata({
            note, ...(sourceUrl ? { source_url: sourceUrl } : {}),
            ...(body.view ? { view: String(body.view) } : {}),
        })));

    return json(res, 201, {
        asset_id: assetId, role: 'inspiration',
        image_url: sourceUrl || (fileName ? getFileUrl('refsheets', subject.project_id, fileName) : null),
        // Said plainly, because the whole point of the role is that it does not
        // silently become conditioning input.
        note: 'Gathered as INSPIRATION. It is kept with the subject and reaches no prompt — '
            + 'it is usually somebody else\'s image, and sending it to a provider is a different '
            + 'act from looking at it.',
        rights: 'unknown',
    });
}

/* ── promote / demote / remove ─────────────────────────────────────────── */

function subjectOfAsset(assetId) {
    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!asset) return null;
    for (const kind of G.SUBJECT_KINDS) {
        const col = G.SUBJECT_SPEC[kind].column;
        if (asset[col]) return { kind, subjectId: asset[col], asset };
    }
    return null;
}

function writeRole(assetId, role) {
    const row = db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(assetId);
    let meta = {};
    try { meta = JSON.parse(row.metadata || '{}') || {}; } catch (_) { meta = {}; }
    meta.plate_role = role;
    db.prepare('UPDATE film_assets SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), assetId);
}

/**
 * Make this the reference — or put it back in the sketchbook.
 *
 * Promotion is the whole point of the gallery, and it is deliberately an
 * explicit act: exploring is free and cheap precisely because nothing becomes
 * the subject until somebody says so.
 */
function setRole(req, res, assetId) {
    const found = subjectOfAsset(assetId);
    if (!found) return json(res, 404, { error: 'Image not found, or not attached to a subject' });
    const body = req.body || {};
    const role = String(body.role || '');
    if (!G.ROLE_IDS.includes(role)) {
        return json(res, 400, { error: `role must be one of: ${G.ROLE_IDS.join(', ')}` });
    }

    const gallery = G.loadGallery(db, found.kind, found.subjectId);

    if (role !== 'reference') {
        /*
         * Demoting the only reference leaves the subject with no plate, and
         * every frame it appears in then invents it. Allowed — a director may
         * be clearing the deck deliberately — but SAID, because the effect is
         * invisible until the next generation comes back with a stranger in it.
         */
        const wasSendable = G.isSendable(found.asset);
        writeRole(assetId, role);
        const left = G.loadGallery(db, found.kind, found.subjectId).filter(i => i.sendable);
        return json(res, 200, {
            asset_id: assetId, role, changed: true,
            references_remaining: left.length,
            ...(wasSendable && left.length === 0 ? {
                warning: `${found.kind} now has NO approved reference. Every frame it appears in `
                    + 'will invent it until one is promoted.',
            } : {}),
        });
    }

    let plan;
    try {
        plan = G.planPromotion(gallery, assetId, { allow_inspiration: body.allow_inspiration === true });
    } catch (err) {
        return json(res, err.code === 'NOT_IN_GALLERY' ? 404 : 409,
            { error: err.code || 'REFUSED', message: err.message });
    }

    if (!plan.changed) {
        return json(res, 200, { asset_id: assetId, role: 'reference', changed: false,
            note: 'Already the reference for this view.' });
    }

    const tx = db.transaction(() => {
        for (const id of plan.demote) writeRole(id, 'concept');
        writeRole(assetId, 'reference');
    });
    tx();

    return json(res, 200, {
        asset_id: assetId, role: 'reference', changed: true,
        view: plan.view || null,
        was: plan.was,
        // Demoted rather than deleted: the picture it replaced cost money and
        // may be the one you come back to.
        demoted: plan.demote,
        note: plan.demote.length
            ? `This is now the reference${plan.view ? ` for '${plan.view}'` : ''}. The previous one `
              + 'was moved back to concepts, not deleted.'
            : `This is now the reference${plan.view ? ` for '${plan.view}'` : ''}.`,
    });
}

/**
 * Remove one image.
 *
 * The row goes and the bytes move to a `deleted/` folder rather than being
 * unlinked: a generated plate cost money, and a gallery you can only add to is
 * not one you can curate. A link-only inspiration has no bytes to move.
 */
function removeImage(req, res, assetId) {
    const found = subjectOfAsset(assetId);
    if (!found) return json(res, 404, { error: 'Image not found' });
    const asset = found.asset;

    let bytes = 'none';
    if (asset.file_path && fs.existsSync(asset.file_path)) {
        try {
            const dir = path.join(path.dirname(asset.file_path), 'deleted');
            fs.mkdirSync(dir, { recursive: true });
            fs.renameSync(asset.file_path, path.join(dir, path.basename(asset.file_path)));
            bytes = 'moved to deleted/';
        } catch (_) { bytes = 'left in place'; }
    }
    db.prepare('DELETE FROM film_assets WHERE id = ?').run(assetId);

    const left = G.loadGallery(db, found.kind, found.subjectId).filter(i => i.sendable);
    return json(res, 200, {
        deleted: assetId, bytes, references_remaining: left.length,
        ...(G.isSendable(asset) && left.length === 0 ? {
            warning: `${found.kind} now has NO approved reference.`,
        } : {}),
    });
}

/* ── routing ───────────────────────────────────────────────────────────── */

async function handleSubjectGallery(req, res, urlParts, query) {
    const segment = urlParts[1];
    const kind = SEGMENT[segment];

    if (kind && urlParts[2]) {
        const id = urlParts[2];
        const section = urlParts[3];

        if (section === 'gallery' && req.method === 'GET') return getGallery(req, res, kind, id);
        if (section === 'explore') {
            if (urlParts[4] === 'preview' && req.method === 'GET') {
                return explorePreview(req, res, kind, id, query);
            }
            if (req.method === 'POST') return explore(req, res, kind, id);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (section === 'inspiration' && req.method === 'POST') {
            return addInspiration(req, res, kind, id);
        }
    }

    if (urlParts[1] === 'gallery' && urlParts[2]) {
        if (urlParts[3] === 'role' && req.method === 'PUT') return setRole(req, res, urlParts[2]);
        if (req.method === 'DELETE') return removeImage(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleSubjectGallery, SEGMENT };
