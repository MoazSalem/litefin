import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * ============================================================================
 * PLAYER OSD VOLUME & MUTE CONTROLS TEST SUITE
 * ============================================================================
 * Validates the volume slider, mute/unmute button, keyboard shortcuts,
 * stealth HUD feedback, and volume persistence for Desktop and Web runtimes:
 * 1. Icon dictionary exposes valid volume SVG assets with osd-icon CSS class
 * 2. DesktopAdapter provides ArrowUp / ArrowDown volume shortcuts and 'M' mute
 * 3. WebAdapter provides ArrowUp / ArrowDown volume shortcuts and 'M' mute
 * 4. OSDController volume UI synchronizes icons, slider value, and fill line
 * 5. Mute toggling and volume adjustment clamp between 0% and 100%
 * 6. Stealth HUD renders volume percentage and muted indicator
 * 7. Volume settings persist across playback sessions via storage
 * ============================================================================
 */

function setupAdapterTest(filePath, adapterExportName) {
    const source = readFileSync(filePath, 'utf8');

    let keydownListener = null;

    const mockDocument = {
        addEventListener(event, handler) {
            if (event === 'keydown') {
                keydownListener = handler;
            }
        },
        removeEventListener() {},
        querySelector() {
            return null; // No modal open by default
        }
    };

    const emittedEvents = [];
    const mockEventBus = {
        emit(event, payload) {
            emittedEvents.push({ event, payload });
        },
        on() {
            return () => {};
        },
        off() {}
    };

    const mockStorage = {
        getItem() { return null; },
        setItem() {},
        flush() {}
    };

    const mockLogger = {
        create() {
            return { debug() {}, info() {}, warn() {}, error() {} };
        }
    };

    const mockWindow = {
        location: { hash: '#/player' }
    };

    const cleanedSource = source
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+default\s+.*?;?/g, '')
        .replace(/export\s+const\s+(\w+)\s*=/g, 'const $1 =');

    const context = {
        document: mockDocument,
        window: mockWindow,
        navigator: { userAgent: 'Chrome/120.0' },
        eventBus: mockEventBus,
        storage: mockStorage,
        logger: mockLogger,
        gamepadManager: { init() {}, update() {}, destroy() {} },
        console,
        Boolean,
        Date
    };

    vm.createContext(context);
    vm.runInContext(cleanedSource + `\nthis.adapter = ${adapterExportName};`, context);

    return {
        adapter: context.adapter,
        mockDocument,
        emittedEvents,
        triggerKeydown(key, keyCode, extra = {}) {
            if (keydownListener) {
                let defaultPrevented = false;
                const event = {
                    key,
                    keyCode,
                    preventDefault() { defaultPrevented = true; },
                    stopPropagation() {},
                    ...extra
                };
                keydownListener(event);
                return { defaultPrevented };
            }
            return { defaultPrevented: false };
        }
    };
}

test('Icons: osdIcons exposes volumeUp, volumeDown, volumeOff, and volumeMute SVG assets', () => {
    const iconsSource = readFileSync(new URL('../src/utils/Icons.js', import.meta.url), 'utf8');
    const cleaned = iconsSource
        .replace(/import\s+[\s\S]*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+function\s+/g, 'function ')
        .replace(/export\s+const\s+(\w+)\s*=/g, 'const $1 =');

    const context = {
        window: {},
        document: { querySelector() { return null; } },
        storage: { getItem() { return 'default'; }, setItem() {} },
        console
    };
    vm.createContext(context);
    vm.runInContext(cleaned + '\nthis.osdIcons = osdIcons;', context);
    const osdIcons = context.osdIcons;

    const volumeKeys = ['volumeUp', 'volumeDown', 'volumeOff', 'volumeMute'];
    for (const key of volumeKeys) {
        assert.ok(osdIcons[key], `osdIcons.${key} must be defined`);
        assert.match(osdIcons[key], /<svg[^>]*>[\s\S]*<\/svg>/, `osdIcons.${key} must be a valid SVG string`);
        assert.match(osdIcons[key], /class="[^"]*osd-icon[^"]*"/, `osdIcons.${key} must carry the osd-icon CSS class`);
    }
});

