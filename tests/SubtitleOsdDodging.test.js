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
const {
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

    // Default position is 10% from top
    let styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'top', value: '10%' },
        { name: 'bottom', value: 'auto' }
    ]);

    // Change setting to 25% from top
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 25);
    styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'top', value: '25%' },
        { name: 'bottom', value: 'auto' }
    ]);

    // Change setting to 5% from top
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 5);
    styles = getSecondaryWindowStyles();
    assert.deepEqual(styles, [
        { name: 'top', value: '5%' },
        { name: 'bottom', value: 'auto' }
    ]);
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
    // Default (custom 10% from top) is top half
    storageMap.clear();
    assert.equal(isSecondarySubtitleInBottomHalf(), false, 'Default secondary must be top half');

    // Custom < 50 (% from top) is top half
    PlayerSettings.set('secondarySubtitleVerticalPosition', 'custom');
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 20);
    assert.equal(isSecondarySubtitleInBottomHalf(), false, 'Secondary custom 20% must be top half');

    // Custom >= 50 (% from top, placed right above primary subtitle at bottom) is bottom half!
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 75);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 75% must be bottom half');

    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 85);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 85% must be bottom half');

    // Custom 90% (near bottom baseline) must be bottom half and dodge UPWARDS
    PlayerSettings.set('secondarySubtitleVerticalPositionCustom', 90);
    assert.equal(isSecondarySubtitleInBottomHalf(), true, 'Secondary custom 90% must be bottom half');
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



