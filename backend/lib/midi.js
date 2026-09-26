/**
 * NOTES, not audio: a cue's parts over a harmonic plan, as a Standard MIDI File.
 *
 * GRD-3994. The director's answer to "editable notes or realistic timbre" was
 * BOTH — realistic instruments they can play. So a cue gets a note list the
 * agent writes (parts over a fixed plan: tempo, meter, key, chord changes,
 * sections) and any part can be replaced by MIDI the director performed. The
 * renderer that turns notes into sound is a later phase; a .mid is already
 * useful to a DAW and to anyone with an instrument open.
 *
 * Times are MILLISECONDS, never beats. The cut is in milliseconds and the cue's
 * length is the contract, so a note list stated in beats would be a second
 * clock that drifts from the picture the moment somebody changes the tempo.
 * Ticks exist only inside the file, derived at write time from the plan's one
 * tempo.
 *
 * Pure: no database, no filesystem. Hand-rolled, because a Standard MIDI File is
 * four chunk types and a variable-length integer, and ADR-002 is one dependency.
 * The parser is not a formality — it reads files a DAW wrote (running status,
 * note-on with velocity 0, format 0 and 1, sysex), because a composer with
 * Ableton open is the first person who will skip the agent entirely.
 */

/** Ticks per quarter note. 480 is what every DAW exports and imports cleanly. */
const PPQ = 480;

/** The sixteen channels, one of which General MIDI reserves for percussion. */
const DRUM_CHANNEL = 9;
const MAX_PARTS = 16;
const MAX_NOTES_PER_PART = 20000;

