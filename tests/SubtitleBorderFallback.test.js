import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * ============================================================================
 * Subtitle Border Fallback Test Suite
 * ============================================================================
 * Chromium 35–122 (crbug.com/41372165) and WebKit/Safari < 17.4 parse
 * paint-order for SVG but ignore it for stroked HTML text, so
 * -webkit-text-stroke thins the glyphs on webOS, older Tizen TVs, and older
 * WebKit builds. Verify that those engines get the text-shadow ring fallback,
 * while keeping the stroke path for engines with real support.
 * ============================================================================
 */

// Polyfill minimal browser globals so Logger, PlatformInfo, and PlayerSettings initialize cleanly
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

// Default to an LG webOS TV running Chromium 120 where CSS.supports reports
// both features as available (the false positive that broke the old code).
const WEBOS_CHROME_120_UA =
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: WEBOS_CHROME_120_UA },
    configurable: true,
    writable: true
});
globalThis.CSS = { supports: () => true };

const { platformInfo } = await import('../src/utils/PlatformInfo.js');
const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { getTextStyles } = await import('../src/utils/SubtitleStyles.js');

function getStyleMap() {
    return Object.fromEntries(
        getTextStyles()
            .filter((style) => style.name)
            .map((style) => [style.name, style.value])
    );
}

function countShadows(value) {
    return (value.match(/rgba\(/g) || []).length;
}

/**
 * Temporarily overrides navigator.userAgent and CSS.supports, refreshes
 * platformInfo, runs the test callback, and restores defaults cleanly.
 */
function withEnv({ userAgent = WEBOS_CHROME_120_UA, cssSupports = () => true }, fn) {
    const prevUa = navigator.userAgent;
    const prevCss = globalThis.CSS;

    try {
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent },
            configurable: true,
            writable: true
        });
        globalThis.CSS = cssSupports ? { supports: cssSupports } : undefined;
        platformInfo.init();
        fn();
    } finally {
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: prevUa },
            configurable: true,
            writable: true
        });
        globalThis.CSS = prevCss;
        platformInfo.init();
    }
}

test.beforeEach(() => {
    PlayerSettings.resetAll();
    storageMap.clear();
});

test('border uses a text-shadow ring instead of a thinning stroke on Chromium < 123', () => {
    withEnv({ userAgent: WEBOS_CHROME_120_UA }, () => {
        PlayerSettings.set('subtitleDropShadow', 'border');
        PlayerSettings.set('subtitleBorderWidth', 3);

        const styles = getStyleMap();

        assert.equal(styles.webkitTextStroke, '');
        assert.equal(styles.paintOrder, '');
        assert.match(styles.textShadow, /1\.5px 0px 0/, 'ring radius should be half the configured border width');
        assert.equal(countShadows(styles.textShadow), 8);
    });
});

test('uniform_border combines the fallback ring before the uniform drop shadow on Chromium < 123', () => {
    withEnv({ userAgent: WEBOS_CHROME_120_UA }, () => {
        PlayerSettings.set('subtitleDropShadow', 'uniform_border');
        PlayerSettings.set('subtitleBorderWidth', 3);
        PlayerSettings.set('subtitleDropShadowBlur', 6);

        const styles = getStyleMap();

        assert.equal(styles.webkitTextStroke, '');
        assert.equal(styles.paintOrder, '');
        assert.equal(countShadows(styles.textShadow), 16, '8 outline shadows plus 8 drop shadows');

        // Outline ring must precede the blurred drop shadows so it paints on top
        const firstOutlineIdx = styles.textShadow.indexOf('1.5px 0px 0');
        const firstBlurIdx = styles.textShadow.indexOf('0px 1px 6px');
        assert.ok(firstOutlineIdx !== -1 && firstBlurIdx !== -1 && firstOutlineIdx < firstBlurIdx);
    });
});

