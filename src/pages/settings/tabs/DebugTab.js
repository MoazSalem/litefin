/**
 * ============================================================================
 * Litefin Tizen - Debug Tab Controller
 * ============================================================================
 * Manages developer diagnostics, telemetry logging, live performance overlay,
 * Movi demuxer logs, ExoPlayer native event tracing, modular filter toggles,
 * client log uploads, and persistent cache storage sanitization.
 * ============================================================================
 */

import { debugOverlay } from '../../../ui/DebugOverlay.js';
import { storage } from '../../../utils/StorageService.js';
import { logger } from '../../../utils/Logger.js';
import { eventBus } from '../../../core/EventBus.js';
import { api } from '../../../api/index.js';
import { i18n } from '../../../utils/i18n.js';

const log = logger.create('DebugTab');

/**
 * Controller for the Settings Developer Diagnostics and Storage Management tab.
 */
export class DebugTab {
    /**
     * Creates an instance of DebugTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain parent page context for dropdown rendering and helper delegation
        this.page = pageContext;

        // Active DOM event listeners array for deterministic lifecycle teardown
        this._listeners = [];
    }

    /**
     * Helper to render dropdown markup via parent page facade.
     * @private
     */
    _renderDropdown(id, options, current) {
        if (this.page && typeof this.page._renderDropdown === 'function') {
            return this.page._renderDropdown(id, options, current);
        }
        return '';
    }

