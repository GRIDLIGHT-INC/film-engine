/**
 * The Previs library: low-poly furniture and people, free to use, placed at
 * real size.
 *
 * "A free low-poly library… low-poly man, woman, children of both genders."
 *
 * Previz wants proxies that read at a glance, not textures that fight the
 * camera. Two sources, both in the repo so nothing is fetched at run time:
 *
 *   furniture   Kenney's Furniture Kit (CC0, public domain), 140 models. Its
 *               units are not metres and not even consistent (a door is 1.01,
 *               a chair 0.47), and one rule fits them: native × 2.0 is a real
 *               size (door 2.02 m, chair 0.94 m, fridge 1.84 m). A layout can
 *               give any object its own measured size, and it is fitted to it.
 *   people      Made here by scripts/make-previs-people.py: a man (1.78 m), a
 *               woman (1.65 m), a boy and a girl of about eight (1.28 m, 1.26 m),
 *               already in metres, facing +Y (yaw 0), with a nose so the facing
 *               reads.
 *
 * The size of every entry is read from its own GLB rather than typed, so a
 * model replaced on disk cannot disagree with the manifest.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'assets', 'previs-library');
const KENNEY_TO_METRES = 2.0;

/** A furniture id's category, from the kit's own naming. */
const CATEGORY_PREFIXES = [
    ['bathroom', 'bathroom'], ['shower', 'bathroom'], ['toilet', 'bathroom'], ['bathtub', 'bathroom'],
    ['washer', 'bathroom'], ['dryer', 'bathroom'],
    ['kitchen', 'kitchen'], ['hood', 'kitchen'], ['toaster', 'kitchen'],
    ['bed', 'bedroom'], ['cabinetBed', 'bedroom'], ['pillow', 'bedroom'],
    ['lounge', 'living'], ['tableCoffee', 'living'], ['television', 'living'], ['cabinetTelevision', 'living'],
    ['speaker', 'living'], ['radio', 'living'], ['rug', 'living'],
    ['table', 'dining'], ['chair', 'dining'], ['bench', 'dining'], ['stool', 'dining'],
    ['desk', 'office'], ['computer', 'office'], ['laptop', 'office'], ['books', 'office'], ['bookcase', 'office'],
    ['lamp', 'lighting'], ['ceilingFan', 'lighting'],
    ['wall', 'structure'], ['floor', 'structure'], ['doorway', 'structure'], ['stairs', 'structure'], ['paneling', 'structure'],
    ['plant', 'decor'], ['pottedPlant', 'decor'], ['coatRack', 'decor'], ['cardboard', 'decor'], ['trashcan', 'decor'],
    ['bear', 'decor'], ['sideTable', 'living'],
];
const CATEGORIES = Object.freeze(['people', ...new Set(CATEGORY_PREFIXES.map(c => c[1])), 'other']);

const PEOPLE = Object.freeze({
    man: 'Man, adult (1.78 m)', woman: 'Woman, adult (1.65 m)',
    boy: 'Boy, about eight (1.28 m)', girl: 'Girl, about eight (1.26 m)',
});

function categoryOf(id) {
    // Longest prefix wins, so `tableCoffee` is living rather than dining.
    let best = null;
    for (const [prefix, cat] of CATEGORY_PREFIXES) {
        if (id.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, cat];
    }
    return best ? best[1] : 'other';
}

/** "loungeSofaCorner" → "Lounge sofa corner". */
function labelOf(id) {
    const words = id.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

let CACHE = null;
function load() {
    if (CACHE) return CACHE;
    const { parseGlb } = require('./glb-parser');
    const out = new Map();
    const add = (id, file, category, label, factor, licence) => {
        let size = null;
        try {
            const g = parseGlb(fs.readFileSync(file));
            // glTF is Y-up: [width x, height y, depth z] → our [width, depth, height].
            size = [g.size[0] * factor, g.size[2] * factor, g.size[1] * factor].map(v => Math.round(v * 1000) / 1000);
        } catch (_) { return; }
        out.set(id, Object.freeze({ id, label, category, file, size_m: size, licence }));
    };
    const furn = path.join(ROOT, 'furniture');
    if (fs.existsSync(furn)) {
        for (const f of fs.readdirSync(furn).filter(f => f.endsWith('.glb')).sort()) {
            const id = f.slice(0, -4);
            add(id, path.join(furn, f), categoryOf(id), labelOf(id), KENNEY_TO_METRES, 'CC0 (Kenney Furniture Kit)');
        }
    }
    for (const [id, label] of Object.entries(PEOPLE)) {
        const f = path.join(ROOT, 'people', `${id}.glb`);
        if (fs.existsSync(f)) add(id, f, 'people', label, 1, 'Film Engine (made by scripts/make-previs-people.py)');
    }
    CACHE = out;
    return out;
}

function get(id) { return load().get(String(id || '')) || null; }

/** Every entry, optionally of one category, without file paths (those stay on the server). */
function list(category) {
    return [...load().values()]
        .filter(e => !category || e.category === category)
        .map(({ file, ...rest }) => Object.assign(rest, { url: `/film/previs-library/${rest.id}/file` }));
}

module.exports = { get, list, CATEGORIES, PEOPLE, KENNEY_TO_METRES, categoryOf, ROOT };
