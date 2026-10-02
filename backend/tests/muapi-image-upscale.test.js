const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), `film-engine-image-upscale-${crypto.randomUUID()}`);
process.env.MUAPI_API_KEY = 'test-muapi-key';
process.env.MUAPI_POLL_MS = '1';

const upscale = require('../lib/providers/muapi-topaz-upscale');

function png(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

function uri(bytes) {
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

test('Topaz Precision High Fidelity V3 uses the smallest scale that reaches the requested tier', () => {
    const twoK = upscale.buildUpscaleRequest({ width: 1200, height: 800, resolution: '2K', image_url: 'https://example.test/in.png' });
    assert.match(twoK.url, /\/topaz-upscale-image-precision$/);
    assert.deepEqual(twoK.body, {
        image_url: 'https://example.test/in.png',
        model: 'High Fidelity V3',
        upscale_factor: 2,
        output_format: 'png',
    });
    assert.equal(twoK.target_pixels, 2048);
    assert.equal(twoK.expected_long_edge, 2400);

    const fourK = upscale.buildUpscaleRequest({ width: 1200, height: 800, resolution: '4k', image_url: 'https://example.test/in.png' });
    assert.equal(fourK.body.upscale_factor, 4);
    assert.equal(fourK.expected_long_edge, 4800);
});

test('a small source automatically stays with Topaz and uses its compatible 8x endpoint', () => {
    const req = upscale.buildUpscaleRequest({ width: 600, height: 400, resolution: '4K', image_url: 'https://example.test/in.png' });
    assert.match(req.url, /\/topaz-image-upscale$/);
    assert.deepEqual(req.body, { image_url: 'https://example.test/in.png', factor: 8 });
    assert.equal(req.model, 'Topaz Image Upscale 8x fallback');
    assert.equal(req.expected_long_edge, 4800);
});

test('upscaleImage uploads, submits, polls, downloads, saves and returns the result', async () => {
    const source = png(1200, 800);
    const output = png(2400, 1600);
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
        const href = String(url);
        let body = null;
        if (init && typeof init.body === 'string') body = JSON.parse(init.body);
        sent.push({ href, method: (init && init.method) || 'GET', body });
        const json = value => ({ ok: true, status: 200, json: async () => value });
        if (href.endsWith('/upload_file')) return json({ url: 'https://cdn.muapi.ai/source.png' });
        if (href.endsWith('/topaz-upscale-image-precision')) return json({ request_id: 'up-1' });
        if (href.includes('/predictions/up-1/result')) return json({ status: 'completed', outputs: ['https://cdn.muapi.ai/upscaled.png'] });
        if (href === 'https://cdn.muapi.ai/upscaled.png') {
            return {
                ok: true,
                status: 200,
                headers: { get: key => key.toLowerCase() === 'content-type' ? 'image/png' : null },
                arrayBuffer: async () => output.buffer.slice(output.byteOffset, output.byteOffset + output.length),
            };
        }
        throw new Error(`unexpected fetch ${href}`);
    };

    try {
        const result = await upscale.upscaleImage({ image: uri(source), resolution: '2K' });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.provider, 'MuAPI');
        assert.equal(result.model, 'Topaz Precision — High Fidelity V3');
        assert.deepEqual(result.source, { width: 1200, height: 800 });
        assert.deepEqual(result.output, { width: 2400, height: 1600 });
        assert.equal(result.resolution, '2K');
        assert.equal(result.scale, 2);
        assert.ok(fs.existsSync(result.file_path));
        assert.deepEqual(fs.readFileSync(result.file_path), output);
        assert.match(result.images[0].data_uri, /^data:image\/png;base64,/);

        const job = sent.find(call => call.href.endsWith('/topaz-upscale-image-precision'));
        assert.deepEqual(job.body, {
            image_url: 'https://cdn.muapi.ai/source.png',
            model: 'High Fidelity V3',
            upscale_factor: 2,
            output_format: 'png',
        });
    } finally {
        global.fetch = realFetch;
    }
});

test('the MCP surface needs only the picture and 2K/4K target', () => {
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(item => item.name === 'image_upscale');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['image', 'resolution']);
    assert.deepEqual(tool.inputSchema.properties.resolution.enum, ['2K', '4K']);
    assert.match(tool.description, /SPENDS/i);
    assert.match(tool.description, /High Fidelity V3/);
});
