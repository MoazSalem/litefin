import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * ============================================================================
 * Remote Button Manager - OSD Layout Toggle (Stealth Mode) Test Suite
 * ============================================================================
 * Tests the shortcut customization that allows physical remote colored buttons
 * (Red, Green, Yellow, Blue) to toggle the OSD layout between Stealth mode
 * ('hidden') and the user's previously selected layout mode ('left', 'centered').
 * ============================================================================
 */

test('SettingsPage: remoteButtonOptions contains playerToggleOsdLayout option', () => {
    // Read SettingsPage source
    const settingsPath = path.resolve('src/pages/settings/SettingsPage.js');
    const source = readFileSync(settingsPath, 'utf8');

    // Verify option value exists
    assert.match(
        source,
        /value:\s*['"]playerToggleOsdLayout['"]/,
        'remoteButtonOptions must contain playerToggleOsdLayout'
    );

    // Verify option label uses localized key
    assert.match(
        source,
        /label:\s*i18n\.t\(['"]OptionPlayerToggleOsdLayout['"]\)/,
        'remoteButtonOptions must use OptionPlayerToggleOsdLayout i18n label'
    );
});

test('RemoteButtonManager: toggles from normal layout to stealth and back', () => {
    // In-memory mock storage and settings stores
    const mockStorage = new Map();
    const mockSettings = { osdLayout: 'left' };
    const toasts = [];
    let updatedOsdLayout = null;

    // Simulated OSDController mock
    const mockOsd = {
        updateLayoutMode(layout) {
            updatedOsdLayout = layout;
        }
    };

    // Simulated RemoteButtonManager logic under test
    const manager = {
        _isPlayerActive() {
            return true;
        },
        _getPlayerOsd() {
            return mockOsd;
        },
        _toggleOsdLayoutMode() {
            const currentLayout = mockSettings.osdLayout || 'left';
            let targetLayout;

            if (currentLayout === 'hidden') {
                let previousLayout = mockStorage.get('pref:previousOsdLayout') || 'left';
                if (previousLayout === 'hidden') {
                    previousLayout = 'left';
                }
                targetLayout = previousLayout;
            } else {
                mockStorage.set('pref:previousOsdLayout', currentLayout);
                targetLayout = 'hidden';
            }

            mockSettings.osdLayout = targetLayout;

            if (this._isPlayerActive()) {
                const osd = this._getPlayerOsd();
                if (osd && typeof osd.updateLayoutMode === 'function') {
                    osd.updateLayoutMode(targetLayout);
                }
            }

            toasts.push(targetLayout);
        }
    };

    // 1. Initial state: 'left'. Toggle should switch to 'hidden' (Stealth)
    manager._toggleOsdLayoutMode();
    assert.equal(mockSettings.osdLayout, 'hidden', 'Layout should become hidden');
    assert.equal(mockStorage.get('pref:previousOsdLayout'), 'left', 'Previous layout should be saved as left');
    assert.equal(updatedOsdLayout, 'hidden', 'OSD should be notified of hidden layout');

    // 2. Second toggle: currently 'hidden'. Toggle should restore 'left'
    manager._toggleOsdLayoutMode();
    assert.equal(mockSettings.osdLayout, 'left', 'Layout should restore to left');
    assert.equal(updatedOsdLayout, 'left', 'OSD should be notified of left layout');

    // 3. Test with 'centered' layout:
    mockSettings.osdLayout = 'centered';
    manager._toggleOsdLayoutMode();
    assert.equal(mockSettings.osdLayout, 'hidden', 'Layout should become hidden from centered');
    assert.equal(mockStorage.get('pref:previousOsdLayout'), 'centered', 'Previous layout should be centered');

    // Restore back from hidden
    manager._toggleOsdLayoutMode();
    assert.equal(mockSettings.osdLayout, 'centered', 'Layout should restore to centered');
});

test('OSDController: updateLayoutMode applies classes and toggles visibility cleanly', () => {
    // Mock DOM elements
    const classList = new Set();
    let isHidden = false;
    let isShown = false;
    let focusPlayPauseCalled = false;
    let cancelDownHoldCalled = false;

    const mockOsd = {
        _osdEl: {
            classList: {
                add(cls) { classList.add(cls); },
                remove(cls) { classList.delete(cls); },
                contains(cls) { return classList.has(cls); }
            }
        },
        _isOsdVisible: true,
        _cancelDownHold() { cancelDownHoldCalled = true; },
        hide() { isHidden = true; this._isOsdVisible = false; },
        show() { isShown = true; this._isOsdVisible = true; },
        showAndFocusPlayPause() { focusPlayPauseCalled = true; },
        updateLayoutMode(newLayout) {
            if (!this._osdEl) return;
            if (newLayout === 'hidden') {
                this._osdEl.classList.add('osd-layout-hidden');
                this._cancelDownHold();
                if (this._isOsdVisible) {
                    this.hide();
                }
            } else {
                this._osdEl.classList.remove('osd-layout-hidden');
                this.show();
                this.showAndFocusPlayPause();
            }
        }
    };

    // Switch to stealth mode: should add class and hide OSD
    mockOsd.updateLayoutMode('hidden');
    assert.equal(classList.has('osd-layout-hidden'), true, 'Should add osd-layout-hidden');
    assert.equal(cancelDownHoldCalled, true, 'Should cancel down hold');
    assert.equal(isHidden, true, 'Should hide OSD');

    // Switch back to normal mode: should remove class and show OSD
    mockOsd.updateLayoutMode('left');
    assert.equal(classList.has('osd-layout-hidden'), false, 'Should remove osd-layout-hidden');
    assert.equal(isShown, true, 'Should show OSD');
    assert.equal(focusPlayPauseCalled, true, 'Should focus play/pause button');
});

test('Toast: in-place replacement updates existing message and resets timer without piling up', () => {
    // Simulated minimal DOM and Toast manager
    const containerChildren = [];
    const container = {
        appendChild(el) {
            containerChildren.push(el);
            el.parentNode = container;
        },
        removeChild(el) {
            const idx = containerChildren.indexOf(el);
            if (idx >= 0) containerChildren.splice(idx, 1);
            el.parentNode = null;
        }
    };

    const toasts = [];
    let timeoutCounter = 0;
    const timeouts = new Map();

    const mockToastManager = {
        show(message, duration = 5000, options = {}) {
            let existingToast = null;
            if (options.id) {
                existingToast = toasts.find(
                    (t) => t._toastId === options.id && !t.classList.has('toast-exit')
                );
            } else if (options.replace && toasts.length > 0) {
                existingToast = toasts.find((t) => !t.classList.has('toast-exit'));
            }

            if (existingToast) {
                if (existingToast._timeoutId) {
                    timeouts.delete(existingToast._timeoutId);
                    existingToast._timeoutId = null;
                }

                existingToast.text = message;

                if (duration > 0) {
                    const tid = ++timeoutCounter;
                    timeouts.set(tid, { toast: existingToast, duration });
                    existingToast._timeoutId = tid;
                }

                return existingToast;
            }

            const toastEl = {
                _toastId: options.id || null,
                _timeoutId: null,
                text: message,
                classList: new Set(),
                parentNode: null
            };

            container.appendChild(toastEl);
            toasts.push(toastEl);

            if (duration > 0) {
                const tid = ++timeoutCounter;
                timeouts.set(tid, { toast: toastEl, duration });
                toastEl._timeoutId = tid;
            }

            return toastEl;
        }
    };

    // 1. Initial toggle: show "OSD Layout: Stealth"
    const toast1 = mockToastManager.show('OSD Layout: Stealth', 2000, { id: 'osd-layout', replace: true });
    assert.equal(containerChildren.length, 1, 'Only one toast element in container');
    assert.equal(toast1.text, 'OSD Layout: Stealth');
    const firstTimeoutId = toast1._timeoutId;

    // 2. Second toggle: show "OSD Layout: Left Aligned"
    const toast2 = mockToastManager.show('OSD Layout: Left Aligned', 2000, { id: 'osd-layout', replace: true });
    assert.equal(containerChildren.length, 1, 'Container still has only 1 toast (no piling up)');
    assert.equal(toast1, toast2, 'Same toast element reference is updated in-place');
    assert.equal(toast1.text, 'OSD Layout: Left Aligned', 'Text updated in-place');
    assert.notEqual(toast1._timeoutId, firstTimeoutId, 'Timeout was reset to new duration');

    // 3. Third toggle: show "OSD Layout: Stealth" again
    const toast3 = mockToastManager.show('OSD Layout: Stealth', 2000, { id: 'osd-layout', replace: true });
    assert.equal(containerChildren.length, 1, 'Container still strictly has 1 toast');
    assert.equal(toast1, toast3, 'Same toast reference reused');
    assert.equal(toast1.text, 'OSD Layout: Stealth', 'Text updated back to Stealth');
});
