/**
 * Port value constructor.
 *
 * Every value crossing an edge is { type, value } — the typing is the whole
 * point of the graph, so it is built in one place rather than spelled out by
 * each handler and eventually forgotten by one of them.
 */
function PORT(type, value) {
    return { type, value };
}

module.exports = { PORT };
