import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

/*
 * ============================================================================
 * UP NEXT FOCUS RETENTION REGRESSION TESTS
 * ============================================================================
 * Verifies that when the Up Next popup dialog is visible:
 * 1. restoreControlsFocus() does not pull focus away to Row 1 (Play/Pause)
 * 2. hide() does not park focus to Play/Pause or seekbar
 * 3. _resetFocusToPlayPause() and _resetFocusToSeekbar() guard against clobbering focus
 * 4. UpNextDialog.handleKey('enter') executes the active button directly
 * ============================================================================
 */

// Load OSDController source stripped of browser imports
const osdSource = readFileSync(new URL('../src/player/osd/OSDController.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class OSDController', 'class OSDController');

// Load UpNextDialog source stripped of browser imports
const upNextSource = readFileSync(new URL('../src/player/osd/UpNextDialog.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class UpNextDialog extends BaseMenu', 'class UpNextDialog extends BaseMenu');

function createOsd(settings = {}) {
    const context = vm.createContext({
        Component: class {},
        BaseMenu: class {
            constructor(osd) {
                this.osd = osd;
                this.isVisible = false;
                this.isModal = false;
            }
            show() { this.isVisible = true; }
            hide() { this.isVisible = false; }
            updateFocus() {}
            handleKey() { return false; }
        },
        document: {
            documentElement: { dir: 'ltr' },
            addEventListener() {},
            removeEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            contains() { return true; }
        },
        logger: {
            create: () => ({ info() {}, error() {}, warn() {}, debug() {} })
        },
        PlayerSettings: {
            get: (key) => settings[key]
        },
        i18n: {
            t: (k) => k
        },
        detailsIcons: {
            ratingStar: ''
        },
        shouldShowScore: () => false,
        getComputedStyle: () => ({ opacity: '1', pointerEvents: 'auto' })
    });

    const OSD = vm.runInContext(osdSource + '\nOSDController;', context);
    const UpNext = vm.runInContext(upNextSource + '\nUpNextDialog;', context);

    const osd = Object.create(OSD.prototype);
    osd._osdEl = {
        classList: { add() {}, remove() {} },
        querySelectorAll: () => [],
        querySelector: () => null
    };
    osd._osdMainEl = {
        classList: { add() {}, remove() {} }
    };
    osd._cachedOverlayRow = [];
    osd._cachedHeaderRow = [];
    osd._currentFocusRow = -1;
    osd._currentFocusIndex = 0;
    osd._updateFocus = () => {};
    osd._clearSeekState = () => {};
    osd._cancelDownHold = () => {};
    osd._stopUpdates = () => {};
    osd._findActionIndex = (action) => (action === 'togglePlay' ? 2 : -1);

    const upNextDialog = Object.create(UpNext.prototype);
    upNextDialog.osd = osd;
    upNextDialog.isVisible = true;
    upNextDialog._focusedButton = 0;
    upNextDialog.$el = null;

    osd.upNextDialog = upNextDialog;
    return { osd, upNextDialog, UpNext };
}

test('restoreControlsFocus retains focus in Row -1 when UpNextDialog is visible', () => {
    const { osd, upNextDialog } = createOsd();
    const playBtn = { id: 'playBtn' };
    const hideBtn = { id: 'hideBtn' };
    osd._cachedOverlayRow = [playBtn, hideBtn];

    upNextDialog.$el = {
        querySelectorAll: (sel) => (sel === '.upnext-btn' ? [playBtn, hideBtn] : [])
    };
    upNextDialog._focusedButton = 0;
    osd._currentFocusRow = -1;
    osd._currentFocusIndex = 0;

    let updateFocusCalled = false;
    osd._updateFocus = () => { updateFocusCalled = true; };

    // When widgets hide, restoreControlsFocus is called
    osd.restoreControlsFocus();

    // Must NOT switch to row 1 (Controls)
    assert.equal(osd._currentFocusRow, -1);
    assert.equal(osd._currentFocusIndex, 0);
    assert.equal(updateFocusCalled, true);
});

test('hide() does not park focus to Play/Pause or seekbar when UpNextDialog is visible', () => {
    // Mode is 'always'
    const { osd } = createOsd({ osdFocusRestoreMode: 'always' });
    osd._currentFocusRow = -1;

    let parkCalled = false;
    osd._resetFocusToPlayPause = () => { parkCalled = true; };
    osd._resetFocusToSeekbar = () => { parkCalled = true; };

    osd.hide();

    assert.equal(parkCalled, false);
    assert.equal(osd._currentFocusRow, -1);
});

test('hide() does not park focus to seekbar in seekbar mode when UpNextDialog is visible', () => {
    const { osd } = createOsd({ osdFocusRestoreMode: 'seekbar' });
    osd._currentFocusRow = -1;

    let seekbarParkCalled = false;
    osd._resetFocusToSeekbar = () => { seekbarParkCalled = true; };

    osd.hide();

    assert.equal(seekbarParkCalled, false);
    assert.equal(osd._currentFocusRow, -1);
});

test('_resetFocusToPlayPause and _resetFocusToSeekbar are no-ops when UpNextDialog is visible', () => {
    const { osd } = createOsd();
    osd._currentFocusRow = -1;

    osd._resetFocusToPlayPause();
    assert.equal(osd._currentFocusRow, -1);

    osd._resetFocusToSeekbar();
    assert.equal(osd._currentFocusRow, -1);
});

test('UpNextDialog handleKey(enter) triggers click on focused button', () => {
    const { upNextDialog } = createOsd();
    let clicked = false;
    const playBtn = {
        click: () => { clicked = true; }
    };
    upNextDialog.$el = {
        querySelectorAll: () => [playBtn]
    };
    upNextDialog._focusedButton = 0;

    const handled = upNextDialog.handleKey('enter');
    assert.equal(handled, true);
    assert.equal(clicked, true);
});
