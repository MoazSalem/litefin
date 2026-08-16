/**
 * ============================================================================
 * Litefin - Add to Target Modal (Playlist / Collection)
 * ============================================================================
 * Shared modal for adding items to a playlist or collection (BoxSet).
 * Two-page flow within a single overlay:
 *   Page 1 — Target selector + conditional fields (name, public) + actions
 *   Page 2 — Picker list of available targets
 *
 * Mode: 'playlist' | 'collection'
 * ============================================================================
 */

import { api } from '../api/ApiClient.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';
import { focusManager } from '../ui/FocusManager.js';

const log = logger.create('AddToTargetModal');

const MODE_CONFIG = {
    playlist: {
        title: 'AddToPlaylist',
        newLabel: 'NewPlaylist',
        targetLabel: 'Playlists',
        itemType: 'Playlist',
        hasPublicToggle: true,
        createApi: (name, isPublic, itemIds) => api.createPlaylist(name, isPublic, itemIds),
        addApi: (targetId, itemIds) => api.addToPlaylist(targetId, itemIds)
    },
    collection: {
        title: 'AddToCollection',
        newLabel: 'NewCollection',
        targetLabel: 'Collections',
        itemType: 'BoxSet',
        hasPublicToggle: false,
        createApi: (name, _isPublic, itemIds) => api.createCollection(name, itemIds),
        addApi: (targetId, itemIds) => api.addToCollection(targetId, itemIds)
    }
};

class AddToTargetModal {
    /**
     * Show the Add to Target modal.
     * @param {Object} detailsPage  - DetailsPage instance (for onBack hijack / focus)
     * @param {string|string[]} itemIds - Item ID(s) to add
     * @param {string} mode - 'playlist' or 'collection'
     * @param {Object} [transitionCtx] - Focus context from the more-options menu
     */
    static async show(detailsPage, itemIds, mode, transitionCtx = null) {
        this._detailsPage = detailsPage;
        this._itemIds = Array.isArray(itemIds) ? itemIds : [itemIds];
        this._mode = mode;
        this._cfg = MODE_CONFIG[mode];
        this._transitionCtx = transitionCtx;
        this._oldOnBack = transitionCtx?.oldOnBack || detailsPage.onBack;
        this._prevFocus = transitionCtx?.prevFocus || focusManager.getFocused();
        this._prevSection = transitionCtx?.prevSection || focusManager.getActiveSection();

        this._selectedTargetId = null; // null = "New"
        this._selectedTargetName = i18n.t(this._cfg.newLabel);
        this._targetName = '';
        this._isPublic = false;
        this._targets = [];

        let overlay = document.getElementById('add-to-target-modal');
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.id = 'add-to-target-modal';
        overlay.className = 'modal-overlay visible';
        document.body.appendChild(overlay);
        this._overlay = overlay;

        this._isPickerPage = false;

        const myOnBack = () => {
            if (this._isPickerPage) {
                this._returnToMain();
            } else if (this._transitionCtx?.fromMoreOptions) {
                detailsPage.onBack = this._oldOnBack;
                this._close(false);
                detailsPage._showMoreOptionsModal(detailsPage._itemId);
            } else {
                this._close(true);
            }
            return true;
        };
        detailsPage.onBack = myOnBack;

        this._renderMain();
    }

