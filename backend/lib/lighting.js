/**
 * How a shot is lit: a TECHNIQUE (where the lights stand and how hard they
 * are) over a MOOD (the colour and quantity of the light), resolved from the
 * most specific place that says anything.
 *
 * "Lighting styles in previz and in the storyboard shots and locations where I
 * can start applying specific lighting techniques specific to a shot vs the
 * general style from the moodboard."
 *
 *   shot      scene card `lighting.{technique, type, key_side, notes}`
 *   location  `lighting_technique` and the free-text `lighting_default`
 *   film      the mood board / style preset, which already reaches every
 *             prompt as the look — nothing here repeats it
 *
 * A technique is a RIG: each light's role, where it stands around the subject
 * measured from the camera (azimuth, positive toward camera-right), how high
 * (elevation), how bright relative to the key, and how soft. The same rig
 * lights the Previs Look view and is said in words to the image model, so what
 * a director sees staged and what is generated describe one lighting setup.
 * `key_side` mirrors the rig: a key from camera-left is the same technique.
 *
 * The mood's colour temperature tints every light; `null` everywhere means the
 * shot says nothing and no lighting words are sent, exactly as before.
 */

const TECHNIQUES = Object.freeze({
    'three-point': {
        label: 'Three-point', prompt: 'classic three-point lighting: key light, soft fill and a back light separating the subject',
        rig: [{ role: 'key', az: 45, el: 35, ratio: 1, soft: 0.5 }, { role: 'fill', az: -45, el: 20, ratio: 0.4, soft: 0.9 },
              { role: 'rim', az: 160, el: 40, ratio: 0.7, soft: 0.3 }],
    },
    rembrandt: {
        label: 'Rembrandt', prompt: 'Rembrandt lighting, a small triangle of light on the shadow-side cheek, strong key high and to the side',
        rig: [{ role: 'key', az: 55, el: 45, ratio: 1, soft: 0.4 }, { role: 'fill', az: -40, el: 10, ratio: 0.15, soft: 0.9 }],
    },
    loop: {
        label: 'Loop', prompt: 'loop lighting, key slightly to the side and above, a small nose shadow falling toward the cheek',
        rig: [{ role: 'key', az: 35, el: 35, ratio: 1, soft: 0.6 }, { role: 'fill', az: -35, el: 15, ratio: 0.3, soft: 0.9 }],
    },
    butterfly: {
        label: 'Butterfly (Paramount)', prompt: 'butterfly lighting, key directly above the lens, a butterfly-shaped shadow under the nose, glamour light',
        rig: [{ role: 'key', az: 0, el: 50, ratio: 1, soft: 0.5 }, { role: 'fill', az: 0, el: -15, ratio: 0.3, soft: 0.9 }],
    },
    clamshell: {
        label: 'Clamshell', prompt: 'clamshell beauty lighting, soft key above and a bounce below, shadowless even face',
        rig: [{ role: 'key', az: 0, el: 40, ratio: 1, soft: 0.9 }, { role: 'fill', az: 0, el: -25, ratio: 0.55, soft: 1 }],
    },
    split: {
        label: 'Split', prompt: 'split lighting, the key at ninety degrees, exactly half the face lit and half in shadow',
        rig: [{ role: 'key', az: 90, el: 5, ratio: 1, soft: 0.3 }],
    },
    broad: {
        label: 'Broad', prompt: 'broad lighting, the side of the face turned toward camera is lit',
        rig: [{ role: 'key', az: 30, el: 30, ratio: 1, soft: 0.6 }, { role: 'fill', az: -50, el: 15, ratio: 0.3, soft: 0.9 }],
    },
    short: {
        label: 'Short', prompt: 'short lighting, the side of the face turned away from camera is lit, the near side in shadow, slimming and moody',
        rig: [{ role: 'key', az: 70, el: 30, ratio: 1, soft: 0.5 }, { role: 'fill', az: -30, el: 10, ratio: 0.15, soft: 0.9 }],
    },
    backlight: {
        label: 'Backlight / rim', prompt: 'strong back light rimming the subject, edges glowing, face in soft shadow',
        rig: [{ role: 'rim', az: 165, el: 30, ratio: 1, soft: 0.3 }, { role: 'fill', az: -30, el: 10, ratio: 0.2, soft: 1 }],
    },
    silhouette: {
        label: 'Silhouette', prompt: 'silhouette, the subject dark against a bright background, only the outline readable',
        rig: [{ role: 'back', az: 180, el: 10, ratio: 1.6, soft: 0.8 }],
    },
    'top-light': {
        label: 'Top light', prompt: 'hard top light from directly above, eyes falling into shadow',
        rig: [{ role: 'key', az: 0, el: 85, ratio: 1, soft: 0.2 }],
    },
    'under-light': {
        label: 'Under light', prompt: 'light from below the face, unnatural and menacing shadows cast upward',
        rig: [{ role: 'key', az: 10, el: -40, ratio: 1, soft: 0.4 }],
    },
    'window-motivated': {
        label: 'Window (motivated)', prompt: 'soft daylight from a large window to the side, natural falloff across the room, motivated source',
        rig: [{ role: 'key', az: 75, el: 20, ratio: 1, soft: 0.95 }, { role: 'fill', az: -60, el: 5, ratio: 0.2, soft: 1 }],
    },
    'practical-motivated': {
        label: 'Practicals (motivated)', prompt: 'lit by the practical lamps in frame, pools of warm light and dark corners',
        rig: [{ role: 'key', az: 60, el: 5, ratio: 0.8, soft: 0.8, kelvin: 2700 }, { role: 'fill', az: -90, el: 0, ratio: 0.15, soft: 1, kelvin: 2700 }],
    },
    'high-key': {
        label: 'High key', prompt: 'high-key lighting, bright and even, almost no shadows',
        rig: [{ role: 'key', az: 30, el: 30, ratio: 1, soft: 1 }, { role: 'fill', az: -30, el: 30, ratio: 0.8, soft: 1 },
              { role: 'back', az: 180, el: 30, ratio: 0.6, soft: 1 }],
    },
    'low-key': {
        label: 'Low key', prompt: 'low-key lighting, a single hard key, deep blacks, most of the frame in shadow',
        rig: [{ role: 'key', az: 70, el: 30, ratio: 1, soft: 0.2 }, { role: 'fill', az: -40, el: 10, ratio: 0.05, soft: 1 }],
    },
    chiaroscuro: {
        label: 'Chiaroscuro', prompt: 'chiaroscuro, a strong contrast of light and dark sculpting the subject out of shadow',
        rig: [{ role: 'key', az: 80, el: 25, ratio: 1, soft: 0.2 }],
    },
});

