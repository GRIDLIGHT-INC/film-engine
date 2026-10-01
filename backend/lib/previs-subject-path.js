/**
 * A staged subject that MOVES during the shot, and a camera that follows it.
 *
 * "The camera follows a girl running from the top floor down through five
 * levels of the house" is a one-take, and a one-take has a person in it who
 * goes somewhere. A staged subject had one position for the whole shot.
 *
 * A subject may now carry `path`: timed keys `{ t (ms within the shot),
 * position [x, y, z], rotationDeg? [0, yaw, 0] }`. Between two keys the
 * position is linear; the FACING is the direction of travel unless both keys
 * say which way the subject faces, because a running person faces where they
 * run. Before the first key and after the last the subject holds.
 *
 * ONE sampler. `subjectPoseAt` is mirrored in the page (src/index.html) so the
 * Plan and Look views can draw the subject at the playhead without a request,
 * and `tests/previs-subject-path.test.js` runs both over the same cases: two
 * samplers that disagree draw the girl somewhere the render does not put her.
 *
 * The convention is the stage's own: yaw 0 faces north (-Z) and turning left
 * is positive, so a direction of travel (dx, dz) is atan2(-dx, -dz).
 */
const MAX_PATH_KEYS = 200;
const DEG = 180 / Math.PI;

function finite3(v) { return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n)); }

/**
 * Refuse a path the sampler would misread, naming the key. `durationMs` bounds
 * the keys when known: a key after the shot ends is a moment nobody sees.
 */
function validateSubjectPath(path, at, durationMs) {
    const errors = [];
    if (path === undefined || path === null) return errors;
    if (!Array.isArray(path)) return [`${at}.path must be an array of keys`];
    if (path.length > MAX_PATH_KEYS) errors.push(`${at}.path has ${path.length} keys; at most ${MAX_PATH_KEYS}`);
    let last = -Infinity;
    path.forEach((k, i) => {
        if (!k || typeof k.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) {
            errors.push(`${at}.path[${i}].t must be a non-negative number of milliseconds`);
            return;
        }
        if (Number.isFinite(durationMs) && durationMs > 0 && k.t > durationMs) {
            errors.push(`${at}.path[${i}].t ${k.t} ms is after the shot ends (${durationMs} ms)`);
        }
        if (k.t <= last) errors.push(`${at}.path[${i}].t must come after the key before it (keys in time order, no two at one moment)`);
        last = k.t;
        if (!finite3(k.position)) errors.push(`${at}.path[${i}].position must be three finite numbers`);
        if (k.rotationDeg !== undefined && !finite3(k.rotationDeg)) errors.push(`${at}.path[${i}].rotationDeg must be three finite numbers`);
    });
    return errors;
}

/**
 * Where a staged subject is, and which way it faces, at `tMs` into the shot.
 * MIRRORED in src/index.html — change both, or the parity test fails.
 */
