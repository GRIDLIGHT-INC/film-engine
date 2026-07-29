const { test, describe } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { extractDocxText, xmlToText, decodeEntities, findEntryOffset } = require('../lib/docx-text');

/**
 * Build a real .docx in memory: a ZIP containing word/document.xml.
 *
 * Constructing the archive rather than committing a binary fixture keeps the
 * test readable and lets each case vary the document body — and it exercises
 * the actual ZIP parser rather than a stub.
 */
function buildDocx(documentXml, { compress = true, extraFiles = [] } = {}) {
    const files = [
        { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
        ...extraFiles,
    ];

    const locals = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, 'utf8');
        const raw = file.data;
        const stored = compress ? zlib.deflateRawSync(raw) : raw;
        const method = compress ? 8 : 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(0, 14);                 // crc — unchecked by the reader
        local.writeUInt32LE(stored.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(Buffer.concat([local, nameBuf, stored]));

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(method, 10);
        cen.writeUInt32LE(stored.length, 20);
        cen.writeUInt32LE(raw.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        central.push(Buffer.concat([cen, nameBuf]));

        offset += 30 + nameBuf.length + stored.length;
    }

    const localBlock = Buffer.concat(locals);
    const centralBlock = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBlock.length, 12);
    eocd.writeUInt32LE(localBlock.length, 16);

    return Buffer.concat([localBlock, centralBlock, eocd]);
}

const doc = body =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;