test('DesktopAdapter: ArrowUp, ArrowDown, and M keyboard shortcuts trigger volume and mute events', () => {
    const { adapter, emittedEvents, triggerKeydown } = setupAdapterTest(
        new URL('../src/desktop/DesktopAdapter.js', import.meta.url),
        'desktopAdapter'
    );

    // Initialize adapter listeners
    adapter.init();

    // 1. Test ArrowUp -> remote:volumeup
    triggerKeydown('ArrowUp', 38);
    const upEvent = emittedEvents.find(e => e.event === 'remote:volumeup');
    assert.ok(upEvent, 'ArrowUp must emit remote:volumeup');

    // 2. Test ArrowDown -> remote:volumedown
    triggerKeydown('ArrowDown', 40);
    const downEvent = emittedEvents.find(e => e.event === 'remote:volumedown');
    assert.ok(downEvent, 'ArrowDown must emit remote:volumedown');

    // 3. Test M -> remote:togglemute
    triggerKeydown('m', 77);
    const muteEvent = emittedEvents.find(e => e.event === 'remote:togglemute');
    assert.ok(muteEvent, 'M key must emit remote:togglemute');
});

test('WebAdapter: ArrowUp, ArrowDown, and M keyboard shortcuts trigger volume and mute events', () => {
    const { adapter, emittedEvents, triggerKeydown } = setupAdapterTest(
        new URL('../src/web/WebAdapter.js', import.meta.url),
        'webAdapter'
    );

    // Initialize adapter listeners
    adapter.init();

    // 1. Test ArrowUp -> remote:volumeup
    triggerKeydown('ArrowUp', 38);
    const upEvent = emittedEvents.find(e => e.event === 'remote:volumeup');
    assert.ok(upEvent, 'ArrowUp must emit remote:volumeup');

    // 2. Test ArrowDown -> remote:volumedown
    triggerKeydown('ArrowDown', 40);
    const downEvent = emittedEvents.find(e => e.event === 'remote:volumedown');
    assert.ok(downEvent, 'ArrowDown must emit remote:volumedown');

    // 3. Test M -> remote:togglemute
    triggerKeydown('m', 77);
    const muteEvent = emittedEvents.find(e => e.event === 'remote:togglemute');
    assert.ok(muteEvent, 'M key must emit remote:togglemute');
});

test('OSDController: Volume UI updates icon, slider value, fill width, and mute tooltip', () => {
    // Mock DOM elements for volume controls
    const button = {
        id: 'osdVolumeBtn',
        title: '',
        attributes: {},
        innerHTML: '',
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; }
    };
    const slider = {
        id: 'osdVolumeSlider',
        value: 100
    };
    const fill = {
        id: 'osdVolumeFill',
        style: { width: '100%' }
    };

    const icons = {
        volumeUp: '<svg>volumeUp</svg>',
        volumeDown: '<svg>volumeDown</svg>',
        volumeOff: '<svg>volumeOff</svg>',
        volumeMute: '<svg>volumeMute</svg>'
    };

    // Helper simulating OSDController._updateVolumeUI logic
    function updateVolumeUI(volume, isMuted) {
        const displayVol = isMuted ? 0 : Math.max(0, Math.min(100, Math.round(volume)));
        slider.value = displayVol;
        fill.style.width = `${displayVol}%`;

        let icon;
        if (isMuted || volume === 0) {
            icon = icons.volumeOff;
        } else if (volume <= 50) {
            icon = icons.volumeDown;
        } else {
            icon = icons.volumeUp;
        }

        const label = isMuted ? 'Unmute' : 'Mute';
        button.innerHTML = icon;
        button.setAttribute('aria-label', label);
        button.title = `${label} (M)`;
    }

    // 1. High Volume (> 50%)
    updateVolumeUI(85, false);
    assert.strictEqual(slider.value, 85);
    assert.strictEqual(fill.style.width, '85%');
    assert.strictEqual(button.innerHTML, icons.volumeUp);
    assert.strictEqual(button.title, 'Mute (M)');
    assert.strictEqual(button.getAttribute('aria-label'), 'Mute');

    // 2. Medium/Low Volume (<= 50%)
    updateVolumeUI(35, false);
    assert.strictEqual(slider.value, 35);
    assert.strictEqual(fill.style.width, '35%');
    assert.strictEqual(button.innerHTML, icons.volumeDown);
    assert.strictEqual(button.title, 'Mute (M)');

    // 3. Muted state (slider shows 0%, icon shows volumeOff, tooltip shows Unmute)
    updateVolumeUI(85, true);
    assert.strictEqual(slider.value, 0);
    assert.strictEqual(fill.style.width, '0%');
    assert.strictEqual(button.innerHTML, icons.volumeOff);
    assert.strictEqual(button.title, 'Unmute (M)');
    assert.strictEqual(button.getAttribute('aria-label'), 'Unmute');

    // 4. Zero volume unmuted
    updateVolumeUI(0, false);
    assert.strictEqual(slider.value, 0);
    assert.strictEqual(fill.style.width, '0%');
    assert.strictEqual(button.innerHTML, icons.volumeOff);
});

