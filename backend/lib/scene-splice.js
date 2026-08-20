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

module.exports = { isSceneHeading, sceneSpans, spliceScene };
