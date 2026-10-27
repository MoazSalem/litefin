/**
 * ============================================================================
 * Custom Collections & Playlists Selection Modal Dialog
 * ============================================================================
 * Manages the multi-select modal dialog allowing users to pick which custom
 * collections and playlists should be rendered as distinct rows on the home
 * screen. Features real-time search filtering, selection state persistence,
 * and comprehensive spatial navigation focus handling.
 * ============================================================================
 */

import { storage } from '../../../utils/StorageService.js';
import { i18n } from '../../../utils/i18n.js';
import { api } from '../../../api/index.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { logger } from '../../../utils/Logger.js';

const log = logger.create('CustomCollectionsModal');

/**
 * Computes a human-readable summary badge indicating how many custom
 * collection and playlist rows are currently selected for the home view.
 *
 * @returns {string} Formatted localized string summary (e.g. "3 Selected")
 */
export function getCustomCollectionsLabel() {
    try {
        // Read raw JSON-serialized array of custom collection descriptors from storage
        const raw = storage.getItem('pref:customCollectionRows');
        const list = raw ? JSON.parse(raw) : [];
        const count = Array.isArray(list) ? list.length : 0;

        // Return localized badge counter or fallback to None Selected
        return count > 0
            ? i18n.t('CollectionsSelected', [count])
            : i18n.t('NoCollectionsSelected') || 'None Selected';
    } catch (_) {
        return i18n.t('NoCollectionsSelected') || 'None Selected';
    }
}

/**
 * Controller class governing modal lifecycle, event dispatch, and spatial
 * navigation boundaries for custom collection curation.
 */
export class CustomCollectionsModal {
    /**
     * Creates a new instance of the CustomCollectionsModal controller.
     *
     * @param {Object} page Host SettingsPage instance providing root context
     */
    constructor(page) {
        this.page = page;
        this._prevFocus = null;
        this._prevSection = null;
        this._selectedMap = new Map();
        this._collections = [];
        this._searchQuery = '';
    }

    /**
     * Opens the custom collections modal, populates live collections from
     * the Jellyfin API, and mounts search and selection event listeners.
     *
     * @param {Function} [onUpdate] Callback executed when selection changes are committed
     * @returns {Promise<void>}
     */
    async show(onUpdate) {
        const overlay = this.page.$('#modal-overlay');
        if (!overlay) return;

        // Preserve previous active focus element and section for seamless restoration
        this._prevFocus = focusManager.getFocused();
        this._prevSection = focusManager.getActiveSection();

        // Parse persistent selections into an easily queryable ID map
        this._selectedMap.clear();
        try {
            const raw = storage.getItem('pref:customCollectionRows');
            const selectedCols = raw ? JSON.parse(raw) : [];
            if (Array.isArray(selectedCols)) {
                selectedCols.forEach((c) => {
                    if (c && c.id) {
                        this._selectedMap.set(c.id, { id: c.id, name: c.name || '' });
                    }
                });
            }
        } catch (_) {
            this._selectedMap.clear();
        }

        // Render intermediate loading spinner inside modal overlay
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
        overlay.innerHTML = `
            <div class="settings-modal custom-collections-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2 data-i18n="ManageCollections">${i18n.t('ManageCollections') || 'Manage Collections'}</h2>
                </div>
                <div class="modal-loading-spinner" style="padding: 40px; text-align: center; color: var(--jf-text-secondary);">
                    ${i18n.t('Loading') || 'Loading...'}
                </div>
            </div>
        `;

        // Query server for BoxSets (Collections) and Playlists
        this._collections = [];
        try {
            const res = await api.getItems({
                IncludeItemTypes: 'BoxSet,Playlist',
                Recursive: true,
                EnableTotalRecordCount: false
            });
            this._collections = res?.Items || [];
            // Sort collections alphabetically for intuitive browsing
            this._collections.sort((a, b) => (a.Name || '').localeCompare(b.Name || ''));
        } catch (err) {
            log.error('Failed to fetch collections for custom rows modal', err);
        }

        // Abort mount if user dismissed the overlay while API request was in-flight
        if (!overlay.classList.contains('visible')) return;

        this._searchQuery = '';
        this._renderModal(overlay, onUpdate);
    }