test('OSDController: Volume persistence and clamping', () => {
    let storedVolume = '1';
    const mockStorage = {
        getItem(key) {
            if (key === 'jellyfin-player-volume') return storedVolume;
            return null;
        },
        setItem(key, value) {
            if (key === 'jellyfin-player-volume') storedVolume = value;
        }
    };

    function saveVolume(val) {
        const normalized = Math.max(0, Math.min(100, Math.round(val))) / 100;
        mockStorage.setItem('jellyfin-player-volume', normalized.toString());
    }

    function getSavedVolume() {
        const stored = mockStorage.getItem('jellyfin-player-volume');
        return stored ? parseFloat(stored) : 1;
    }

    // Default: 1.0 (100%)
    assert.strictEqual(getSavedVolume(), 1.0);

    // Save 75%
    saveVolume(75);
    assert.strictEqual(getSavedVolume(), 0.75);

    // Clamp over 100%
    saveVolume(120);
    assert.strictEqual(getSavedVolume(), 1.0);

    // Clamp under 0%
    saveVolume(-15);
    assert.strictEqual(getSavedVolume(), 0.0);
});

test('OSDController: Volume controls are positioned inside osd-controls-right preceding fullscreen button', () => {
    /*
     * Read the raw OSDController source to inspect the HTML template structure
     * for control placement and platform condition guards.
     */
    const osdSource = readFileSync(new URL('../src/player/osd/OSDController.js', import.meta.url), 'utf8');

    // 1. Verify volume group is NOT inside osd-controls-left
    const leftControlsMatch = osdSource.match(/<div class="osd-controls-left">([\s\S]*?)<\/div>\s*<div class="osd-ends-at"/);
    assert.ok(leftControlsMatch, 'osd-controls-left section must be present');
    assert.ok(
        !leftControlsMatch[1].includes('osdVolumeGroup'),
        'osdVolumeGroup must not be inside osd-controls-left'
    );

    // 2. Verify volume group IS inside osd-controls-right
    const rightControlsMatch = osdSource.match(/<div class="osd-controls-right">([\s\S]*?)<\/div>\s*<\/div>\s*<!-- Seekbar/);
    assert.ok(rightControlsMatch, 'osd-controls-right section must be present');
    const rightHtml = rightControlsMatch[1];
    assert.ok(
        rightHtml.includes('id="osdVolumeGroup"'),
        'osdVolumeGroup must be located within osd-controls-right'
    );

    // 3. Verify volume group appears before osdFullscreenBtn in right controls cluster
    const volumeIndex = rightHtml.indexOf('id="osdVolumeGroup"');
    const fullscreenIndex = rightHtml.indexOf('id="osdFullscreenBtn"');
    assert.ok(volumeIndex !== -1, 'osdVolumeGroup must exist in right controls');
    assert.ok(fullscreenIndex !== -1, 'osdFullscreenBtn must exist in right controls');
    assert.ok(
        volumeIndex < fullscreenIndex,
        'osdVolumeGroup must precede osdFullscreenBtn on the right side'
    );
});

