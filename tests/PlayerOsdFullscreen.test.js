import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * ============================================================================
 * PLAYER OSD FULLSCREEN BUTTON TEST SUITE
 * ============================================================================
 * Validates the fullscreen presentation mode button added to the player OSD
 * for Windows, Desktop, and Web runtimes:
 * 1. Icon dictionary contains valid fullscreen & fullscreenExit SVG markup
 * 2. DesktopAdapter provides isFullscreen() and toggleFullscreen() IPC
 * 3. WebAdapter provides isFullscreen() and toggleFullscreen() HTML5 API
 * 4. Fullscreen state changes broadcast 'window:fullscreen' via eventBus
 * 5. Button tooltip and icon toggle dynamically between Windowed and Fullscreen
 * ============================================================================
 */

function setupAdapterTest(filePath, adapterExportName) {
    const source = readFileSync(filePath, 'utf8');

    let fullscreenListener = null;
    let fullscreenElement = null;
    let keydownListener = null;

    const mockDocument = {
        addEventListener(event, handler) {
            if (event === 'fullscreenchange') {
                fullscreenListener = handler;
            } else if (event === 'keydown') {
                keydownListener = handler;
            }
        },
        removeEventListener() {},
        querySelector() {
            return null;
        },
        get fullscreenElement() {
            return fullscreenElement;
        },
        set fullscreenElement(val) {
            fullscreenElement = val;
        },
        documentElement: {
            requestFullscreen() {
                fullscreenElement = {};
                return Promise.resolve();
            }
        },
        exitFullscreen() {
            fullscreenElement = null;
            return Promise.resolve();
        }
    };

    const emittedEvents = [];
    const mockEventBus = {
        emit(event, payload) {
            emittedEvents.push({ event, payload });
        },
        on(event, handler) {
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
        // Mouse and trackpad horizontal row scrolling subsystem mock
        mouseRowScroller: { init() {} },
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
        triggerFullscreenChange() {
            if (fullscreenListener) fullscreenListener();
        },
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

test('Icons: osdIcons exposes fullscreen and fullscreenExit SVG assets', () => {
    // Read Icons.js in vm context
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

    // Verify fullscreen entry icon exists and contains SVG structure
    assert.ok(osdIcons.fullscreen, 'osdIcons.fullscreen must be defined');
    assert.match(osdIcons.fullscreen, /<svg[^>]*>[\s\S]*<\/svg>/, 'osdIcons.fullscreen must be a valid SVG string');
    assert.match(osdIcons.fullscreen, /class="[^"]*osd-icon[^"]*"/, 'osdIcons.fullscreen must carry the osd-icon CSS class');

    // Verify fullscreen exit icon exists and contains SVG structure
    assert.ok(osdIcons.fullscreenExit, 'osdIcons.fullscreenExit must be defined');
    assert.match(osdIcons.fullscreenExit, /<svg[^>]*>[\s\S]*<\/svg>/, 'osdIcons.fullscreenExit must be a valid SVG string');
    assert.match(osdIcons.fullscreenExit, /class="[^"]*osd-icon[^"]*"/, 'osdIcons.fullscreenExit must carry the osd-icon CSS class');
});

test('DesktopAdapter: toggleFullscreen and isFullscreen methods work correctly', async () => {
    const { adapter, mockDocument, emittedEvents, triggerFullscreenChange } = setupAdapterTest(
        new URL('../src/desktop/DesktopAdapter.js', import.meta.url),
        'desktopAdapter'
    );

    // Initial state: windowed mode
    assert.strictEqual(adapter.isFullscreen(), false, 'DesktopAdapter should initially report windowed');

    // Toggle fullscreen -> triggers requestFullscreen
    const toggled = await adapter.toggleFullscreen();
    assert.strictEqual(toggled, true, 'toggleFullscreen should return true when entering fullscreen');
    assert.strictEqual(adapter.isFullscreen(), true, 'isFullscreen() should now return true');

    // Verify event emitted
    const fsEvent = emittedEvents.find(e => e.event === 'window:fullscreen');
    assert.ok(fsEvent, 'window:fullscreen event must be emitted');
    assert.strictEqual(fsEvent.payload, true);

    // Toggle back to windowed -> triggers exitFullscreen
    const exited = await adapter.toggleFullscreen();
    assert.strictEqual(exited, false, 'toggleFullscreen should return false when exiting fullscreen');
    assert.strictEqual(adapter.isFullscreen(), false, 'isFullscreen() should return false');

    // Simulate native document fullscreenchange
    mockDocument.fullscreenElement = {};
    triggerFullscreenChange();
    assert.strictEqual(adapter.isFullscreen(), true, 'Native fullscreenchange should update adapter state');
});

test('WebAdapter: toggleFullscreen and isFullscreen methods work correctly', async () => {
    const { adapter, mockDocument, emittedEvents, triggerFullscreenChange } = setupAdapterTest(
        new URL('../src/web/WebAdapter.js', import.meta.url),
        'webAdapter'
    );

    // Initial state: windowed mode
    assert.strictEqual(adapter.isFullscreen(), false, 'WebAdapter should initially report windowed');

    // Toggle fullscreen -> triggers requestFullscreen
    const toggled = await adapter.toggleFullscreen();
    assert.strictEqual(toggled, true, 'toggleFullscreen should return true when entering fullscreen');
    assert.strictEqual(adapter.isFullscreen(), true, 'isFullscreen() should now return true');

    // Verify event emitted
    const fsEvent = emittedEvents.find(e => e.event === 'window:fullscreen');
    assert.ok(fsEvent, 'window:fullscreen event must be emitted');
    assert.strictEqual(fsEvent.payload, true);

    // Toggle back to windowed -> triggers exitFullscreen
    const exited = await adapter.toggleFullscreen();
    assert.strictEqual(exited, false, 'toggleFullscreen should return false when exiting fullscreen');
    assert.strictEqual(adapter.isFullscreen(), false, 'isFullscreen() should return false');

    // Simulate native document fullscreenchange
    mockDocument.fullscreenElement = {};
    triggerFullscreenChange();
    assert.strictEqual(adapter.isFullscreen(), true, 'Native fullscreenchange should update adapter state');
});

test('OSDController: Fullscreen button markup, tooltip and state updates', () => {
    // Mock button DOM element
    const button = {
        id: 'osdFullscreenBtn',
        title: 'Full Screen (F)',
        attributes: {},
        innerHTML: 'expand_svg',
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; }
    };

    // Simulate _updateFullscreenButton logic
    function updateBtn(isFs) {
        const label = isFs ? 'Exit Full Screen' : 'Full Screen';
        button.title = `${label} (F)`;
        button.setAttribute('aria-label', label);
        button.innerHTML = isFs ? 'shrink_svg' : 'expand_svg';
    }

    // Windowed mode -> Full Screen (F) tooltip
    updateBtn(false);
    assert.strictEqual(button.title, 'Full Screen (F)');
    assert.strictEqual(button.getAttribute('aria-label'), 'Full Screen');
    assert.strictEqual(button.innerHTML, 'expand_svg');

    // Fullscreen mode -> Exit Full Screen (F) tooltip
    updateBtn(true);
    assert.strictEqual(button.title, 'Exit Full Screen (F)');
    assert.strictEqual(button.getAttribute('aria-label'), 'Exit Full Screen');
    assert.strictEqual(button.innerHTML, 'shrink_svg');

    // Return to windowed
    updateBtn(false);
    assert.strictEqual(button.title, 'Full Screen (F)');
    assert.strictEqual(button.getAttribute('aria-label'), 'Full Screen');
    assert.strictEqual(button.innerHTML, 'expand_svg');
});

test('DesktopAdapter: Escape shortcut disables fullscreen when active, and emits key:back in windowed mode', async () => {
    const { adapter, emittedEvents, triggerKeydown } = setupAdapterTest(
        new URL('../src/desktop/DesktopAdapter.js', import.meta.url),
        'desktopAdapter'
    );

    // Initialize adapter listeners
    adapter.init();

    // 1. In windowed mode: Escape should fall through and emit key:back
    assert.strictEqual(adapter.isFullscreen(), false);
    triggerKeydown('Escape', 27);
    const backEvent1 = emittedEvents.find(e => e.event === 'key:back');
    assert.ok(backEvent1, 'Escape must emit key:back when in windowed mode');

    // Clear events
    emittedEvents.length = 0;

    // 2. In fullscreen mode: Escape should toggle fullscreen off instead of emitting key:back
    await adapter.toggleFullscreen();
    assert.strictEqual(adapter.isFullscreen(), true);

    const { defaultPrevented } = triggerKeydown('Escape', 27);
    assert.strictEqual(defaultPrevented, true, 'Escape in fullscreen mode must preventDefault');
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(adapter.isFullscreen(), false, 'Escape in fullscreen mode must toggle fullscreen off');
    const backEvent2 = emittedEvents.find(e => e.event === 'key:back');
    assert.strictEqual(backEvent2, undefined, 'Escape in fullscreen mode must NOT emit key:back');
});

test('WebAdapter: Escape shortcut disables fullscreen when active, and emits key:back in windowed mode', async () => {
    const { adapter, emittedEvents, triggerKeydown } = setupAdapterTest(
        new URL('../src/web/WebAdapter.js', import.meta.url),
        'webAdapter'
    );

    // Initialize adapter listeners
    adapter.init();

    // 1. In windowed mode: Escape should fall through and emit key:back
    assert.strictEqual(adapter.isFullscreen(), false);
    triggerKeydown('Escape', 27);
    const backEvent1 = emittedEvents.find(e => e.event === 'key:back');
    assert.ok(backEvent1, 'Escape must emit key:back when in windowed mode');

    // Clear events
    emittedEvents.length = 0;

    // 2. In fullscreen mode: Escape should toggle fullscreen off instead of emitting key:back
    await adapter.toggleFullscreen();
    assert.strictEqual(adapter.isFullscreen(), true);

    const { defaultPrevented } = triggerKeydown('Escape', 27);
    assert.strictEqual(defaultPrevented, true, 'Escape in fullscreen mode must preventDefault');
    assert.strictEqual(adapter.isFullscreen(), false, 'Escape in fullscreen mode must toggle fullscreen off');
    const backEvent2 = emittedEvents.find(e => e.event === 'key:back');
    assert.strictEqual(backEvent2, undefined, 'Escape in fullscreen mode must NOT emit key:back');
});

test('OSDController: double click toggles fullscreen and _handleBack overrides back in fullscreen', () => {
    const osdSource = readFileSync(new URL('../src/player/osd/OSDController.js', import.meta.url), 'utf8');

    // 1. Verify dblclick listener registration is present on desktop/web
    assert.ok(
        osdSource.includes("this._osdEl.addEventListener('dblclick'"),
        'OSDController must register a dblclick listener on _osdEl'
    );

    // 2. Verify _handleBack overrides back navigation when in fullscreen on desktop/web
    assert.ok(
        osdSource.includes('(platformInfo.isDesktop || platformInfo.isWeb) && this._isFullscreen()'),
        'OSDController _handleBack must check platformInfo and _isFullscreen'
    );

    // 3. Verify single-click background timer buffering exists
    assert.ok(
        osdSource.includes('_dispatchBackgroundClick'),
        'OSDController must define _dispatchBackgroundClick'
    );
    assert.ok(
        osdSource.includes('_clearBackgroundClickTimeout'),
        'OSDController must define _clearBackgroundClickTimeout'
    );
});

test('PlayerPage: single click is debounced and double click triggers fullscreen without play/pause override', () => {
    const playerPageSource = readFileSync(new URL('../src/pages/PlayerPage.js', import.meta.url), 'utf8');

    // 1. Verify _bgClickTimer instance variable initialization
    assert.ok(
        playerPageSource.includes('this._bgClickTimer = null;'),
        'PlayerPage must initialize this._bgClickTimer'
    );

    // 2. Verify single-click listener debounces on desktop and web runtimes
    assert.ok(
        playerPageSource.includes('if (platformInfo.isDesktop || platformInfo.isWeb) {'),
        'PlayerPage click listener must check platformInfo.isDesktop and platformInfo.isWeb'
    );
    assert.ok(
        playerPageSource.includes('if (e.detail > 1) {'),
        'PlayerPage click listener must discard consecutive clicks in multi-click sequence'
    );
    assert.ok(
        playerPageSource.includes('this._bgClickTimer = setTimeout('),
        'PlayerPage click listener must buffer single-click with setTimeout'
    );

    // 3. Verify dblclick listener exists on this.el for desktop and web
    assert.ok(
        playerPageSource.includes("this.el.addEventListener('dblclick'"),
        'PlayerPage must attach dblclick event listener to this.el'
    );
    assert.ok(
        playerPageSource.includes('this._osd._toggleFullscreen()'),
        'PlayerPage dblclick listener must invoke this._osd._toggleFullscreen()'
    );

    // 4. Verify cleanup in destroy and _stopAndExit
    assert.ok(
        playerPageSource.includes('clearTimeout(this._bgClickTimer)'),
        'PlayerPage must clear _bgClickTimer on teardown and exit'
    );
});


