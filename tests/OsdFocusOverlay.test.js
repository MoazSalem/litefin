import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/*
 * ============================================================================
 * OSD FOCUS / OVERLAY RESOLUTION REGRESSION TESTS
 * ============================================================================
 * Covers the two overlay-OK routing helpers added to OSDController:
 *   - _getFocusedOverlayElement()
 *   - _getHighlightedSkipPrompt()
 *
 * Follows the established OSD test pattern (see tests/SkipIconsDynamic.test.js
 * and tests/TimelineSeek.test.js): the browser-level imports are stripped, the
 * class is evaluated inside a `vm` context with a few tiny globals, and the
 * instance is built with Object.create(OSD.prototype). No real DOM, no network
 * and no timers are involved - everything is deterministic.
 * ============================================================================
 */

// Load OSDController source stripped of browser-level imports
const osdSource = readFileSync(new URL('../src/player/osd/OSDController.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class OSDController', 'class OSDController');

/*
 * Build a bare OSDController instance inside an isolated vm context.
 * `getComputedStyleImpl` is injected as the vm global used by
 * _getHighlightedSkipPrompt(); when omitted, elements may carry a
 * `computedStyle` object that is returned verbatim.
 */
function createOsd(getComputedStyleImpl) {
    const context = vm.createContext({
        Component: class {},
        document: {
            addEventListener() {},
            removeEventListener() {},
            getElementById() {
                return null;
            },
            querySelector() {
                return null;
            },
            /* Stands in for Node.contains(): true only for nodes flagged as in-document. */
            contains(el) {
                return !!(el && el.inDoc === true);
            }
        },
        logger: {
            create: () => ({ info() {}, error() {}, warn() {}, debug() {} })
        },
        PlayerSettings: {
            get: () => undefined
        },
        getComputedStyle: getComputedStyleImpl || ((el) => (el && el.computedStyle) || { opacity: '1', pointerEvents: 'auto' })
    });

    const OSD = vm.runInContext(osdSource + '\nOSDController;', context);
    return Object.create(OSD.prototype);
}

/* ---------------------------------------------------------------------------
 * _getFocusedOverlayElement()
 * ------------------------------------------------------------------------- */

test('OSDController: _getFocusedOverlayElement returns the cached element at the focus index', () => {
    const osd = createOsd();
    const first = { id: 'first' };
    const second = { id: 'second' };
    osd._cachedOverlayRow = [first, second];

    osd._currentFocusIndex = 0;
    assert.equal(osd._getFocusedOverlayElement(), first);

    osd._currentFocusIndex = 1;
    assert.equal(osd._getFocusedOverlayElement(), second);
});

test('OSDController: _getFocusedOverlayElement clamps an out-of-range index to the last cached element', () => {
    const osd = createOsd();
    const only = { id: 'only' };
    osd._cachedOverlayRow = [only];
    // The stored index comes from the (wider) controls row and must not escape
    // the single-button overlay row.
    osd._currentFocusIndex = 2;
    assert.equal(osd._getFocusedOverlayElement(), only);

    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    osd._cachedOverlayRow = [a, b, c];
    osd._currentFocusIndex = 42;
    assert.equal(osd._getFocusedOverlayElement(), c);
});

test('OSDController: _getFocusedOverlayElement falls back to _getFocused() for an empty overlay row', () => {
    const osd = createOsd();
    const fallback = { id: 'focused' };
    let calls = 0;
    osd._getFocused = () => {
        calls++;
        return fallback;
    };
    osd._cachedOverlayRow = [];
    osd._currentFocusIndex = 2;

    let result;
    assert.doesNotThrow(() => {
        result = osd._getFocusedOverlayElement();
    });
    assert.equal(result, fallback);
    assert.equal(calls, 1);
});

test('OSDController: _getFocusedOverlayElement never performs a negative-index lookup when the row is empty', () => {
    const osd = createOsd();
    const fallback = { id: 'fallback' };
    osd._getFocused = () => fallback;

    // A Proxy records every negative numeric index the helper touches.
    const negativeReads = [];
    const emptyRow = new Proxy([], {
        get(target, prop) {
            if (typeof prop === 'string' && /^-\d+$/.test(prop)) negativeReads.push(prop);
            return target[prop];
        }
    });
    osd._cachedOverlayRow = emptyRow;
    osd._currentFocusIndex = 3; // clamps to index 0, never to -1

    assert.equal(osd._getFocusedOverlayElement(), fallback);
    assert.deepEqual(negativeReads, []);
});

test('OSDController: _getFocusedOverlayElement delegates to the real DOM _getFocused() lookup for an empty row', () => {
    const osd = createOsd();
    const domFocused = { id: 'dom-focused' };
    osd._osdEl = {
        querySelector: (selector) => (selector === '.focused' ? domFocused : null)
    };
    osd._cachedOverlayRow = [];
    osd._currentFocusIndex = 0;

    assert.equal(osd._getFocusedOverlayElement(), domFocused);
});

/* ---------------------------------------------------------------------------
 * _isConnected()
 *
 * Chromium 38 (webOS 3.x / Ultra-Legacy) has no Element.isConnected, so the
 * helper has to fall back to document.contains() there - otherwise the overlay
 * click guards never pass and OK toggles playback instead of the prompt.
 * ------------------------------------------------------------------------- */

test('OSDController: _isConnected uses the native property when the engine has it', () => {
    const osd = createOsd();
    assert.equal(osd._isConnected({ isConnected: true }), true);
    assert.equal(osd._isConnected({ isConnected: false, inDoc: true }), false);
});

test('OSDController: _isConnected falls back to document.contains without Element.isConnected', () => {
    const osd = createOsd();
    assert.equal(osd._isConnected({ inDoc: true }), true);
    assert.equal(osd._isConnected({ inDoc: false }), false);
});

test('OSDController: _isConnected is false for a missing element', () => {
    const osd = createOsd();
    assert.equal(osd._isConnected(null), false);
    assert.equal(osd._isConnected(undefined), false);
});

/* ---------------------------------------------------------------------------
 * _getHighlightedSkipPrompt()
 * ------------------------------------------------------------------------- */

// Minimal fake for `.osd-overlays .plugin-widget.visible` plus its CTA.
function makeWidget(cta, computedStyle) {
    return {
        computedStyle,
        querySelector: (selector) => (selector === '.skip-intro-btn.focused' ? cta : null)
    };
}

// Minimal fake for the OSD root: resolves only the visible plugin widget.
function makeOsdRoot(widget) {
    return {
        querySelector: (selector) => (selector === '.osd-overlays .plugin-widget.visible' ? widget : null)
    };
}

test('OSDController: _getHighlightedSkipPrompt returns the focused button of an on-screen widget', () => {
    const styleCalls = [];
    const osd = createOsd((el) => {
        styleCalls.push(el);
        return el.computedStyle;
    });
    const cta = { id: 'skip-intro-cta' };
    const widget = makeWidget(cta, { opacity: '1', pointerEvents: 'auto' });
    osd._osdEl = makeOsdRoot(widget);

    assert.equal(osd._getHighlightedSkipPrompt(), cta);
    assert.equal(styleCalls.length, 1);
    assert.equal(styleCalls[0], widget);
});

for (const [label, style] of [
    ['transparent widget (opacity: 0)', { opacity: '0', pointerEvents: 'auto' }],
    ['non-interactive widget (pointer-events: none)', { opacity: '1', pointerEvents: 'none' }]
]) {
    test(`OSDController: _getHighlightedSkipPrompt returns null for a ${label}`, () => {
        const osd = createOsd((el) => el.computedStyle);
        const cta = { id: 'skip-intro-cta' };
        const widget = makeWidget(cta, style);
        osd._osdEl = makeOsdRoot(widget);

        assert.equal(osd._getHighlightedSkipPrompt(), null);
    });
}

test('OSDController: _getHighlightedSkipPrompt returns null when the widget has no focused button', () => {
    const styleCalls = [];
    const osd = createOsd((el) => {
        styleCalls.push(el);
        return el.computedStyle;
    });
    const widget = makeWidget(null, { opacity: '1', pointerEvents: 'auto' });
    osd._osdEl = makeOsdRoot(widget);

    assert.equal(osd._getHighlightedSkipPrompt(), null);
    // The style check must be short-circuited when there is no highlighted CTA.
    assert.equal(styleCalls.length, 0);
});

test('OSDController: _getHighlightedSkipPrompt returns null when no widget is present in the DOM', () => {
    const styleCalls = [];
    const osd = createOsd((el) => {
        styleCalls.push(el);
        return el.computedStyle;
    });
    osd._osdEl = makeOsdRoot(null);

    assert.equal(osd._getHighlightedSkipPrompt(), null);
    assert.equal(styleCalls.length, 0);
});
