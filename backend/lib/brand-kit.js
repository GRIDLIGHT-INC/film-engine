'use strict';

/**
 * -- A brand kit that reaches the frame -------------------------------------
 *
 * A brand OUTLIVES a project, for the reason the style book does: one client
 * buys many spots, and a kit that dies with the project is one that is
 * re-uploaded every time that client comes back. No `project_id`, and it
 * survives a project delete.
 *
 * The failure this module is written against is the one this codebase keeps
 * paying for: a table of fields nobody consults. A brand kit is exactly the
 * shape of thing that becomes a form, so every field DECLARES what it reaches —
 * a prompt, a compliance check, the handoff folder, or a person — and the test
 * holds each declaration to being true.
 *
 * Pure. No database, no I/O.
 */

/**
 * Every field, and what it reaches.
 *
 *   prompt      conditions a generation
 *   compliance  read by lib/compliance.js before spend
 *   handoff     travels into the Premiere package for the editor
 *   person      production paperwork, read by nobody automatic
 *
 * `person` is not a lesser category — an approval contact is genuinely the
 * right thing to record and the wrong thing to send to a model — but it has to
 * be SAID, because a field beside "Tone" that looks like it conditions the
 * frame and does not is worse than one that is absent.
 */
const BRAND_FIELDS = [
    { id: 'name', label: 'Name', reaches: 'handoff',
      why: 'names the package folder and the spec sheet the editor opens' },
    { id: 'tone', label: 'Tone', reaches: 'prompt',
      why: 'how the film should FEEL — the one brand field that is a look rather than a word' },
    { id: 'palette', label: 'Palette', reaches: 'prompt',
      why: 'the colours the frame is graded toward; also written to the handoff as palette.json' },
    { id: 'logo_asset_id', label: 'Logo', reaches: 'handoff',
      why: 'the graphics layer places it in Premiere; a diffusion model asked to draw a logo draws a smudge' },
    { id: 'logo_clear_space', label: 'Logo clear space', reaches: 'handoff',
      why: 'a rule the editor applies when placing it, not something a generation can honour' },
    { id: 'fonts', label: 'Fonts', reaches: 'handoff',
      why: 'typography is set in Premiere; an image model cannot be asked to render a typeface' },
    { id: 'cta', label: 'Call to action', reaches: 'compliance',
      why: 'checked for presence before spend, and placed as a super in the edit' },
    { id: 'cta_url', label: 'CTA URL', reaches: 'handoff',
      why: 'goes on the end card, and is rendered as a link so it must be http(s)' },
    { id: 'legal_line', label: 'Legal line', reaches: 'compliance',
      why: 'a brand carrying one and a deliverable set that places it nowhere is a finding' },
    { id: 'banned_phrases', label: 'Banned phrases', reaches: 'compliance',
      why: 'refused in the copy before anything generates' },
    { id: 'approval_contact', label: 'Approval contact', reaches: 'person',
      why: 'who signs the spot off — production paperwork, deliberately not sent anywhere' },
    { id: 'notes', label: 'Notes', reaches: 'person',
      why: 'read by whoever is working, never by a prompt builder' },
];

/** The fields that must change a prompt when they change. */
const PROMPT_FIELDS = BRAND_FIELDS.filter(f => f.reaches === 'prompt').map(f => f.id);

const HEX = /^#[0-9a-f]{6}$/i;

/** A JSON column that may be junk. Never throws — it arrives from a database. */
function parseList(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'string') return [];
    try {
        const out = JSON.parse(value);
        return Array.isArray(out) ? out : [];
    } catch (_) { return []; }
}

