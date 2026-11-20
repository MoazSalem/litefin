/**
 * ============================================================================
 * Litefin - CustomHeadersDialog
 * ============================================================================
 * Lightweight modal dialog for configuring reverse proxy HTTP authentication
 * headers (Cloudflare Zero Trust / Access, Pangolin, Authelia, Traefik, etc.).
 *
 * Optimized specifically for low-spec Smart TV runtimes:
 *   - Zero backdrop-filter blur effects to prevent GPU/compositor stalls.
 *   - Zero box-shadows for fast hardware rasterization.
 *   - Flat, solid high-contrast backgrounds with clear focus rings.
 *   - Spatial navigation lock via FocusManager trap enforcement.
 *   - Quick-preset insertion for Cloudflare and Pangolin tokens.
 * ============================================================================
 */

import { focusManager } from './FocusManager.js';
import { i18n } from '../utils/i18n.js';
import { customHeaders, HEADER_PRESETS } from '../utils/CustomHeaders.js';
import { logger } from '../utils/Logger.js';
import { escapeHtml } from '../utils/Utils.js';
import { eventBus } from '../core/EventBus.js';

const log = logger.create('CustomHeadersDialog');

class CustomHeadersDialog {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this._serverUrl = '';
        this._headers = [];
        this._onSave = null;
        this._onCancel = null;
        this._boundOnBack = null;
    }

    /**
     * Opens the Custom Headers configuration dialog.
     *
     * @param {Object} options
     * @param {string} options.serverUrl - Target server address
     * @param {Array<Object>} [options.existingHeaders] - Pre-populated header items
     * @param {Function} [options.onSave] - Callback executed with saved headers
     * @param {Function} [options.onCancel] - Callback executed on dismissal
     */
    show(options = {}) {
        if (this.isVisible) return;
        this.isVisible = true;

        this._serverUrl = options.serverUrl || '';
        this._onSave = options.onSave || null;
        this._onCancel = options.onCancel || null;

        // Clone existing headers or load stored headers for this server address
        if (Array.isArray(options.existingHeaders) && options.existingHeaders.length > 0) {
            this._headers = JSON.parse(JSON.stringify(options.existingHeaders));
        } else if (this._serverUrl) {
            const stored = customHeaders.getServerHeaders(this._serverUrl);
            this._headers = JSON.parse(JSON.stringify(stored));
        } else {
            this._headers = [];
        }

        // Build DOM structure
        this.overlay = document.createElement('div');
        this.overlay.id = 'custom-headers-dialog-overlay';
        this.overlay.className = 'modal-overlay visible custom-headers-overlay';
        document.body.appendChild(this.overlay);

        this._renderDialog();

        // Listen for hardware remote Back button
        this._boundOnBack = () => {
            if (this.isVisible) {
                if (typeof this._onCancel === 'function') {
                    this._onCancel();
                }
                this.close();
            }
        };
        eventBus.on('key:back', this._boundOnBack);
    }

    /**
     * Renders or re-renders the dialog template and binds focus traps.
     * @private
     */
    _renderDialog() {
        if (!this.overlay) return;

        this.overlay.innerHTML = `
            <div class="settings-modal custom-headers-modal" role="dialog" aria-modal="true" aria-label="Custom HTTP Headers">
                <!-- Dialog Title -->
                <div class="modal-header custom-headers-dialog-header">
                    <h2>${i18n.t('CustomHttpHeadersTitle') || 'Custom HTTP Headers'}</h2>
                </div>

                <!-- Presets Quick Bar and Add Row Action -->
                <div class="custom-headers-toolbar" id="custom-headers-presets-bar">
                    <div class="custom-headers-presets-group">
                        <span class="custom-headers-presets-label">${i18n.t('Presets') || 'Presets'}:</span>
                        <button type="button" class="preset-pill-btn" id="preset-cf-btn" tabindex="0">
                            + Cloudflare Zero Trust
                        </button>
                        <button type="button" class="preset-pill-btn" id="preset-pangolin-btn" tabindex="0">
                            + Pangolin
                        </button>
                    </div>
                    <button type="button" class="add-header-action-btn" id="add-header-btn" tabindex="0">
                        <span class="add-header-plus">+</span>
                        <span>${i18n.t('AddCustomHeader') || 'Add Header'}</span>
                    </button>
                </div>

                <!-- Column Header Labels for Television Readability -->
                <div class="custom-headers-col-headers">
                    <span class="col-head col-head-key">Header Name</span>
                    <span class="col-head col-head-val">Header Value</span>
                    <span class="col-head col-head-toggle">Status</span>
                    <span class="col-head col-head-delete">Remove</span>
                </div>

                <!-- Headers List Container -->
                <div class="modal-content custom-headers-content" id="custom-headers-list-container">
                    ${this._renderHeadersList()}
                </div>

                <!-- Unified Modal Actions Footer -->
                <div class="modal-actions" id="custom-headers-actions">
                    <button type="button" class="modal-action-btn close" id="custom-headers-cancel-btn" tabindex="0">
                        ${i18n.t('ButtonCancel') || 'Cancel'}
                    </button>
                    <button type="button" class="modal-action-btn apply" id="custom-headers-save-btn" tabindex="0">
                        ${i18n.t('Save') || 'Save'}
                    </button>
                </div>
            </div>
        `;

        this._bindEvents();
        this._bindRowInputs();
        this._setupFocusTrap();
    }

    /**
     * Generates HTML markup for the configured header rows.
     * Includes clear placeholders, status indicators, and delete actions.
     * Starts inputs in read-only mode for smooth D-pad spatial navigation.
     *
     * @private
     * @returns {string} HTML string
     */
    _renderHeadersList() {
        if (!this._headers || this._headers.length === 0) {
            return `
                <div class="custom-headers-empty">
                    ${i18n.t('NoCustomHeadersConfigured') || 'No custom headers configured. Use a preset above or click Add Header to start.'}
                </div>
            `;
        }

        return this._headers
            .map((item, index) => {
                const keyVal = escapeHtml(item.key || '');
                const valVal = escapeHtml(item.value || '');
                const isEnabled = item.enabled !== false;
                const toggleText = isEnabled ? i18n.t('Enabled') || 'Enabled' : i18n.t('Disabled') || 'Disabled';
                const toggleClass = isEnabled ? 'btn-toggle-active' : 'btn-toggle-inactive';

                return `
                <div class="custom-header-row" data-index="${index}">
                    <input
                        type="text"
                        class="custom-header-input custom-header-key"
                        placeholder="e.g. CF-Access-Client-Id"
                        value="${keyVal}"
                        data-index="${index}"
                        tabindex="0"
                        readonly
                    />
                    <input
                        type="text"
                        class="custom-header-input custom-header-val"
                        placeholder="Header Value / Token"
                        value="${valVal}"
                        data-index="${index}"
                        tabindex="0"
                        readonly
                    />
                    <button
                        type="button"
                        class="custom-header-toggle ${toggleClass}"
                        data-index="${index}"
                        tabindex="0"
                        title="${toggleText}"
                    >
                        <span class="toggle-status-dot"></span>
                        <span>${toggleText}</span>
                    </button>
                    <button
                        type="button"
                        class="custom-header-delete"
                        data-index="${index}"
                        tabindex="0"
                        title="${i18n.t('Delete') || 'Delete'}"
                    >
                        ✕
                    </button>
                </div>
            `;
            })
            .join('');
    }

    /**
     * Wires click, keydown, and blur listeners to row inputs to seamlessly toggle
     * between spatial navigation (readOnly = true) and active text entry (readOnly = false).
     * @private
     */
    _bindRowInputs() {
        if (!this.overlay) return;

        const inputs = this.overlay.querySelectorAll('.custom-header-key, .custom-header-val');
        inputs.forEach((input) => {
            // Unlock on click/tap to allow editing
            input.addEventListener('click', () => {
                if (input.readOnly) {
                    input.readOnly = false;
                    input.focus();
                }
            });

            // Enter key toggles between navigation and active editing
            input.addEventListener('keydown', (e) => {
                if (e.keyCode === 13) {
                    if (!input.readOnly) {
                        input.readOnly = true;
                        this._syncInputsToMemory();
                    } else {
                        input.click();
                    }
                }
            });

            // Restore readonly and sync back to memory on blur
            input.addEventListener('blur', () => {
                setTimeout(() => {
                    input.readOnly = true;
                    this._syncInputsToMemory();
                }, 200);
            });
        });
    }

    /**
     * Synchronizes current input DOM values back into memory.
     * @private
     */
    _syncInputsToMemory() {
        if (!this.overlay) return;

        const keyInputs = this.overlay.querySelectorAll('.custom-header-key');
        const valInputs = this.overlay.querySelectorAll('.custom-header-val');

        keyInputs.forEach((input) => {
            const idx = parseInt(input.getAttribute('data-index'), 10);
            if (this._headers[idx]) {
                this._headers[idx].key = input.value.trim();
            }
        });

        valInputs.forEach((input) => {
            const idx = parseInt(input.getAttribute('data-index'), 10);
            if (this._headers[idx]) {
                this._headers[idx].value = input.value.trim();
            }
        });
    }

    /**
     * Sets up event listeners for inputs, preset triggers, and action buttons.
     * @private
     */
    _bindEvents() {
        if (!this.overlay) return;

        // Add Cloudflare Preset button
        const cfBtn = this.overlay.querySelector('#preset-cf-btn');
        if (cfBtn) {
            cfBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                const cfPreset = HEADER_PRESETS.find((p) => p.id === 'cloudflare');
                if (cfPreset) {
                    cfPreset.headers.forEach((h) => {
                        this._headers.push({ ...h, presetId: 'cloudflare' });
                    });
                }
                this._refreshList('#preset-cf-btn');
            };
        }

        // Add Pangolin Preset button
        const pangolinBtn = this.overlay.querySelector('#preset-pangolin-btn');
        if (pangolinBtn) {
            pangolinBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                const pPreset = HEADER_PRESETS.find((p) => p.id === 'pangolin');
                if (pPreset) {
                    pPreset.headers.forEach((h) => {
                        this._headers.push({ ...h, presetId: 'pangolin' });
                    });
                }
                this._refreshList('#preset-pangolin-btn');
            };
        }

        // Add blank header button
        const addBtn = this.overlay.querySelector('#add-header-btn');
        if (addBtn) {
            addBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();
                this._headers.push({ key: '', value: '', enabled: true });
                const newIdx = this._headers.length - 1;
                this._refreshList(`.custom-header-row[data-index="${newIdx}"] .custom-header-key`);
            };
        }

        // Save button
        const saveBtn = this.overlay.querySelector('#custom-headers-save-btn');
        if (saveBtn) {
            saveBtn.onclick = (e) => {
                e.stopPropagation();
                this._syncInputsToMemory();

                // Prune completely empty rows before saving
                const cleaned = this._headers.filter((h) => h && h.key && h.key.trim().length > 0);

                if (this._serverUrl) {
                    customHeaders.setServerHeaders(this._serverUrl, cleaned);
                }

                if (typeof this._onSave === 'function') {
                    this._onSave(cleaned);
                }

                this.close();
            };
        }

        // Cancel button
        const cancelBtn = this.overlay.querySelector('#custom-headers-cancel-btn');
        if (cancelBtn) {
            cancelBtn.onclick = (e) => {
                e.stopPropagation();
                if (typeof this._onCancel === 'function') {
                    this._onCancel();
                }
                this.close();
            };
        }

        // Row toggle & delete button handlers
        const container = this.overlay.querySelector('#custom-headers-list-container');
        if (container) {
            container.onclick = (e) => {
                const target = e.target.closest('button');
                if (!target) return;

                const idx = parseInt(target.getAttribute('data-index'), 10);
                if (isNaN(idx) || !this._headers[idx]) return;

                if (target.classList.contains('custom-header-toggle')) {
                    e.stopPropagation();
                    this._syncInputsToMemory();
                    this._headers[idx].enabled = !this._headers[idx].enabled;
                    this._refreshList(`.custom-header-row[data-index="${idx}"] .custom-header-toggle`);
                } else if (target.classList.contains('custom-header-delete')) {
                    e.stopPropagation();
                    this._syncInputsToMemory();
                    this._headers.splice(idx, 1);
                    const nextFocus =
                        idx > 0
                            ? `.custom-header-row[data-index="${idx - 1}"] .custom-header-delete`
                            : this._headers.length > 0
                              ? '.custom-header-row[data-index="0"] .custom-header-delete'
                              : '#add-header-btn';
                    this._refreshList(nextFocus);
                }
            };
        }

        // Backdrop click to dismiss
        this.overlay.onclick = (e) => {
            if (e.target === this.overlay) {
                if (typeof this._onCancel === 'function') {
                    this._onCancel();
                }
                this.close();
            }
        };
    }

    /**
     * Refreshes the headers container without recreating the entire modal DOM or stacking traps.
     * @param {string} [focusSelector=null] - Optional selector of element to focus after refresh
     * @private
     */
    _refreshList(focusSelector = null) {
        if (!this.overlay) return;
        const container = this.overlay.querySelector('#custom-headers-list-container');
        if (container) {
            container.innerHTML = this._renderHeadersList();
            this._bindRowInputs();
            focusManager.invalidateCache('__trap__');
            if (focusSelector) {
                const target = this.overlay.querySelector(focusSelector);
                if (target) {
                    focusManager.focusElement(target);
                }
            }
        }
    }

    /**
     * Locks 2D grid spatial navigation into the modal dialog and selects the initial focused control.
     * @private
     */
    _setupFocusTrap() {
        if (!this.overlay) return;

        const modalDialog = this.overlay.querySelector('.settings-modal');
        if (modalDialog) {
            focusManager.pushTrap(modalDialog, {
                orientation: 'grid',
                defaultFocusSelector: '#custom-headers-save-btn'
            });
        }
    }

    /**
     * Closes the dialog and restores previous spatial focus.
     */
    close() {
        if (!this.isVisible) return;
        this.isVisible = false;

        if (this._boundOnBack) {
            eventBus.off('key:back', this._boundOnBack);
            this._boundOnBack = null;
        }

        // Disarm focus trap
        focusManager.popTrap();

        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        log.info('Closed CustomHeadersDialog');
    }
}

export const customHeadersDialog = new CustomHeadersDialog();