/*
 * The MOOD a scene card has always carried (`lighting.type`), as light: a
 * colour temperature, how much ambient fills the dark, and a colour override
 * for the moods that are not white light. Keyed by the card's own vocabulary,
 * which the test holds equal.
 */
const MOODS = Object.freeze({
    natural: { kelvin: 5600, ambient: 0.45 },
    'golden-hour': { kelvin: 3200, ambient: 0.35, sunEl: 10 },
    'blue-hour': { kelvin: 9500, ambient: 0.25 },
    overcast: { kelvin: 6500, ambient: 0.7 },
    night: { kelvin: 4100, ambient: 0.08 },
    studio: { kelvin: 5600, ambient: 0.3 },
    'high-key': { kelvin: 5600, ambient: 0.75 },
    'low-key': { kelvin: 4300, ambient: 0.06 },
    silhouette: { kelvin: 5600, ambient: 0.05 },
    'rim-light': { kelvin: 5600, ambient: 0.15 },
    practical: { kelvin: 2800, ambient: 0.15 },
    neon: { kelvin: 6500, ambient: 0.12, colours: ['#ff3fa4', '#2de2ff'] },
    candlelight: { kelvin: 1900, ambient: 0.06 },
    moonlight: { kelvin: 8500, ambient: 0.08 },
    fluorescent: { kelvin: 4200, ambient: 0.5, tint: '#e8ffe8' },
    dramatic: { kelvin: 4800, ambient: 0.1 },
    soft: { kelvin: 5600, ambient: 0.55 },
    hard: { kelvin: 5600, ambient: 0.2 },
});