function subjectPoseAt(su, tMs) {
    const base = su && Array.isArray(su.position) ? su.position.map(Number) : [0, 0, 0];
    const baseYaw = Number(((su && su.rotationDeg) || [])[1]) || 0;
    const keys = (su && Array.isArray(su.path) ? su.path : [])
        .filter(k => k && Number.isFinite(Number(k.t)) && Array.isArray(k.position) && k.position.length === 3)
        .slice().sort((a, b) => a.t - b.t);
    if (!keys.length) return { position: base, yawDeg: baseYaw, moving: false };
    const yawOf = k => (Array.isArray(k.rotationDeg) ? Number(k.rotationDeg[1]) || 0 : null);
    if (keys.length === 1) {
        const y = yawOf(keys[0]);
        return { position: keys[0].position.map(Number), yawDeg: y == null ? baseYaw : y, moving: false };
    }
    const T = Number(tMs) || 0;
    const travel = (a, b) => {
        const dx = b.position[0] - a.position[0], dz = b.position[2] - a.position[2];
        return Math.hypot(dx, dz) > 0.01 ? Math.atan2(-dx, -dz) * DEG : null;
    };
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t < T) i++;
    const a = keys[i], b = keys[i + 1];
    const f = b.t > a.t ? Math.max(0, Math.min(1, (T - a.t) / (b.t - a.t))) : 0;
    const position = a.position.map((v, x) => Number(v) + (Number(b.position[x]) - Number(v)) * f);
    const ya = yawOf(a), yb = yawOf(b);
    let yawDeg;
    if (ya != null && yb != null) {
        yawDeg = ya + ((((yb - ya) % 360) + 540) % 360 - 180) * f;
    } else {
        yawDeg = travel(a, b);
        // A pause on the spot keeps the facing it arrived with, then the one it leaves with.
        for (let j = i - 1; yawDeg == null && j >= 0; j--) yawDeg = travel(keys[j], keys[j + 1]);
        for (let j = i + 1; yawDeg == null && j < keys.length - 1; j++) yawDeg = travel(keys[j], keys[j + 1]);
        if (yawDeg == null) yawDeg = ya != null ? ya : (yb != null ? yb : baseYaw);
    }
    const moving = T > a.t && T < b.t && travel(a, b) != null;
    // In (-180, 180], and never -0: a facing is a number people read.
    yawDeg = ((((yawDeg + 180) % 360) + 360) % 360) - 180;
    if (yawDeg === -180) yawDeg = 180;
    return { position, yawDeg: yawDeg + 0, moving };
}

/** True when a subject moves at all during the shot. */
function hasPath(su) { return !!(su && Array.isArray(su.path) && su.path.length >= 2); }

/** How far, how fast, from where to where: the facts the prompt line is built from. */
function pathSummary(su) {
    if (!hasPath(su)) return null;
    const keys = su.path.slice().sort((a, b) => a.t - b.t);
    let dist = 0;
    for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1].position, b = keys[i].position;
        dist += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    const secs = Math.max(1e-3, (keys[keys.length - 1].t - keys[0].t) / 1000);
    return { from: keys[0].position.slice(), to: keys[keys.length - 1].position.slice(),
             distanceM: dist, speedMs: dist / secs, startMs: keys[0].t, endMs: keys[keys.length - 1].t };
}

/**
 * Camera keys for a Steadicam FOLLOW: the camera walks the subject's own path
 * `distanceM` behind them (so it goes through the same doors and down the
 * same stairs), `heightM` above the path, aimed at the subject's chest.
 * Ordinary camera keys (t 0..1, degrees): nothing downstream changes.
 */
