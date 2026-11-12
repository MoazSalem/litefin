import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Subtitle Border Fallback Test Suite
 * ============================================================================
 * Chromium 35–122 parse paint-order but ignore it for stroked HTML text
 * (crbug.com/41372165), so -webkit-text-stroke thins the glyphs on webOS and
 * old Tizen TVs. Verify that those engines get the text-shadow ring fallback,
 * while keeping the stroke path for engines with real support.
 * ============================================================================
 */

// Polyfill minimal browser globals so Logger and PlayerSettings initialize cleanly
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) ?? null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (index) => [...storageMap.keys()][index] ?? null,
    get length() {
        return storageMap.size;
    }
};
globalThis.window = globalThis;
globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };

// Simulate an LG webOS TV running Chromium 120. CSS.supports reports both
// features as available, which is exactly the false positive that broke the
// old implementation.
Object.defineProperty(globalThis, 'navigator', {
    value: {
        userAgent:
            'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    configurable: true
});
globalThis.CSS = { supports: () => true };

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { getTextStyles } = await import('../src/utils/SubtitleStyles.js');

function getStyleMap() {
    return Object.fromEntries(getTextStyles().filter((style) => style.name).map((style) => [style.name, style.value]));
}

function countShadows(value) {
    return (value.match(/rgba\(/g) || []).length;
}

test('border uses a text-shadow ring instead of a thinning stroke on Chromium < 123', () => {
    PlayerSettings.set('subtitleDropShadow', 'border');
    PlayerSettings.set('subtitleBorderWidth', 3);

    const styles = getStyleMap();

    assert.equal(styles.webkitTextStroke, '');
    assert.equal(styles.paintOrder, '');
    assert.match(styles.textShadow, /1\.5px 0px 0/, 'ring radius should be half the configured border width');
    assert.equal(countShadows(styles.textShadow), 8);
});

test('uniform_border combines the fallback ring with the uniform drop shadow', () => {
    PlayerSettings.set('subtitleDropShadow', 'uniform_border');
    PlayerSettings.set('subtitleBorderWidth', 3);

    const styles = getStyleMap();

    assert.equal(styles.webkitTextStroke, '');
    assert.equal(styles.paintOrder, '');
    assert.equal(countShadows(styles.textShadow), 16, '8 outline shadows plus 8 drop shadows');
});

test('uniform still uses only the existing drop shadow', () => {
    PlayerSettings.set('subtitleDropShadow', 'uniform');

    const styles = getStyleMap();

    assert.equal(countShadows(styles.textShadow), 8);
});
