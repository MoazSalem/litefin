/**
 * ============================================================================
 * Litefin Tizen - Backup & Restore Tab Controller
 * ============================================================================
 * Manages Jellyfin companion server settings synchronization, multi-device
 * configuration snapshots, user-specific preference isolation, cloud backups,
 * profile reset, and complete factory restore workflows.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { platformInfo } from '../../../utils/PlatformInfo.js';
import { PlayerSettings } from '../../../utils/PlayerSettings.js';
import { api } from '../../../api/index.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { BackupModals } from '../modals/BackupModals.js';

const log = logger.create('BackupTab');

/**
 * Sensitive storage keys excluded from cloud settings snapshots.
 */
const EXCLUDED_BACKUP_KEYS = [
    'litefin:serverUrl', 'litefin:deviceId', 'litefin:activeUserId',
    'litefin:serverSessions', 'litefin:sessions', 'litefin:serverNames',
    'litefin:accessToken', 'litefin:userId', 'app_platform'
];

/**
 * Helper to serialize current application preferences into a JSON string.
 */
function serializeBackupPayload() {
    const backupData = {};
    for (const key of storage.keys()) {
        if (!EXCLUDED_BACKUP_KEYS.includes(key) && !key.startsWith('serverPlugin:available:') && !key.startsWith('litefin:user_settings_')) {
            const value = storage.getItem(key);
            if (value !== null) backupData[key] = value;
        }
    }
    return JSON.stringify(backupData);
}

/**
 * Controller for Settings Backup, Restore, and Configuration Reset.
 */
export class BackupTab {
    constructor(pageContext) {
        this.page = pageContext;
        this.modals = new BackupModals(pageContext);
        this.backupsList = [];
        this._selectedBackupId = 'new';
        this._listeners = [];
    }

    render() {
        const isPerUser = storage.getItem('litefin:settings_per_user') === 'true';
        return `
            <div class="settings-tab-content" id="backup-tab-content">
                <h2 class="content-title" data-i18n="BackupRestore">${i18n.t('BackupRestore') || 'Backup & Restore'}</h2>
                <p class="content-subtitle" data-i18n="BackupDescription">${i18n.t('BackupDescription') || 'Synchronize your application settings and preferences across all your devices by backing them up to your Jellyfin server.'}</p>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelSettingsPerUser">${i18n.t('LabelSettingsPerUser') || 'Settings Per User'}</span><span class="setting-description" data-i18n="SettingsPerUserDescription">${i18n.t('SettingsPerUserDescription') || 'Store distinct settings and preferences for each logged-in user profile.'}</span></div>
                    <div class="setting-control"><button class="toggle-switch ${isPerUser ? 'active' : ''}" id="toggle-settings-per-user" tabindex="0"></button></div>
                </div>

                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name" id="backup-select-label">${i18n.t('SelectedBackup') || 'Selected Backup'}</span><span class="setting-description" id="backup-status-message">${i18n.t('CheckingBackupStatus') || 'Checking server for settings backup...'}</span></div>
                    <div class="setting-control" id="backup-select-container"><span style="opacity: 0.6;">${i18n.t('LoadingStatus') || 'Checking server for settings backup...'}</span></div>
                </div>

                <div class="setting-item" id="setting-item-backup-name" style="display: none; margin-top: 20px;">
                    <div class="setting-label"><span class="setting-name">${i18n.t('BackupName') || 'Backup Name (Optional)'}</span><span class="setting-description">Provide a custom label to easily distinguish this backup.</span></div>
                    <div class="setting-control"><input id="input-backup-name" type="text" class="focusable" tabindex="0" data-focusable="true" placeholder="e.g. Living Room TV" style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 1rem; width: 250px;"/></div>
                </div>

                <div id="backup-actions-container"></div>

                ${isPerUser ? `
                <div class="setting-item" style="margin-top: 40px; border-top: 1px solid var(--jf-divider); padding-top: 40px;">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelResetUserToGlobal">${i18n.t('LabelResetUserToGlobal') || 'Reset Profile Settings to Global'}</span><span class="setting-description" data-i18n="LabelResetUserToGlobalDescription">${i18n.t('LabelResetUserToGlobalDescription') || 'Discard all custom settings for this profile and copy the current global settings.'}</span></div>
                    <div class="setting-control"><button class="btn btn-secondary btn-small focusable" id="btn-reset-user-to-global" tabindex="0" data-focusable="true">${i18n.t('ButtonResetToGlobal') || 'Reset to Global'}</button></div>
                </div>` : ''}

                <div class="setting-item" style="${isPerUser ? 'margin-top: 20px;' : 'margin-top: 40px; border-top: 1px solid var(--jf-divider); padding-top: 40px;'}">
                    <div class="setting-label"><span class="setting-name" data-i18n="LabelResetSettings">${i18n.t('LabelResetSettings') || 'Reset All Settings'}</span><span class="setting-description" data-i18n="LabelResetSettingsDescription">${i18n.t('LabelResetSettingsDescription') || 'Restore all application and player settings to their default values. This will not sign you out.'}</span></div>
                    <div class="setting-control"><button class="btn btn-danger btn-small focusable" id="btn-reset-settings" tabindex="0" data-focusable="true">${i18n.t('ButtonResetAll') || 'Reset All'}</button></div>
                </div>
            </div>
        `;
    }