function followCameraKeys(su, opts) {
    const o = opts || {};
    if (!hasPath(su)) {
        const e = new Error('that subject has no path to follow: record at least two keys first');
        e.code = 'NO_PATH';
        throw e;
    }
    const duration = Math.max(1, Number(o.durationMs) || 4000);
    const distance = Number.isFinite(Number(o.distanceM)) && Number(o.distanceM) >= 0 ? Number(o.distanceM) : 2.5;
    const height = Number.isFinite(Number(o.heightM)) ? Number(o.heightM) : 1.6;
    const focal = Number(o.focalMm) > 0 ? Number(o.focalMm) : 24;
    const subjH = (Array.isArray(su.sizeM) && Number(su.sizeM[1]) > 0) ? Number(su.sizeM[1]) : 1.6;
    const aimUp = subjH * 0.7;

    // The subject's route as arc length over time, finely sampled.
    const N = 400;
    const pts = [], arc = [0];
    for (let i = 0; i <= N; i++) pts.push(subjectPoseAt(su, duration * i / N).position);
    for (let i = 1; i <= N; i++) {
        const a = pts[i - 1], b = pts[i];
        arc.push(arc[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    // Which way the route starts, to stand behind the subject before they set off.
    let dir0 = null;
    for (let i = 1; i <= N && !dir0; i++) {
        const dx = pts[i][0] - pts[0][0], dz = pts[i][2] - pts[0][2], d = Math.hypot(dx, dz);
        if (d > 0.05) dir0 = [dx / d, dz / d];
    }
    if (!dir0) {
        const y = (Number(((su.rotationDeg) || [])[1]) || 0) / DEG;
        dir0 = [-Math.sin(y), -Math.cos(y)];
    }
    const atArc = s => {
        if (s <= 0) return [pts[0][0] - dir0[0] * -s, pts[0][1], pts[0][2] - dir0[1] * -s];
        let j = 1;
        while (j < N && arc[j] < s) j++;
        const span = arc[j] - arc[j - 1];
        const f = span > 0 ? Math.min(1, (s - arc[j - 1]) / span) : 0;
        return pts[j - 1].map((v, x) => v + (pts[j][x] - v) * f);
    };
    const count = Math.max(2, Math.min(MAX_PATH_KEYS, Math.round(Number(o.keys) || (duration / 250 + 1))));
    const keys = [];
    for (let k = 0; k < count; k++) {
        const t = k / (count - 1);
        const idx = Math.round(t * N);
        const subj = pts[idx];
        const p = atArc(arc[idx] - distance);
        const eye = [p[0], p[1] + height, p[2]];
        const aim = [subj[0], subj[1] + aimUp, subj[2]];
        const dx = aim[0] - eye[0], dy = aim[1] - eye[1], dz = aim[2] - eye[2];
        const horiz = Math.hypot(dx, dz);
        const yaw = horiz > 1e-3 ? Math.atan2(-dx, -dz) * DEG : subjectPoseAt(su, duration * t).yawDeg;
        const pitch = Math.atan2(dy, Math.max(horiz, 1e-3)) * DEG;
        const r = n => Math.round(n * 1000) / 1000;
        keys.push({ t: r(t), position: eye.map(r), rotation: [r(yaw), r(pitch), 0], focalMm: focal, rotationUnit: 'degrees' });
    }
    return keys;
}

/**
 * The camera pose at `t` (0..1) along a sampled path. MIRRORS the page's
 * worldPoseAtT, which is what the playhead shows, so a rendered previz frame
 * is the frame the director scrubbed to.
 */
function cameraPoseAt(path, t) {
    const pts = (Array.isArray(path) ? path : []).filter(k => k && Array.isArray(k.position));
    if (pts.length < 2) return null;
    const T = Math.max(0, Math.min(1, t));
    let i = 0;
    const tOf = (k, n) => (k.t == null ? n / (pts.length - 1) : k.t);
    while (i < pts.length - 2 && tOf(pts[i + 1], i + 1) < T) i++;
    const a = pts[i], c = pts[i + 1];
    const ta = tOf(a, i), tc = tOf(c, i + 1);
    const f = tc > ta ? (T - ta) / (tc - ta) : 0;
    const lerp = (x, y) => x + (y - x) * f;
    const ang = (x, y) => x + ((((y - x) % 360) + 540) % 360 - 180) * f;
    const ra = a.rotation || [0, 0, 0], rc = c.rotation || ra;
    return {
        position: a.position.map((v, k) => lerp(v, c.position[k])),
        rotation: ra.map((v, k) => ang(v, rc[k])),
        focalMm: lerp(a.focalMm || 35, c.focalMm || a.focalMm || 35),
    };
}

/** Where a camera at this pose looks, 5 units out: the page's previsAim. */
function aimPoint(pose) {
    const yaw = ((pose.rotation || [])[0] || 0) / DEG;
    const pitch = ((pose.rotation || [])[1] || 0) / DEG;
    const dir = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    return pose.position.map((v, k) => v + dir[k] * 5);
}

module.exports = {
    MAX_PATH_KEYS, validateSubjectPath, subjectPoseAt, hasPath, pathSummary,
    followCameraKeys, cameraPoseAt, aimPoint,
};
