/**
 * ============================================================================
 * Litefin Tizen - Plugins Tab Controller
 * ============================================================================
 * Manages plugin discovery, enabled status toggles, server dependency
 * validations, Seerr integration status, and server dashboard shortcuts.
 * ============================================================================
 */

import { api } from '../../../api/index.js';
import { seerr } from '../../../api/seerrClient.js';
import { pluginManager } from '../../../plugins/PluginManager.js';
import { focusManager } from '../../../ui/FocusManager.js';
import { i18n } from '../../../utils/i18n.js';
import { logger } from '../../../utils/Logger.js';
import { EXTERNAL_LINK_SVG } from '../../../utils/Icons.js';
import { openExternalUrl } from '../modals/AboutDeviceSpecs.js';

const log = logger.create('PluginsTab');

/**
 * Controller for the Settings Plugins management tab.
 */
export class PluginsTab {
    /**
     * Creates an instance of PluginsTab.
     * @param {Object} pageContext The parent SettingsPage instance
     */
    constructor(pageContext) {
        // Retain parent page context for overlay and spatial nav helpers
        this.page = pageContext;

        // Track registered listeners for cleanup
        this._listeners = [];
    }

    /**
     * Generates HTML markup for the Plugins tab.
     * @returns {string} Serialized HTML template
     */
    render() {
        // Retrieve loaded plugin manifests from PluginManager
        const plugins = pluginManager.getPluginList();

        // Helper: build human-readable status badge for plugin entries
        const statusBadge = (p) => {
            if (!p.enabled && !p.dependencyDeferred) {
                return `<span class="plugin-status plugin-status--disabled">${i18n.t('Disabled')}</span>`;
            }
            if (p.dependencyDeferred) {
                return `<span class="plugin-status plugin-status--pending">${i18n.t('PendingVerification', ['Pending'])}</span>`;
            }
            return `<span class="plugin-status plugin-status--active">${i18n.t('Active')}</span>`;
        };

        // Build toggle row markup for each installed plugin
        const rows = plugins
            .map((p) => `
            <div class="setting-item">
                <div class="setting-label">
                    <span class="setting-name">${p.name} <span class="plugin-version">v${p.version}</span> ${statusBadge(p)}</span>
                    ${p.description ? `<span class="setting-description">${p.description}</span>` : ''}
                    ${p.serverDependency ? `<span class="setting-description plugin-dep">${i18n.t('RequiresPlugin', ['Requires'])}: <code>${p.serverDependency}</code></span>` : ''}
                </div>
                <div class="setting-control">
                    <button class="toggle-switch ${p.enabled ? 'active' : ''}" data-plugin-id="${p.id}" id="plugin-toggle-${p.id}" tabindex="0"></button>
                </div>
            </div>
        `).join('');

        const content =
            plugins.length > 0
                ? rows
                : `<p class="settings-empty-state">${i18n.t('NoPlugins', ['No plugins installed.'])}</p>`;

        return `
            <div class="settings-tab-content">
                <div class="plugins-tab-header">
                    <div class="plugins-tab-header-info">
                        <h2 class="content-title" data-i18n="Plugins">${i18n.t('Plugins')}</h2>
                        <p class="content-subtitle" data-i18n="PluginsTabDescription">
                            ${i18n.t('PluginsTabDescription') || 'Extend functionality with community add-ons, metadata providers, and third-party integrations.'}
                        </p>
                    </div>
                    <!-- Quick-launch button opening Jellyfin Server Dashboard in a new window -->
                    <button class="btn btn-option btn-open-dashboard focusable" id="btn-open-dashboard" tabindex="0" data-focusable="true" title="${i18n.t('OpenJellyfinDashboard') || 'Open Jellyfin Dashboard'}">
                        ${EXTERNAL_LINK_SVG}
                        <span class="btn-label" data-i18n="OpenJellyfinDashboard">${i18n.t('OpenJellyfinDashboard') || 'Open Jellyfin Dashboard'}</span>
                    </button>
                </div>

                <div class="setting-item" id="seerr-status-card">
                    <div class="setting-label">
                        <span class="setting-name">
                            ${i18n.t('LitefinAndSeerrStatusLabel', ['Litefin Plugin & Seerr State'])}
                            <span id="litefin-plugin-status-badge" class="plugin-status plugin-status--pending">Probing...</span>
                            <span id="seerr-status-badge" class="plugin-status plugin-status--pending" style="display: none;">Probing...</span>
                        </span>
                        <span class="setting-description" id="seerr-status-description">
                            Probing server companion plugin and Seerr status...
                        </span>
                    </div>
                </div>

                <h3 class="setting-section-title">${i18n.t('InstalledPlugins', ['Installed Plugins'])}</h3>
                ${content}
            </div>
        `;
    }

