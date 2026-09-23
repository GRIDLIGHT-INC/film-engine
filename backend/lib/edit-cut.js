/**
 * READING AN EDIT BACK: where each shot sits in a cut made in an editor.
 *
 * Film Engine exports to Premiere and could not read anything back, so a score
 * written here was timed to the ASSEMBLY — the shots in running order at their
 * own lengths — while the film that will actually play is the cut the editor
 * made: trimmed, reordered, some shots dropped. This reads that cut.
 *
 * Two formats, because they are the two an editor can hand over from Premiere:
 *
 *   xmeml  "Final Cut Pro XML" (File → Export → Final Cut Pro XML). Frames at
 *          the sequence timebase, clip items per track, transitions between.
 *   edl    CMX 3600 (File → Export → EDL). Timecode events, one picture track,
 *          the clip's name in a `* FROM CLIP NAME:` comment.
 *
 * FCPXML (Final Cut Pro, Resolve) is NOT read yet, and is refused by name
 * rather than parsed as something it is not.
 *
 * PURE: no database, no filesystem. `parseCut` turns text into events on the
 * edit's own clock; `matchCut` (which takes a list of the project's shots and
 * clip files) says which Film Engine shot each event is — or that it is none.
 * An unmatched event is REPORTED, never dropped: a title card or a stock shot
 * is part of the cut and takes up time the score has to cover.
 */

// ── A small XML reader ────────────────────────────────────────────────────
//
// No dependency (ADR-002). Elements, attributes, text, CDATA; comments,
// processing instructions and a DOCTYPE are skipped. Enough for xmeml, which
// is plain element-and-text XML.

function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
        if (k === 'quot') return '"'; if (k === 'apos') return "'";
        if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
        if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
        return m;
    });
}

function parseXml(text) {
    const src = String(text || '');
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    let i = 0;
    const TAG = /^<\s*(\/)?\s*([A-Za-z_][\w:.-]*)([^>]*?)(\/)?\s*>/;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0) { stack[stack.length - 1].text += decodeEntities(src.slice(i)); break; }
        if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
        if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
        if (src.startsWith('<![CDATA[', lt)) {
            const e = src.indexOf(']]>', lt);
            stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? src.length : e);
            i = e < 0 ? src.length : e + 3; continue;
        }
        if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt); i = e < 0 ? src.length : e + 2; continue; }
        if (src.startsWith('<!', lt)) {
            // A DOCTYPE, possibly with an internal subset in brackets.
            let depth = 0, j = lt + 2;
            for (; j < src.length; j++) {
                if (src[j] === '[') depth++;
                else if (src[j] === ']') depth--;
                else if (src[j] === '>' && depth <= 0) break;
            }
            i = j + 1; continue;
        }
        const m = TAG.exec(src.slice(lt, lt + 4096));
        if (!m) throw new Error(`not readable XML near character ${lt}`);
        const [whole, closing, name, rawAttrs, selfClosing] = m;
        if (closing) {
            // Close back to the matching element; a stray close is tolerated.
            for (let k = stack.length - 1; k > 0; k--) {
                if (stack[k].name === name) { stack.length = k; break; }
            }
        } else {
            const attrs = {};
            for (const a of rawAttrs.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
                attrs[a[1]] = decodeEntities(a[3] !== undefined ? a[3] : a[4]);
            }
            const el = { name, attrs, children: [], text: '' };
            stack[stack.length - 1].children.push(el);
            if (!selfClosing) stack.push(el);
        }
        i = lt + whole.length;
    }
    return root;
}

