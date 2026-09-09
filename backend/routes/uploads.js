/**
 * The HTTP face of a resumable transfer.
 *
 * Five operations, because that is what a transfer that survives a dropped
 * connection needs: agree what is coming, send a piece, ask where you got to,
 * finalise, give up. Take away `status` and a client cannot resume — it can
 * only start again, which is the thing this exists to stop.
 *
 * THE COMPLETION HANDS OFF TO `importMedia`, exactly as a direct upload does.
 * A chunked path that wrote the file itself would skip the magic-byte sniffing,
 * the asset row and the duration measurement — and it would skip them on the
 * route built for the LARGEST files, which is the worst one to exempt.
 */

const uploads = require('../lib/uploads');
const { importMedia } = require('../lib/media-imports');

function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/*
 * A refusal a client can ACT ON. `wrong offset` carries the true number so the
 * phone corrects itself rather than guessing again; `incomplete` says how much
 * arrived so it can resume rather than restart. Both are 409 — the request was
 * well formed and the state disagrees with it, which is exactly what a client
 * is expected to reconcile and retry.
 */
function fail(res, err) {
    const why = String(err && err.message ? err.message : err);
    if (/^unknown upload/.test(why)) return send(res, 404, { error: why });
    if (/wrong offset|incomplete/.test(why)) return send(res, 409, { error: why });
    return send(res, 400, { error: why });
}

/**
 * `/film/uploads` and `/film/uploads/:id[/complete]`.
 *
 * Returns false when the path is not ours, so `server.js` keeps looking —
 * the same contract every other route module here follows.
 */
async function handleUploads(req, res, parts) {
    if (parts[1] !== 'uploads') return false;
    const id = parts[2];
    const tail = parts[3];

    try {
        if (!id && req.method === 'POST') {
            send(res, 201, uploads.beginUpload(req.body || {}));
            return true;
        }
        if (id && !tail && req.method === 'GET') {
            send(res, 200, uploads.uploadStatus(id));
            return true;
        }
        if (id && !tail && (req.method === 'PATCH' || req.method === 'PUT')) {
            /*
             * The chunk travels as RAW BYTES — `readBody` hands back
             * `{__raw, __mime}` for a media content-type — and the offset rides
             * in a header rather than the body, because a body that is bytes
             * has nowhere to put a number.
             */
            const body = req.body || {};
            const bytes = body.__raw;
            if (!Buffer.isBuffer(bytes)) {
                send(res, 400, {
                    error: 'a chunk must be sent as raw bytes with a media Content-Type — '
                        + 'application/octet-stream is the usual choice',
                });
                return true;
            }
            const offset = Number(req.headers['x-upload-offset']);
            if (!Number.isInteger(offset) || offset < 0) {
                send(res, 400, {
                    error: 'X-Upload-Offset must say where in the file this chunk starts. Ask '
                        + 'GET /film/uploads/:id if you do not know.',
                });
                return true;
            }
            send(res, 200, uploads.appendChunk(id, offset, bytes));
            return true;
        }
        if (id && tail === 'complete' && req.method === 'POST') {
            const done = uploads.completeUpload(id);
            /*
             * Straight into the same import path a direct upload takes. The
             * target may be named now or when the transfer opened; naming it up
             * front is better, because an unknown one is then refused before
             * twenty minutes of transfer rather than after.
             */
            const target = (req.body && req.body.target) || done.target;
            if (!target) {
                send(res, 400, {
                    error: 'this upload names no import target, so the finished file has nowhere '
                        + 'to go. Name one when the upload is opened.',
                });
                return true;
            }
            const input = {
                ...(done.owner || {}),
                ...(req.body || {}),
                bytes: done.bytes,
                mime: done.mime,
                name: (req.body && req.body.name) || done.name,
            };
            send(res, 201, importMedia(target, input));
            return true;
        }
        if (id && !tail && req.method === 'DELETE') {
            send(res, 200, uploads.abandonUpload(id));
            return true;
        }
    } catch (err) {
        fail(res, err);
        return true;
    }

    send(res, 405, { error: `cannot ${req.method} ${parts.join('/')}` });
    return true;
}

module.exports = { handleUploads };