    /**
     * Binds DOM event listeners and triggers initial Seerr probe on mount.
     * @param {HTMLElement} container The mounted tab container or parent page root
     */
    mount(container) {
        this._unbindListeners();

        const find = (selector) => {
            return (container && container.querySelector(selector)) || document.querySelector(selector);
        };

        const addManagedListener = (element, event, handler) => {
            if (!element) return;
            element.addEventListener(event, handler);
            this._listeners.push({ element, event, handler });
        };

        // ----------------------------------------------------
        // Server Dashboard External Link Handler
        // ----------------------------------------------------
        const btnOpenDashboard = find('#btn-open-dashboard');
        if (btnOpenDashboard) {
            addManagedListener(btnOpenDashboard, 'click', (e) => {
                e.preventDefault();
                const rawUrl = api.serverUrl || (typeof window !== 'undefined' ? window.location.origin : '');
                const serverUrl = rawUrl.replace(/\/+$/, '');
                const dashboardUrl = `${serverUrl}/web/index.html#!/dashboard.html`;
                openExternalUrl(dashboardUrl);
            });
        }

        // ----------------------------------------------------
        // Plugin Enable / Disable Toggle Switch Handlers
        // ----------------------------------------------------
        const toggles = (container || document).querySelectorAll('[data-plugin-id]');
        for (let i = 0; i < toggles.length; i++) {
            const btn = toggles[i];
            addManagedListener(btn, 'click', async () => {
                const pluginId = btn.dataset.pluginId;
                const newEnabled = !btn.classList.contains('active');
                const statusEl = btn.closest('.setting-item')?.querySelector('.plugin-status');

                // Disabling is immediate and does not require server checks
                if (!newEnabled) {
                    btn.classList.remove('active');
                    if (statusEl) {
                        statusEl.className = 'plugin-status plugin-status--disabled';
                        statusEl.textContent = i18n.t('Disabled');
                    }
                    await pluginManager.setPluginEnabled(pluginId, false);
                    return;
                }

                // Check server dependency requirement before committing enable
                const entry = pluginManager.getPlugin(pluginId);
                const hasDependency = !!entry?.plugin?.serverDependency;

                if (hasDependency) {
                    btn.disabled = true;
                    if (statusEl) {
                        statusEl.className = 'plugin-status plugin-status--pending';
                        statusEl.textContent = i18n.t('Checking');
                    }

                    try {
                        const depCheck = await pluginManager.checkServerDependency(pluginId);

                        if (!depCheck.available && !depCheck.deferred) {
                            btn.disabled = false;
                            btn.classList.remove('active');
                            if (statusEl) {
                                statusEl.className = 'plugin-status plugin-status--disabled';
                                statusEl.textContent = i18n.t('Disabled');
                            }
                            this.showPluginDependencyError(entry.plugin.name || pluginId, depCheck.serverPluginName);
                            return;
                        }

                        if (depCheck.deferred) {
                            log.warn(
                                `Plugin '${pluginId}' dependency check deferred (non-admin, no itemId) — enabling tentatively`
                            );
                        }
                    } catch (err) {
                        log.warn(`Plugin '${pluginId}' dependency check failed with error, enabling anyway:`, err);
                    }

                    btn.disabled = false;
                }

                // Commit enable state
                btn.classList.add('active');
                if (statusEl) {
                    statusEl.className = 'plugin-status plugin-status--active';
                    statusEl.textContent = i18n.t('Active');
                }
                await pluginManager.setPluginEnabled(pluginId, true);
            });
        }

        // Trigger companion plugin & Seerr status probe
        this.refreshSeerrStatus(container);
    }