const kids = (el, name) => (el ? el.children.filter(c => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const textOf = (el, name) => { const c = kid(el, name); return c ? c.text.trim() : ''; };
function descendants(el, name, out = []) {
    for (const c of (el ? el.children : [])) { if (c.name === name) out.push(c); descendants(c, name, out); }
    return out;
}

function rateOf(el) {
    const r = kid(el, 'rate');
    const timebase = Number(textOf(r, 'timebase')) || 0;
    const ntsc = /^true$/i.test(textOf(r, 'ntsc'));
    return timebase ? { timebase, ntsc, fps: ntsc ? timebase * 1000 / 1001 : timebase } : null;
}

const framesToMs = (frames, fps) => Math.round((Number(frames) || 0) * 1000 / fps);

// ── xmeml ─────────────────────────────────────────────────────────────────

function basenameOf(p) {
    const s = decodeURIComponent(String(p || '').replace(/^file:\/\/(localhost)?/i, ''));
    return s.split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * Every sequence in an xmeml document, each as events on the picture tracks.
 *
 * A clip item next to a transition carries `-1` for the side that touches it:
 * the edit point is then the transition's CENTRE, which is where the cut is
 * read from in every editor. Our own exporter writes explicit frame numbers
 * beside a transition instead; both shapes resolve to the same cut.
 */
function parseXmeml(text) {
    const doc = parseXml(text);
    const top = kid(doc, 'xmeml');
    if (!top) throw new Error('this is not a Final Cut Pro XML (xmeml) document: it has no <xmeml> root');
    const files = new Map();
    for (const f of descendants(top, 'file')) {
        if (f.attrs.id && (kid(f, 'name') || kid(f, 'pathurl'))) {
            files.set(f.attrs.id, { name: textOf(f, 'name'), path: textOf(f, 'pathurl') });
        }
    }
    const sequences = descendants(top, 'sequence').map(seq => {
        const rate = rateOf(seq) || { timebase: 24, ntsc: false, fps: 24 };
        const video = kid(kid(seq, 'media'), 'video');
        const tracks = kids(video, 'track').map((track, ti) => {
            const items = track.children.filter(c => c.name === 'clipitem' || c.name === 'transitionitem');
            const events = [];
            items.forEach((it, idx) => {
                if (it.name !== 'clipitem') return;
                if (/^false$/i.test(textOf(it, 'enabled'))) return;      // a disabled clip is not in the picture
                let start = Number(textOf(it, 'start'));
                let end = Number(textOf(it, 'end'));
                const prev = items[idx - 1], next = items[idx + 1];
                if (start < 0 && prev && prev.name === 'transitionitem') {
                    start = Math.round((Number(textOf(prev, 'start')) + Number(textOf(prev, 'end'))) / 2);
                }
                if (end < 0 && next && next.name === 'transitionitem') {
                    end = Math.round((Number(textOf(next, 'start')) + Number(textOf(next, 'end'))) / 2);
                }
                if (!(end > start) || start < 0) return;
                const fileEl = kid(it, 'file');
                const file = fileEl ? (files.get(fileEl.attrs.id) || { name: textOf(fileEl, 'name'), path: textOf(fileEl, 'pathurl') }) : null;
                const inF = Number(textOf(it, 'in')) || 0;
                events.push({
                    track: ti + 1,
                    name: textOf(it, 'name'),
                    file_name: file ? (file.name || basenameOf(file.path)) : '',
                    file_path: file ? file.path : '',
                    start_ms: framesToMs(start, rate.fps),
                    end_ms: framesToMs(end, rate.fps),
                    source_in_ms: framesToMs(inF, rate.fps),
                });
            });
            return events;
        });
        const all = tracks.flat();
        const durationFrames = Number(textOf(seq, 'duration')) || 0;
        return {
            name: textOf(seq, 'name') || 'Sequence',
            fps: rate.fps,
            duration_ms: durationFrames ? framesToMs(durationFrames, rate.fps) : Math.max(0, ...all.map(e => e.end_ms)),
            tracks,
        };
    });
    if (!sequences.length) throw new Error('the XML holds no <sequence> to read a cut from');
    return sequences;
}

// ── CMX 3600 EDL ──────────────────────────────────────────────────────────

function tcToMs(tc, fps) {
    const m = /^(\d{2}):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(String(tc).trim());
    if (!m) throw new Error(`"${tc}" is not a timecode`);
    const nominal = Math.round(fps);
    const frames = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * nominal + +m[4];
    return Math.round(frames * 1000 / fps);
}

/**
 * An EDL's events on its picture track. Timecodes are record times, so the
 * first event's record-in is the edit's zero (usually 01:00:00:00).
 */
function parseEdl(text, fps) {
    const rate = Number(fps) > 0 ? Number(fps) : 24;
    const lines = String(text || '').split(/\r?\n/);
    const title = (lines.find(l => /^TITLE:/i.test(l)) || '').replace(/^TITLE:\s*/i, '').trim();
    const EVENT = /^(\d{3,6})\s+(\S+)\s+(\S+)\s+(C|D|W\d{3}|K\s*[BO]?)\s*(\d{3})?\s+(\d\d:\d\d:\d\d[:;.]\d\d)\s+(\d\d:\d\d:\d\d[:;.]\d\d)\s+(\d\d:\d\d:\d\d[:;.]\d\d)\s+(\d\d:\d\d:\d\d[:;.]\d\d)/i;
    const raw = [];
    for (const line of lines) {
        const m = EVENT.exec(line.trim());
        if (m) {
            raw.push({ reel: m[2], channel: m[3].toUpperCase(), src_in: m[6], rec_in: m[8], rec_out: m[9], name: '' });
            continue;
        }
        const clip = /^\*\s*FROM CLIP NAME:\s*(.+)$/i.exec(line.trim());
        if (clip && raw.length) raw[raw.length - 1].name = clip[1].trim();
    }
    const picture = raw.filter(e => e.channel.includes('V') || e.channel === 'B');
    if (!picture.length) throw new Error('the EDL holds no picture events to read a cut from');
    const zero = Math.min(...picture.map(e => tcToMs(e.rec_in, rate)));
    const events = picture.map(e => ({
        track: 1,
        name: e.name || e.reel,
        file_name: e.name || '',
        file_path: '',
        start_ms: tcToMs(e.rec_in, rate) - zero,
        end_ms: tcToMs(e.rec_out, rate) - zero,
        source_in_ms: tcToMs(e.src_in, rate),
    })).filter(e => e.end_ms > e.start_ms);
    return [{ name: title || 'EDL', fps: rate, duration_ms: Math.max(0, ...events.map(e => e.end_ms)), tracks: [events] }];
}

/** What the text is. FCPXML is named and refused rather than misread. */
function detectFormat(text) {
    const head = String(text || '').slice(0, 4000);
    if (/<xmeml\b/i.test(head)) return 'xmeml';
    if (/<fcpxml\b/i.test(head)) return 'fcpxml';
    if (/^\s*TITLE:/im.test(head) || /^\d{3,6}\s+\S+\s+\S+\s+C\s/m.test(head)) return 'edl';
    return null;
}

/**
 * Text in, cut out: `{ format, sequence, sequences, events, duration_ms, fps }`.
 *
 * The PICTURE is the lowest video track that has anything on it — in a cut
 * that is where the edit lives; higher tracks are titles and overlays, which
 * are reported as `overlays` rather than read as cuts.
 */
function parseCut(text, opts) {
    const o = opts || {};
    const format = detectFormat(text);
    if (format === 'fcpxml') throw new Error('this is FCPXML (Final Cut Pro / Resolve). From Premiere, use File → Export → Final Cut Pro XML, or export an EDL');
    if (!format) throw new Error('not a cut Film Engine can read: expected Final Cut Pro XML (xmeml) or a CMX 3600 EDL');
    const sequences = format === 'xmeml' ? parseXmeml(text) : parseEdl(text, o.fps);
    const wanted = o.sequence ? sequences.find(s => s.name === o.sequence) : null;
    if (o.sequence && !wanted) throw new Error(`no sequence named "${o.sequence}" — this file has ${sequences.map(s => `"${s.name}"`).join(', ')}`);
    // The sequence with the most picture, unless one was named.
    const seq = wanted || sequences.slice().sort((a, b) => b.tracks.flat().length - a.tracks.flat().length)[0];
    const primaryIndex = seq.tracks.findIndex(t => t.length);
    if (primaryIndex < 0) throw new Error(`sequence "${seq.name}" has no clips on any picture track`);
    const events = seq.tracks[primaryIndex].slice().sort((a, b) => a.start_ms - b.start_ms);
    const overlays = seq.tracks.slice(primaryIndex + 1).flat().sort((a, b) => a.start_ms - b.start_ms);
    return {
        format,
        sequence: seq.name,
        sequences: sequences.map(s => s.name),
        fps: seq.fps,
        duration_ms: Math.max(seq.duration_ms || 0, ...events.map(e => e.end_ms), 0),
        picture_track: primaryIndex + 1,
        events,
        overlays,
    };
}

// ── Which Film Engine shot each event is ──────────────────────────────────

/**
 * Match every event to a shot, and say how.
 *
 *   `file`   the clip's file is one Film Engine stored for that shot — the
 *            strongest answer, because the editor cut the file we made.
 *   `code`   the clip's name contains a shot code as a whole token ("2AA_v2"
 *            is 2AA, never 2A); longest code first.
 *   none     an event this project did not make: a title, a stock shot. Kept,
 *            because it is still time the score has to cover.
 *
 * `shots`: [{ id, shot_code, scene_id }]; `files`: [{ file_name, shot_id, covers? }].
 */
function matchCut(cut, shots, files) {
    const byFile = new Map();
    for (const f of files || []) {
        if (f.file_name && f.shot_id && !byFile.has(f.file_name.toLowerCase())) byFile.set(f.file_name.toLowerCase(), f);
    }
    const byId = new Map((shots || []).map(s => [s.id, s]));
    const codes = (shots || []).filter(s => s.shot_code).slice().sort((a, b) => b.shot_code.length - a.shot_code.length);
    const tokensOf = s => String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    const matchOne = e => {
        const f = byFile.get(String(e.file_name || '').toLowerCase()) || byFile.get(basenameOf(e.file_path).toLowerCase());
        if (f && byId.has(f.shot_id)) return { shot: byId.get(f.shot_id), how: 'file', covers: f.covers || [] };
        for (const source of [e.file_name, e.name, basenameOf(e.file_path)]) {
            const tokens = new Set(tokensOf(String(source || '').replace(/\.[a-z0-9]{2,4}$/i, '')));
            const hit = codes.find(s => tokens.has(s.shot_code.toUpperCase()));
            if (hit) return { shot: hit, how: 'code', covers: [] };
        }
        return null;
    };
    const events = (cut.events || []).map(e => {
        const m = matchOne(e);
        return {
            ...e,
            duration_ms: e.end_ms - e.start_ms,
            shot_id: m ? m.shot.id : null,
            shot_code: m ? m.shot.shot_code : null,
            scene_id: m ? m.shot.scene_id || null : null,
            matched_by: m ? m.how : null,
            covers: m ? m.covers : [],
        };
    });
    const matched = events.filter(e => e.shot_id);
    const usedShots = new Set(matched.map(e => e.shot_id));
    return {
        ...cut,
        events,
        summary: {
            events: events.length,
            matched: matched.length,
            unmatched: events.length - matched.length,
            unmatched_names: events.filter(e => !e.shot_id).map(e => e.name || e.file_name || '(unnamed)'),
            shots_used: usedShots.size,
            shots_not_in_cut: (shots || []).filter(s => !usedShots.has(s.id)).map(s => s.shot_code),
            by: { file: matched.filter(e => e.matched_by === 'file').length, code: matched.filter(e => e.matched_by === 'code').length },
        },
    };
}

module.exports = { parseXml, parseXmeml, parseEdl, parseCut, detectFormat, matchCut, tcToMs, CUT_FORMATS: Object.freeze(['xmeml', 'edl']) };
