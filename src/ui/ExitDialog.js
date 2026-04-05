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
        this.prevFocus = null;
        this.prevSection = null;
    }

    show() {
        if (this.isVisible) return;
        this.isVisible = true;

        this.prevFocus = focusManager.getFocused();
        this.prevSection = focusManager.getActiveSection();

        this.overlay = document.createElement('div');
        this.overlay.id = 'exit-dialog';
        this.overlay.className = 'modal-overlay visible';
        document.body.appendChild(this.overlay);

        this.overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('ConfirmAppExitTitle') || 'Exit Application?'}">
                <div class="modal-header">
                    <h2>${i18n.t('ConfirmAppExitTitle') || 'Exit Application?'}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
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

        focusManager.register('exit-dialog-actions', this.overlay.querySelector('#exit-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first' // Focus Cancel safely
        });

        focusManager.setActiveSection('exit-dialog-actions');

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

        this.overlay.classList.remove('visible');
        setTimeout(() => {
            if (this.overlay && this.overlay.parentNode) {
                this.overlay.parentNode.removeChild(this.overlay);
            }
            this.overlay = null;
        }, 300);

        focusManager.unregister('exit-dialog-actions');

        if (this.prevSection) focusManager.setActiveSection(this.prevSection, false);
        if (this.prevFocus) focusManager.focusElement(this.prevFocus);
    }
}

export const exitDialog = new ExitDialog();
