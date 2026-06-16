/**
 * ============================================================================
 * Litefin - PinDialog
 * ============================================================================
 * Modal numeric keypad for entering / setting a 4-digit profile PIN.
 *
 * Two modes:
 *   - 'verify': caller passes a userId; the dialog checks each completed entry
 *     against pinManager.verifyPin(). Wrong PIN shakes + clears; correct PIN
 *     closes the dialog and calls onSuccess().
 *   - 'set': two-step (enter, then confirm). On a matching confirm it closes
 *     and calls onSuccess(pin); a mismatch shakes and restarts at step 1.
 *
 * Input methods (both supported):
 *   - On-screen keypad navigated by D-pad (most TV smart remotes have no
 *     number pad). The keypad grid is a focusManager section.
 *   - Physical remote / keyboard number keys: a keydown listener accepts
 *     digit keycodes 48-57 and Backspace (8) while the dialog is open.
 *
 * Built on the same overlay/focus pattern as ExitDialog.js and reuses the
 * shared .modal-overlay / .settings-modal styles (see styles/pin-dialog.css
 * for the dots + keypad).
 * ============================================================================
 */

import { focusManager } from './FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { pinManager } from '../utils/PinManager.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('PinDialog');

const PIN_LENGTH = 4;
const SECTION = 'pin-dialog-keypad';

const BACKSPACE_SVG =
    '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m0 16H7.07L2.4 12l4.66-7H22zm-11.59-2L14 13.41L17.59 17L19 15.59L15.41 12L19 8.41L17.59 7L14 10.59L10.41 7L9 8.41L12.59 12L9 15.59z"/></svg>';

class PinDialog {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this.prevFocus = null;
        this.prevSection = null;

        // Per-show state
        this._mode = 'verify';
        this._userId = null;
        this._onSuccess = null;
        this._onCancel = null;

        // Entry state
        this._entered = '';
        this._step = 'enter'; // 'enter' | 'confirm' (set mode only)
        this._firstPin = '';

