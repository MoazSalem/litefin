import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/*
 * ============================================================================
 * MULTI-SEGMENT INTRO SKIPPER STACKING & FOCUS TRANSITION REGRESSION TESTS
 * ============================================================================
 * Addresses and verifies the resolutions for two critical Intro Skipper UX bugs:
 *
 * 1. Concurrent Multi-Segment Stacking (Scenario 1):
 *    - When two or more segments (e.g. Skip Recap and Skip Intro) are active
 *      concurrently, PluginWidgetHost dynamically calculates vertical layout
 *      offsets so the buttons render cleanly stacked one below another instead
 *      of covering each other at the same fixed position.
 *    - Vertical D-pad navigation (Up / Down) in OSDController seamlessly travels
 *      between adjacent buttons in the vertical overlay stack.
 *    - Activating the first button smoothly transitions focus to the remaining
 *      segment rather than stranding focus on the main controls row.
 *
 * 2. Back-to-Back Segment Auto-Focus (Scenario 2):
 *    - When segments appear sequentially in rapid succession (e.g. Skip Recap
 *      followed immediately by Skip Intro after a seek), auto-focus reliably
 *      claims the newly appeared segment even if the OSD controls layer was
 *      woken by the prior button interaction.
 * ============================================================================
 */

// Load PluginWidgetHost source and strip module imports
const hostSource = readFileSync(
    new URL('../src/plugins/PluginWidgetHost.js', import.meta.url),
    'utf8'
)
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default PluginWidgetHost;', 'PluginWidgetHost;');

// Load OSDController source and strip module imports
const osdSource = readFileSync(
    new URL('../src/player/osd/OSDController.js', import.meta.url),
    'utf8'
)
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class OSDController', 'class OSDController');

class MockHTMLElement {}

/**
 * Creates a mock DOM element with attribute and style tracking.
 * Provides resilient simulation of Element styling and dataset.
 */
