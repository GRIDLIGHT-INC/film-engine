/**
 * Which blocks in the screenplay editor are nothing but space.
 *
 * An empty block costs 32px on screen — its own line plus the margin its type
 * carries — and serialises to NOTHING: `serializeElement` opens with
 * `if (!text) return;`. So it is pure layout with no meaning, and the moment
 * anything re-parses the document and rebuilds the editor they all vanish at
 * once. That is why the extra space "fixes itself" when you click away: the
 * screenplay was never wrong, only the DOM was.
 *
 * Measured on a real document: the correct gap between dialogue and the next
 * character cue is 16px; one stale empty block makes it 48, two make it 80,
 * three make it 112.
 *
 * ONE EXCEPTION, and it is the whole safety of this: the block holding the
 * caret is empty because you are about to type in it. Sweeping that away would
 * delete the line you are writing.
 *
 * Pure, and mirrored by a copy in the SPA — index.html cannot require a node
 * module (build.target is single-html) — with the two held in lockstep by
 * screenplay-empty-blocks.test.js. Two rules that disagree is how a fix
 * survives in the tests and not on the screen.
 */

/**
 * Types whose emptiness is meaningful.
 *
 * The title page has no body text and is entirely the point; it is also
 * contenteditable="false" and carries its data in an attribute. Named
 * explicitly rather than matched by a pattern, so the next type that needs an
 * exemption has to be added deliberately instead of falling through one.
 */
const KEEP_EMPTY = Object.freeze(['title-page']);

/**
 * The editor's OWN furniture: things it inserts among the blocks that are not
 * content and never were.
 *
 * A page-break indicator is a <div> with a class, no element type and no text —
 * which is precisely the shape of an empty block. The orphan-adoption loop met
 * five of them on every keystroke and turned each into an empty `action` block:
 * 32px of nothing, five per keypress, then counted as lines, which inflated the
 * page estimate, which inserted more indicators, which became more empty
 * blocks. That is where "a huge space that is left" came from, and why it grew
 * the longer you typed.
 *
 * Deleting them instead is not the fix either — that silently removes the
 * pagination. Furniture must be INVISIBLE to both passes.
 */
const FURNITURE_CLASSES = Object.freeze(['page-break-indicator']);

/** Is this the editor's own furniture rather than something the writer typed? */
function isFurniture(node) {
    if (!node) return false;
    const cls = String(node.className || '');
    return FURNITURE_CLASSES.some(c => cls.split(/\s+/).includes(c));
}

/** A block is empty when it has no text a screenplay would print. */
function isEmptyBlock(block) {
    if (!block) return true;
    return String(block.text || '').trim() === '';
}

/**
 * Indices of the blocks that may be removed.
 *
 * `blocks` is [{ type, text, hasCaret }] — deliberately plain data, so the rule
 * can be tested without a DOM and the page can apply it to real nodes.
 */
function droppableEmpties(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!b) continue;
        if (isFurniture(b)) continue;          // not content, never was
        if (KEEP_EMPTY.includes(b.type)) continue;
        if (b.hasCaret) continue;              // you are typing in it
        if (!isEmptyBlock(b)) continue;
        out.push(i);
    }
    return out;
}

module.exports = { KEEP_EMPTY, FURNITURE_CLASSES, isFurniture, isEmptyBlock, droppableEmpties };