    /**
     * Generates HTML markup for the Debug and Storage Management tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        const logsEnabled = debugOverlay.isLogsEnabled;
        const overlayEnabled = debugOverlay.isOverlayEnabled;
        const moviLogsEnabled = storage.getItem('debug_movi_logs') === 'true';
        const exoLogsEnabled = storage.getItem('debug_exoplayer_logs') === 'true';

        return `
            <div class="settings-tab-content">
                <h2 class="content-title" data-i18n="Debug">${i18n.t('Debug')}</h2>
                <p class="content-subtitle" data-i18n="DebugTabDescription">${i18n.t('DebugTabDescription') || 'Inspect developer metrics, view performance stats, test logs, and capture crash reports.'}</p>

                <!-- Debug Logs Master Switch -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableDebugLogs">${i18n.t('EnableDebugLogs')}</span>
                        <span class="setting-description" data-i18n="EnableDebugLogsDescription">${i18n.t('EnableDebugLogsDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="toggle-switch ${logsEnabled ? 'active' : ''}" id="toggle-debug-logs" tabindex="0"></button></div>
                </div>

                <!-- On-Screen HUD Overlay Switch -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ShowDebugOverlay">${i18n.t('ShowDebugOverlay')}</span>
                        <span class="setting-description" data-i18n="ShowDebugOverlayDescription">${i18n.t('ShowDebugOverlayDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="toggle-switch ${overlayEnabled ? 'active' : ''}" id="toggle-debug-overlay" tabindex="0" ${!logsEnabled ? 'disabled style="opacity: 0.5"' : ''}></button></div>
                </div>

                <!-- Client Telemetry Log Upload Button -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="UploadLogs">${i18n.t('UploadLogs')}</span>
                        <span class="setting-description" data-i18n="UploadLogsDescription">${i18n.t('UploadLogsDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="btn btn-option" id="btn-upload-logs" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Upload">${i18n.t('Upload')}</button></div>
                </div>

                <!-- WebAssembly Demuxer Low-Level Logs -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableMoviDebugLogs">${i18n.t('EnableMoviDebugLogs') || 'Enable Movi Engine Logs'}</span>
                        <span class="setting-description" data-i18n="EnableMoviDebugLogsDescription">${i18n.t('EnableMoviDebugLogsDescription') || 'Output low-level WebAssembly demuxer, FFmpeg, and decoding logs from movi-player to the logger.'}</span>
                    </div>
                    <div class="setting-control"><button class="toggle-switch ${moviLogsEnabled ? 'active' : ''}" id="toggle-debug-movi-logs" tabindex="0"></button></div>
                </div>

                <!-- Media3 ExoPlayer Android Bridge Logs -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="EnableExoPlayerDebugLogs">${i18n.t('EnableExoPlayerDebugLogs') || 'Enable ExoPlayer Debug Logs'}</span>
                        <span class="setting-description" data-i18n="EnableExoPlayerDebugLogsDescription">${i18n.t('EnableExoPlayerDebugLogsDescription') || 'Output low-level Media3 ExoPlayer playback and state events to the console.'}</span>
                    </div>
                    <div class="setting-control"><button class="toggle-switch ${exoLogsEnabled ? 'active' : ''}" id="toggle-debug-exoplayer-logs" tabindex="0"></button></div>
                </div>

                <!-- Debug Overlay Width Dimension -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayWidth">${i18n.t('OverlayWidth')}</span>
                        <span class="setting-description" data-i18n="OverlayWidthDescription">${i18n.t('OverlayWidthDescription')}</span>
                    </div>
                    <div class="setting-control">${this._renderDropdown('debug-width-select', [{ value: 'small', label: i18n.t('Small') }, { value: 'medium', label: i18n.t('Medium') }, { value: 'large', label: i18n.t('Large') }, { value: 'full', label: i18n.t('FullScreen') }], debugOverlay.Width || 'small')}</div>
                </div>

                <!-- Debug Overlay Height Dimension -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayHeight">${i18n.t('OverlayHeight')}</span>
                        <span class="setting-description" data-i18n="OverlayHeightDescription">${i18n.t('OverlayHeightDescription')}</span>
                    </div>
                    <div class="setting-control">${this._renderDropdown('debug-height-select', [{ value: 'small', label: i18n.t('Small') }, { value: 'medium', label: i18n.t('Medium') }, { value: 'large', label: i18n.t('Large') }, { value: 'full', label: i18n.t('FullScreen') }], debugOverlay.Height || 'small')}</div>
                </div>

                <!-- Debug Overlay Screen Position Anchor -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="OverlayPosition">${i18n.t('OverlayPosition')}</span>
                        <span class="setting-description" data-i18n="OverlayPositionDescription">${i18n.t('OverlayPositionDescription')}</span>
                    </div>
                    <div class="setting-control">${this._renderDropdown('debug-position-select', [{ value: 'top-left', label: i18n.t('TopLeft') }, { value: 'top-right', label: i18n.t('TopRight') }, { value: 'bottom-left', label: i18n.t('BottomLeft') }, { value: 'bottom-right', label: i18n.t('BottomRight') }], debugOverlay.Position || 'bottom-right')}</div>
                </div>

                <!-- Storage Management Section -->
                <h3 class="setting-section-title" data-i18n="StorageManagement">${i18n.t('StorageManagement')}</h3>

                <!-- Storage Memory & Key Count Telemetry Display -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="LocalStorageUsage">${i18n.t('LocalStorageUsage')}</span>
                        <span class="setting-description" id="storage-usage-display" data-i18n="Calculating">${i18n.t('Calculating')}</span>
                    </div>
                </div>

                <!-- Clear Library Card Image Thumbnails Cache -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearImageCache">${i18n.t('ClearImageCache')}</span>
                        <span class="setting-description" data-i18n="ClearImageCacheDescription">${i18n.t('ClearImageCacheDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="btn btn-option" id="btn-clear-image-cache" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Clear">${i18n.t('Clear')}</button></div>
                </div>

                <!-- Clear Persisted Debug Filter Rules -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearDebugFilters">${i18n.t('ClearDebugFilters')}</span>
                        <span class="setting-description" data-i18n="ClearDebugFiltersDescription">${i18n.t('ClearDebugFiltersDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="btn btn-option" id="btn-clear-debug-filters" tabindex="0" style="width: auto; min-width: 120px;" data-i18n="Clear">${i18n.t('Clear')}</button></div>
                </div>

                <!-- Wipe All Non-Auth Caches -->
                <div class="setting-item">
                    <div class="setting-label">
                        <span class="setting-name" data-i18n="ClearAllCaches">${i18n.t('ClearAllCaches')}</span>
                        <span class="setting-description" data-i18n="ClearAllCachesDescription">${i18n.t('ClearAllCachesDescription')}</span>
                    </div>
                    <div class="setting-control"><button class="btn btn-danger" id="btn-clear-all-storage" tabindex="0" style="width: auto; min-width: 120px; padding: 12px 24px; font-size: 1.2rem;" data-i18n="Clear">${i18n.t('Clear')}</button></div>
                </div>

                <!-- Modular Log Filters Subsystem -->
                <h3 class="setting-section-title" data-i18n="ModuleFilters">${i18n.t('ModuleFilters')}</h3>
                <div class="module-filters-grid">
                    <div class="setting-item compact">
                        <div class="setting-label"><span class="setting-name" data-i18n="EnableAllFilters">${i18n.t('EnableAllFilters')}</span></div>
                        <div class="setting-control"><button class="btn btn-option" id="btn-enable-all-filters" tabindex="0" style="width: auto; min-width: 100px;" data-i18n="Enable">${i18n.t('Enable')}</button></div>
                    </div>
                    <div class="setting-item compact">
                        <div class="setting-label"><span class="setting-name" data-i18n="DisableAllFilters">${i18n.t('DisableAllFilters')}</span></div>
                        <div class="setting-control"><button class="btn btn-option" id="btn-disable-all-filters" tabindex="0" style="width: auto; min-width: 100px;" data-i18n="Disable">${i18n.t('Disable')}</button></div>
                    </div>
                    ${debugOverlay.getKnownModules().map((module) => `
                        <div class="setting-item compact">
                            <div class="setting-label"><span class="setting-name">${module}</span></div>
                            <div class="setting-control"><button class="toggle-switch module-filter-toggle ${debugOverlay.isModuleEnabled(module) ? 'active' : ''}" data-module="${module}" tabindex="0"></button></div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    /**
     * Binds DOM click listeners and populates storage metrics when tab mounts.
     * @param {HTMLElement} root Root element container
     */
    mount(root) {
        if (!root) return;

        // Register DOM listener and record for teardown
        const addListener = (selector, event, handler) => {
            const el = root.querySelector(selector);
            if (el) {
                el.addEventListener(event, handler);
                this._listeners.push({ el, event, handler });
            }
        };

        // Populate storage usage metrics immediately
        this.updateStorageUsageDisplay(root);

        // Debug log capture master toggle switch
        addListener('#toggle-debug-logs', 'click', () => {
            const toggleLogs = root.querySelector('#toggle-debug-logs');
            if (!toggleLogs) return;
            const newState = !toggleLogs.classList.contains('active');
            toggleLogs.classList.toggle('active');
            debugOverlay.setLogsEnabled(newState);
            storage.setItem('debug_logs_enabled', newState);

            const toggleOverlay = root.querySelector('#toggle-debug-overlay');
            if (toggleOverlay) {
                if (newState) {
                    toggleOverlay.removeAttribute('disabled');
                    toggleOverlay.style.opacity = '1';
                } else {
                    toggleOverlay.setAttribute('disabled', 'true');
                    toggleOverlay.style.opacity = '0.5';
                    if (toggleOverlay.classList.contains('active')) {
                        toggleOverlay.classList.remove('active');
                        debugOverlay.setOverlayEnabled(false);
                        storage.setItem('debug_overlay_enabled', false);
                    }
                }
            }
        });

        // Debug floating overlay display toggle switch
        addListener('#toggle-debug-overlay', 'click', () => {
            const toggleOverlay = root.querySelector('#toggle-debug-overlay');
            if (!toggleOverlay || toggleOverlay.getAttribute('disabled')) return;
            const newState = !toggleOverlay.classList.contains('active');
            toggleOverlay.classList.toggle('active');
            debugOverlay.setOverlayEnabled(newState);
            storage.setItem('debug_overlay_enabled', newState);
        });

        // Engine logs: Movi WebAssembly demuxer
        addListener('#toggle-debug-movi-logs', 'click', () => {
            const toggle = root.querySelector('#toggle-debug-movi-logs');
            if (!toggle) return;
            const newState = !toggle.classList.contains('active');
            toggle.classList.toggle('active');
            storage.setItem('debug_movi_logs', newState);
            eventBus.emit('prefChanged:debug_movi_logs', newState);
        });

        // Engine logs: ExoPlayer native Android bridge
        addListener('#toggle-debug-exoplayer-logs', 'click', () => {
            const toggle = root.querySelector('#toggle-debug-exoplayer-logs');
            if (!toggle) return;
            const newState = !toggle.classList.contains('active');
            toggle.classList.toggle('active');
            storage.setItem('debug_exoplayer_logs', newState);
            eventBus.emit('prefChanged:debug_exoplayer_logs', newState);
        });

        // Client telemetry log upload action button
        addListener('#btn-upload-logs', 'click', async () => {
            const btn = root.querySelector('#btn-upload-logs');
            if (!btn) return;
            btn.disabled = true;
            btn.textContent = i18n.t('Uploading');
            try {
                const logs = debugOverlay.getLogDump();
                if (!logs) throw new Error('No logs to upload');
                const filename = `Litefin_Log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
                await api.uploadClientLog(filename, logs);
                btn.textContent = i18n.t('Success');
            } catch (error) {
                log.error('Failed to upload logs:', error);
                btn.textContent = i18n.t('Failed');
            } finally {
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = i18n.t('Upload');
                }, 2000);
            }
        });

        // Storage clearing: Thumbnail cache
        addListener('#btn-clear-image-cache', 'click', () => {
            const btn = root.querySelector('#btn-clear-image-cache');
            if (!btn) return;
            const removed = storage.clearByPrefix('libThumb:');
            btn.textContent = removed > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
            setTimeout(() => { btn.textContent = i18n.t('Clear'); }, 2000);
            this.updateStorageUsageDisplay(root);
        });

        // Storage clearing: Debug filter rules
        addListener('#btn-clear-debug-filters', 'click', () => {
            const btn = root.querySelector('#btn-clear-debug-filters');
            if (!btn) return;
            const removed = storage.clearByPrefix('debug_filter_');
            if (logger._disabledModules) logger._disabledModules.clear();
            btn.textContent = removed > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
            setTimeout(() => { btn.textContent = i18n.t('Clear'); }, 2000);
            this.updateStorageUsageDisplay(root);
        });

        // Storage clearing: All non-essential caches
        addListener('#btn-clear-all-storage', 'click', () => {
            const btn = root.querySelector('#btn-clear-all-storage');
            if (!btn) return;
            btn.disabled = true;
            btn.textContent = i18n.t('Working');
            const removed = storage.clearByPrefix('libThumb:');
            if (logger._disabledModules) logger._disabledModules.clear();
            btn.disabled = false;
            btn.textContent = removed > 0 ? i18n.t('Done') : i18n.t('AlreadyEmpty');
            setTimeout(() => { btn.textContent = i18n.t('ClearAll'); }, 2500);
            this.updateStorageUsageDisplay(root);
        });

        // Bulk filter toggles
        addListener('#btn-enable-all-filters', 'click', () => {
            debugOverlay.getKnownModules().forEach((mod) => debugOverlay.toggleModule(mod, true));
            root.querySelectorAll('.module-filter-toggle').forEach((btn) => btn.classList.add('active'));
        });

        addListener('#btn-disable-all-filters', 'click', () => {
            debugOverlay.getKnownModules().forEach((mod) => debugOverlay.toggleModule(mod, false));
            root.querySelectorAll('.module-filter-toggle').forEach((btn) => btn.classList.remove('active'));
        });

        // Individual modular log filter toggles
        root.querySelectorAll('.module-filter-toggle').forEach((btn) => {
            const handler = () => {
                const module = btn.dataset.module;
                const newState = !btn.classList.contains('active');
                btn.classList.toggle('active');
                debugOverlay.toggleModule(module, newState);
            };
            btn.addEventListener('click', handler);
            this._listeners.push({ el: btn, event: 'click', handler });
        });
    }

    /**
     * Updates the formatted localStorage consumption summary element.
     * @param {HTMLElement} [root] Container element to search for usage label
     */
    updateStorageUsageDisplay(root) {
        const target = root || (this.page ? this.page.element : null) || document;
        const el = target ? target.querySelector('#storage-usage-display') : null;
        if (!el) return;

        const report = storage.getStorageReport();
        const fmt = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
        };

        const topGroups = Object.entries(report.breakdown)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 4)
            .map(([prefix, bytes]) => `${prefix}: ${fmt(bytes)}`)
            .join(' · ');

        el.textContent = `${fmt(report.totalBytes)} across ${report.keyCount} keys — ${topGroups}`;
    }

    /**
     * Unregisters all active DOM event listeners to avoid memory leaks.
     */
    destroy() {
        this._listeners.forEach(({ el, event, handler }) => {
            if (el && typeof el.removeEventListener === 'function') {
                el.removeEventListener(event, handler);
            }
        });
        this._listeners = [];
    }
}

export default DebugTab;