const KEY_SIDES = Object.freeze(['right', 'left']);

/** Approximate a colour temperature as sRGB (Tanner Helland's fit), as #rrggbb. */
function kelvinToHex(k) {
    const t = Math.max(1000, Math.min(40000, Number(k) || 5600)) / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
    else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
    if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    const h = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
}

/**
 * What lights THIS shot, and where each part came from. The shot's own card
 * wins, then the location; the film's general look is the style preset and is
 * not repeated here. Returns null facets rather than inventing any.
 */
function resolveLighting(card, location) {
    const shot = (card && card.lighting) || {};
    const loc = location || {};
    const out = { technique: null, type: null, key_side: 'right', notes: null, sources: {} };
    if (shot.technique && TECHNIQUES[shot.technique]) { out.technique = shot.technique; out.sources.technique = 'shot'; }
    else if (loc.lighting_technique && TECHNIQUES[loc.lighting_technique]) { out.technique = loc.lighting_technique; out.sources.technique = 'location'; }
    if (shot.type && MOODS[shot.type]) { out.type = shot.type; out.sources.type = 'shot'; }
    if (KEY_SIDES.includes(shot.key_side)) { out.key_side = shot.key_side; out.sources.key_side = 'shot'; }
    else if (KEY_SIDES.includes(loc.lighting_key_side)) { out.key_side = loc.lighting_key_side; out.sources.key_side = 'location'; }
    if (shot.notes) { out.notes = shot.notes; out.sources.notes = 'shot'; }
    else if (loc.lighting_default) { out.notes = loc.lighting_default; out.sources.notes = 'location'; }
    return out;
}

/** The technique in words for an image model, with the side the key comes from. */
function techniquePhrase(resolved) {
    const t = resolved && resolved.technique && TECHNIQUES[resolved.technique];
    if (!t) return null;
    const key = t.rig.find(l => l.role === 'key');
    const side = key && Math.abs(key.az) >= 15 && Math.abs(key.az) <= 165
        ? `, key light from camera ${resolved.key_side === 'left' ? 'left' : 'right'}` : '';
    return t.prompt + side;
}

/**
 * The rig as lights around a subject, for the Previs view: world positions
 * from the camera and subject (horizontal), each light's colour and strength.
 * Pure: the page mirrors it and the test holds the two equal.
 */
function rigLights(resolved, camera, subject) {
    const t = resolved && resolved.technique && TECHNIQUES[resolved.technique];
    if (!t || !camera || !subject) return [];
    const mood = MOODS[resolved.type] || MOODS.natural;
    const mirror = resolved.key_side === 'left' ? -1 : 1;
    let bx = camera[0] - subject[0], bz = camera[2] - subject[2];
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl; bz /= bl;
    // Looking from the camera at the subject, camera-right is the forward turned clockwise.
    const fx = -bx, fz = -bz;
    const rx = -fz, rz = fx;
    const eye = subject[1] + 1.5;
    const R = 2.5;
    return t.rig.map(l => {
        const az = l.az * mirror * Math.PI / 180, el = l.el * Math.PI / 180;
        const dx = bx * Math.cos(az) + rx * Math.sin(az), dz = bz * Math.cos(az) + rz * Math.sin(az);
        const colour = (mood.colours && l.role === 'key') ? mood.colours[0]
            : (mood.colours && l.role !== 'key') ? mood.colours[1] || mood.colours[0]
            : kelvinToHex(l.kelvin || mood.kelvin);
        return {
            role: l.role, ratio: l.ratio, soft: l.soft, colour,
            position: [subject[0] + dx * R * Math.cos(el), eye + R * Math.sin(el), subject[2] + dz * R * Math.cos(el)],
            target: [subject[0], eye - 0.15, subject[2]],
        };
    });
}

function vocabulary() {
    return {
        techniques: Object.entries(TECHNIQUES).map(([id, t]) => ({ id, label: t.label, prompt: t.prompt })),
        moods: Object.keys(MOODS),
        key_sides: KEY_SIDES.slice(),
    };
}

module.exports = { TECHNIQUES, MOODS, KEY_SIDES, kelvinToHex, resolveLighting, techniquePhrase, rigLights, vocabulary };
