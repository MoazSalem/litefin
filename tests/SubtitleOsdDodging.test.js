import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

// Polyfill minimal browser DOM globals so PlayerSettings initializes cleanly in Node
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({ canPlayType: () => '' })
};

const { PlayerSettings } = await import('../src/utils/PlayerSettings.js');
const { storage } = await import('../src/utils/StorageService.js');
const {
    getTextStyles,
    getSecondaryTextStyles,
    getWindowStyles,
    getSecondaryWindowStyles,
    isPrimarySubtitleInBottomHalf,
    isSecondarySubtitleInBottomHalf
} = await import('../src/utils/SubtitleStyles.js');

/**
 * ============================================================================
 * Subtitle OSD Dodging (Smart Shift) Test Suite
 * ============================================================================
 * Verifies that text subtitles dynamically dodge bottom OSD controls, that
 * dual-subtitle state applies compact scaling, that the user setting persists,
 * and that graphic/ASS subtitles do not dodge to protect their native layout.
 * ============================================================================
 */

test('PlayerSettings defaults subtitleOsdDodging to true', () => {
    storageMap.clear();
    assert.equal(PlayerSettings.get('subtitleOsdDodging'), true);
});

test('PlayerSettings can toggle subtitleOsdDodging on and off', () => {
    storageMap.clear();
    PlayerSettings.set('subtitleOsdDodging', false);
    assert.equal(PlayerSettings.get('subtitleOsdDodging'), false);

    PlayerSettings.set('subtitleOsdDodging', true);
    assert.equal(PlayerSettings.get('subtitleOsdDodging'), true);
});

test('Dual Subtitle State synchronizes has-dual-subtitles and osd-dodging-disabled classes', () => {
    // Mock minimal classList
    const createMockElement = () => {
        const classes = new Set();
        return {
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => {
                    if (force === undefined) {
                        if (classes.has(c)) classes.delete(c);
                        else classes.add(c);
                    } else if (force) {
                        classes.add(c);
                    } else {
                        classes.delete(c);
                    }
                },
                contains: (c) => classes.has(c)
            },
            classes
        };
    };

    const pageEl = createMockElement();
    const playerContainer = createMockElement();
    const primaryOverlay = {
        classList: { contains: (c) => false },
        innerHTML: 'Primary subtitle text'
    };
    const secondaryOverlay = {
        classList: { contains: (c) => false },
        innerHTML: 'Secondary subtitle text'
    };

    // Replicate _updateDualSubtitleState logic
    const updateState = (isDodgingEnabled, isDual) => {
        pageEl.classList.toggle('has-dual-subtitles', isDual);
        playerContainer.classList.toggle('has-dual-subtitles', isDual);

        pageEl.classList.toggle('osd-dodging-disabled', !isDodgingEnabled);
        playerContainer.classList.toggle('osd-dodging-disabled', !isDodgingEnabled);
    };

    // 1. Both subtitles present with dodging enabled
    updateState(true, true);
    assert.equal(pageEl.classList.contains('has-dual-subtitles'), true);
    assert.equal(playerContainer.classList.contains('has-dual-subtitles'), true);
    assert.equal(pageEl.classList.contains('osd-dodging-disabled'), false);
    assert.equal(playerContainer.classList.contains('osd-dodging-disabled'), false);

    // 2. Dodging disabled by user setting
    updateState(false, true);
    assert.equal(pageEl.classList.contains('has-dual-subtitles'), true);
    assert.equal(pageEl.classList.contains('osd-dodging-disabled'), true);
    assert.equal(playerContainer.classList.contains('osd-dodging-disabled'), true);

    // 3. Single subtitle with dodging enabled
    updateState(true, false);
    assert.equal(pageEl.classList.contains('has-dual-subtitles'), false);
    assert.equal(playerContainer.classList.contains('has-dual-subtitles'), false);
    assert.equal(pageEl.classList.contains('osd-dodging-disabled'), false);
});

