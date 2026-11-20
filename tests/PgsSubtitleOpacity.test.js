import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Polyfill minimal browser DOM globals for Node test environment
const storageMap = new Map();
globalThis.localStorage = {
    getItem: (key) => storageMap.get(key) || null,
    setItem: (key, val) => storageMap.set(key, String(val)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear()
};
globalThis.window = globalThis;
globalThis.document = {
    createElement: () => ({
        style: {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
        appendChild: () => {},
        canPlayType: () => ''
    })
};

const PlayerSettings = (await import('../src/utils/PlayerSettings.js')).default;

test('PlayerSettings defaults subtitlePgsOpacity to 100 and subtitlePgsOpacityHdr to 80', () => {
    storageMap.clear();

    // Assert default values
    assert.equal(PlayerSettings.get('subtitlePgsOpacity'), 100);
    assert.equal(PlayerSettings.get('subtitlePgsOpacityHdr'), 80);

    // Verify settings can be modified and persist correctly
    PlayerSettings.set('subtitlePgsOpacity', 85);
    assert.equal(PlayerSettings.get('subtitlePgsOpacity'), 85);

    PlayerSettings.set('subtitlePgsOpacityHdr', 60);
    assert.equal(PlayerSettings.get('subtitlePgsOpacityHdr'), 60);

    // Restore defaults for subsequent tests
    PlayerSettings.set('subtitlePgsOpacity', 100);
    PlayerSettings.set('subtitlePgsOpacityHdr', 80);
});

test('SubtitleQuickSettings displays PGS opacity controls and filters out text styling when PGS is active', async () => {
    const SubtitleQuickSettings = (await import('../src/player/osd/SubtitleQuickSettings.js')).default;

    // Create dummy OSD mock with PGS active
    const dummyOsdPgs = {
        player: {
            _subtitleManager: {
                isASSActive: () => false,
                isPGSActive: () => true
            }
        }
    };

    const menu = new SubtitleQuickSettings(dummyOsdPgs);
    menu._buildItems();

    // PGS controls must be present and visible
    const pgsSdrItem = menu.items.find(i => i.id === 'pgsOpacitySdr');
    const pgsHdrItem = menu.items.find(i => i.id === 'pgsOpacityHdr');
    assert.ok(pgsSdrItem, 'pgsOpacitySdr item must exist in SubtitleQuickSettings');
    assert.ok(pgsHdrItem, 'pgsOpacityHdr item must exist in SubtitleQuickSettings');

    // Text-only styling items must be filtered out when PGS is active
    const textColorItem = menu.items.find(i => i.id === 'textColorSdr');
    const fontItem = menu.items.find(i => i.id === 'font');
    const shadowItem = menu.items.find(i => i.id === 'shadow');

    assert.equal(textColorItem, undefined, 'Text color setting must be filtered out when PGS is active');
    assert.equal(fontItem, undefined, 'Font family setting must be filtered out when PGS is active');
    assert.equal(shadowItem, undefined, 'Text shadow setting must be filtered out when PGS is active');
});

test('SubtitleQuickSettings displays text styling and filters out PGS opacity when text subtitle is active', async () => {
    const SubtitleQuickSettings = (await import('../src/player/osd/SubtitleQuickSettings.js')).default;

    // Create dummy OSD mock with normal text subtitles active (neither ASS nor PGS)
    const dummyOsdText = {
        player: {
            _subtitleManager: {
                isASSActive: () => false,
                isPGSActive: () => false
            }
        }
    };

    const menu = new SubtitleQuickSettings(dummyOsdText);
    menu._buildItems();

    // Text items must be present
    const textColorItem = menu.items.find(i => i.id === 'textColorSdr');
    const fontItem = menu.items.find(i => i.id === 'font');
    assert.ok(textColorItem, 'textColorSdr must be visible for text subtitles');
    assert.ok(fontItem, 'font must be visible for text subtitles');

    // PGS controls must be filtered out
    const pgsSdrItem = menu.items.find(i => i.id === 'pgsOpacitySdr');
    const pgsHdrItem = menu.items.find(i => i.id === 'pgsOpacityHdr');
    assert.equal(pgsSdrItem, undefined, 'pgsOpacitySdr must be filtered out for text subtitles');
    assert.equal(pgsHdrItem, undefined, 'pgsOpacityHdr must be filtered out for text subtitles');
});

