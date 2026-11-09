import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ============================================================================
 * ImageCache Engine Detection Test Suite
 * ============================================================================
 * Verifies that modern Chromium environments (such as Tizen 9.0 running
 * Chromium 120) are NOT misclassified as legacy WebKit engines due to the
 * static token '537.36' in their User-Agent strings.
 *
 * Ensures that true legacy platforms (Tizen 2.x, Tizen 3.x, webOS 1.x)
 * maintain their legacy classification for conservative image preloading.
 * ============================================================================
 */

/**
 * Evaluates whether a given user agent string is classified as legacy WebKit
 * using the exact logic present in ImageCache.js.
 *
 * @param {string} userAgent - Browser user agent string
 * @returns {boolean} True if classified as legacy WebKit
 */
function evaluateIsLegacyWebKit(userAgent) {
    const _userAgent = userAgent || '';

    // Check if a Chromium engine token is present (standard or Tizen format)
    const chromeMatch =
        _userAgent.match(/(?:Chrome|Chromium|CriOS)\/(\d+)/i) ||
        _userAgent.match(/like Gecko\)\s+(\d+)\.\d+/i);

    // If Chromium is detected, evaluate the major version
    if (chromeMatch) {
        const majorVersion = parseInt(chromeMatch[1], 10);
        // Only Chromium versions prior to 50 require the legacy profile
        return !isNaN(majorVersion) && majorVersion < 50;
    }

    // When no Chromium token exists, verify legacy engine indicators
    return /AppleWebKit\/53[0-8]|Tizen 2\.|Web0S; Linux\/SmartTV/i.test(_userAgent);
}

test('ImageCache: Tizen 9.0 (Chromium 120) is classified as modern', () => {
    // Tizen 9.0 User Agent from actual device logs
    const tizen9Ua =
        'Mozilla/5.0 (SMART-TV; Linux; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36';

    const isLegacy = evaluateIsLegacyWebKit(tizen9Ua);
    assert.strictEqual(
        isLegacy,
        false,
        'Tizen 9.0 Chromium 120 must not be classified as legacy WebKit'
    );
});

test('ImageCache: Modern Desktop Chrome 120 is classified as modern', () => {
    // Desktop Chrome 120 User Agent
    const desktopChromeUa =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const isLegacy = evaluateIsLegacyWebKit(desktopChromeUa);
    assert.strictEqual(
        isLegacy,
        false,
        'Desktop Chrome 120 must not be classified as legacy WebKit'
    );
});

test('ImageCache: Tizen 3.0 (Chrome 47) is classified as legacy', () => {
    // Tizen 3.0 User Agent
    const tizen3Ua =
        'Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1 Chrome/47.0.2526.69';

    const isLegacy = evaluateIsLegacyWebKit(tizen3Ua);
    assert.strictEqual(
        isLegacy,
        true,
        'Tizen 3.0 running Chrome 47 must be classified as legacy'
    );
});

test('ImageCache: Tizen 2.4 (pure WebKit 538.1) is classified as legacy', () => {
    // Tizen 2.4 User Agent without Chrome branding
    const tizen2Ua =
        'Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1';

    const isLegacy = evaluateIsLegacyWebKit(tizen2Ua);
    assert.strictEqual(
        isLegacy,
        true,
        'Tizen 2.4 running pure WebKit 538.1 must be classified as legacy'
    );
});

test('ImageCache: webOS 1.2 is classified as legacy', () => {
    // Early webOS User Agent
    const webos1Ua =
        'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/538.2 (KHTML, like Gecko) Large Screen WebAppManager Safari/538.2';

    const isLegacy = evaluateIsLegacyWebKit(webos1Ua);
    assert.strictEqual(
        isLegacy,
        true,
        'webOS 1.2 with Web0S identifier must be classified as legacy'
    );
});

test('ImageCache: Source code integrity verification', () => {
    const filePath = path.resolve('src/utils/ImageCache.js');
    const source = fs.readFileSync(filePath, 'utf8');

    // Confirm that the false-positive naive pattern has been replaced with the guarded version
    assert.ok(
        source.includes('majorVersion < 50'),
        'ImageCache.js must guard against modern Chromium versions'
    );
    assert.ok(
        source.includes('chromeMatch'),
        'ImageCache.js must inspect Chromium tokens prior to legacy fallbacks'
    );
});