const para = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('docx-text', () => {
    describe('extractDocxText', () => {
        test('extracts prose from a real deflate-compressed docx', () => {
            const buf = buildDocx(doc(para('The fog came in low.') + para('Nobody moved.')));
            const result = extractDocxText(buf);
            assert.equal(result.ok, true);
            assert.equal(result.text, 'The fog came in low.\nNobody moved.');
        });

        test('handles stored (uncompressed) entries', () => {
            const buf = buildDocx(doc(para('Uncompressed.')), { compress: false });
            const result = extractDocxText(buf);
            assert.equal(result.ok, true);
            assert.equal(result.text, 'Uncompressed.');
        });

        test('finds the document even when other entries come first', () => {
            const buf = buildDocx(doc(para('Body text.')), {
                extraFiles: [{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }],
            });
            assert.equal(extractDocxText(buf).text, 'Body text.');
        });

        test('includes standard supplemental text parts', () => {
            const buf = buildDocx(doc(para('Body text.')), {
                extraFiles: [
                    { name: 'word/footnotes.xml', data: Buffer.from(doc(para('Footnote text.')), 'utf8') },
                    { name: 'word/endnotes.xml', data: Buffer.from(doc(para('Endnote text.')), 'utf8') },
                    { name: 'word/header1.xml', data: Buffer.from(doc(para('Header text.')), 'utf8') },
                    { name: 'word/footer1.xml', data: Buffer.from(doc(para('Footer text.')), 'utf8') },
                ],
            });
            const result = extractDocxText(buf);
            assert.equal(result.ok, true);
            assert.match(result.text, /Body text/);
            assert.match(result.text, /Footnote text/);
            assert.match(result.text, /Endnote text/);
            assert.match(result.text, /Header text/);
            assert.match(result.text, /Footer text/);
            assert.ok(result.files_read.includes('word/document.xml'));
            assert.ok(result.files_read.includes('word/footnotes.xml'));
        });

        test('reports counts alongside the text', () => {
            const buf = buildDocx(doc(para('One.') + '<w:p/>' + para('Two.')));
            const result = extractDocxText(buf);
            assert.equal(result.characters, result.text.length);
            assert.ok(result.paragraphs >= 1);
        });

        test('rejects a .doc or renamed file with a useful message', () => {
            const result = extractDocxText(Buffer.from('\\xd0\\xcf\\x11\\xe0 old word file'));
            assert.equal(result.ok, false);
            assert.match(result.error, /not a \.docx/i);
        });

        test('rejects empty and non-buffer input', () => {
            assert.equal(extractDocxText(Buffer.alloc(0)).ok, false);
            assert.equal(extractDocxText(null).ok, false);
            assert.equal(extractDocxText('a string').ok, false);
        });

        test('reports a docx with no document body', () => {
            // A valid zip whose only entry is something else.
            const buf = buildDocx('<w:document/>');
            const renamed = Buffer.from(buf);
            // Rename every occurrence — the central directory is what the
            // reader consults, and the local header must agree with it.
            let idx = renamed.indexOf('word/document.xml');
            while (idx !== -1) {
                renamed.write('word/notabody0.xml', idx);
                idx = renamed.indexOf('word/document.xml', idx + 1);
            }
            const result = extractDocxText(renamed);
            assert.equal(result.ok, false);
            assert.match(result.error, /document body|missing/i);
        });

        test('reports a document containing no readable text', () => {
            const buf = buildDocx(doc('<w:p><w:r><w:drawing/></w:r></w:p>'));
            const result = extractDocxText(buf);
            assert.equal(result.ok, false);
            assert.match(result.error, /no readable text/i);
        });
    });

    describe('xmlToText', () => {
        test('paragraph boundaries become newlines', () => {
            assert.equal(xmlToText(doc(para('A') + para('B'))), 'A\nB');
        });

        test('line breaks and tabs are preserved', () => {
            assert.equal(
                xmlToText(doc('<w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t><w:tab/><w:t>C</w:t></w:r></w:p>')),
                'A\nB\tC'
            );
        });

        test('joins runs within a paragraph without inserting spaces', () => {
            // Word splits a sentence across runs at formatting boundaries;
            // rejoining with a space would corrupt every italicised word.
            assert.equal(
                xmlToText(doc('<w:p><w:r><w:t>Half</w:t></w:r><w:r><w:t>way</w:t></w:r></w:p>')),
                'Halfway'
            );
        });

        test('drops tracked-change deletions so removed text does not reappear', () => {
            const xml = doc(
                '<w:p><w:r><w:t>Keep this </w:t></w:r>' +
                '<w:del><w:r><w:delText>and not this</w:delText></w:r></w:del>' +
                '<w:r><w:t>and this.</w:t></w:r></w:p>'
            );
            const text = xmlToText(xml);
            assert.equal(text, 'Keep this and this.');
            assert.ok(!text.includes('not this'));
        });

        test('collapses runs of blank paragraphs to a single blank line', () => {
            const xml = doc(para('A') + '<w:p/>' + '<w:p/>' + '<w:p/>' + para('B'));
            assert.equal(xmlToText(xml), 'A\n\nB');
        });

        test('separates table cells and rows', () => {
            const xml = doc('<w:tbl><w:tr><w:tc>' + para('L') + '</w:tc><w:tc>' + para('R') + '</w:tc></w:tr></w:tbl>');
            const text = xmlToText(xml);
            assert.ok(text.includes('L'));
            assert.ok(text.includes('R'));
        });

        test('strips markup that is not a text run', () => {
            const xml = doc('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Only me</w:t></w:r></w:p>');
            assert.equal(xmlToText(xml), 'Only me');
        });
    });

    describe('decodeEntities', () => {
        test('decodes the predefined entities', () => {
            assert.equal(decodeEntities('&lt;b&gt; &amp; &quot;x&quot; &apos;y&apos;'), '<b> & "x" \'y\'');
        });

        test('decodes numeric and hex references', () => {
            assert.equal(decodeEntities('&#8212;'), '—');
            assert.equal(decodeEntities('&#x2019;'), '’');
        });

        test('unescapes &amp; last so &amp;lt; does not become a tag', () => {
            assert.equal(decodeEntities('&amp;lt;'), '&lt;');
        });

        test('ignores out-of-range code points instead of throwing', () => {
            assert.equal(decodeEntities('&#1114112;'), '');
        });
    });

    describe('findEntryOffset', () => {
        test('returns -1 when the archive has no end-of-central-directory', () => {
            assert.equal(findEntryOffset(Buffer.from('not a zip at all'), 'word/document.xml'), -1);
        });

        test('returns -1 for a name that is not present', () => {
            const buf = buildDocx(doc(para('x')));
            assert.equal(findEntryOffset(buf, 'word/footnotes.xml'), -1);
        });
    });
});