    static _renderMain() {
        const isNew = !this._selectedTargetId;
        const cfg = this._cfg;

        let fieldsHtml = '';
        if (isNew) {
            fieldsHtml = `
                <div class="modal-field-group">
                    <input type="text" id="att-name" class="text-input tv-input playlist-name-input"
                           value="${this._targetName}" placeholder="${i18n.t('LabelName') || 'Name'}" tabindex="0">
                </div>
            `;

            if (cfg.hasPublicToggle) {
                fieldsHtml += `
                    <button class="modal-option-btn check-btn ${this._isPublic ? 'selected' : ''}"
                            id="att-public-toggle" data-value="${this._isPublic}" tabindex="0">
                        <div class="checkbox-box">
                            <span class="check-mark">✔</span>
                        </div>
                        <span class="btn-label">${i18n.t('LabelPublic')}</span>
                    </button>
                `;
            }
        }

        this._overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t(cfg.title)}</h2>
                </div>
                <div class="modal-options">
                    <button class="modal-option-btn" id="att-target-selector" tabindex="0">
                        <span class="pe-selector-label">${i18n.t(cfg.targetLabel)}</span>
                        <span class="pe-selector-value" id="att-selected-name">${this._selectedTargetName}</span>
                        <span class="pe-chevron">›</span>
                    </button>
                    ${fieldsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn btn-add" id="att-btn-add" tabindex="0">${i18n.t('ButtonAdd')}</button>
                    <button class="modal-action-btn" id="att-btn-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        this._optionsSection = 'att-options';
        this._actionsSection = 'att-actions';

        const optionsEl = this._overlay.querySelector('.modal-options');
        const actionsEl = this._overlay.querySelector('.modal-actions');

        focusManager.unregister(this._optionsSection);
        focusManager.unregister(this._actionsSection);

        focusManager.register(this._optionsSection, optionsEl, {
            orientation: 'vertical',
            leaveDown: this._actionsSection,
            enterTo: 'first'
        });

        focusManager.register(this._actionsSection, actionsEl, {
            orientation: 'horizontal',
            leaveUp: this._optionsSection
        });

        focusManager.setActiveSection(this._optionsSection);

        const selector = this._overlay.querySelector('#att-target-selector');
        if (selector) {
            selector.onclick = (e) => {
                e.stopPropagation();
                this._showPicker();
            };
        }

        const toggle = this._overlay.querySelector('#att-public-toggle');
        if (toggle) {
            toggle.onclick = (e) => {
                e.stopPropagation();
                const nameInput = this._overlay.querySelector('#att-name');
                if (nameInput) this._targetName = nameInput.value;
                this._isPublic = !this._isPublic;
                this._renderMain();
            };
        }

        const addBtn = this._overlay.querySelector('#att-btn-add');
        if (addBtn) {
            addBtn.onclick = (e) => {
                e.stopPropagation();
                this._submit();
            };
        }

        const cancelBtn = this._overlay.querySelector('#att-btn-cancel');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                this._close(true);
            };
        }

        this._overlay.onclick = (e) => {
            if (e.target === this._overlay) this._close(true);
        };
    }

    static async _showPicker() {
        const cfg = this._cfg;

        if (this._targets.length === 0) {
            try {
                const response = await api.getItems({
                    IncludeItemTypes: cfg.itemType,
                    Recursive: true,
                    Limit: 200,
                    Fields: ''
                });
                this._targets = response.Items || [];
            } catch (e) {
                log.error(`Failed to fetch ${cfg.itemType} targets`, e);
            }
        }

        const oldSection = this._optionsSection;

        const newBtn = `
            <button class="modal-option-btn ${!this._selectedTargetId ? 'selected' : ''}" data-id="" tabindex="0">
                <span>${i18n.t(cfg.newLabel)}</span>
            </button>
        `;

        const targetBtns = this._targets
            .map(
                (t) => `
                <button class="modal-option-btn ${this._selectedTargetId === t.Id ? 'selected' : ''}" data-id="${t.Id}" tabindex="0">
                    <span>${t.Name}</span>
                </button>
            `
            )
            .join('');

        const optionsHtml = newBtn + targetBtns;

        this._overlay.innerHTML = `
            <div class="settings-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2>${i18n.t(cfg.targetLabel)}</h2>
                </div>
                <div class="modal-options">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button class="modal-action-btn" id="att-btn-picker-back" tabindex="0">${i18n.t('ButtonBack')}</button>
                    <button class="modal-action-btn" id="att-btn-picker-cancel" tabindex="0">${i18n.t('ButtonCancel')}</button>
                </div>
            </div>
        `;

        this._isPickerPage = true;
        this._pickerOptionsSection = 'att-picker-options';
        this._pickerActionsSection = 'att-picker-actions';

        const optionsEl = this._overlay.querySelector('.modal-options');
        const actionsEl = this._overlay.querySelector('.modal-actions');

        focusManager.unregister(oldSection);
        focusManager.unregister(this._actionsSection);

        focusManager.register(this._pickerOptionsSection, optionsEl, {
            orientation: 'vertical',
            leaveDown: this._pickerActionsSection,
            enterTo: 'first'
        });

        focusManager.register(this._pickerActionsSection, actionsEl, {
            orientation: 'horizontal',
            leaveUp: this._pickerOptionsSection
        });

        focusManager.setActiveSection(this._pickerOptionsSection);

        this._overlay.querySelectorAll('.modal-option-btn').forEach((btn) => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const tId = btn.dataset.id;
                if (!tId) {
                    this._selectedTargetId = null;
                    this._selectedTargetName = i18n.t(cfg.newLabel);
                } else {
                    const target = this._targets.find((t) => t.Id === tId);
                    if (target) {
                        this._selectedTargetId = target.Id;
                        this._selectedTargetName = target.Name;
                    }
                }
                this._returnToMain();
            };
        });

        const backBtn = this._overlay.querySelector('#att-btn-picker-back');
        if (backBtn) {
            backBtn.onclick = (e) => {
                e.stopPropagation();
                this._returnToMain();
            };
        }

        const cancelBtn = this._overlay.querySelector('#att-btn-picker-cancel');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                this._close(true);
            };
        }

        this._overlay.onclick = (e) => {
            if (e.target === this._overlay) this._close(true);
        };
    }

    static _returnToMain() {
        focusManager.unregister(this._pickerOptionsSection);
        focusManager.unregister(this._pickerActionsSection);
        this._pickerOptionsSection = null;
        this._pickerActionsSection = null;

        this._isPickerPage = false;
        this._renderMain();
    }

    static async _submit() {
        const cfg = this._cfg;
        let targetId = this._selectedTargetId;

        try {
            if (!targetId) {
                const nameInput = this._overlay.querySelector('#att-name');
                const name = nameInput ? nameInput.value.trim() : this._targetName;
                if (!name) {
                    log.warn('Target name is required');
                    if (nameInput) nameInput.focus();
                    return;
                }

                const result = await cfg.createApi(name, this._isPublic, this._itemIds);
                targetId = result.Id;
                log.info(`Created ${this._mode} "${name}" (${targetId}) and added items`);
            } else {
                await cfg.addApi(targetId, this._itemIds);
                log.info(`Added items to ${this._mode} ${targetId}`);
            }
        } catch (e) {
            log.error(`Failed to save to ${this._mode}`, e);
            return;
        }

        this._close(true);
    }

    static _close(restoreFocus = true) {
        if (!this._overlay) return;

        this._overlay.classList.remove('visible');

        focusManager.unregister(this._optionsSection);
        focusManager.unregister(this._actionsSection);
        if (this._pickerOptionsSection) focusManager.unregister(this._pickerOptionsSection);
        if (this._pickerActionsSection) focusManager.unregister(this._pickerActionsSection);

        const dp = this._detailsPage;
        if (dp) {
            dp.onBack = this._oldOnBack;
        }

        setTimeout(() => {
            if (this._overlay) this._overlay.remove();
            this._overlay = null;
        }, 300);

        if (restoreFocus) {
            if (this._prevSection) focusManager.setActiveSection(this._prevSection, false);
            if (this._prevFocus) focusManager.focusElement(this._prevFocus);
        }

        this._detailsPage = null;
        this._transitionCtx = null;
    }
}

export default AddToTargetModal;