    mount(root) {
        if (!root) return;
        const addListener = (selector, event, handler) => {
            const el = root.querySelector(selector);
            if (el) { el.addEventListener(event, handler); this._listeners.push({ el, event, handler }); }
        };

        addListener('#toggle-settings-per-user', 'click', () => {
            const toggle = root.querySelector('#toggle-settings-per-user');
            if (!toggle) return;
            const nextVal = storage.getItem('litefin:settings_per_user') !== 'true';
            storage.setItem('litefin:settings_per_user', nextVal.toString());
            toggle.classList.toggle('active', nextVal);
            log.info(`Settings Per User set to: ${nextVal}`);
            this._triggerHardReload();
        });

        addListener('#btn-reset-user-to-global', 'click', () => {
            this.modals.showResetUserToGlobalConfirmation(() => this.handleResetUserToGlobal());
        });

        addListener('#btn-reset-settings', 'click', () => {
            this.modals.showResetConfirmation(() => this.handleResetAll());
        });

        this.updateBackupStatusDisplay(root);
    }

    _triggerHardReload() {
        if (this.page && typeof this.page._triggerHardReload === 'function') {
            this.page._triggerHardReload();
        } else {
            window.location.reload();
        }
    }

    async _sendBackup(payload) {
        return api.post('/Litefin/Backup', {
            Settings: serializeBackupPayload(),
            DeviceId: api.deviceId,
            DeviceName: api.deviceName || 'Web Client',
            AppVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0',
            Platform: platformInfo.platformString || 'web',
            ...payload
        });
    }

    async updateBackupStatusDisplay(root) {
        const target = root || (this.page ? this.page.element : null) || document;
        const msgEl = target.querySelector('#backup-status-message');
        if (!msgEl) return;

        try {
            msgEl.innerText = i18n.t('CheckingBackupStatus') || 'Checking server for settings backup...';
            if (!(await api.isLitefinPluginAvailable(true))) {
                msgEl.innerText = i18n.t('BackupPluginError') || 'Server backup plugin is not available. Please ensure the Litefin backup plugin is installed on your Jellyfin server.';
                const sc = target.querySelector('#backup-select-container');
                const ac = target.querySelector('#backup-actions-container');
                if (sc) sc.innerHTML = '';
                if (ac) ac.innerHTML = '';
                return;
            }

            const backups = await api.get('/Litefin/Backup');
            this.backupsList = (backups || []).sort((a, b) => new Date(b.DateCreated) - new Date(a.DateCreated));
            msgEl.innerText = this.backupsList.length > 0 ? `Found ${this.backupsList.length} settings backup(s) on the server.` : (i18n.t('NoBackupFound') || 'No settings backup found on the server.');

            if (!this._selectedBackupId) this._selectedBackupId = 'new';
            this.updateBackupTabUI(target);
        } catch (error) {
            log.error('Failed to get backups list:', error);
            msgEl.innerText = i18n.t('BackupPluginError') || 'Server backup plugin is not available. Please ensure the Litefin backup plugin is installed on your Jellyfin server.';
            const sc = target.querySelector('#backup-select-container');
            const ac = target.querySelector('#backup-actions-container');
            if (sc) sc.innerHTML = '';
            if (ac) ac.innerHTML = '';
        }
    }