test('fallback outline scales sample count for wider borders and handles non-positive width', () => {
    withEnv({ userAgent: WEBOS_CHROME_120_UA }, () => {
        PlayerSettings.set('subtitleDropShadow', 'border');

        // Medium-high width scales up to 24 samples to avoid angular notches
        PlayerSettings.set('subtitleBorderWidth', 10);
        assert.equal(countShadows(getStyleMap().textShadow), 24);

        // Maximum slider width caps at 32 samples
        PlayerSettings.set('subtitleBorderWidth', 20);
        assert.equal(countShadows(getStyleMap().textShadow), 32);

        // Non-positive width degrades gracefully
        PlayerSettings.set('subtitleBorderWidth', 0);
        assert.equal(getStyleMap().textShadow, 'none');

        PlayerSettings.set('subtitleDropShadow', 'uniform_border');
        assert.equal(
            countShadows(getStyleMap().textShadow),
            8,
            'uniform_border keeps only uniformShadow when borderWidth <= 0'
        );
    });
});

test('border and uniform_border keep webkitTextStroke + paintOrder on Chromium >= 123', () => {
    const chrome123Ua =
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

    withEnv({ userAgent: chrome123Ua }, () => {
        PlayerSettings.set('subtitleDropShadow', 'border');
        PlayerSettings.set('subtitleBorderWidth', 4);

        const borderStyles = getStyleMap();
        assert.match(borderStyles.webkitTextStroke, /^4px rgba\(/);
        assert.equal(borderStyles.paintOrder, 'stroke fill');
        assert.equal(borderStyles.textShadow, 'none');

        PlayerSettings.set('subtitleDropShadow', 'uniform_border');
        const uniformBorderStyles = getStyleMap();
        assert.match(uniformBorderStyles.webkitTextStroke, /^4px rgba\(/);
        assert.equal(uniformBorderStyles.paintOrder, 'stroke fill');
        assert.equal(countShadows(uniformBorderStyles.textShadow), 8);
    });
});

test('non-Chromium browsers respect CSS.supports for stroke vs shadow fallback', () => {
    const firefoxUa = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';

    withEnv({ userAgent: firefoxUa, cssSupports: () => true }, () => {
        PlayerSettings.set('subtitleDropShadow', 'border');
        const styles = getStyleMap();
        assert.equal(styles.paintOrder, 'stroke fill');
        assert.match(styles.webkitTextStroke, /^3px rgba\(/);
    });

    withEnv(
        {
            userAgent: firefoxUa,
            cssSupports: (prop) => prop !== 'paint-order'
        },
        () => {
            PlayerSettings.set('subtitleDropShadow', 'border');
            const styles = getStyleMap();
            assert.equal(styles.webkitTextStroke, '');
            assert.equal(styles.paintOrder, '');
            assert.equal(countShadows(styles.textShadow), 8);
        }
    );
});

test('WebKit/Safari < 17.4 falls back to shadow ring while Safari >= 17.4 uses stroke', () => {
    const safari173Ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15';
    const iosCriOs172Ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
    const safari174Ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

    for (const ua of [safari173Ua, iosCriOs172Ua]) {
        withEnv({ userAgent: ua, cssSupports: () => true }, () => {
            PlayerSettings.set('subtitleDropShadow', 'border');
            const styles = getStyleMap();
            assert.equal(styles.webkitTextStroke, '');
            assert.equal(styles.paintOrder, '');
            assert.equal(countShadows(styles.textShadow), 8);
        });
    }

    withEnv({ userAgent: safari174Ua, cssSupports: () => true }, () => {
        PlayerSettings.set('subtitleDropShadow', 'border');
        const styles = getStyleMap();
        assert.equal(styles.paintOrder, 'stroke fill');
        assert.match(styles.webkitTextStroke, /^3px rgba\(/);
    });
});

test('uniform still uses only the existing drop shadow', () => {
    withEnv({ userAgent: WEBOS_CHROME_120_UA }, () => {
        PlayerSettings.set('subtitleDropShadow', 'uniform');

        const styles = getStyleMap();

        assert.equal(countShadows(styles.textShadow), 8);
    });
});
