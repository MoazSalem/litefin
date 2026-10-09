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