/** General MIDI Level 1 program names, 0-indexed. The program number IS the index. */
const GM_PROGRAMS = Object.freeze([
    'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
    'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
    'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
    'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
    'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
    'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
    'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
    'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
    'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
    'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
    'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
    'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
    'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
    'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
    'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
    'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
    'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
    'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
    'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
    'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
    'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
    'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
    'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]);

/** Where a part came from. A performed part is never overwritten by a rewrite unless named. */
const PART_SOURCES = Object.freeze(['agent', 'performed']);

// ── validation ───────────────────────────────────────────────────────────

const METER_RE = /^(\d{1,2})\/(1|2|4|8|16|32)$/;
const CHORD_RE = /^[A-G](#|b)?[A-Za-z0-9+#b°ø()/-]{0,14}$/;
const isInt = n => Number.isInteger(n);

/**
 * Validate a note list against the cue it belongs to, and return it normalised.
 *
 * `length_ms` is the cue's length contract and `frame_ms` the tolerance — one
 * frame of the project's rate, because a note list that ends a frame early or
 * late is the same cue and one that ends a second late is not.
 *
 * Every refusal names the part and the field. "Invalid note" sends a composer
 * back to scan twenty thousand notes; "strings: note 412 ends at 30512ms, past
 * the cue at 30000ms" does not.
 */
function validateScore(input, { length_ms, frame_ms = 1000 / 24 } = {}) {
    const errors = [];
    const s = input && typeof input === 'object' ? input : {};
    const plan = s.plan && typeof s.plan === 'object' ? s.plan : {};
    const cueLength = Number(length_ms);

    if (!(cueLength > 0)) errors.push('the cue has no length to write notes against');

    const tempo = Number(plan.tempo_bpm);
    if (!(tempo >= 20 && tempo <= 300)) errors.push(`plan.tempo_bpm must be between 20 and 300 (got ${plan.tempo_bpm})`);
    const meter = String(plan.meter || '4/4');
    if (!METER_RE.test(meter)) errors.push(`plan.meter must look like "4/4" or "6/8" (got ${plan.meter})`);

    let planLength = plan.length_ms == null ? cueLength : Number(plan.length_ms);
    if (plan.length_ms != null && cueLength > 0 && Math.abs(planLength - cueLength) > frame_ms) {
        errors.push(`plan.length_ms is ${planLength}ms and the cue is ${cueLength}ms; a note list is written `
            + 'to the length of the cut, within one frame');
    }
    if (cueLength > 0) planLength = cueLength;
    const limit = planLength + frame_ms;

    const chords = [];
    for (const [i, c] of (Array.isArray(plan.chords) ? plan.chords : []).entries()) {
        const at = Number(c && c.start_ms), sym = String((c && c.symbol) || '');
        if (!(at >= 0 && at < limit)) errors.push(`plan.chords[${i}]: start_ms ${c && c.start_ms} is outside the cue`);
        else if (!CHORD_RE.test(sym)) errors.push(`plan.chords[${i}]: "${sym}" is not a chord symbol (e.g. "Dm7", "F#maj7", "C/E")`);
        else chords.push({ start_ms: Math.round(at), symbol: sym });
    }
    chords.sort((a, b) => a.start_ms - b.start_ms);

    const sections = [];
    for (const [i, x] of (Array.isArray(plan.sections) ? plan.sections : []).entries()) {
        const from = Number(x && x.start_ms), to = Number(x && x.end_ms), name = String((x && x.name) || '').trim();
        if (!name) errors.push(`plan.sections[${i}]: a section needs a name`);
        else if (!(from >= 0 && to > from && to <= limit)) {
            errors.push(`plan.sections[${i}] "${name}": ${x.start_ms}–${x.end_ms}ms is not a range inside the cue`);
        } else sections.push({ name: name.slice(0, 80), start_ms: Math.round(from), end_ms: Math.round(Math.min(to, planLength)) });
    }
    sections.sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 1; i < sections.length; i++) {
        if (sections[i].start_ms < sections[i - 1].end_ms) {
            errors.push(`plan.sections: "${sections[i - 1].name}" and "${sections[i].name}" overlap`);
        }
    }

    const rawParts = Array.isArray(s.parts) ? s.parts : [];
    if (!rawParts.length) errors.push('a note list needs at least one part');
    if (rawParts.length > MAX_PARTS) errors.push(`${rawParts.length} parts; a MIDI file has sixteen channels`);

    const seen = new Set();
    const parts = [];
    let melodic = 0;
    for (const [pi, p] of rawParts.entries()) {
        const name = String((p && p.name) || '').trim();
        const label = name || `parts[${pi}]`;
        if (!name) { errors.push(`parts[${pi}]: a part needs a name`); continue; }
        if (name.length > 60) errors.push(`${label}: a part name is at most 60 characters`);
        if (seen.has(name.toLowerCase())) errors.push(`${label}: two parts share this name`);
        seen.add(name.toLowerCase());

        const drums = !!p.drums;
        const program = p.program == null ? 0 : Number(p.program);
        if (!drums && !(isInt(program) && program >= 0 && program <= 127)) {
            errors.push(`${label}: program must be a General MIDI program 0–127 (got ${p.program})`);
        }
        if (!drums) melodic++;
        const source = p.source == null ? 'agent' : String(p.source);
        if (!PART_SOURCES.includes(source)) errors.push(`${label}: source must be ${PART_SOURCES.join(' or ')}`);

        const notes = Array.isArray(p.notes) ? p.notes : [];
        if (!notes.length) errors.push(`${label}: a part with no notes is not a part`);
        if (notes.length > MAX_NOTES_PER_PART) errors.push(`${label}: ${notes.length} notes; at most ${MAX_NOTES_PER_PART}`);

        const clean = [];
        for (const [ni, n] of notes.slice(0, MAX_NOTES_PER_PART).entries()) {
            const at = Number(n && n.start_ms), dur = Number(n && n.duration_ms);
            const pitch = Number(n && n.pitch), vel = n && n.velocity == null ? 90 : Number(n && n.velocity);
            if (!(at >= 0)) { errors.push(`${label}: note ${ni} has no start_ms`); continue; }
            if (!(dur > 0)) { errors.push(`${label}: note ${ni} has no duration`); continue; }
            if (!(isInt(pitch) && pitch >= 0 && pitch <= 127)) { errors.push(`${label}: note ${ni} pitch ${n.pitch} is not 0–127`); continue; }
            if (!(isInt(vel) && vel >= 1 && vel <= 127)) { errors.push(`${label}: note ${ni} velocity ${n.velocity} is not 1–127`); continue; }
            if (at + dur > limit) {
                errors.push(`${label}: note ${ni} ends at ${Math.round(at + dur)}ms, past the cue at ${Math.round(planLength)}ms`);
                continue;
            }
            clean.push({ start_ms: Math.round(at), duration_ms: Math.max(1, Math.round(Math.min(at + dur, planLength) - Math.round(at))), pitch, velocity: vel });
        }
        clean.sort((a, b) => a.start_ms - b.start_ms || a.pitch - b.pitch);
        parts.push({
            name: name.slice(0, 60),
            instrument: String(p.instrument || (drums ? 'Drums' : GM_PROGRAMS[program] || '')).slice(0, 80),
            program: drums ? 0 : program,
            drums,
            source,
            notes: clean,
        });
    }
    if (melodic > MAX_PARTS - 1) errors.push(`${melodic} melodic parts; channel 10 is percussion, so fifteen is the most`);

    return {
        ok: errors.length === 0,
        errors,
        score: {
            plan: {
                tempo_bpm: tempo, meter, key: plan.key ? String(plan.key).slice(0, 20) : null,
                length_ms: Math.round(planLength), chords, sections,
            },
            parts,
        },
    };
}

// ── writing ──────────────────────────────────────────────────────────────

function varlen(n) {
    let v = Math.max(0, Math.round(n));
    const bytes = [v & 0x7F];
    while ((v >>= 7)) bytes.unshift((v & 0x7F) | 0x80);
    return bytes;
}

function metaEvent(type, data) {
    const payload = Buffer.isBuffer(data) ? [...data] : data;
    return [0xFF, type, ...varlen(payload.length), ...payload];
}

const text = s => [...Buffer.from(String(s), 'utf8')];

/** Key signature meta from "D minor", "Eb major", "F#m". Null when it cannot be read. */
function keySignature(key) {
    const m = String(key || '').trim().match(/^([A-G])(#|b)?\s*(m(?:in(?:or)?)?|maj(?:or)?)?$/i);
    if (!m) return null;
    const minor = !!m[3] && /^m(in|$)/i.test(m[3]) && !/^maj/i.test(m[3]);
    const name = m[1].toUpperCase() + (m[2] || '');
    const MAJOR = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
    const MINOR = { A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7 };
    const sf = (minor ? MINOR : MAJOR)[name];
    return sf == null ? null : [sf & 0xFF, minor ? 1 : 0];
}

function chunk(id, bytes) {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([head, Buffer.from(bytes)]);
}

/** Events at absolute ticks → an MTrk body with delta times and an end-of-track. */
function trackBody(events, endTick) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out = [];
    let last = 0;
    for (const e of events) {
        out.push(...varlen(e.tick - last), ...e.bytes);
        last = e.tick;
    }
    out.push(...varlen(Math.max(0, endTick - last)), 0xFF, 0x2F, 0x00);
    return out;
}

/**
 * The note list as a format-1 Standard MIDI File: a conductor track carrying the
 * plan (tempo, meter, key, section markers, chord changes as text), then ONE
 * TRACK PER PART, so a DAW opens it as separate instruments with their names.
 *
 * Assumes a validated score — validateScore is the gate, this is the printer.
 */
function writeSmf(score) {
    const { plan, parts } = score;
    const msPerTick = 60000 / plan.tempo_bpm / PPQ;
    const tick = ms => Math.round(ms / msPerTick);
    const endTick = tick(plan.length_ms);

    const conductor = [
        { tick: 0, order: 0, bytes: metaEvent(0x03, text('plan')) },
        { tick: 0, order: 1, bytes: metaEvent(0x51, [...(() => { const u = Math.round(60e6 / plan.tempo_bpm); return [(u >> 16) & 0xFF, (u >> 8) & 0xFF, u & 0xFF]; })()]) },
    ];
    const [num, den] = plan.meter.split('/').map(Number);
    conductor.push({ tick: 0, order: 2, bytes: metaEvent(0x58, [num, Math.log2(den), 24, 8]) });
    const ks = keySignature(plan.key);
    if (ks) conductor.push({ tick: 0, order: 3, bytes: metaEvent(0x59, ks) });
    for (const s of plan.sections) conductor.push({ tick: tick(s.start_ms), order: 4, bytes: metaEvent(0x06, text(s.name)) });
    for (const c of plan.chords) conductor.push({ tick: tick(c.start_ms), order: 5, bytes: metaEvent(0x01, text(`chord ${c.symbol}`)) });

    const tracks = [chunk('MTrk', trackBody(conductor, endTick))];
    let nextChannel = 0;
    for (const part of parts) {
        let channel = DRUM_CHANNEL;
        if (!part.drums) {
            if (nextChannel === DRUM_CHANNEL) nextChannel++;
            channel = nextChannel++;
        }
        const events = [
            { tick: 0, order: 0, bytes: metaEvent(0x03, text(part.name)) },
            { tick: 0, order: 1, bytes: metaEvent(0x04, text(part.instrument || '')) },
            { tick: 0, order: 2, bytes: [0xC0 | channel, part.program & 0x7F] },
        ];
        for (const n of part.notes) {
            const on = tick(n.start_ms);
            const off = Math.max(on + 1, tick(n.start_ms + n.duration_ms));
            // Note-off sorts before note-on at the same tick, so a repeated pitch
            // re-strikes instead of being cut by its own predecessor's release.
            events.push({ tick: on, order: 4, bytes: [0x90 | channel, n.pitch, n.velocity] });
            events.push({ tick: off, order: 3, bytes: [0x80 | channel, n.pitch, 64] });
        }
        tracks.push(chunk('MTrk', trackBody(events, endTick)));
    }

    const header = Buffer.alloc(6);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(tracks.length, 2);
    header.writeUInt16BE(PPQ, 4);
    return Buffer.concat([chunk('MThd', [...header]), ...tracks]);
}

// ── reading ──────────────────────────────────────────────────────────────

/** Does this look like a Standard MIDI File at all? The bytes decide, never the name. */
function isMidi(bytes) {
    return Buffer.isBuffer(bytes) && bytes.length >= 14 && bytes.toString('ascii', 0, 4) === 'MThd';
}

/**
 * Read a Standard MIDI File into notes in milliseconds.
 *
 * Tolerant of what DAWs actually write — running status, note-on at velocity 0
 * as a release, format 0 with everything on one track, sysex — and strict about
 * what would make the times wrong: an SMPTE time division is refused rather than
 * guessed, and a chunk that runs past the end of the file is an error rather
 * than a silently shorter part.
 */
function parseSmf(bytes) {
    if (!isMidi(bytes)) throw new Error('not a MIDI file: expected a Standard MIDI File (.mid)');
    const headLen = bytes.readUInt32BE(4);
    if (headLen < 6 || 8 + headLen > bytes.length) throw new Error('invalid MIDI: header chunk is truncated');
    const format = bytes.readUInt16BE(8);
    const declaredTracks = bytes.readUInt16BE(10);
    const division = bytes.readUInt16BE(12);
    if (format > 2) throw new Error(`invalid MIDI: unknown format ${format}`);
    if (division & 0x8000) {
        throw new Error('this MIDI file uses SMPTE time; export it with a tempo-based (ticks per beat) clock');
    }
    if (!division) throw new Error('invalid MIDI: time division is zero');

    const rawTracks = [];
    let off = 8 + headLen;
    while (off + 8 <= bytes.length) {
        const id = bytes.toString('ascii', off, off + 4);
        const len = bytes.readUInt32BE(off + 4);
        const start = off + 8, end = start + len;
        if (end > bytes.length) throw new Error(`invalid MIDI: ${id} chunk runs past the end of the file`);
        if (id === 'MTrk') rawTracks.push(bytes.subarray(start, end));
        off = end;
    }
    if (!rawTracks.length) throw new Error('invalid MIDI: no tracks');

    const tempos = [];        // { tick, uspq }
    let timeSignature = null, key = null;
    const markers = [];       // { tick, text, kind }
    const tracks = [];
    let lastTick = 0;

    for (const [ti, data] of rawTracks.entries()) {
        let p = 0, tick = 0, status = 0;
        const readVar = () => {
            let v = 0, b, guard = 0;
            do {
                if (p >= data.length) throw new Error(`invalid MIDI: track ${ti} ends inside a number`);
                b = data[p++]; v = (v << 7) | (b & 0x7F);
                if (++guard > 4) throw new Error(`invalid MIDI: track ${ti} has an oversized number`);
            } while (b & 0x80);
            return v;
        };
        const need = n => { if (p + n > data.length) throw new Error(`invalid MIDI: track ${ti} is truncated`); };
        const track = { index: ti, name: null, instrument: null, channel: null, program: null, rawNotes: [] };
        const open = new Map();

        while (p < data.length) {
            tick += readVar();
            need(1);
            let b = data[p];
            if (b & 0x80) { p++; } else {
                if (!status) throw new Error(`invalid MIDI: track ${ti} uses running status before any status byte`);
                b = status;
            }
            if (b === 0xFF) {
                need(1);
                const type = data[p++];
                const len = readVar();
                need(len);
                const payload = data.subarray(p, p + len);
                p += len;
                if (type === 0x2F) break;
                if (type === 0x51 && len === 3) tempos.push({ tick, uspq: (payload[0] << 16) | (payload[1] << 8) | payload[2] });
                else if (type === 0x58 && len >= 2 && !timeSignature) timeSignature = `${payload[0]}/${2 ** payload[1]}`;
                else if (type === 0x59 && len === 2 && !key) key = { sf: (payload[0] << 24) >> 24, minor: payload[1] === 1 };
                else if (type === 0x03 && track.name == null) track.name = payload.toString('utf8');
                else if (type === 0x04 && track.instrument == null) track.instrument = payload.toString('utf8');
                else if (type === 0x06) markers.push({ tick, text: payload.toString('utf8'), kind: 'marker' });
                else if (type === 0x01) markers.push({ tick, text: payload.toString('utf8'), kind: 'text' });
                continue;
            }
            if (b === 0xF0 || b === 0xF7) { const len = readVar(); need(len); p += len; status = 0; continue; }
            status = b;
            const kind = b & 0xF0, ch = b & 0x0F;
            const width = (kind === 0xC0 || kind === 0xD0) ? 1 : 2;
            need(width);
            const d1 = data[p], d2 = width === 2 ? data[p + 1] : 0;
            p += width;
            if (kind === 0xC0) { if (track.program == null) track.program = d1; if (track.channel == null) track.channel = ch; continue; }
            const k = ch * 128 + d1;
            if (kind === 0x90 && d2 > 0) {
                if (track.channel == null) track.channel = ch;
                if (!open.has(k)) open.set(k, []);
                open.get(k).push({ tick, velocity: d2, channel: ch });
            } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
                const stack = open.get(k);
                if (stack && stack.length) {
                    const on = stack.shift();
                    track.rawNotes.push({ on: on.tick, off: tick, pitch: d1, velocity: on.velocity, channel: ch });
                }
            }
        }
        // A note never released ends where its track ends, rather than vanishing.
        for (const [k, stack] of open) {
            for (const on of stack) track.rawNotes.push({ on: on.tick, off: Math.max(tick, on.tick + 1), pitch: k % 128, velocity: on.velocity, channel: on.channel });
        }
        lastTick = Math.max(lastTick, tick);
        tracks.push(track);
    }

    // Tick → milliseconds through the tempo map. 500000 µs/quarter (120bpm) until told otherwise.
    tempos.sort((a, b) => a.tick - b.tick);
    const segments = [];
    let accMs = 0, prevTick = 0, uspq = 500000;
    for (const t of tempos) {
        accMs += ((t.tick - prevTick) * uspq) / division / 1000;
        segments.push({ tick: t.tick, ms: accMs, uspq: t.uspq });
        prevTick = t.tick; uspq = t.uspq;
    }
    const toMs = tk => {
        let base = { tick: 0, ms: 0, uspq: 500000 };
        for (const s of segments) { if (s.tick <= tk) base = s; else break; }
        return base.ms + ((tk - base.tick) * base.uspq) / division / 1000;
    };

    const out = tracks.map(t => {
        const notes = t.rawNotes
            .map(n => {
                const start = toMs(n.on);
                return { start_ms: Math.round(start), duration_ms: Math.max(1, Math.round(toMs(n.off) - start)), pitch: n.pitch, velocity: n.velocity };
            })
            .sort((a, b) => a.start_ms - b.start_ms || a.pitch - b.pitch);
        return {
            index: t.index, name: t.name, instrument: t.instrument,
            channel: t.channel, program: t.program,
            drums: t.channel === DRUM_CHANNEL, notes,
        };
    });

    const noteEnd = Math.max(0, ...out.flatMap(t => t.notes.map(n => n.start_ms + n.duration_ms)));
    return {
        format, ppq: division, declared_tracks: declaredTracks,
        tempo_bpm: tempos.length ? Math.round((60e6 / tempos[0].uspq) * 1000) / 1000 : 120,
        tempo_changes: tempos.length,
        time_signature: timeSignature || '4/4',
        key,
        markers: markers.map(m => ({ ms: Math.round(toMs(m.tick)), text: m.text, kind: m.kind })),
        length_ms: Math.max(noteEnd, Math.round(toMs(lastTick))),
        tracks: out,
    };
}

module.exports = {    PPQ, DRUM_CHANNEL, GM_PROGRAMS,
    validateScore, writeSmf, parseSmf, isMidi,};
