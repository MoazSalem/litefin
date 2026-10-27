/**
 * ============================================================================
 * Litefin Tizen - Libraries Tab Controller
 * ============================================================================
 * Admin-only media library management tab. Enables administrators to review
 * server media collections, initiate global server-wide library scans, and
 * configure per-library metadata refresh modes.
 * ============================================================================
 */

import { auth, api } from '../../../api/index.js';
import { toast } from '../../../ui/Toast.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { escapeHtml } from '../../../utils/Utils.js';
import { REFRESH_ICONS_SVG } from '../../../utils/Icons.js';

const log = logger.create('LibrariesTab');

/**
 * Controller for the Settings Libraries management tab.
 */
export class LibrariesTab {
    /**
     * Creates an instance of LibrariesTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain reference to parent SettingsPage for dialogs and focus registration
        this.page = pageContext;

        // Track active listeners for teardown
        this._listeners = [];

        // Track debounce timers
        this._debounceTimer = null;
    }

    /**
     * Generates HTML markup for the Libraries tab.
     * Enforces administrator policy validation before rendering controls.
     * @returns {string} Serialized HTML template string
     */
    render() {
        // Enforce admin permission guard directly in template
        const user = auth.getCurrentUser();
        if (!user?.Policy?.IsAdministrator) {
            return `
                <div class="settings-tab-content">
                    <h2 class="content-title" data-i18n="AccessDenied">${i18n.t('AccessDenied') || 'Access Denied'}</h2>
                    <p class="content-subtitle" data-i18n="AdminOnlyFeature">
                        ${i18n.t('AdminOnlyFeature') || 'This section requires administrator privileges.'}
                    </p>
                </div>
            `;
        }

        // Return structured administrator view
        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Libraries">${i18n.t('Libraries') || 'Libraries'}</h2>
                <p class="content-subtitle" data-i18n="LibrariesAdminDescription">
                    ${i18n.t('LibrariesAdminDescription') || 'Manage server media libraries, trigger global library scans, and refresh metadata.'}
                </p>

                <div class="libraries-tab-container">
                    <!-- Global Actions Row (Scan All Libraries) using standard setting-item layout -->
                    <div class="setting-item">
                        <div class="setting-label">
                            <span class="setting-name" data-i18n="ScanAllLibraries">${i18n.t('ScanAllLibraries') || 'Scan All Libraries'}</span>
                            <span class="setting-description" data-i18n="ScanAllLibrariesDescription">
                                ${i18n.t('ScanAllLibrariesDescription') || 'Trigger a comprehensive scan across all media libraries to discover newly added files.'}
                            </span>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-option btn-scan-all-libraries" id="btn-scan-all-libraries" tabindex="0" data-focusable="true">
                                ${REFRESH_ICONS_SVG}
                                <span class="btn-label" data-i18n="ScanAll">${i18n.t('ScanAll') || 'Scan All'}</span>
                            </button>
                        </div>
                    </div>

                    <!-- Individual Libraries Section Header -->
                    <div class="library-list-section-header">
                        <span class="library-list-section-title" data-i18n="MediaLibraries">${i18n.t('MediaLibraries') || 'Media Libraries'}</span>
                        <span class="library-list-count-badge" id="libraries-count-badge">...</span>
                    </div>

                    <!-- Dynamic Library Items List Container -->
                    <div class="library-items-list" id="libraries-admin-list">
                        <div class="library-admin-loading" data-i18n="LoadingLibraries">
                            ${i18n.t('LoadingLibraries') || 'Loading libraries...'}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Binds DOM event listeners and fetches live libraries when the tab is mounted.
     * @param {HTMLElement} container The mounted tab container or parent page root
     */
    async mount(container) {
        // Reset listeners
        this._unbindListeners();

        // Ensure user is an administrator before querying API endpoints
        const user = auth.getCurrentUser();
        if (!user?.Policy?.IsAdministrator) return;

        // Scoped query selector helper
        const find = (selector) => {
            return (container && container.querySelector(selector)) || document.querySelector(selector);
        };

        const listContainer = find('#libraries-admin-list');
        const countBadge = find('#libraries-count-badge');
        const scanAllBtn = find('#btn-scan-all-libraries');

        // Helper to register listeners for guaranteed cleanup
        const addManagedListener = (element, event, handler) => {
            if (!element) return;
            element.addEventListener(event, handler);
            this._listeners.push({ element, event, handler });
        };

        // ----------------------------------------------------
        // Global Scan All Libraries Handler
        // ----------------------------------------------------
        if (scanAllBtn) {
            addManagedListener(scanAllBtn, 'click', async (e) => {
                e.stopPropagation();
                try {
                    // Temporarily visually disable button to avoid duplicate triggers
                    scanAllBtn.disabled = true;
                    scanAllBtn.style.opacity = '0.6';

                    // Trigger server-wide library scan: POST /Library/Refresh
                    await api.refreshAllLibraries();

                    // Display feedback toast
                    toast.show(i18n.t('LibraryScanQueued') || 'Library scan queued for all libraries.', 3500, {
                        type: 'info'
                    });
                } catch (err) {
                    log.error('Failed to trigger scan of all libraries:', err);
                    toast.show(i18n.t('LibraryScanFailed') || 'Failed to trigger library scan.', 4000, {
                        type: 'error'
                    });
                } finally {
                    // Debounce restore button state
                    this._debounceTimer = setTimeout(() => {
                        if (scanAllBtn) {
                            scanAllBtn.disabled = false;
                            scanAllBtn.style.opacity = '1';
                        }
                    }, 1200);
                }
            });
        }

        if (!listContainer) return;

        // ----------------------------------------------------
        // Load & Render Media Libraries from API
        // ----------------------------------------------------
        try {
            const viewsResponse = await api.getUserViews();
            const libraries = viewsResponse.Items || [];

            // Update badge count
            if (countBadge) {
                const countText =
                    libraries.length === 1 ? i18n.t('Library') || 'Library' : i18n.t('Libraries') || 'Libraries';
                countBadge.textContent = `${libraries.length} ${countText}`;
            }

            // Handle empty library state
            if (libraries.length === 0) {
                listContainer.innerHTML = `
                    <div class="library-admin-loading" data-i18n="NoLibrariesFound">
                        ${i18n.t('NoLibrariesFound') || 'No media libraries found.'}
                    </div>
                `;
                return;
            }

            // Build rows for each library
            listContainer.innerHTML = libraries
                .map((lib) => {
                    const colTypeLabel = lib.CollectionType || 'library';

                    return `
                        <div class="setting-item library-setting-row" data-id="${lib.Id}">
                            <div class="setting-label">
                                <span class="setting-name">${escapeHtml(lib.Name)}</span>
                                <span class="setting-description library-admin-type">${escapeHtml(colTypeLabel)}</span>
                            </div>
                            <div class="setting-control">
                                <button class="btn btn-option btn-library-refresh-options" 
                                        id="btn-refresh-${lib.Id}"
                                        data-id="${lib.Id}" 
                                        data-name="${escapeHtml(lib.Name)}" 
                                        tabindex="0" 
                                        data-focusable="true">
                                    ${REFRESH_ICONS_SVG}
                                    <span class="btn-label">${i18n.t('Refresh') || 'Refresh...'}</span>
                                </button>
                            </div>
                        </div>
                    `;
                })
                .join('');

            // ------------------------------------------------
            // Bind Per-Library Refresh Modal Triggers
            // ------------------------------------------------
            const refreshButtons = listContainer.querySelectorAll('.btn-library-refresh-options');
            for (let i = 0; i < refreshButtons.length; i++) {
                const btn = refreshButtons[i];
                addManagedListener(btn, 'click', (e) => {
                    e.stopPropagation();
                    const libId = btn.dataset.id;
                    const libName = btn.dataset.name || i18n.t('Library') || 'Library';

                    const options = [
                        {
                            value: 'ValidationOnly',
                            label: i18n.t('ScanNewUpdatedFiles') || 'Scan for new and updated files'
                        },
                        {
                            value: 'Default',
                            label: i18n.t('SearchMissingMetadata') || 'Search for missing metadata'
                        },
                        {
                            value: 'FullRefresh',
                            label: i18n.t('ReplaceAllMetadata') || 'Replace all metadata'
                        }
                    ];

                    // Open selection modal via parent page helper
                    if (this.page && typeof this.page._renderSelectionModal === 'function') {
                        this.page._renderSelectionModal(
                            `${libName} — ${i18n.t('RefreshMode') || 'Refresh mode'}`,
                            options,
                            'ValidationOnly',
                            async (selectedMode) => {
                                try {
                                    let refreshParams = {};

                                    if (selectedMode === 'ValidationOnly') {
                                        refreshParams = {
                                            MetadataRefreshMode: 'ValidationOnly',
                                            ImageRefreshMode: 'ValidationOnly',
                                            ReplaceAllMetadata: false,
                                            ReplaceAllImages: false,
                                            Recursive: true
                                        };
                                    } else if (selectedMode === 'FullRefresh') {
                                        refreshParams = {
                                            MetadataRefreshMode: 'FullRefresh',
                                            ImageRefreshMode: 'FullRefresh',
                                            ReplaceAllMetadata: true,
                                            ReplaceAllImages: true,
                                            Recursive: true
                                        };
                                    } else {
                                        refreshParams = {
                                            MetadataRefreshMode: 'Default',
                                            ImageRefreshMode: 'Default',
                                            ReplaceAllMetadata: false,
                                            ReplaceAllImages: false,
                                            Recursive: true
                                        };
                                    }

                                    // Send POST /Items/{libId}/Refresh
                                    await api.refreshItem(libId, refreshParams);

                                    toast.show(`${i18n.t('RefreshQueued') || 'Refresh queued for'} ${libName}`, 3500, {
                                        type: 'info'
                                    });
                                } catch (refreshErr) {
                                    log.error(`Failed to refresh metadata for library ${libName} (${libId}):`, refreshErr);
                                    toast.show(`${i18n.t('RefreshFailed') || 'Refresh failed for'} ${libName}`, 4000, {
                                        type: 'error'
                                    });
                                }
                            }
                        );
                    }
                });
            }

            // Invalidate spatial navigation cache and re-wire TV focus
            focusManager.invalidateCache('settings-content');
            if (this.page && typeof this.page._setupFocus === 'function') {
                this.page._setupFocus();
            }
        } catch (err) {
            log.error('Failed to load libraries in admin tab:', err);
            listContainer.innerHTML = `
                <div class="library-admin-loading" data-i18n="ErrorLoadingLibraries">
                    ${i18n.t('ErrorLoadingLibraries') || 'Error loading media libraries.'}
                </div>
            `;
        }
    }

    /**
     * Unbinds managed DOM listeners.
     * @private
     */
    _unbindListeners() {
        for (let i = 0; i < this._listeners.length; i++) {
            const { element, event, handler } = this._listeners[i];
            if (element && typeof element.removeEventListener === 'function') {
                element.removeEventListener(event, handler);
            }
        }
        this._listeners = [];
    }

    /**
     * Cleans up listeners and timers upon unmount.
     */
    destroy() {
        this._unbindListeners();
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this.page = null;
    }
}

export default LibrariesTab;