test('CSS rules verify only text subtitles (.subtitle-overlay) dodge OSD, not ASS/PGS', () => {
    const cssPath = path.resolve('src/styles/player-page.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Verify .subtitle-overlay has the translateY dodging rule
    assert.match(
        cssContent,
        /\.player-page\.osd-active:not\(\.osd-dodging-disabled\)\s+\.subtitle-overlay:not\(\.secondary\)/,
        'Text subtitle overlay must dodge OSD when active'
    );

    // Verify ASS and PGS canvas/DOM containers do NOT have dodging transform rules
    assert.doesNotMatch(
        cssContent,
        /\.player-page\.osd-active[^{]*\.libass-wasm-wrapper/,
        'libass-wasm wrapper must not dodge OSD to preserve native authored layout'
    );
    assert.doesNotMatch(
        cssContent,
        /\.player-page\.osd-active[^{]*\.libjass-wrapper/,
        'libjass wrapper must not dodge OSD to preserve native authored layout'
    );
    assert.doesNotMatch(
        cssContent,
        /\.player-page\.osd-active[^{]*\.assjs-container/,
        'assjs container must not dodge OSD to preserve native authored layout'
    );
    assert.doesNotMatch(
        cssContent,
        /\.player-page\.osd-active[^{]*\.pgs-subtitle-wrapper/,
        'pgs wrapper must not dodge OSD to preserve native bitmap position'
    );
});

test('Dual Subtitle State strips osd-active when OSD is hidden or unmounted', () => {
    // Mock minimal classList
    const createMockElement = () => {
        const classes = new Set();
        return {
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, force) => {
                    if (force === undefined) {
                        if (classes.has(c)) classes.delete(c);
                        else classes.add(c);
                    } else if (force) {
                        classes.add(c);
                    } else {
                        classes.delete(c);
                    }
                },
                contains: (c) => classes.has(c)
            },
            classes
        };
    };

    const pageEl = createMockElement();
    const playerContainer = createMockElement();

    // Replicate _updateDualSubtitleState logic with OSD visibility checking
    const updateDualSubtitleState = (osdInstance, isDodgingEnabled, isDual) => {
        pageEl.classList.toggle('has-dual-subtitles', isDual);
        playerContainer.classList.toggle('has-dual-subtitles', isDual);

        pageEl.classList.toggle('osd-dodging-disabled', !isDodgingEnabled);
        playerContainer.classList.toggle('osd-dodging-disabled', !isDodgingEnabled);

        const isOsdVisible = !!(osdInstance && osdInstance.isOsdVisible);
        if (!isOsdVisible) {
            pageEl.classList.remove('osd-active');
            playerContainer.classList.remove('osd-active');
        }
    };

    // Simulate startup with leftover or spurious osd-active class
    pageEl.classList.add('osd-active');
    playerContainer.classList.add('osd-active');
    assert.equal(pageEl.classList.contains('osd-active'), true);
    assert.equal(playerContainer.classList.contains('osd-active'), true);

    // 1. Subtitles render while OSD is null (startup before OSD mount)
    updateDualSubtitleState(null, true, false);
    assert.equal(pageEl.classList.contains('osd-active'), false, 'osd-active must be removed when OSD is null');
    assert.equal(playerContainer.classList.contains('osd-active'), false, 'playerContainer osd-active must be removed when OSD is null');

    // 2. Subtitles render while OSD is mounted but hidden (isOsdVisible = false)
    pageEl.classList.add('osd-active');
    playerContainer.classList.add('osd-active');
    const mockOsd = { isOsdVisible: false };
    updateDualSubtitleState(mockOsd, true, false);
    assert.equal(pageEl.classList.contains('osd-active'), false, 'osd-active must be removed when OSD is not visible');
    assert.equal(playerContainer.classList.contains('osd-active'), false, 'playerContainer osd-active must be removed when OSD is not visible');

    // 3. Subtitles render when OSD is active and visible
    mockOsd.isOsdVisible = true;
    pageEl.classList.add('osd-active');
    playerContainer.classList.add('osd-active');
    updateDualSubtitleState(mockOsd, true, false);
    assert.equal(pageEl.classList.contains('osd-active'), true, 'osd-active must be retained when OSD is visible');
    assert.equal(playerContainer.classList.contains('osd-active'), true, 'playerContainer osd-active must be retained when OSD is visible');
});

test('Secondary Subtitle position setting updates window styles correctly', () => {
    storageMap.clear();
    storage.removeItem('player:secondarySubtitleVerticalPositionCustom');
    storage.removeItem('player:secondarySubtitleVerticalPosition');

    // Default position is 80% from bottom with elevated z-index and normalized opacity
    let styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'zIndex', value: '150' },
        { name: 'opacity', value: '1' },
        { name: 'top', value: 'auto' },
        { name: 'bottom', value: '80%' }
    ]);

    // Change setting to 25% from bottom
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 25);
    styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'zIndex', value: '150' },
        { name: 'opacity', value: '1' },
        { name: 'top', value: 'auto' },
        { name: 'bottom', value: '25%' }
    ]);

    // Change setting to 5% from bottom
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 5);
    styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'zIndex', value: '150' },
        { name: 'opacity', value: '1' },
        { name: 'top', value: 'auto' },
        { name: 'bottom', value: '5%' }
    ]);
});

