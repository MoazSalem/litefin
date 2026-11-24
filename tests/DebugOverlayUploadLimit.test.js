import assert from 'node:assert/strict';
import test from 'node:test';

// Polyfill minimal browser DOM globals required by DebugOverlay in Node.js test environment
if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        location: { origin: 'http://localhost' }
    };
}
if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = {
        userAgent: 'Litefin-Test-Runner/1.0'
    };
}
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
    };
}
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        createElement: () => ({
            style: {},
            classList: { add: () => {}, remove: () => {}, toggle: () => {} },
            appendChild: () => {},
            addEventListener: () => {}
        }),
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: {
            getAttribute: () => 'classic',
            setAttribute: () => {},
            style: {}
        },
        head: { appendChild: () => {} }
    };
}
if (typeof globalThis.__APP_VERSION__ === 'undefined') {
    globalThis.__APP_VERSION__ = '2.10.0';
}

// Dynamically import DebugOverlay utilities
const { debugOverlay, getUtf8ByteLength } = await import('../src/ui/DebugOverlay.js');

test('DebugOverlay: getUtf8ByteLength calculates exact byte sizes for varied UTF encodings', () => {
    // Basic ASCII characters (1 byte per char)
    assert.equal(getUtf8ByteLength('hello world'), Buffer.byteLength('hello world', 'utf8'));

    // Latin extended and accented characters (2 bytes per char)
    assert.equal(getUtf8ByteLength('café crème résumé'), Buffer.byteLength('café crème résumé', 'utf8'));

    // East Asian CJK glyphs (3 bytes per char)
    assert.equal(getUtf8ByteLength('你好世界 - ログダンプテスト'), Buffer.byteLength('你好世界 - ログダンプテスト', 'utf8'));

    // Modern 4-byte surrogate pairs (emojis and supplemental planes)
    assert.equal(getUtf8ByteLength('🚀 🔥 🎉 ✨ 📺'), Buffer.byteLength('🚀 🔥 🎉 ✨ 📺', 'utf8'));

    // CRLF line terminators and whitespace
    assert.equal(getUtf8ByteLength('Line 1\r\nLine 2\r\n'), Buffer.byteLength('Line 1\r\nLine 2\r\n', 'utf8'));

    // Empty and null inputs
    assert.equal(getUtf8ByteLength(''), 0);
    assert.equal(getUtf8ByteLength(null), 0);
});

test('DebugOverlay: getLogDump strictly enforces 900,000 UTF-8 byte upload budget', () => {
    // Reset internal buffer
    debugOverlay._uploadBuffer = [];

    // Populate buffer with 3,000 lines, each roughly 400 bytes
    // Total size would exceed 1.2 MB without size bounding
    for (let i = 1; i <= 3000; i++) {
        const padding = 'x'.repeat(350);
        debugOverlay._uploadBuffer.push(`[12:00:00.000] [INFO] [TestModule] Line #${i} payload: ${padding}`);
    }

    // Generate output dump
    const dump = debugOverlay.getLogDump();
    const totalBytes = Buffer.byteLength(dump, 'utf8');

    // Verify dump never exceeds 900,000 bytes
    assert.ok(totalBytes <= 900000, `Expected dump bytes <= 900000, got ${totalBytes}`);

    // Verify header metadata is present
    assert.ok(dump.includes('Litefin Client Log'));
    assert.ok(dump.includes('User Agent: '));

    // Verify most recent lines are retained rather than oldest
    assert.ok(dump.includes('Line #3000'), 'Dump should contain latest entries');
    assert.ok(!dump.includes('Line #1 '), 'Dump should discard ancient entries');

    // Verify chronological order (Line #2000 precedes Line #3000)
    const firstMatch = dump.indexOf('Line #');
    const lastMatch = dump.lastIndexOf('Line #');
    assert.ok(firstMatch < lastMatch, 'Chronological ordering must be preserved');
});

test('DebugOverlay: getLogDump handles and skips individual oversized anomaly lines', () => {
    // Reset internal buffer
    debugOverlay._uploadBuffer = [];

    // Push standard entry
    debugOverlay._uploadBuffer.push('[12:00:00.000] [INFO] [System] Normal line before anomaly');

    // Push single massive anomaly line exceeding 900,000 bytes
    const giantPayload = 'G'.repeat(950000);
    debugOverlay._uploadBuffer.push(`[12:00:01.000] [DEBUG] [Demuxer] Giant: ${giantPayload}`);

    // Push standard recent entry
    debugOverlay._uploadBuffer.push('[12:00:02.000] [INFO] [System] Normal line after anomaly');

    // Generate output dump
    const dump = debugOverlay.getLogDump();
    const totalBytes = Buffer.byteLength(dump, 'utf8');

    // Size must remain within safe budget
    assert.ok(totalBytes <= 900000);

    // Normal lines should be present
    assert.ok(dump.includes('Normal line after anomaly'));
    assert.ok(dump.includes('Normal line before anomaly'));

    // Oversized entry must be skipped
    assert.ok(!dump.includes(giantPayload));
});
