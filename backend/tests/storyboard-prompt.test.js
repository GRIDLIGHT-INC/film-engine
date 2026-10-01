/**
 * Storyboard Prompt Engineering Tests
 *
 * Unit tests for the prompt builder and style lock functions.
 *
 * Run: node --test backend/tests/storyboard-prompt.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildStoryboardPrompt,
    MAX_PROMPT_CHARS,
    applyStyleLock,
    SHOT_TYPE_MAP,
    MOVEMENT_MAP,
    LIGHTING_MAP,
    STYLE_PRESETS,
    DEFAULT_NEGATIVE_PROMPT,
} = require('../lib/storyboard-prompt');
const { VALID_SHOT_TYPES, VALID_CAMERA_MOVES, VALID_LIGHTING } = require('../lib/scene-card-schema');

// ── Test Data ────────────────────────────────────────────────────────

const minimalCard = {
    shot_code: '1A',
    description: 'A man walks into a dark room.',
};

const fullCard = {
    shot_code: '1A',
    action: 'John enters the dimly lit office and notices Sarah at the desk.',
    camera: {
        shot_type: 'medium',
        movement: 'dolly-in',
        lens: '35mm',
    },
    lighting: {
        type: 'low-key',
        notes: 'single desk lamp casting long shadows',
    },
    characters: [
        { name: 'JOHN', position: 'frame-left', action: 'walking' },
        { name: 'SARAH', position: 'frame-right', action: 'sitting' },
    ],
    dialogue: [
        { character: 'JOHN', line: "I didn't expect to find you here." },
    ],
    style: {
        mood: 'tense',
        color_palette: 'cool',
        film_grain: 'light',
    },
    generation: {
        mode: 'creative',
        negative_prompt: 'bright, cheerful',
    },
    duration_ms: 4000,
};

const testCharacters = [
    { name: 'JOHN', appearance_prompt: 'tall man, gray hair, trench coat', lora_id: 'john_v2', ti_token: '' },
    { name: 'SARAH', appearance_prompt: 'young woman, red dress', lora_id: '', ti_token: 'sarah_tok' },
];

const testLocation = {
    name: 'Office',
    description: 'Modern glass office, 30th floor, city skyline visible',
    lighting_default: 'fluorescent',
};

// ── buildStoryboardPrompt ───────────────────────────────────────────

describe('buildStoryboardPrompt', () => {
    it('builds a prompt from minimal scene card', () => {
        const { prompt, negative_prompt } = buildStoryboardPrompt(minimalCard, [], null, null);
        assert.ok(prompt.includes('A man walks into a dark room'));
        assert.ok(prompt.includes('masterpiece, high quality'));
        assert.ok(negative_prompt.includes('blurry'));
    });

    it('a STILL is built from description, and action is only its fallback', () => {
        // description is the look; action is the motion layer, which belongs to
        // video (lib/motion-prompt.js reads the opposite order, on purpose).
        const both = { ...minimalCard, action: 'Running through rain', description: 'A person runs' };
        const { prompt } = buildStoryboardPrompt(both, [], null, null);
        assert.ok(prompt.includes('A person runs'), 'the still was not built from the description');
        assert.ok(!prompt.includes('Running through rain'), 'the motion text reached a still');
        const onlyAction = { ...minimalCard, description: undefined, action: 'Running through rain' };
        assert.ok(buildStoryboardPrompt(onlyAction, [], null, null).prompt.includes('Running through rain'),
            'a card carrying only motion painted nothing');
    });

    it('maps shot_type to camera description', () => {
        const card = { shot_code: '1A', camera: { shot_type: 'close-up' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        // A size word in shot_type is said through the shot-size standard.
        assert.ok(prompt.includes('close-up (CU): the face fills most of the frame'));
    });

    it('maps an angle in shot_type to its own phrase', () => {
        const card = { shot_code: '1A', camera: { shot_type: 'low-angle' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        assert.ok(prompt.includes('low angle shot, looking up'));
    });

    it('maps camera movement', () => {
        const card = { shot_code: '1A', camera: { movement: 'dolly-in' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        assert.ok(prompt.includes('camera moving closer'));
    });

    it('includes lens info', () => {
        const card = { shot_code: '1A', camera: { lens: '85mm' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        assert.ok(prompt.includes('85mm lens'));
    });

    it('omits movement for static camera', () => {
        const card = { shot_code: '1A', camera: { movement: 'static' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        // MOVEMENT_MAP['static'] is empty string, should not appear
        assert.ok(!prompt.includes('static'));
    });

    it('maps lighting type', () => {
        const card = { shot_code: '1A', lighting: { type: 'golden-hour' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        assert.ok(prompt.includes('warm golden hour sunlight'));
    });

    it('includes lighting notes', () => {
        const card = { shot_code: '1A', lighting: { type: 'natural', notes: 'window light from left' } };
        const { prompt } = buildStoryboardPrompt(card, [], null, null);
        assert.ok(prompt.includes('window light from left'));
    });

    it('injects character appearance_prompt when matched', () => {
        const card = { shot_code: '1A', characters: ['JOHN'] };
        const { prompt } = buildStoryboardPrompt(card, testCharacters, null, null);
        assert.ok(prompt.includes('tall man, gray hair, trench coat'));
    });

    it('matches characters case-insensitively', () => {
        const card = { shot_code: '1A', characters: ['john'] };
        const { prompt } = buildStoryboardPrompt(card, testCharacters, null, null);
        assert.ok(prompt.includes('tall man, gray hair, trench coat'));
    });

    it('prepends LoRA tokens with correct syntax', () => {
        const card = { shot_code: '1A', characters: [{ name: 'JOHN' }] };
        const { prompt } = buildStoryboardPrompt(card, testCharacters, null, null);
        assert.ok(prompt.includes('<lora:john_v2:0.8>'));
    });

    it('prepends TI tokens', () => {
        const card = { shot_code: '1A', characters: [{ name: 'SARAH' }] };
        const { prompt } = buildStoryboardPrompt(card, testCharacters, null, null);
        assert.ok(prompt.includes('sarah_tok'));
    });

    it('includes location description', () => {
        const { prompt } = buildStoryboardPrompt(minimalCard, [], testLocation, null);
        assert.ok(prompt.includes('Modern glass office, 30th floor'));
    });

    it('includes location lighting_default when no explicit lighting', () => {
        const card = { shot_code: '1A', description: 'test' };
        const { prompt } = buildStoryboardPrompt(card, [], testLocation, null);
        assert.ok(prompt.includes('fluorescent lighting'));
    });

    it('does NOT include location lighting_default when explicit lighting set', () => {
        const card = { shot_code: '1A', lighting: { type: 'natural' } };
        const { prompt } = buildStoryboardPrompt(card, [], testLocation, null);
        assert.ok(!prompt.includes('fluorescent lighting'));
    });

    it('applies cinematic style preset', () => {
        const { prompt, negative_prompt } = buildStoryboardPrompt(minimalCard, [], null, 'cinematic');
        assert.ok(prompt.includes('cinematic'));
        assert.ok(prompt.includes('film grain'));
        assert.ok(negative_prompt.includes('cartoon'));
    });

    it('applies noir style preset', () => {
        const { prompt, negative_prompt } = buildStoryboardPrompt(minimalCard, [], null, 'noir');
        assert.ok(prompt.includes('film noir'));
        assert.ok(prompt.includes('black and white'));
        assert.ok(negative_prompt.includes('color'));
    });

    it('includes scene card style overrides (mood, palette, grain)', () => {
        const { prompt } = buildStoryboardPrompt(fullCard, [], null, null);
        assert.ok(prompt.includes('tense mood'));
        assert.ok(prompt.includes('cool color palette'));
        assert.ok(prompt.includes('light film grain'));
    });

    it('includes generation negative_prompt from scene card', () => {
        const { negative_prompt } = buildStoryboardPrompt(fullCard, [], null, null);
        assert.ok(negative_prompt.includes('bright, cheerful'));
    });

    it('builds full prompt in correct order', () => {
        const { prompt } = buildStoryboardPrompt(fullCard, testCharacters, testLocation, 'cinematic');
        // LoRA tokens should come first
        const loraIdx = prompt.indexOf('<lora:john_v2:0.8>');
        const subjectIdx = prompt.indexOf('John enters');
        const qualityIdx = prompt.indexOf('masterpiece');
        assert.ok(loraIdx < subjectIdx, 'LoRA tokens should precede subject');
        assert.ok(subjectIdx < qualityIdx, 'Subject should precede quality tags');
    });

    it('handles null/undefined characters gracefully', () => {
        const card = { shot_code: '1A', characters: null };
        const { prompt } = buildStoryboardPrompt(card, null, null, null);
        assert.ok(prompt.includes('masterpiece'));
    });

    it('handles empty scene card', () => {
        const { prompt } = buildStoryboardPrompt({}, [], null, null);
        assert.ok(prompt.includes('masterpiece, high quality'));
    });
});

// ── Mapping Coverage ────────────────────────────────────────────────

describe('Mapping coverage', () => {
    it('SHOT_TYPE_MAP covers all VALID_SHOT_TYPES', () => {
        for (const type of VALID_SHOT_TYPES) {
            assert.ok(
                SHOT_TYPE_MAP[type] !== undefined,
                `SHOT_TYPE_MAP missing entry for: ${type}`
            );
        }
    });

    it('MOVEMENT_MAP covers all VALID_CAMERA_MOVES', () => {
        for (const move of VALID_CAMERA_MOVES) {
            assert.ok(
                MOVEMENT_MAP[move] !== undefined,
                `MOVEMENT_MAP missing entry for: ${move}`
            );
        }
    });

    it('LIGHTING_MAP covers all VALID_LIGHTING', () => {
        for (const light of VALID_LIGHTING) {
            assert.ok(
                LIGHTING_MAP[light] !== undefined,
                `LIGHTING_MAP missing entry for: ${light}`
            );
        }
    });

    it('all STYLE_PRESETS have suffix and negative', () => {
        for (const [name, preset] of Object.entries(STYLE_PRESETS)) {
            assert.ok(preset.suffix, `${name} preset missing suffix`);
            assert.ok(preset.negative, `${name} preset missing negative`);
        }
    });
});

// ── applyStyleLock ──────────────────────────────────────────────────

describe('applyStyleLock', () => {
    it('returns deterministic seed when styleLock is true', () => {
        const result = applyStyleLock(1000, 3, { styleLock: true });
        assert.equal(result.seed, 1003);
    });

    it('defaults to styleLock=true', () => {
        const result = applyStyleLock(500, 0, {});
        assert.equal(result.seed, 500);
    });

    it('returns null seed when styleLock is false', () => {
        const result = applyStyleLock(1000, 3, { styleLock: false });
        assert.equal(result.seed, null);
        assert.equal(result.ip_adapter_image, null);
        assert.equal(result.ip_adapter_weight, null);
    });

    it('includes IP-Adapter fields when image and weight provided', () => {
        const result = applyStyleLock(1000, 2, {
            styleLock: true,
            ipAdapterImage: '/path/to/ref.png',
            consistencyWeight: 0.8,
        });
        assert.equal(result.seed, 1002);
        assert.equal(result.ip_adapter_image, '/path/to/ref.png');
        assert.equal(result.ip_adapter_weight, 0.8);
    });

    it('omits IP-Adapter when consistencyWeight is 0', () => {
        const result = applyStyleLock(1000, 0, {
            styleLock: true,
            ipAdapterImage: '/path/to/ref.png',
            consistencyWeight: 0,
        });
        assert.equal(result.seed, 1000);
        assert.equal(result.ip_adapter_image, null);
    });

    it('omits IP-Adapter when no image provided', () => {
        const result = applyStyleLock(1000, 0, {
            styleLock: true,
            consistencyWeight: 0.7,
        });
        assert.equal(result.ip_adapter_image, null);
    });

    it('uses default consistencyWeight of 0.7', () => {
        const result = applyStyleLock(1000, 0, {
            styleLock: true,
            ipAdapterImage: '/ref.png',
        });
        assert.equal(result.ip_adapter_weight, 0.7);
    });

    it('handles no options argument', () => {
        const result = applyStyleLock(42, 5);
        assert.equal(result.seed, 47);
    });
});

describe('style reaches the prompt (regression)', () => {
    // film_projects.style_preset is a free-text column; STYLE_PRESETS is a
    // six-key lookup. A director who set "Guillermo del Toro gothic: teal/amber,
    // wet streets, anamorphic" got a prompt with NO look in it at all — the
    // lookup missed and the string was dropped with no error. Every frame then
    // rendered in whatever default the model reached for, which is one of the
    // reasons a set of storyboards can look like eight different films.
    const CUSTOM = 'Guillermo del Toro gothic: teal/amber, wet streets, mist, anamorphic, grain';
    const card = {
        shot_code: '1A',
        description: 'A dragon over a suburban street.',
        camera: { shot_type: 'wide', movement: 'static', lens: '35mm' },
        lighting: { type: 'dramatic' },
    };

    it('a custom style string appears verbatim in the prompt', () => {
        const { prompt } = buildStoryboardPrompt(card, [], null, CUSTOM);
        assert.ok(prompt.includes(CUSTOM),
            'the custom style was dropped — the prompt carries no look');
    });

    it('every built-in preset still contributes its own suffix', () => {
        // Set-based: a named preset must never be replaced by the pass-through,
        // because presets also carry a matched negative prompt.
        for (const [name, def] of Object.entries(STYLE_PRESETS)) {
            const { prompt } = buildStoryboardPrompt(card, [], null, name);
            assert.ok(prompt.includes(def.suffix), `preset '${name}' lost its suffix`);
            // Not asserting the key is absent: 'cinematic' legitimately appears
            // inside its own suffix. The real risk is the pass-through firing
            // for a known preset, which would append the bare key AND skip the
            // matched negative prompt — so check the negative side instead.
            assert.ok(buildStoryboardPrompt(card, [], null, name).negative_prompt.includes(def.negative),
                `preset '${name}' lost its negative prompt — the pass-through fired instead`);
        }
    });

    it('a preset still contributes its negative prompt; a custom style adds none', () => {
        const preset = buildStoryboardPrompt(card, [], null, 'noir');
        assert.ok(preset.negative_prompt.includes(STYLE_PRESETS.noir.negative));

        const custom = buildStoryboardPrompt(card, [], null, CUSTOM);
        assert.ok(!custom.negative_prompt.includes(CUSTOM),
            'a free-text style must not be pushed into the negative prompt');
    });

    it('an empty or missing style adds nothing', () => {
        for (const empty of ['', '   ', null, undefined]) {
            const { prompt } = buildStoryboardPrompt(card, [], null, empty);
            assert.ok(!/,\s*,/.test(prompt), `'${empty}' produced an empty prompt segment`);
        }
    });
});

describe('prompt fits the provider (regression)', () => {
    // Runway's text_to_image rejects prompts over ~1000 characters. A described
    // character (~800) plus a described location (~900) plus an auteur style
    // (~400) totalled well over 2,000 before the shot action was added, so
    // every frame failed at once — and the fields responsible were exactly the
    // ones written to FIX continuity. Long inputs must degrade into shorter
    // descriptions, not into a provider rejection.
    const LONG_CHAR = { name: 'MAYA', appearance_prompt: 'A '.repeat(400) + 'woman.' };
    const LONG_LOC = { name: 'STREET', description: 'B '.repeat(400) + 'street.' };
    const LONG_STYLE = 'C '.repeat(300) + 'gothic';
    const card = {
        shot_code: '1A',
        description: 'D '.repeat(200) + 'happens.',
        camera: { shot_type: 'wide', movement: 'static', lens: '35mm' },
        lighting: { type: 'dramatic' },
        characters: [{ name: 'MAYA' }],
    };

    it('a maximally long input still produces a usable prompt', () => {
        const { prompt } = buildStoryboardPrompt(card, [LONG_CHAR], LONG_LOC, LONG_STYLE);
        assert.ok(prompt.length <= MAX_PROMPT_CHARS,
            `prompt was ${prompt.length} chars — the provider would reject it`);
        assert.ok(prompt.length > 200, 'trimmed so hard the prompt says nothing');
    });

    it('the shot action survives — it is what the frame is of', () => {
        const modest = { name: 'MAYA', appearance_prompt: 'Woman, 30s, rust cardigan.' };
        const { prompt } = buildStoryboardPrompt(
            { ...card, description: 'A dragon shears the roofline off a house.' },
            [modest], { name: 'S', description: 'A wet suburban street.' }, 'noir');
        assert.ok(prompt.includes('dragon shears the roofline'),
            'the action was trimmed away in favour of description');
    });

    it('each long field is capped independently, so one cannot starve the others', () => {
        const { prompt } = buildStoryboardPrompt(card, [LONG_CHAR], LONG_LOC, LONG_STYLE);
        // If only a tail-trim were applied, the first field would consume
        // everything and later ones would vanish entirely.
        assert.ok(prompt.includes('A A'), 'character appearance is absent');
        assert.ok(prompt.includes('B B'), 'location description is absent — starved by the character');
    });

    it('a caller with more room can raise the ceiling', () => {
        const tight = buildStoryboardPrompt(card, [LONG_CHAR], LONG_LOC, LONG_STYLE);
        const roomy = buildStoryboardPrompt(card, [LONG_CHAR], LONG_LOC, LONG_STYLE,
            { maxPromptChars: 4000, appearanceAllowance: 1500, locationAllowance: 1500 });
        assert.ok(roomy.prompt.length > tight.prompt.length,
            'the ceiling is not overridable, so a roomier provider is held to Runway limits');
    });
});