    updateBackupTabUI(root) {
        const target = root || (this.page ? this.page.element : null) || document;
        const selectContainer = target.querySelector('#backup-select-container');
        const actionsContainer = target.querySelector('#backup-actions-container');
        const nameInputContainer = target.querySelector('#setting-item-backup-name');
        if (!selectContainer || !actionsContainer) return;

        const currentSelectedVal = this._selectedBackupId || 'new';
        const options = [{ value: 'new', label: i18n.t('NewBackup') || 'Create New Backup' }];
        const backups = this.backupsList || [];

        backups.forEach((b) => {
            const d = new Date(b.DateCreated);
            const dateStr = `${d.toLocaleDateString()}, ${i18n.formatLocalTime(d)}`;
            const device = b.DeviceName || 'Unknown Device';
            const platformMap = { web: 'Web', tizen: 'Tizen', webos: 'WebOS' };
            const infoSuffix = b.Platform ? `${dateStr}, ${platformMap[b.Platform] || b.Platform}` : dateStr;
            const isFallback = !b.Name || b.Name.trim() === '' || b.Name.startsWith(device);
            options.push({ value: b.Id, label: isFallback ? `${device} - ${b.Username} (${infoSuffix})` : `${b.Name} - ${b.Username} (${infoSuffix})` });
        });

        if (this.page && typeof this.page._renderDropdown === 'function') {
            selectContainer.innerHTML = this.page._renderDropdown('litefin-backup-select', options, currentSelectedVal);
        }

        const selectBtn = selectContainer.querySelector('.select-btn');
        if (selectBtn) {
            selectBtn.onclick = () => {
                if (this.page && typeof this.page._renderSelectionModal === 'function') {
                    this.page._renderSelectionModal(i18n.t('SelectBackup') || 'Select Backup', options, currentSelectedVal, (val) => {
                        this._selectedBackupId = val;
                        this.updateBackupTabUI(target);
                        setTimeout(() => {
                            const btn = target.querySelector('#litefin-backup-select-btn');
                            if (btn) focusManager.focusElement(btn);
                        }, 50);
                    });
                }
            };
        }

        if (currentSelectedVal === 'new') {
            if (nameInputContainer) nameInputContainer.style.display = '';
            actionsContainer.innerHTML = `
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name">${i18n.t('LabelBackUp') || 'Back Up App Settings'}</span><span class="setting-description">${i18n.t('BackUpNowDescription') || 'Uploads your current preferences and player settings to the Jellyfin server.'}</span></div>
                    <div class="setting-control"><button class="btn btn-primary btn-small focusable" id="btn-backup-now" tabindex="0" data-focusable="true">${i18n.t('ButtonBackUp') || 'Back Up Now'}</button></div>
                </div>
            `;
            const btn = actionsContainer.querySelector('#btn-backup-now');
            if (btn) btn.onclick = () => this.handleBackupNow(target);
        } else {
            if (nameInputContainer) nameInputContainer.style.display = 'none';
            const selectedBackup = backups.find((b) => b.Id === currentSelectedVal);
            if (!selectedBackup) { this._selectedBackupId = 'new'; this.updateBackupTabUI(target); return; }

            const isOwner = selectedBackup.UserId === api.userId;
            actionsContainer.innerHTML = `
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name">${i18n.t('LabelRestore') || 'Restore App Settings'}</span><span class="setting-description">${i18n.t('RestoreSettingsDescription') || 'Restore settings from the server backup and reload the application.'}</span></div>
                    <div class="setting-control"><button class="btn btn-secondary btn-small focusable" id="btn-restore-now" tabindex="0" data-focusable="true">${i18n.t('ButtonRestore') || 'Restore Settings'}</button></div>
                </div>
                ${isOwner ? `
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name">Overwrite Backup</span><span class="setting-description">Update this backup snapshot with your current device settings.</span></div>
                    <div class="setting-control"><button class="btn btn-secondary btn-small focusable" id="btn-overwrite-now" tabindex="0" data-focusable="true">${i18n.t('Overwrite') || 'Overwrite'}</button></div>
                </div>
                <div class="setting-item">
                    <div class="setting-label"><span class="setting-name">${i18n.t('LabelDelete') || 'Delete Backup'}</span><span class="setting-description">${i18n.t('DeleteBackupDescription') || 'Completely remove the settings backup from the Jellyfin server.'}</span></div>
                    <div class="setting-control"><button class="btn btn-danger btn-small focusable" id="btn-delete-backup" tabindex="0" data-focusable="true">${i18n.t('ButtonDelete') || 'Delete'}</button></div>
                </div>` : ''}
            `;

            const btnRestore = actionsContainer.querySelector('#btn-restore-now');
            const btnOverwrite = actionsContainer.querySelector('#btn-overwrite-now');
            const btnDelete = actionsContainer.querySelector('#btn-delete-backup');

            if (btnRestore) btnRestore.onclick = () => this.modals.showRestoreConfirmation(selectedBackup, (rec) => this.handleRestoreNow(rec));
            if (btnOverwrite && isOwner) btnOverwrite.onclick = () => this.modals.showOverwriteConfirmation(selectedBackup, (rec) => this.handleOverwriteBackup(rec, target));
            if (btnDelete && isOwner) btnDelete.onclick = () => this.modals.showDeleteBackupConfirmation(selectedBackup, (rec) => this.handleDeleteBackup(rec, target));
        }

        focusManager.invalidateCache('settings-content');
        if (this.page && typeof this.page._setupFocus === 'function') this.page._setupFocus();
    }

