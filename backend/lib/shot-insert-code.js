/**
 * The code an inserted shot gets (PGN-019), said once.
 *
 * Numbered the way a script supervisor numbers an insert: after 2A comes 2AA,
 * and a second insert after the same shot walks the suffix to 2AB — nothing
 * already written down is renamed. The insert route writes with this, and the
 * production graph's add palette previews with a mirror of it held equal by
 * tests/graph-add-palette.test.js, so the code a person is shown is the code
 * the shot gets.
 *
 * @returns {string|null} the next free code, or null when all 26 are taken.
 */
function nextInsertCode(anchorCode, usedCodes) {
    const used = new Set((usedCodes || []).map(c => String(c || '').toUpperCase()));
    let code = String(anchorCode || '') + 'A';
    let guard = 0;
    while (used.has(code.toUpperCase()) && guard++ < 25) {
        code = code.slice(0, -1) + String.fromCharCode(code.charCodeAt(code.length - 1) + 1);
    }
    return used.has(code.toUpperCase()) ? null : code;
}

module.exports = { nextInsertCode };