    /**
     * Queries server companion plugin and updates Seerr status cards.
     * @param {HTMLElement} [container]
     */
    async refreshSeerrStatus(container) {
        const find = (selector) => {
            return (container && container.querySelector(selector)) || document.querySelector(selector);
        };

        const litefinBadgeEl = find('#litefin-plugin-status-badge');
        const seerrBadgeEl = find('#seerr-status-badge');
        const descEl = find('#seerr-status-description');
        if (!descEl) return;

        try {
            const isLitefinAvailable = await api.isLitefinPluginAvailable(true);

            if (!isLitefinAvailable) {
                if (litefinBadgeEl) {
                    litefinBadgeEl.className = 'plugin-status plugin-status--disabled';
                    litefinBadgeEl.textContent = i18n.t('LitefinPluginMissing', ['Litefin Plugin: Missing']);
                }
                if (seerrBadgeEl) {
                    seerrBadgeEl.style.display = 'none';
                }
                descEl.textContent = i18n.t('LitefinPluginMissingDesc', [
                    'Litefin companion plugin is not installed on the Jellyfin server. Seerr integration, batch queries, and server backups are disabled.'
                ]);
                return;
            }

            if (litefinBadgeEl) {
                litefinBadgeEl.className = 'plugin-status plugin-status--active';
                litefinBadgeEl.textContent = i18n.t('LitefinPluginActive', ['Litefin Plugin: Active']);
            }

            const status = await seerr.status(true);
            if (seerrBadgeEl) {
                seerrBadgeEl.style.display = '';
            }

            if (status.configured && status.available) {
                if (seerrBadgeEl) {
                    seerrBadgeEl.className = 'plugin-status plugin-status--active';
                    seerrBadgeEl.textContent = i18n.t('SeerrStatusConnected', ['Seerr: Connected']);
                }
                descEl.textContent = i18n.t('SeerrStatusConnectedDesc', [
                    'Litefin companion plugin is active and successfully connected to Seerr.'
                ]);
            } else if (status.configured && !status.available) {
                if (seerrBadgeEl) {
                    seerrBadgeEl.className = 'plugin-status plugin-status--disabled';
                    seerrBadgeEl.textContent = i18n.t('SeerrStatusUnreachable', ['Seerr: Unreachable']);
                }
                descEl.textContent = i18n.t('SeerrStatusUnreachableDesc', [
                    'Litefin plugin is installed, but the Jellyfin server cannot reach the configured Seerr instance.'
                ]);
            } else if (!status.configured && status.available) {
                if (seerrBadgeEl) {
                    seerrBadgeEl.className = 'plugin-status plugin-status--pending';
                    seerrBadgeEl.textContent = i18n.t('SeerrStatusNotConfigured', ['Seerr: Not Configured']);
                }
                descEl.textContent = i18n.t('SeerrStatusNotConfiguredDesc', [
                    'Litefin companion plugin is active, but Seerr URL or API key is not configured in the plugin settings.'
                ]);
            } else {
                if (seerrBadgeEl) {
                    seerrBadgeEl.className = 'plugin-status plugin-status--disabled';
                    seerrBadgeEl.textContent = i18n.t('SeerrStatusDisabled', ['Seerr: Disabled']);
                }
                descEl.textContent = i18n.t('SeerrStatusMissingDesc', [
                    'Litefin companion plugin is active on the server, but Seerr integration is not configured.'
                ]);
            }
        } catch (err) {
            log.warn('Litefin & Seerr server integration status check failed', err);
            if (litefinBadgeEl) {
                litefinBadgeEl.className = 'plugin-status plugin-status--disabled';
                litefinBadgeEl.textContent = i18n.t('PluginMissing', ['Plugin Missing / Unreachable']);
            }
            if (seerrBadgeEl) {
                seerrBadgeEl.style.display = 'none';
            }
            descEl.textContent = i18n.t('SeerrStatusPluginMissingDesc', [
                'Litefin companion plugin is not reachable on the Jellyfin server.'
            ]);
        }
    }

    /**
     * Displays missing server companion plugin error dialog.
     * @param {string} pluginName
     * @param {string} dependencyName
     */
    showPluginDependencyError(pluginName, dependencyName) {
        const overlay =
            (this.page && typeof this.page.$ === 'function' ? this.page.$('#modal-overlay') : null) ||
            document.getElementById('modal-overlay');
        if (!overlay) return;

        const title = i18n.t('MissingServerPlugin') || 'Missing Server Plugin';
        const message =
            i18n.t('MissingServerPluginMessage', [pluginName, dependencyName]) ||
            `'${pluginName}' requires the '${dependencyName}' plugin to be installed and enabled on your Jellyfin server. Please install it via the Jellyfin dashboard and try again.`;
        const btnCloseText = i18n.t('ButtonClose') || 'Close';

        overlay.innerHTML = `
            <div class="settings-modal modal-error" role="dialog" aria-modal="true">
                <div class="modal-header"><h2>${title}</h2></div>
                <div class="modal-content" style="padding: 20px; font-size: 1.1em; color: var(--text-secondary); text-align: center; line-height: 1.5;">${message}</div>
                <div class="modal-actions" style="margin-top: 10px;">
                    <button class="modal-action-btn" id="btn-modal-error-ok" tabindex="0">${btnCloseText}</button>
                </div>
            </div>
        `;

        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');

        const btnOk = overlay.querySelector('#btn-modal-error-ok');
        if (btnOk) {
            btnOk.onclick = (e) => {
                e.stopPropagation();
                if (this.page && typeof this.page._closeSelectionModal === 'function') {
                    this.page._closeSelectionModal();
                } else {
                    overlay.classList.remove('visible');
                    overlay.setAttribute('aria-hidden', 'true');
                }
            };
        }

        if (this.page && typeof this.page.registerFocusSection === 'function') {
            this.page.registerFocusSection('modal-error-content', overlay.querySelector('.modal-actions'), {
                orientation: 'horizontal',
                enterTo: 'first'
            });
            focusManager.setActiveSection('modal-error-content');
            setTimeout(() => {
                if (btnOk) focusManager.focusElement(btnOk);
            }, 50);
        }
    }

    /**
     * Unbinds managed listeners.
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
     * Teardown hook.
     */
    destroy() {
        this._unbindListeners();
        this.page = null;
    }
}

export default PluginsTab;