/** { valid, errors } — the shape validateProjectSettings already uses. */
function validateBrand(brand) {
    const errors = [];
    const b = brand || {};

    if (!String(b.name || '').trim()) errors.push('name is required — a kit nobody can identify is not reusable');
    if (String(b.name || '').length > 200) errors.push('name must be 200 characters or fewer');

    /*
     * Hex only. A CSS colour NAME is understood by the browser and not agreed
     * on by a print document, an export and a contrast calculation — the rule
     * the character palette already follows.
     */
    for (const c of parseList(b.palette)) {
        if (!HEX.test(String(c))) errors.push(`palette entry "${c}" is not a #rrggbb colour`);
    }

    for (const f of parseList(b.fonts)) {
        if (!f || typeof f !== 'object' || !f.family) {
            errors.push('each font needs at least a family');
            break;
        }
    }

    /*
     * http(s) only. A javascript: URL in something the page renders is a script
     * injection with extra steps — the rule the style book's link classifier
     * already sets. Empty is fine: not every spot has an end-card URL.
     */
    const url = String(b.cta_url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
        errors.push('cta_url must be an http(s) URL — it is rendered as a link');
    }

    for (const [field, max] of [['cta', 200], ['legal_line', 1000], ['tone', 1000],
        ['logo_clear_space', 200], ['approval_contact', 200], ['notes', 4000]]) {
        if (String(b[field] || '').length > max) errors.push(`${field} must be ${max} characters or fewer`);
    }
    return { valid: errors.length === 0, errors };
}

/**
 * The subset of a brand that belongs in a generation prompt.
 *
 * The LOOK, never the COPY. A CTA, a legal line and a banned-phrase list are
 * words that go on the screen in Premiere's graphics layer; putting them in an
 * image prompt asks a diffusion model to render legible text, which it does
 * badly and which would then be baked into a frame that cost money.
 */
function brandPromptContext(brand) {
    const b = brand || {};
    const out = {};
    const tone = String(b.tone || '').trim();
    if (tone) out.tone = tone;
    const palette = parseList(b.palette).filter(c => HEX.test(String(c)));
    if (palette.length) out.palette = palette;
    return out;
}

/**
 * Applied where consistency already is.
 *
 * Beside `applyConsistencyToImagePayload` in capability-payloads.js so the
 * routes, the orchestrator and the flow canvas all pick it up and none can
 * drift — which is the whole reason that module exists.
 *
 * It APPENDS. Whatever leads a prompt is what the image is OF, and the image is
 * of the shot; a brand that led would make every frame a picture of a brand.
 */
function applyBrandToImagePayload(payload, brand) {
    const p = payload || {};
    const ctx = brandPromptContext(brand);
    if (!ctx.tone && !ctx.palette) return p;

    const parts = [];
    if (ctx.tone) parts.push(ctx.tone);
    if (ctx.palette) parts.push(`brand palette ${ctx.palette.join(', ')}`);
    return { ...p, prompt: `${p.prompt || ''}${p.prompt ? ', ' : ''}${parts.join(', ')}` };
}

/**
 * The /brand/ folder in the handoff.
 *
 * Every path RELATIVE to the package root: an absolute path relinks on exactly
 * one machine, which is the machine it will never be opened on.
 *
 * A brand with nothing in it produces nothing rather than a folder of empty
 * files — an empty legal.txt reads as "there is no legal line", which is a
 * different claim from "nobody recorded one".
 */
function brandFolder(brand, assets) {
    const b = brand || {};
    const out = [];
    const list = Array.isArray(assets) ? assets : [];

    const logo = list.find(a => a && a.id === b.logo_asset_id);
    if (logo && logo.file_path) {
        const ext = String(logo.file_name || 'logo.png').split('.').pop();
        out.push({ path: `brand/logo.${ext}`, source: logo.file_path });
    }
    const palette = parseList(b.palette);
    if (palette.length) out.push({ path: 'brand/palette.json', content: JSON.stringify(palette, null, 2) });
    const fonts = parseList(b.fonts);
    if (fonts.length) out.push({ path: 'brand/fonts.json', content: JSON.stringify(fonts, null, 2) });
    if (String(b.legal_line || '').trim()) out.push({ path: 'brand/legal.txt', content: b.legal_line });
    if (String(b.cta || '').trim()) {
        out.push({
            path: 'brand/cta.txt',
            content: b.cta_url ? `${b.cta}\n${b.cta_url}\n` : `${b.cta}\n`,
        });
    }
    if (String(b.logo_clear_space || '').trim()) {
        out.push({ path: 'brand/logo-clear-space.txt', content: b.logo_clear_space });
    }
    return out;
}

module.exports = {
    BRAND_FIELDS, PROMPT_FIELDS, parseList,
    validateBrand, brandPromptContext, applyBrandToImagePayload, brandFolder,
};