test('getWindowStyles provides elevated zIndex and normalized opacity for OSD contrast protection', () => {
    storageMap.clear();

    // Default preset (-2) bottom positioning
    let styles = getWindowStyles();
    const zIndexStyle = styles.find((s) => s.name === 'zIndex');
    const opacityStyle = styles.find((s) => s.name === 'opacity');

    assert.equal(zIndexStyle?.value, '150', 'Primary window styles must enforce z-index: 150');
    assert.equal(opacityStyle?.value, '1', 'Primary window styles must normalize opacity: 1');

    // Custom bottom positioning
    PlayerSettings.set('subtitleVerticalPosition', 'custom');
    PlayerSettings.set('subtitleVerticalPositionCustom', 15);
    styles = getWindowStyles();

    assert.equal(styles.find((s) => s.name === 'zIndex')?.value, '150');
    assert.equal(styles.find((s) => s.name === 'opacity')?.value, '1');
});

test('CSS rules ensure secondary subtitle does not have hardcoded top !important override', () => {
    const cssPath = path.resolve('src/styles/player-page.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Verify secondary subtitle baseline does NOT force top !important
    assert.doesNotMatch(
        cssContent,
        /\.subtitle-overlay\.secondary[^{]*\{[^}]*top:\s*10%\s*!important/s,
        'Secondary subtitle baseline must not force top: 10% !important so dynamic inline styling works'
    );

    // Verify ultra-legacy does not force top !important
    assert.doesNotMatch(
        cssContent,
        /html\[data-layout-tier="ultra-legacy"\]\s+\.subtitle-overlay\.secondary[^{]*\{[^}]*top:\s*10%\s*!important/s,
        'Ultra-legacy secondary subtitle must not force top: 10% !important'
    );
});

test('CSS rules ensure secondary subtitle does not have diminished opacity override', () => {
    const cssPath = path.resolve('src/styles/player-page.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Ensure secondary subtitles do not declare custom fractional opacity (e.g. 0.9)
    // so brightness, chromaticity, and drop shadow contrast match primary subtitles.
    assert.doesNotMatch(
        cssContent,
        /\.subtitle-overlay\.secondary\s+\.subtitle-line[^{]*\{[^}]*opacity:\s*0\.[0-9]+/s,
        'Secondary subtitle must not force reduced opacity on .subtitle-line'
    );
});

test('Secondary subtitle text styles match primary brightness, hue, and shadow appearance', () => {
    storageMap.clear();

    // Configure distinct subtitle appearance attributes
    PlayerSettings.set('subtitleTextColor', '#ffff00');
    PlayerSettings.set('subtitleTextOpacity', 90);
    PlayerSettings.set('subtitleTextBackground', '#000000');
    PlayerSettings.set('subtitleBackgroundOpacity', 75);
    PlayerSettings.set('subtitleDropShadow', 'uniform_border');
    PlayerSettings.set('subtitleDropShadowColor', '#00ffff');
    PlayerSettings.set('subtitleDropShadowOpacity', 80);
    PlayerSettings.set('subtitleDropShadowBlur', 8);
    PlayerSettings.set('subtitleBorderWidth', 4);
    PlayerSettings.set('subtitleBorderOpacity', 95);

    // Fetch primary and secondary style property arrays
    const primaryStyles = getTextStyles(false);
    const secondaryStyles = getSecondaryTextStyles(false);

    // Helper to extract CSS style property values by name
    const getVal = (styles, name) => styles.find((s) => s.name === name)?.value;

    // Verify exact parity across brightness, hue, color opacity, and shadows
    assert.equal(getVal(secondaryStyles, 'color'), getVal(primaryStyles, 'color'), 'Text color and opacity must match');
    assert.equal(getVal(secondaryStyles, 'opacity'), getVal(primaryStyles, 'opacity'), 'Layer opacity must match');
    assert.equal(getVal(secondaryStyles, 'textShadow'), getVal(primaryStyles, 'textShadow'), 'Text drop shadow must match');
    assert.equal(getVal(secondaryStyles, 'webkitTextStroke'), getVal(primaryStyles, 'webkitTextStroke'), 'Border stroke outline must match');
    assert.equal(getVal(secondaryStyles, 'paintOrder'), getVal(primaryStyles, 'paintOrder'), 'Paint order must match');
    assert.equal(getVal(secondaryStyles, 'backgroundColor'), getVal(primaryStyles, 'backgroundColor'), 'Background color and opacity must match');
});

test('Smart Hemisphere Detection correctly classifies subtitle positions', () => {
    storageMap.clear();

    // 1. Primary Subtitle
    // Default preset (-2) is bottom
    assert.equal(isPrimarySubtitleInBottomHalf(), true, 'Default primary preset must be bottom half');

    // Preset 0 or positive is top
    PlayerSettings.set('subtitleVerticalPosition', '0');
    assert.equal(isPrimarySubtitleInBottomHalf(), false, 'Primary preset 0 must be top half');

    // Custom < 50 (% from bottom) is bottom half
    PlayerSettings.set('subtitleVerticalPosition', 'custom');
    PlayerSettings.set('subtitleVerticalPositionCustom', 12);
    assert.equal(isPrimarySubtitleInBottomHalf(), true, 'Primary custom 12% must be bottom half');

    // Custom >= 50 (% from bottom) is top half
    PlayerSettings.set('subtitleVerticalPositionCustom', 80);
    assert.equal(isPrimarySubtitleInBottomHalf(), false, 'Primary custom 80% must be top half');

    // 2. Secondary Subtitle
    // Default (custom 80% from bottom) is top half
    storageMap.clear();
    storage.removeItem('player:secondarySubtitleVerticalPositionCustom');
    storage.removeItem('player:secondarySubtitleVerticalPosition');
    assert.equal(isSecondarySubtitleInBottomHalf(), false, 'Default secondary (80% from bottom) must be top half');

    // Custom >= 50 (% from bottom) is top half
    PlayerSettings.set('secondarySubtitleVerticalPosition', 'custom');
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 80);
    assert.equal(isSecondarySubtitleInBottomHalf(), false, 'Secondary custom 80% must be top half');

    // Custom < 50 (% from bottom, placed right above primary subtitle at bottom) is bottom half!
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 20);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 20% must be bottom half');

    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 15);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 15% must be bottom half');

    // Custom 10% (near bottom baseline) must be bottom half and dodge UPWARDS
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 10);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 10% must be bottom half');
});

test('Smart Dodging CSS rules shift bottom half UP and top half DOWN', () => {
    const cssPath = path.resolve('src/styles/player-page.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Bottom-half single subtitle elevates up
    assert.match(
        cssContent,
        /\.player-page\.osd-active:not\(\.has-dual-subtitles\):not\(\.osd-dodging-disabled\)\s+\.subtitle-overlay\.pos-bottom[^{]*\{[^}]*translateY\(-18\.5vh\)/s,
        'Single subtitle in bottom half must push UP'
    );

    // Top-half single subtitle pushes DOWN
    assert.match(
        cssContent,
        /\.player-page\.osd-active:not\(\.has-dual-subtitles\):not\(\.osd-dodging-disabled\)\s+\.subtitle-overlay\.pos-top[^{]*\{[^}]*translateY\(14vh\)/s,
        'Single subtitle in top half must push DOWN'
    );

    // Dual subtitles in bottom half both elevate UP with compact scale
    assert.match(
        cssContent,
        /\.player-page\.osd-active\.has-dual-subtitles:not\(\.osd-dodging-disabled\)\s+\.subtitle-overlay\.pos-bottom[^{]*\{[^}]*translateY\(-17\.5vh\)\s+scale\(0\.88\)/s,
        'Dual subtitles in bottom half must push UP together with compact scale'
    );

    // Dual subtitles in top half push DOWN with compact scale
    assert.match(
        cssContent,
        /\.player-page\.osd-active\.has-dual-subtitles:not\(\.osd-dodging-disabled\)\s+\.subtitle-overlay\.pos-top[^{]*\{[^}]*translateY\(12vh\)\s+scale\(0\.88\)/s,
        'Dual subtitles in top half must push DOWN together with compact scale'
    );
});

test('CSS rules elevate subtitle overlays above OSD gradients and enforce opacity: 1 during active shift', () => {
    const cssPath = path.resolve('src/styles/player-page.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');

    // Base subtitle-overlay must have z-index: 150 (above OSD 100)
    assert.match(
        cssContent,
        /\.subtitle-overlay\s*\{[^}]*z-index:\s*150;/s,
        'Base .subtitle-overlay must have z-index: 150 to paint in front of OSD gradient'
    );

    // Active OSD dodging must enforce z-index: 150 !important and opacity: 1 !important
    assert.match(
        cssContent,
        /\.player-page\.osd-active\s+\.subtitle-overlay[^{]*\{[^}]*z-index:\s*150\s*!important/s,
        'Active OSD dodging must enforce z-index: 150 !important on subtitle overlays'
    );
    assert.match(
        cssContent,
        /\.player-page\.osd-active\s+\.subtitle-overlay[^{]*\{[^}]*opacity:\s*1\s*!important/s,
        'Active OSD dodging must enforce opacity: 1 !important on subtitle overlays'
    );

    // Active OSD dodging must enforce opacity: 1 !important on subtitle lines
    assert.match(
        cssContent,
        /\.player-page\.osd-active\s+\.subtitle-overlay\s+\.subtitle-line[^{]*\{[^}]*opacity:\s*1\s*!important/s,
        'Active OSD dodging must enforce opacity: 1 !important on subtitle lines'
    );

    // Ultra-legacy must also elevate to z-index: 150 !important
    assert.match(
        cssContent,
        /html\[data-layout-tier="ultra-legacy"\]\s+\.subtitle-overlay\s*\{[^}]*z-index:\s*150\s*!important;/s,
        'Ultra-legacy .subtitle-overlay must have z-index: 150 !important'
    );
});



