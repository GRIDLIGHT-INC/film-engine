/**
 * Settings that belong to the person, not the project.
 *
 * The screenplay's author was a free-text field on every title page: retyped
 * per project, per draft, and blank whenever anyone forgot — which on a title
 * page is the field a reader looks at first. It is not a fact about a
 * screenplay. It is a fact about whoever is writing them here.
 *
 * Set-based over the known settings, because the failure mode of a key/value
 * store is that it accepts anything: a caller who misspells a key gets a 200
 * and believes it was saved, and nothing ever reads the row again.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-appsettings-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleAppSettings, SETTINGS } = require('../routes/app-settings');
const fs = require('fs');
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

function call(method, body) {
    return new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handleAppSettings({ method, body: body || {} }, res))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

test('every known setting reads back as it was written', async () => {
    for (const key of Object.keys(SETTINGS)) {
        const value = `value-for-${key}`;
        const put = await call('PUT', { [key]: value });
        assert.strictEqual(put.status, 200, JSON.stringify(put.body));
        const got = await call('GET');
        assert.strictEqual(got.body.settings[key], value, `${key} did not survive the round trip`);
    }
});

test('an unset setting reads as its default, not as missing', async () => {
    // A caller that has to distinguish undefined from "" writes that check
    // once per caller and gets it wrong somewhere.
    const got = await call('GET');
    for (const key of Object.keys(SETTINGS)) {
        assert.ok(typeof got.body.settings[key] === 'string', `${key} is not always a string`);
    }
});

test('a misspelled key is reported, not silently accepted', async () => {
    const res = await call('PUT', { authr: 'Manny Henri' });
    assert.strictEqual(res.status, 400, 'a PUT of only unknown keys returned success');
    assert.ok(res.body.unknown.includes('authr'), 'the unknown key is not named back');
});

test('a PUT merges rather than clearing what it does not mention', async () => {
    await call('PUT', { author: 'Manny Henri' });
    const res = await call('PUT', { author: 'Manny Henri' });
    assert.strictEqual(res.body.settings.author, 'Manny Henri');
    // With one setting this is trivially true; it is asserted because the
    // second setting is where a rebuild-from-body implementation starts
    // wiping fields nobody touched.
    assert.deepStrictEqual(res.body.changed, ['author']);
});

test('the title page is printed, not edited in the middle of the script', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/\.title-page-block \{ display: none !important; \}/.test(html),
        'the title page is still a slab at the top of the editor');
    const print = html.slice(html.indexOf('@media print'));
    assert.ok(/\.title-page-block \{\s*display: block !important;/.test(print),
        'hiding it on screen also hid it from the printer, which is the one place it belongs');
    // It is hidden, not removed: the block carries the data the Fountain
    // serialiser writes back, so deleting it would lose the title page itself.
    assert.ok(/data-title-page-data/.test(html), 'the title page data is no longer in the document');
    assert.ok(/onclick="openTitlePageModal\(\)"/.test(html), 'no way left to edit it');
});

test('the author fills a blank credit and never overwrites one', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.ok(/currentTitlePage\.author \|\| await appAuthor\(\)/.test(html),
        'the app author does not fill a blank title page');
    assert.ok(!/await appAuthor\(\) \|\| currentTitlePage\.author/.test(html),
        'the setting outranks the screenplay, so it can reassign authorship');
});
