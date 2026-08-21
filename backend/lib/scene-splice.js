/**
 * Replace one scene inside a screenplay, and leave the rest byte-identical.
 *
 * The screenplay is the source. Everything downstream is derived from it, so a
 * scene edited anywhere else immediately disagrees with the document it came
 * from — which is why film_scenes.description is a projection and not somewhere
 * to write.
 *
 * But requiring a whole-document rewrite to change one scene is its own bug.
 * The model has to reproduce every other scene faithfully from memory, and the
 * cost of one mistake is silent: a stray reflow in scene 1 marks its shots as
 * behind, and a director re-does work nobody asked them to.
 *
 * So this splices. Find the scene's span in the Fountain, swap those lines, and
 * hand the whole document back to the same reconciler a full rewrite uses. One
 * scene changes, every other byte survives, and the drift report stays honest
 * because it is comparing text that genuinely did not move.
 *
 * Pure: takes a string, returns a string. The route does the reading and saving.
 */

/**
 * A scene heading, by the Fountain rules that matter here.
 *
 * INT./EXT. and their variants, plus a forced heading with a leading dot — but
 * NOT `..`, which is Fountain's escape for a line that genuinely starts with a
 * full stop. Getting that wrong splits a scene at a line of dialogue.
 */
function isSceneHeading(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (/^\.[^.]/.test(t)) return true;
    return /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s]/i.test(t);
}

/**
 * Where each scene starts and ends, in line numbers.
 *
 * Any title page is skipped: it sits above the first heading, is not a scene,
 * and including it would make scene 1 unsplice-able without destroying it.
 */
function sceneSpans(fountain) {
    const lines = String(fountain || '').split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i++) if (isSceneHeading(lines[i])) starts.push(i);

    return starts.map((start, n) => ({
        index: n,                                   // 0-based scene order
        start,
        end: n + 1 < starts.length ? starts[n + 1] - 1 : lines.length - 1,
        heading: lines[start].trim(),
    }));
}

/**
 * Swap one scene's text for another.
 *
 * `replacement` is the whole scene INCLUDING its heading, because a caller that
 * supplies only a body has to be told where the heading ends, and every way of
 * telling them is a second convention to get wrong.
 *
 * Throws rather than guessing when the scene is not there: silently appending
 * to the end of a screenplay is the kind of help nobody wants.
 */
function spliceScene(fountain, sceneIndex, replacement) {
    const spans = sceneSpans(fountain);
    const span = spans[sceneIndex];
    if (!span) {
        const err = new Error(
            `That screenplay has ${spans.length} scene(s); there is no scene at position ${sceneIndex + 1}`);
        err.code = 'NO_SUCH_SCENE';
        throw err;
    }

    const body = String(replacement || '').replace(/\s+$/, '');
    if (!body.trim()) {
        const err = new Error('A scene needs text. To remove a scene, delete it rather than emptying it.');
        err.code = 'EMPTY_SCENE';
        throw err;
    }
    if (!isSceneHeading(body.split('\n')[0])) {
        const err = new Error(
            'A replacement scene must start with its own scene heading (INT./EXT. LOCATION - TIME).');
        err.code = 'NO_HEADING';
        throw err;
    }

    const lines = String(fountain || '').split('\n');
    const before = lines.slice(0, span.start);
    const after = lines.slice(span.end + 1);

    // Put back exactly the blank lines the old scene ended with.
    //
    // Trimming the replacement and appending a fixed separator looks tidier and
    // is wrong at the end of a document: the last scene's trailing newline
    // disappears, so re-saving a scene with the text it already has produces a
    // different file, a new version, and a warning that the shots are behind.
    // "Did that apply?" has to be a free question.
    let trailing = 0;
    for (let i = span.end; i >= span.start && lines[i].trim() === ''; i--) trailing++;
    const gap = new Array(trailing).fill('');

    return [...before, ...body.split('\n'), ...gap, ...after].join('\n');
}

/**
 * Add scenes to the end, leaving every existing byte where it was.
 *
 * The primitive the chapter-by-chapter import needs. `script_write` rewrites the
 * whole document and `spliceScene` replaces one scene by index; neither can add
 * without re-sending everything, which is quadratic in tokens and — worse —
 * risks reflowing scenes nobody edited.
 *
 * **The result is guaranteed to START WITH the original, byte for byte.** That
 * is not a nicety: `syncScenesWithScreenplay` matches scenes by number and
 * restamps whatever it matches, so a prefix that shifts by one character marks
 * every shot below it as behind. Everything here exists to keep that promise.
 *
 * A FRAGMENT, not a scene. A novel chapter is rarely one scene — it may be an
 * arrival, a conversation and a departure — and a one-scene-per-call signature
 * would make the model call this three times per chapter, each call re-parsing
 * and re-reconciling the entire screenplay. That is the quadratic problem again
 * in miniature.
 *
 * Refuses a fragment with no scene heading rather than appending it. Bare prose
 * would land inside the previous scene, silently, and the first sign would be a
 * scene that had grown a paragraph nobody wrote there.
 *
 * @returns {{ fountain: string, added: number, headings: string[] }}
 */
function appendScenes(fountain, fragment) {
    const base = String(fountain || '');
    const frag = String(fragment || '');

    // "Did that apply?" has to be a free question. An empty append changes
    // nothing and must not produce a version — the rule spliceScene already
    // follows for a save that says what the scene already said.
    if (!frag.trim()) return { fountain: base, added: 0, headings: [] };

    const spans = sceneSpans(frag);
    if (!spans.length) {
        const err = new Error(
            'A fragment must contain at least one scene heading (INT./EXT., or a line starting with a full stop). '
            + 'Bare prose would be appended inside the previous scene.');
        err.code = 'NO_SCENE_HEADING';
        throw err;
    }

    // Anything above the fragment's first heading is dropped rather than
    // carried: it would silently extend the LAST existing scene, which is the
    // failure this function refuses bare prose to avoid. Dropping it visibly is
    // wrong too, so it is refused instead.
    if (spans[0].start > 0 && frag.split('\n').slice(0, spans[0].start).some(l => l.trim())) {
        const err = new Error(
            'The fragment has text above its first scene heading. That text would extend the previous '
            + 'scene rather than start a new one — move it under a heading, or into the scene it belongs to.');
        err.code = 'TEXT_BEFORE_HEADING';
        throw err;
    }

    // Exactly enough separation for Fountain, and not one byte more. Computed
    // from what the base already ends with, so appending to a document that
    // ends in a newline does not introduce a second one and appending twice is
    // stable.
    const body = frag.replace(/^\n+/, '');
    let sep = '\n\n';
    if (base === '') sep = '';
    else if (base.endsWith('\n\n')) sep = '';
    else if (base.endsWith('\n')) sep = '\n';

    return {
        fountain: base + sep + body,
        added: spans.length,
        headings: spans.map(s => s.heading),
    };
}

module.exports = { isSceneHeading, sceneSpans, spliceScene, appendScenes };