        this._onKeyDown = this._handleKeyDown.bind(this);
    }

    /**
     * Open the PIN dialog.
     * @param {Object} opts
     * @param {'verify'|'set'} opts.mode
     * @param {string} [opts.userId] - required for 'verify' mode
     * @param {string} [opts.title]
     * @param {Function} [opts.onSuccess] - (pin) => void; pin only meaningful in 'set' mode
     * @param {Function} [opts.onCancel]
     */
    show({ mode = 'verify', userId = null, title = null, onSuccess = null, onCancel = null } = {}) {
        if (this.isVisible) return;
        this.isVisible = true;

        this._mode = mode;
        this._userId = userId;
        this._onSuccess = onSuccess;
        this._onCancel = onCancel;
        this._entered = '';
        this._step = 'enter';
        this._firstPin = '';

        this.prevFocus = focusManager.getFocused();
        this.prevSection = focusManager.getActiveSection();

        this.overlay = document.createElement('div');
        this.overlay.id = 'pin-dialog';
        this.overlay.className = 'modal-overlay visible';
        document.body.appendChild(this.overlay);

        const heading = title || (mode === 'set' ? i18n.t('SetPin') || 'Set PIN' : i18n.t('EnterPin') || 'Enter PIN');

        this.overlay.innerHTML = `
            <div class="settings-modal pin-dialog-modal" role="dialog" aria-modal="true" aria-label="${heading}">
                <div class="modal-header">
                    <h2 id="pin-dialog-title">${heading}</h2>
                </div>
                <p class="pin-dialog-subtitle" id="pin-dialog-subtitle"></p>
                <div class="pin-dots" id="pin-dots">
                    ${Array.from({ length: PIN_LENGTH }, () => '<span class="pin-dot"></span>').join('')}
                </div>
                <div class="pin-keypad" id="pin-keypad">
                    ${[1, 2, 3, 4, 5, 6, 7, 8, 9]
                        .map((n) => `<button class="pin-key" data-digit="${n}" tabindex="0">${n}</button>`)
                        .join('')}
                    <button class="pin-key pin-key-empty" tabindex="-1" aria-hidden="true"></button>
                    <button class="pin-key" data-digit="0" tabindex="0">0</button>
                    <button class="pin-key pin-key-action" data-action="delete" tabindex="0"
                        aria-label="${i18n.t('Delete') || 'Delete'}">${BACKSPACE_SVG}</button>
                </div>
            </div>
        `;

        const keypad = this.overlay.querySelector('#pin-keypad');

        keypad.addEventListener('click', (e) => {
            const key = e.target.closest('.pin-key');
            if (!key) return;
            if (key.dataset.action === 'delete') {
                this._deleteDigit();
            } else if (key.dataset.digit !== undefined) {
                this._addDigit(key.dataset.digit);
            }
        });

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.close(true);
        };

        focusManager.register(SECTION, keypad, { orientation: 'grid', enterTo: 'first' });
        focusManager.setActiveSection(SECTION);

        // Physical number keys / keyboard digits — captured globally while open.
        document.addEventListener('keydown', this._onKeyDown, true);

        this._updateSubtitle();
        this._updateDots();
    }

    /**
     * @param {boolean} [cancelled=false] - whether this close is a cancel
     */
    close(cancelled = false) {
        if (!this.isVisible) return;
        this.isVisible = false;

        document.removeEventListener('keydown', this._onKeyDown, true);

        const onCancel = this._onCancel;
        this._onSuccess = null;
        this._onCancel = null;

        if (this.overlay) {
            this.overlay.classList.remove('visible');
            const overlay = this.overlay;
            setTimeout(() => {
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            this.overlay = null;
        }

        focusManager.unregister(SECTION);
        if (this.prevSection) focusManager.setActiveSection(this.prevSection, false);
        if (this.prevFocus) focusManager.focusElement(this.prevFocus);

        if (cancelled && typeof onCancel === 'function') onCancel();
    }

    // ========================================================================
    // Entry logic
    // ========================================================================

    _addDigit(digit) {
        if (this._entered.length >= PIN_LENGTH) return;
        this._entered += String(digit);
        this._updateDots();

        if (this._entered.length === PIN_LENGTH) {
            // Defer so the final dot paints before we act on it.
            setTimeout(() => this._onComplete(), 120);
        }
    }

    _deleteDigit() {
        if (this._entered.length === 0) return;
        this._entered = this._entered.slice(0, -1);
        this._updateDots();
    }

    _onComplete() {
        const pin = this._entered;

        if (this._mode === 'verify') {
            if (pinManager.verifyPin(this._userId, pin)) {
                const onSuccess = this._onSuccess;
                this.close(false);
                if (typeof onSuccess === 'function') onSuccess(pin);
            } else {
                this._rejectEntry(i18n.t('WrongPin') || 'Wrong PIN');
            }
            return;
        }

        // 'set' mode
        if (this._step === 'enter') {
            this._firstPin = pin;
            this._step = 'confirm';
            this._entered = '';
            this._updateSubtitle();
            this._updateDots();
        } else if (pin === this._firstPin) {
            const onSuccess = this._onSuccess;
            this.close(false);
            if (typeof onSuccess === 'function') onSuccess(pin);
        } else {
            // Mismatch — restart from step 1
            this._step = 'enter';
            this._firstPin = '';
            this._rejectEntry(i18n.t('PinMismatch') || 'PINs did not match');
        }
    }

    /**
     * Visually reject the current entry: show an error, shake, then clear.
     * @param {string} message
     */
    _rejectEntry(message) {
        log.info('PIN entry rejected');
        const dots = this.overlay && this.overlay.querySelector('#pin-dots');
        if (dots) {
            dots.classList.add('pin-error');
            setTimeout(() => dots.classList.remove('pin-error'), 500);
        }
        this._entered = '';
        this._updateSubtitle(message);
        this._updateDots();
    }

    // ========================================================================
    // Rendering helpers
    // ========================================================================

    _updateDots() {
        if (!this.overlay) return;
        const dots = this.overlay.querySelectorAll('.pin-dot');
        dots.forEach((dot, i) => dot.classList.toggle('filled', i < this._entered.length));
    }

    /**
     * @param {string} [errorMessage] - if provided, shown as an error line
     */
    _updateSubtitle(errorMessage) {
        if (!this.overlay) return;
        const sub = this.overlay.querySelector('#pin-dialog-subtitle');
        if (!sub) return;

        if (errorMessage) {
            sub.textContent = errorMessage;
            sub.classList.add('error');
            return;
        }

        sub.classList.remove('error');
        if (this._mode === 'set') {
            sub.textContent =
                this._step === 'confirm'
                    ? i18n.t('ConfirmPin') || 'Re-enter your PIN to confirm'
                    : i18n.t('EnterNewPin') || 'Enter a new 4-digit PIN';
        } else {
            sub.textContent = '';
        }
    }

    // ========================================================================
    // Keyboard / remote input
    // ========================================================================

    _handleKeyDown(e) {
        if (!this.isVisible) return;

        // Prefer KeyboardEvent.key — it's the most reliable across the various
        // TV engines (some remotes report keyCode 0 for number buttons).
        const key = e.key;
        if (key && key.length === 1 && key >= '0' && key <= '9') {
            this._addDigit(key);
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Fallback by keyCode: 48-57 (top row / remote num pad), 96-105 (numpad).
        const code = e.keyCode || e.which;
        if ((code >= 48 && code <= 57) || (code >= 96 && code <= 105)) {
            const digit = code >= 96 ? code - 96 : code - 48;
            this._addDigit(digit);
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        // Backspace — delete last digit
        if (key === 'Backspace' || code === 8) {
            this._deleteDigit();
            e.preventDefault();
            e.stopPropagation();
        }
        // Note: BACK / Escape is handled centrally by App.js (key:back) so it
        // composes with the rest of the app's back-navigation stack.
    }
}

export const pinDialog = new PinDialog();
export default PinDialog;
