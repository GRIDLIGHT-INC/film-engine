/**
 * Unit tests for the pure 3D payload builders (lib/threed-prompt.js).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeSubject,
    build3DPayload,
    buildFromImagePayload,
    buildRigPayload,
    buildRetexturePayload,
    buildAnimatePayload,
    VALID_FORMATS,
    VALID_QUALITY,
    DEFAULT_FORMAT,
    DEFAULT_MODEL,
    NEGATIVE_PROMPT_3D,
} = require('../lib/threed-prompt');

describe('threed-prompt', () => {
    describe('normalizeSubject', () => {
        it('builds a character prompt from appearance fields', () => {
            const s = normalizeSubject({
                name: 'Jax',
                appearance_prompt: 'rugged bounty hunter',
                build: 'tall',
                hair: 'short black',
                distinguishing: 'scar',
                ethnicity: 'latino',
            }, 'character');
            assert.equal(s.name, 'Jax');
            assert.equal(s.category, 'character');
            assert.equal(s.prompt, 'rugged bounty hunter, tall, short black, scar, latino');
        });

        it('builds a prop prompt from visual_prompt + description', () => {
            const s = normalizeSubject({ name: 'Sword', visual_prompt: 'ornate steel blade', description: 'family heirloom', category: 'weapon' }, 'prop');
            assert.equal(s.name, 'Sword');
            assert.equal(s.category, 'weapon');
            assert.equal(s.prompt, 'ornate steel blade, family heirloom');
        });

        it('falls back to name when no descriptive fields', () => {
            const c = normalizeSubject({ name: 'Nameless' }, 'character');
            assert.equal(c.prompt, 'Nameless');
            const p = normalizeSubject({ name: 'Thing' }, 'prop');
            assert.equal(p.prompt, 'Thing');
        });

        it('tolerates a null/empty row', () => {
            const s = normalizeSubject(null, 'character');
            assert.equal(s.name, 'character');
            assert.ok(typeof s.prompt === 'string');
        });
    });

    describe('build3DPayload', () => {
        const subject = { name: 'Jax', prompt: 'rugged bounty hunter', category: 'character' };

        it('applies documented defaults', () => {
            const p = build3DPayload(subject, {});
            assert.equal(p.format, DEFAULT_FORMAT);
            assert.equal(p.format, 'glb');
            assert.equal(p.model, DEFAULT_MODEL);
            assert.equal(p.quality, 'standard');
            assert.equal(p.seed, -1);
            assert.equal(p.target_polycount, 30000);
            assert.equal(p.texture_resolution, 1024);
            assert.equal(p.pbr, true);
            assert.equal(p.negative_prompt, NEGATIVE_PROMPT_3D);
        });

        it('embeds the subject prompt with topology hints', () => {
            const p = build3DPayload(subject, {});
            assert.match(p.prompt, /rugged bounty hunter/);
            assert.match(p.prompt, /clean topology/);
        });

        it('produces a sane default prompt when subject is empty', () => {
            const p = build3DPayload({}, {});
            assert.match(p.prompt, /3D model/);
        });

        it('clamps invalid format to the default', () => {
            assert.equal(build3DPayload(subject, { format: 'exe' }).format, 'glb');
            assert.equal(build3DPayload(subject, { format: 'FBX' }).format, 'fbx');
        });

        it('clamps invalid quality to standard', () => {
            assert.equal(build3DPayload(subject, { quality: 'ultra' }).quality, 'standard');
            assert.equal(build3DPayload(subject, { quality: 'high' }).quality, 'high');
        });

        it('defaults symmetry true for characters, false for props', () => {
            assert.equal(build3DPayload({ name: 'x', category: 'character' }, {}).symmetry, true);
            assert.equal(build3DPayload({ name: 'x', category: 'prop' }, {}).symmetry, false);
        });

        it('allows explicit symmetry override', () => {
            assert.equal(build3DPayload({ name: 'x', category: 'character' }, { symmetry: false }).symmetry, false);
            assert.equal(build3DPayload({ name: 'x', category: 'prop' }, { symmetry: true }).symmetry, true);
        });

        it('honors integer seed and polycount overrides', () => {
            const p = build3DPayload(subject, { seed: 42, target_polycount: 5000, texture_resolution: 2048 });
            assert.equal(p.seed, 42);
            assert.equal(p.target_polycount, 5000);
            assert.equal(p.texture_resolution, 2048);
        });

        it('ignores non-integer seed', () => {
            assert.equal(build3DPayload(subject, { seed: 'abc' }).seed, -1);
            assert.equal(build3DPayload(subject, { seed: 1.5 }).seed, -1);
        });

        it('every VALID_FORMATS entry survives clamping', () => {
            for (const f of VALID_FORMATS) {
                assert.equal(build3DPayload(subject, { format: f }).format, f);
            }
        });

        it('every VALID_QUALITY entry survives clamping', () => {
            for (const q of VALID_QUALITY) {
                assert.equal(build3DPayload(subject, { quality: q }).quality, q);
            }
        });
    });

    describe('buildFromImagePayload', () => {
        it('carries the image ref and defaults', () => {
            const p = buildFromImagePayload('BASE64DATA', {});
            assert.equal(p.init_image, 'BASE64DATA');
            assert.equal(p.format, 'glb');
            assert.equal(p.model, DEFAULT_MODEL);
            assert.equal(p.remove_background, true);
            assert.equal(p.seed, -1);
        });

        it('honors remove_background=false and format', () => {
            const p = buildFromImagePayload('X', { remove_background: false, format: 'usdz' });
            assert.equal(p.remove_background, false);
            assert.equal(p.format, 'usdz');
        });

        it('tolerates a null image ref', () => {
            const p = buildFromImagePayload(null, {});
            assert.equal(p.init_image, null);
        });
    });

    describe('buildRigPayload', () => {
        it('defaults to a humanoid skeleton', () => {
            const p = buildRigPayload('asset-ref', {});
            assert.equal(p.asset, 'asset-ref');
            assert.equal(p.skeleton, 'humanoid');
            assert.equal(p.model, DEFAULT_MODEL);
        });
        it('accepts a custom skeleton', () => {
            assert.equal(buildRigPayload('a', { skeleton: 'quadruped' }).skeleton, 'quadruped');
        });
    });

    describe('buildRetexturePayload', () => {
        it('carries a trimmed prompt and default texture resolution', () => {
            const p = buildRetexturePayload('asset-ref', { prompt: '  weathered bronze  ' });
            assert.equal(p.asset, 'asset-ref');
            assert.equal(p.prompt, 'weathered bronze');
            assert.equal(p.texture_resolution, 1024);
        });
    });

    describe('buildAnimatePayload', () => {
        it('carries clip name and defaults', () => {
            const p = buildAnimatePayload('asset-ref', 'walk', {});
            assert.equal(p.asset, 'asset-ref');
            assert.equal(p.animation, 'walk');
            assert.equal(p.loop, true);
            assert.equal(p.fps, 30);
        });
        it('defaults clip to idle and honors loop/fps overrides', () => {
            const p = buildAnimatePayload('a', undefined, { loop: false, fps: 24 });
            assert.equal(p.animation, 'idle');
            assert.equal(p.loop, false);
            assert.equal(p.fps, 24);
        });
    });
});