    /**
     * Renders modal dialog structure, filters list items, and binds DOM events.
     *
     * @private
     * @param {HTMLElement} overlay Dialog backdrop container
     * @param {Function} [onUpdate] Layout refresh callback
     */
    _renderModal(overlay, onUpdate) {
        // Filter collections by case-insensitive name match
        const filteredCols = this._searchQuery
            ? this._collections.filter((c) => (c.Name || '').toLowerCase().includes(this._searchQuery.toLowerCase()))
            : this._collections;

        // Generate checkable button rows
        const colRowsHtml = filteredCols
            .map((c) => {
                const isSelected = this._selectedMap.has(c.Id);
                return `
                <button class="modal-option-btn check-btn ${isSelected ? 'selected' : ''}" data-id="${c.Id}" data-name="${escapeHtml(c.Name || '')}" tabindex="0">
                    <div class="checkbox-box"><span class="check-mark">&#10003;</span></div>
                    <span class="modal-option-label">${escapeHtml(c.Name || '')}</span>
                </button>
            `;
            })
            .join('');

        // Populate overlay markup with search input, scrollable list, and footer actions
        overlay.innerHTML = `
            <div class="settings-modal custom-collections-modal" role="dialog" aria-modal="true">
                <div class="modal-header">
                    <h2 data-i18n="ManageCollections">${i18n.t('ManageCollections') || 'Manage Collections'}</h2>
                </div>

                <!-- Search Input Box -->
                <div class="fav-lang-search-box">
                    <input type="text" id="custom-col-search-input" class="fav-lang-search-input" 
                           placeholder="${i18n.t('Search') || 'Search...'}" 
                           value="${escapeHtml(this._searchQuery)}" tabindex="0" />
                </div>

                <!-- Scrollable Collections List -->
                <div class="modal-options custom-col-list" id="custom-col-list" style="max-height: 50vh; overflow-y: auto;">
                    ${colRowsHtml || `<div class="modal-no-options" data-i18n="NoCollectionsFound">${i18n.t('NoCollectionsFound') || 'No collections or playlists found'}</div>`}
                </div>

                <!-- Action Confirmation Buttons -->
                <div class="modal-actions">
                    <button class="modal-action-btn" id="btn-custom-col-clear" tabindex="0" data-i18n="ClearAll">${i18n.t('ClearAll') || 'Clear All'}</button>
                    <button class="modal-action-btn primary" id="btn-custom-col-done" tabindex="0" data-i18n="Done">${i18n.t('Done') || 'Done'}</button>
                </div>
            </div>
        `;

        // Bind row selection toggles
        overlay.querySelectorAll('.custom-col-list .check-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const name = btn.dataset.name;
                if (this._selectedMap.has(id)) {
                    this._selectedMap.delete(id);
                    btn.classList.remove('selected');
                } else {
                    this._selectedMap.set(id, { id, name });
                    btn.classList.add('selected');
                }
                this._saveSelection(onUpdate);
            });
        });

        // Search filtering handler
        const searchInput = overlay.querySelector('#custom-col-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this._searchQuery = e.target.value;
                this._renderModal(overlay, onUpdate);
                const updatedInput = overlay.querySelector('#custom-col-search-input');
                if (updatedInput) {
                    updatedInput.focus();
                    updatedInput.setSelectionRange(updatedInput.value.length, updatedInput.value.length);
                }
            });
        }

        // Clear All selection button
        const clearBtn = overlay.querySelector('#btn-custom-col-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._selectedMap.clear();
                overlay
                    .querySelectorAll('.custom-col-list .check-btn')
                    .forEach((b) => b.classList.remove('selected'));
                this._saveSelection(onUpdate);
            });
        }

        // Done button to close modal
        const doneBtn = overlay.querySelector('#btn-custom-col-done');
        if (doneBtn) {
            doneBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close(onUpdate);
            });
        }

        // Backdrop click dismiss handler
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                e.stopPropagation();
                this.close(onUpdate);
            }
        };

        // Wire spatial navigation focus sections
        this._setupFocusSections(overlay);
    }

    /**
     * Persists currently selected collections to browser storage and updates badge.
     *
     * @private
     * @param {Function} [onUpdate] Callback to notify callers of layout changes
     */
    _saveSelection(onUpdate) {
        const arrayToSave = Array.from(this._selectedMap.values());
        storage.setItem('pref:customCollectionRows', JSON.stringify(arrayToSave));

        // Update badge count label on settings home page if present
        const countLabel = this.page.$('#custom-collections-count-label');
        if (countLabel) {
            countLabel.innerText = getCustomCollectionsLabel();
        }

        if (typeof onUpdate === 'function') {
            onUpdate();
        }
    }

    /**
     * Registers directional navigation sections for modal components.
     *
     * @private
     * @param {HTMLElement} overlay Dialog backdrop container
     */
    _setupFocusSections(overlay) {
        this.page.registerFocusSection('custom-col-search', overlay.querySelector('.fav-lang-search-box'), {
            orientation: 'horizontal',
            leaveDown: 'custom-col-list'
        });

        this.page.registerFocusSection('custom-col-list', overlay.querySelector('#custom-col-list'), {
            orientation: 'vertical',
            leaveUp: 'custom-col-search',
            leaveDown: 'custom-col-actions'
        });

        this.page.registerFocusSection('custom-col-actions', overlay.querySelector('.modal-actions'), {
            orientation: 'horizontal',
            leaveUp: 'custom-col-list'
        });

        // Establish initial focus on first list option or search box
        const firstOption = overlay.querySelector('#custom-col-list .check-btn');
        if (firstOption) {
            focusManager.setActiveSection('custom-col-list');
            setTimeout(() => {
                focusManager.focusElement(firstOption);
            }, 50);
        } else {
            focusManager.setActiveSection('custom-col-search');
            setTimeout(() => {
                const searchEl = overlay.querySelector('#custom-col-search-input');
                if (searchEl) focusManager.focusElement(searchEl);
            }, 50);
        }
    }

    /**
     * Dismantles modal overlay, deregisters navigation zones, and restores focus.
     *
     * @param {Function} [onUpdate] Callback to refresh caller view
     */
    close(onUpdate) {
        const overlay = this.page.$('#modal-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;

        // Detach click listener and hide dialog shell
        overlay.onclick = null;
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML = '';

        // Clean up focus registrations
        this.page.unregisterFocusSection('custom-col-search');
        this.page.unregisterFocusSection('custom-col-list');
        this.page.unregisterFocusSection('custom-col-actions');
        focusManager.unregister('custom-col-search');
        focusManager.unregister('custom-col-list');
        focusManager.unregister('custom-col-actions');

        // Refresh counter label
        const countLabel = this.page.$('#custom-collections-count-label');
        if (countLabel) {
            countLabel.innerText = getCustomCollectionsLabel();
        }

        // Execute external update callback (e.g. re-render home layout UI)
        if (typeof onUpdate === 'function') {
            onUpdate();
        }

        // Invalidate spatial navigation cache
        focusManager.invalidateCache('settings-content');

        // Restore active focus section and previous element
        const targetSection = this._prevSection || 'settings-display';
        focusManager.setActiveSection(targetSection, false);

        if (this._prevFocus && document.contains(this._prevFocus)) {
            focusManager.focusElement(this._prevFocus);
        } else {
            const manageBtn = this.page.$('#btn-manage-custom-collections');
            if (manageBtn) {
                focusManager.focusElement(manageBtn);
            } else {
                focusManager.focusFirstInActiveSection();
            }
        }

        this._prevFocus = null;
        this._prevSection = null;
    }
}