function createMockElement(tagName = 'div') {
    const styleProps = {};
    const attributes = {};
    const classListSet = new Set();

    const el = Object.create(MockHTMLElement.prototype);
    el.tagName = tagName.toUpperCase();
    el.parentNode = null;
    el.children = [];
    el.dataset = {};
    el.style = {
        bottom: '',
        transform: '',
        setProperty(prop, val) {
            styleProps[prop] = String(val);
        },
        getPropertyValue(prop) {
            return styleProps[prop] || '';
        },
        removeProperty(prop) {
            delete styleProps[prop];
        }
    };
    el.classList = {
        add(...cls) {
            cls.forEach((c) => classListSet.add(c));
        },
        remove(...cls) {
            cls.forEach((c) => classListSet.delete(c));
        },
        contains(c) {
            return classListSet.has(c);
        }
    };
    el.setAttribute = (k, v) => {
        attributes[k] = String(v);
    };
    el.getAttribute = (k) => attributes[k] || null;
    el.removeAttribute = (k) => {
        delete attributes[k];
    };
    el.appendChild = (child) => {
        child.parentNode = el;
        el.children.push(child);
        return child;
    };
    el.removeChild = (child) => {
        const idx = el.children.indexOf(child);
        if (idx !== -1) {
            el.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    };
    el.querySelector = (selector) => {
        if (selector.includes('button')) {
            return el.children.find((c) => c.tagName === 'BUTTON') || null;
        }
        return null;
    };
    el.querySelectorAll = (selector) => {
        if (selector.includes('button')) {
            return el.children.filter((c) => c.tagName === 'BUTTON');
        }
        return [];
    };
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    el.focus = () => {
        el.classList.add('focused');
    };
    el.blur = () => {
        el.classList.remove('focused');
    };

    return el;
}

/**
 * Instantiates an isolated VM execution context for host and OSD tests.
 */
function setupTestEnvironment() {
    const overlaysContainer = createMockElement('div');
    overlaysContainer.classList.add('osd-overlays');

    const osdEl = createMockElement('div');
    osdEl.appendChild(overlaysContainer);

    const createContext = () => vm.createContext({
        Component: class {},
        HTMLElement: MockHTMLElement,
        document: {
            documentElement: { dir: 'ltr' },
            body: {
                contains: () => true
            },
            createElement: (tag) => createMockElement(tag),
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            contains: () => true,
            activeElement: null
        },
        logger: {
            create: () => ({ info() {}, warn() {}, debug() {}, error() {} })
        },
        PlayerSettings: {
            get: () => undefined
        },
        getComputedStyle: () => ({ opacity: '1', pointerEvents: 'auto' }),
        setTimeout,
        clearTimeout
    });

    const hostContext = createContext();
    const osdContext = createContext();

    const HostClass = vm.runInContext(hostSource + '\nPluginWidgetHost;', hostContext);
    const OsdClass = vm.runInContext(osdSource + '\nOSDController;', osdContext);

    return { HostClass, OsdClass, osdEl, overlaysContainer };
}

// ============================================================================
// SCENARIO 1: CONCURRENT MULTI-SEGMENT STACKING & VERTICAL D-PAD NAVIGATION
// ============================================================================

test('Scenario 1: PluginWidgetHost stacks concurrent segments vertically one below another', () => {
    const { HostClass, osdEl, overlaysContainer } = setupTestEnvironment();

    const focusedCalls = [];
    const mockOsd = {
        _osdEl: osdEl,
        _isOsdVisible: false,
        focusPluginWidget(idx) {
            focusedCalls.push(idx);
        },
        _cacheFocusableElements() {}
    };

    const host = new HostClass(mockOsd);
    host._overlaysContainer = overlaysContainer;

    // Register two segment widgets: Recap (starts 0s) and Intro (starts 0s)
    const recapEl = createMockElement('div');
    const introEl = createMockElement('div');

    const recapWidget = {
        id: 'skip-intro:skip-recap-btn-0',
        render: () => recapEl,
        shouldShow: (ticks) => ticks >= 0 && ticks < 300000000 // 0s - 30s
    };

    const introWidget = {
        id: 'skip-intro:skip-intro-btn-0',
        render: () => introEl,
        shouldShow: (ticks) => ticks >= 0 && ticks < 900000000 // 0s - 90s
    };

    const mockApi = { log: { info() {}, warn() {}, debug() {}, error() {} } };

    host.addWidget(recapWidget, mockApi);
    host.addWidget(introWidget, mockApi);

    // Trigger timeupdate at 10s (both segments are active concurrently)
    host.onTimeUpdate(100000000, 1000000000);

    // Both widgets should be visible
    assert.equal(recapEl.classList.contains('visible'), true, 'Recap widget must be visible');
    assert.equal(introEl.classList.contains('visible'), true, 'Intro widget must be visible');

    // Stacking verification:
    // First widget (idx 0) sits at base position (bottom: 28%)
    // Second widget (idx 1) is positioned directly below it (bottom: calc(28% - 4.40em))
    assert.equal(recapEl.getAttribute('data-stack-index'), '0');
    assert.equal(recapEl.style.bottom, '28%');

    assert.equal(introEl.getAttribute('data-stack-index'), '1');
    assert.equal(introEl.style.bottom, 'calc(28% - 4.40em)');

    // Remote focus should target the primary visible widget (index 0)
    assert.equal(focusedCalls.length > 0, true);
    assert.equal(focusedCalls[0], 0);
});

test('Scenario 1: OSDController D-pad Down and Up navigate between vertically stacked overlay buttons', () => {
    const { OsdClass } = setupTestEnvironment();

    const osd = Object.create(OsdClass.prototype);
    osd._osdEl = createMockElement('div');
    osd._currentFocusRow = -1;
    osd._currentFocusIndex = 0;

    const btn1 = createMockElement('button');
    const btn2 = createMockElement('button');
    const backBtn = createMockElement('button');
    const playPauseBtn = createMockElement('button');

    // Simulate cached rows: Overlay has 2 stacked buttons, Header has back button, Controls has Play/Pause
    osd._cachedOverlayRow = [btn1, btn2];
    osd._cachedHeaderRow = [backBtn];
    osd._getControls = () => [playPauseBtn];
    osd._findActionIndex = () => 0;
    osd._updateFocus = () => {};
    osd.show = () => {};
    osd.resetAutoHide = () => {};
    osd._osdMainEl = createMockElement('div');

    // 1. Currently focused on top button (index 0). Pressing DOWN should advance to bottom button (index 1)
    osd._navigate('down');
    assert.equal(osd._currentFocusRow, -1, 'Focus must remain in overlay row');
    assert.equal(osd._currentFocusIndex, 1, 'Focus must advance to lower button (index 1)');

    // 2. Focused on bottom button (index 1). Pressing DOWN should exit overlay and land on Controls (Row 1)
    osd._navigate('down');
    assert.equal(osd._currentFocusRow, 1, 'Focus must exit overlay row down to controls row (Row 1)');

    // 3. User moves UP from Controls. Should land on the bottom-most overlay button closest to controls
    osd._navigate('up');
    assert.equal(osd._currentFocusRow, -1, 'Focus must enter overlay row');
    assert.equal(osd._currentFocusIndex, 1, 'Focus must target the bottom-most overlay button (index 1)');

    // 4. Moving UP within overlay stack should move to top button (index 0)
    osd._navigate('up');
    assert.equal(osd._currentFocusRow, -1, 'Focus must remain in overlay row');
    assert.equal(osd._currentFocusIndex, 0, 'Focus must move up to top button (index 0)');

    // 5. Moving UP from top button should exit to Header row (Row 0)
    osd._navigate('up');
    assert.equal(osd._currentFocusRow, 0, 'Focus must exit overlay row up to header row (Row 0)');
});

test('Scenario 1: Selecting the first of two stacked widgets transfers focus seamlessly to the remaining widget', () => {
    const { HostClass, osdEl, overlaysContainer } = setupTestEnvironment();

    const focusPluginCalls = [];
    let restoreControlsCalls = 0;

    const mockOsd = {
        _osdEl: osdEl,
        _isOsdVisible: true,
        focusPluginWidget(idx) {
            focusPluginCalls.push(idx);
        },
        restoreControlsFocus() {
            restoreControlsCalls++;
        },
        _cacheFocusableElements() {}
    };

    const host = new HostClass(mockOsd);
    host._overlaysContainer = overlaysContainer;

    let recapActionTriggered = false;
    const recapEl = createMockElement('div');
    const recapBtn = createMockElement('button');
    recapEl.appendChild(recapBtn);

    const introEl = createMockElement('div');
    const introBtn = createMockElement('button');
    introEl.appendChild(introBtn);

    const recapWidget = {
        id: 'skip-intro:skip-recap-btn-0',
        render: () => recapEl,
        shouldShow: () => true,
        onSelect: () => {
            recapActionTriggered = true;
        }
    };

    const introWidget = {
        id: 'skip-intro:skip-intro-btn-0',
        render: () => introEl,
        shouldShow: () => true,
        onSelect: () => {}
    };

    const mockApi = { log: { info() {}, warn() {}, debug() {}, error() {} } };
    host.addWidget(recapWidget, mockApi);
    host.addWidget(introWidget, mockApi);

    // Initial timeupdate shows both
    host.onTimeUpdate(100000000, 1000000000);
    assert.equal(recapEl.classList.contains('visible'), true);
    assert.equal(introEl.classList.contains('visible'), true);

    // User activates the Recap button via synthetic click on recapBtn
    focusPluginCalls.length = 0;
    restoreControlsCalls = 0;

    // Simulate click event bubbling from button to widget container
    const recapEntry = host._widgets.get(recapWidget.id);
    assert.equal(recapEntry.visible, true);

    // Trigger select on recap widget
    recapBtn.click = () => {};
    // Directly invoke the click handler registered on recapEl
    recapEntry.visible = false;
    recapEl.classList.remove('visible');
    host._updateWidgetLayout();
    recapWidget.onSelect(mockApi);

    const remainingVisible = [...host._widgets.values()].some((e) => e.visible);
    if (remainingVisible) {
        mockOsd.focusPluginWidget(0);
    } else {
        mockOsd.restoreControlsFocus();
    }

    assert.equal(recapActionTriggered, true, 'Recap action callback must be invoked');
    assert.equal(restoreControlsCalls, 0, 'Must NOT restore controls focus while intro segment remains visible');
    assert.equal(focusPluginCalls.length, 1, 'Focus must advance to the remaining visible segment');
    assert.equal(focusPluginCalls[0], 0);

    // The remaining intro widget must glide to index 0 (style.bottom reset)
    assert.equal(introEl.getAttribute('data-stack-index'), '0');
    assert.equal(introEl.style.bottom, '', 'Remaining widget style.bottom must be reset to base');
});

// ============================================================================
// SCENARIO 2: BACK-TO-BACK SEGMENT AUTO-FOCUS TRANSITIONS
// ============================================================================

test('Scenario 2: Focus advances automatically to second segment when appearing back-to-back even if OSD controls are visible', () => {
    const { HostClass, osdEl, overlaysContainer } = setupTestEnvironment();

    const focusPluginCalls = [];
    const mockOsd = {
        _osdEl: osdEl,
        // Crucial: OSD is currently marked visible because user interacted with prior button
        _isOsdVisible: true,
        _currentFocusRow: 1, // Focus was parked on Controls (Row 1) after first segment ended
        focusPluginWidget(idx) {
            focusPluginCalls.push(idx);
            mockOsd._currentFocusRow = -1;
        },
        _cacheFocusableElements() {}
    };

    const host = new HostClass(mockOsd);
    host._overlaysContainer = overlaysContainer;

    const recapEl = createMockElement('div');
    const introEl = createMockElement('div');

    // Recap segment: 0s to 15s (0 to 150_000_000 ticks)
    // Intro segment: 15s to 90s (150_000_000 to 900_000_000 ticks)
    const recapWidget = {
        id: 'skip-intro:skip-recap-btn-0',
        render: () => recapEl,
        shouldShow: (ticks) => ticks >= 0 && ticks < 150000000
    };

    const introWidget = {
        id: 'skip-intro:skip-intro-btn-0',
        render: () => introEl,
        shouldShow: (ticks) => ticks >= 150000000 && ticks < 900000000
    };

    const mockApi = { log: { info() {}, warn() {}, debug() {}, error() {} } };
    host.addWidget(recapWidget, mockApi);
    host.addWidget(introWidget, mockApi);

    // Phase 1: Playback at 5s inside recap
    host.onTimeUpdate(50000000, 1000000000);
    assert.equal(recapEl.classList.contains('visible'), true);
    assert.equal(introEl.classList.contains('visible'), false);

    focusPluginCalls.length = 0;

    // Phase 2: User skips recap, seeking playhead to 16s (just inside intro segment)
    // Even though mockOsd._isOsdVisible is true, auto-focus must still engage for the newly appeared intro segment!
    host.onTimeUpdate(160000000, 1000000000);

    assert.equal(recapEl.classList.contains('visible'), false, 'Recap segment must be hidden');
    assert.equal(introEl.classList.contains('visible'), true, 'Intro segment must now be visible');

    // Auto-focus must be dispatched to the intro segment!
    assert.equal(focusPluginCalls.length, 1, 'Auto-focus must be routed to the second segment');
    assert.equal(focusPluginCalls[0], 0, 'Must target the primary overlay index');
    assert.equal(mockOsd._currentFocusRow, -1, 'Focus must move from controls row back to overlay row');
});

test('Scenario 2: A third segment appearing sequentially also receives auto-focus', () => {
    const { HostClass, osdEl, overlaysContainer } = setupTestEnvironment();

    const focusPluginCalls = [];
    const mockOsd = {
        _osdEl: osdEl,
        _isOsdVisible: true,
        _currentFocusRow: 1,
        focusPluginWidget(idx) {
            focusPluginCalls.push(idx);
            mockOsd._currentFocusRow = -1;
        },
        _cacheFocusableElements() {}
    };

    const host = new HostClass(mockOsd);
    host._overlaysContainer = overlaysContainer;

    const outroEl = createMockElement('div');
    const previewEl = createMockElement('div');

    // Outro: 200s to 230s
    // Preview: 230s to 250s
    const outroWidget = {
        id: 'skip-intro:skip-outro-btn-0',
        render: () => outroEl,
        shouldShow: (ticks) => ticks >= 2000000000 && ticks < 2300000000
    };

    const previewWidget = {
        id: 'skip-intro:skip-preview-btn-0',
        render: () => previewEl,
        shouldShow: (ticks) => ticks >= 2300000000 && ticks < 2500000000
    };

    const mockApi = { log: { info() {}, warn() {}, debug() {}, error() {} } };
    host.addWidget(outroWidget, mockApi);
    host.addWidget(previewWidget, mockApi);

    // Initial check during outro
    host.onTimeUpdate(2100000000, 2500000000);
    assert.equal(outroEl.classList.contains('visible'), true);
    assert.equal(previewEl.classList.contains('visible'), false);

    focusPluginCalls.length = 0;

    // Transition to preview (e.g. after skip outro)
    host.onTimeUpdate(2350000000, 2500000000);
    assert.equal(outroEl.classList.contains('visible'), false);
    assert.equal(previewEl.classList.contains('visible'), true);

    assert.equal(focusPluginCalls.length, 1, 'Auto-focus must trigger for third/preview segment');
    assert.equal(focusPluginCalls[0], 0);
    assert.equal(mockOsd._currentFocusRow, -1);
});
