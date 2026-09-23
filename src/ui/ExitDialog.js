import { focusManager } from './FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { tizenAdapter } from '../tizen/TizenAdapter.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('ExitDialog');

class ExitDialog {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
    }

    show() {
        if (this.isVisible) return;
        this.isVisible = true;

        this.overlay = document.createElement('div');
        this.overlay.id = 'exit-dialog';
        this.overlay.className = 'modal-overlay visible';
        document.body.appendChild(this.overlay);

        this.overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('ConfirmAppExitTitle') || 'Exit Application?'}">
                <div class="modal-header">
                    <h2>${i18n.t('ConfirmAppExitTitle') || 'Exit Application?'}</h2>
                </div>
                <div class="modal-content" style="padding: 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('ConfirmAppExitMessage') || 'Are you sure you want to exit Litefin?'}
                </div>
                <div class="modal-actions" id="exit-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="exit-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="exit-dialog-yes" tabindex="0">
                        ${i18n.t('ButtonYes') || 'Yes'}
                    </button>
                </div>
            </div>
        `;

        /*
         * Focus Trap Enforcement
         * ------------------------------------------------------------------------
         * Use pushTrap() to capture previous focus/section and lock navigation into
         * the modal dialog. Crucially, FocusManager's focusElement() ignores external
         * focus requests (such as asynchronous HomePage row render callbacks) while
         * a trap is active. This prevents the HomePage render pipeline from stealing
         * focus away from the exit dialog when the user rapidly presses Back.
         *
         * Initial Focus:
         * We set defaultFocusSelector to '#exit-dialog-yes' so the user lands on the
         * Exit ("Yes") button by default for quick app exit.
         * ------------------------------------------------------------------------
         */
        focusManager.pushTrap(this.overlay.querySelector('#exit-dialog-actions'), {
            orientation: 'horizontal',
            defaultFocusSelector: '#exit-dialog-yes' // Focus Exit ("Yes") by default
        });

        this.overlay.querySelector('#exit-dialog-no').onclick = (e) => {
            e.stopPropagation();
            this.close();
        };

        this.overlay.querySelector('#exit-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            log.info('User confirmed exit via dialog.');
            if (platformInfo.isWebOS) {
                webosAdapter.exit();
            } else {
                tizenAdapter.exit();
            }
        };

        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) this.close();
        };
    }

    close() {
        if (!this.isVisible) return;
        this.isVisible = false;

        // Immediately disarm and blur all modal action buttons.
        // During the 300ms CSS fadeout, the overlay remains in the DOM;
        // if buttons retain tabindex="0", native browser focus or synthetic
        // focusin events can latch onto them right before DOM removal,
        // which would leave FocusManager stranded on a detached element.
        if (this.overlay) {
            this.overlay.classList.remove('visible');
            this.overlay.style.pointerEvents = 'none';
            this.overlay.setAttribute('aria-hidden', 'true');

            // Find all buttons or focusables inside the modal
            const actionButtons = this.overlay.querySelectorAll('button, [tabindex]');
            actionButtons.forEach((btn) => {
                btn.setAttribute('tabindex', '-1');
                btn.setAttribute('disabled', 'true');
                if (typeof btn.blur === 'function') {
                    btn.blur();
                }
            });
        }

        // Clean up DOM node after transition finishes
        const closingOverlay = this.overlay;
        setTimeout(() => {
            if (closingOverlay && closingOverlay.parentNode) {
                closingOverlay.parentNode.removeChild(closingOverlay);
            }
            if (this.overlay === closingOverlay) {
                this.overlay = null;
            }
        }, 300);

        /*
         * Release the focus trap and restore focus/section back to what was active
         * prior to showing the exit dialog.
         */
        focusManager.popTrap();
    }
}

export const exitDialog = new ExitDialog();