    async handleBackupNow(root) {
        const target = root || (this.page ? this.page.element : null) || document;
        const btn = target.querySelector('#btn-backup-now');
        const origText = btn ? btn.innerText : 'Back Up Now';
        if (btn) { btn.innerText = i18n.t('BackingUp') || 'Backing Up...'; btn.disabled = true; }

        try {
            const inputNameEl = target.querySelector('#input-backup-name');
            const customName = inputNameEl ? inputNameEl.value.trim() : '';

            await this._sendBackup({ Name: customName });
            if (inputNameEl) inputNameEl.value = '';
            await this.updateBackupStatusDisplay(target);
            if (this.backupsList && this.backupsList.length > 0) {
                this._selectedBackupId = this.backupsList[0].Id;
                this.updateBackupTabUI(target);
            }
        } catch (error) {
            log.error('Backup failed:', error);
            const msgEl = target.querySelector('#backup-status-message');
            if (msgEl) msgEl.innerText = i18n.t('BackupFailed') || 'Backup failed. Please verify plugin connectivity.';
        } finally {
            if (btn) { btn.innerText = origText; btn.disabled = false; }
        }
    }

    async handleOverwriteBackup(backupRecord, root) {
        const target = root || (this.page ? this.page.element : null) || document;
        const btn = target.querySelector('#btn-overwrite-now');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

        try {
            await this._sendBackup({ Id: backupRecord.Id, Name: backupRecord.Name });
            await this.updateBackupStatusDisplay(target);
        } catch (error) {
            log.error('Overwrite backup failed:', error);
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        }
    }

    async handleRestoreNow(backupRecord) {
        if (!backupRecord || !backupRecord.Settings) return;

        try {
            const restoredData = JSON.parse(backupRecord.Settings);
            PlayerSettings.resetAll();
            storage.clearByPrefix('pref:');
            storage.removeItem('app_language');
            storage.removeItem('layout_direction');
            storage.removeItem('image_preset');
            storage.removeItem('image_details_preset');

            const keysToClear = storage.keys().filter((k) => k.startsWith('litefin:') && !EXCLUDED_BACKUP_KEYS.includes(k) && !k.startsWith('litefin:user_settings_'));
            for (const key of keysToClear) storage.removeItem(key);

            for (const [key, value] of Object.entries(restoredData)) storage.setItem(key, value);
            this._triggerHardReload();
        } catch (error) {
            log.error('Restore failed:', error);
        }
    }

    async handleDeleteBackup(backupRecord, root) {
        const target = root || (this.page ? this.page.element : null) || document;
        try {
            await api.delete(`/Litefin/Backup/${backupRecord.Id}`);
            this._selectedBackupId = 'new';
            await this.updateBackupStatusDisplay(target);
        } catch (error) {
            log.error('Delete backup failed:', error);
        }
    }

    handleResetUserToGlobal() {
        const activeUserId = storage.getItem('litefin:activeUserId');
        if (activeUserId) {
            storage.removeItem(`litefin:user_settings_${activeUserId}`);
            storage.setItem('litefin:skip_profiles_once', 'true');
            storage.flush();
            this._triggerHardReload();
        }
    }

    handleResetAll() {
        PlayerSettings.resetAll();
        storage.clearByPrefix('pref:');
        storage.clearByPrefix('litefin:');
        storage.removeItem('app_language');
        storage.removeItem('layout_direction');
        storage.removeItem('image_preset');
        storage.removeItem('image_details_preset');
        storage.clearByPrefix('debug_');
        this._triggerHardReload();
    }

    destroy() {
        this._listeners.forEach(({ el, event, handler }) => {
            if (el && typeof el.removeEventListener === 'function') {
                el.removeEventListener(event, handler);
            }
        });
        this._listeners = [];
    }
}

export default BackupTab;
