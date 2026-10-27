/**
 * ============================================================================
 * Litefin Tizen - Backup Modals Controller
 * ============================================================================
 * Houses accessible confirmation dialogs for destructive settings actions:
 * snapshot overwrite, preference restoration, server backup deletion,
 * system-wide factory reset, and profile-to-global synchronization.
 * ============================================================================
 */

import { focusManager } from '../../../ui/FocusManager.js';
import { i18n } from '../../../utils/i18n.js';

/**
 * Controller managing modal dialog interactions for settings backups.
 */
export class BackupModals {
    /**
     * Creates an instance of BackupModals.
     * @param {Object} pageContext Parent SettingsPage context
     */
    constructor(pageContext) {
        // Retain parent page context for spatial focus integration
        this.page = pageContext;
    }

    /**
     * Displays confirmation dialog before overwriting an existing server backup snapshot.
     * @param {Object} backupRecord Selected backup payload
     * @param {Function} onConfirm Callback when user confirms overwrite
     */
    showOverwriteConfirmation(backupRecord, onConfirm) {
        // Cache previous focus targets to restore state on modal dismiss
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        // Construct modal overlay container
        const overlay = document.createElement('div');
        overlay.id = 'overwrite-backup-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('Overwrite') || 'Overwrite'}">
                <div class="modal-header">
                    <h2>${i18n.t('Overwrite') || 'Overwrite Backup'}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    Are you sure you want to overwrite this backup snapshot? This will replace the stored settings with your current preferences.
                </div>
                <div class="modal-actions" id="overwrite-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="overwrite-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="overwrite-dialog-yes" tabindex="0">
                        ${i18n.t('Overwrite') || 'Overwrite'}
                    </button>
                </div>
            </div>
        `;

        // Teardown handler returning focus safely to background surface
        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('overwrite-dialog-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        // Register modal actions section with focus manager
        focusManager.register('overwrite-dialog-actions', overlay.querySelector('#overwrite-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });
        focusManager.setActiveSection('overwrite-dialog-actions');

        // Cancel button click
        overlay.querySelector('#overwrite-dialog-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        // Confirm overwrite button click
        overlay.querySelector('#overwrite-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
            if (typeof onConfirm === 'function') {
                onConfirm(backupRecord);
            }
        };

        // Click outside modal backdrop to dismiss
        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }

    /**
     * Displays confirmation dialog before overwriting active preferences with a backup.
     * @param {Object} backupRecord Selected backup payload
     * @param {Function} onConfirm Callback when user confirms restore
     */
    showRestoreConfirmation(backupRecord, onConfirm) {
        // Cache previous focus state
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        // Construct modal overlay container
        const overlay = document.createElement('div');
        overlay.id = 'restore-settings-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('RestoreSettings') || 'Restore Settings'}">
                <div class="modal-header">
                    <h2>${i18n.t('RestoreSettings') || 'Restore Settings'}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('RestoreSettingsWarning') || 'Restoring settings will overwrite all your current preferences. The app will reload to apply the changes. Do you want to continue?'}
                </div>
                <div class="modal-actions" id="restore-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="restore-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="restore-dialog-yes" tabindex="0">
                        ${i18n.t('Restore') || 'Restore'}
                    </button>
                </div>
            </div>
        `;

        // Teardown handler restoring focus
        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('restore-dialog-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        // Register actions section defaulting cursor to safe Cancel button
        focusManager.register('restore-dialog-actions', overlay.querySelector('#restore-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });
        focusManager.setActiveSection('restore-dialog-actions');

        overlay.querySelector('#restore-dialog-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        overlay.querySelector('#restore-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
            if (typeof onConfirm === 'function') {
                onConfirm(backupRecord);
            }
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }

    /**
     * Displays deletion warning prompt before purging backup snapshot from server.
     * @param {Object} backupRecord Selected backup payload
     * @param {Function} onConfirm Callback when user confirms deletion
     */
    showDeleteBackupConfirmation(backupRecord, onConfirm) {
        // Cache previous focus state
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        const overlay = document.createElement('div');
        overlay.id = 'delete-backup-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('DeleteBackup') || 'Delete Backup'}">
                <div class="modal-header">
                    <h2>${i18n.t('DeleteBackup') || 'Delete Backup'}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('DeleteBackupWarning') || 'Are you sure you want to permanently delete your settings backup from the server?'}
                </div>
                <div class="modal-actions" id="delete-backup-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="delete-backup-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="delete-backup-yes" tabindex="0">
                        ${i18n.t('Delete') || 'Delete'}
                    </button>
                </div>
            </div>
        `;

        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('delete-backup-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        focusManager.register('delete-backup-actions', overlay.querySelector('#delete-backup-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });
        focusManager.setActiveSection('delete-backup-actions');

        overlay.querySelector('#delete-backup-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        overlay.querySelector('#delete-backup-yes').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
            if (typeof onConfirm === 'function') {
                onConfirm(backupRecord);
            }
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }

    /**
     * Show a confirmation dialog before wiping all app and player preferences.
     * @param {Function} onConfirm Callback when user confirms complete reset
     */
    showResetConfirmation(onConfirm) {
        // Cache focus targets
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        const overlay = document.createElement('div');
        overlay.id = 'reset-settings-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('LabelResetSettings')}">
                <div class="modal-header">
                    <h2>${i18n.t('LabelResetSettings')}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('ResetSettingsWarning')}
                </div>
                <div class="modal-actions" id="reset-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="reset-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="reset-dialog-yes" tabindex="0">
                        ${i18n.t('ButtonResetAll') || 'Reset All'}
                    </button>
                </div>
            </div>
        `;

        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('reset-dialog-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        focusManager.register('reset-dialog-actions', overlay.querySelector('#reset-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });
        focusManager.setActiveSection('reset-dialog-actions');

        overlay.querySelector('#reset-dialog-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        overlay.querySelector('#reset-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
            if (typeof onConfirm === 'function') {
                onConfirm();
            }
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }

    /**
     * Show a confirmation dialog before resetting current profile settings to global defaults.
     * @param {Function} onConfirm Callback when user confirms profile reset
     */
    showResetUserToGlobalConfirmation(onConfirm) {
        // Cache focus targets
        const prevFocus = focusManager.getFocused();
        const prevSection = focusManager.getActiveSection();

        const overlay = document.createElement('div');
        overlay.id = 'reset-user-to-global-dialog';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);

        overlay.innerHTML = `
            <div class="settings-modal exit-dialog-modal" role="dialog" aria-modal="true" aria-label="${i18n.t('LabelResetUserToGlobal')}">
                <div class="modal-header">
                    <h2>${i18n.t('LabelResetUserToGlobal')}</h2>
                </div>
                <div class="modal-content" style="padding: 0 24px 24px; color: var(--text-color); font-size: 1.1rem; text-align: center;">
                    ${i18n.t('ResetUserToGlobalWarning')}
                </div>
                <div class="modal-actions" id="reset-user-dialog-actions" style="margin-top: 0; justify-content: center; gap: 16px;">
                    <button class="modal-action-btn" id="reset-user-dialog-no" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button class="modal-action-btn danger-btn" id="reset-user-dialog-yes" tabindex="0">
                        ${i18n.t('ButtonResetToGlobal') || 'Reset to Global'}
                    </button>
                </div>
            </div>
        `;

        const closeDialog = () => {
            overlay.classList.remove('visible');
            setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            focusManager.unregister('reset-user-dialog-actions');
            if (prevSection) focusManager.setActiveSection(prevSection, false);
            if (prevFocus) focusManager.focusElement(prevFocus);
        };

        focusManager.register('reset-user-dialog-actions', overlay.querySelector('#reset-user-dialog-actions'), {
            orientation: 'horizontal',
            enterTo: 'first'
        });
        focusManager.setActiveSection('reset-user-dialog-actions');

        overlay.querySelector('#reset-user-dialog-no').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
        };

        overlay.querySelector('#reset-user-dialog-yes').onclick = (e) => {
            e.stopPropagation();
            closeDialog();
            if (typeof onConfirm === 'function') {
                onConfirm();
            }
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) closeDialog();
        };
    }
}

export default BackupModals;
