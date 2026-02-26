/**
 * ============================================================================
 * Litefin Tizen - PluginWidgetHost
 * ============================================================================
 * Manages the injection of plugin UI widgets into the OSD overlay layer.
 *
 * Background:
 *   The OSDController renders a `.osd-overlays` container (Row -1 in the OSD
 *   focus model). Existing widgets like Subtitle Offset and Playback Info live
 *   there. Their visible child elements are collected by _cacheFocusableElements()
 *   into _cachedOverlayRow — making them automatically focusable via D-pad.
 *
 *   PluginWidgetHost slots plugin widgets into this same container so they
 *   benefit from the exact same focus machinery with zero structural OSD changes.
 *
 * Widget Visibility:
 *   Each widget can implement shouldShow(positionTicks) → boolean.
 *   On every timeupdate tick, PluginWidgetHost evaluates this and toggles the
 *   `.visible` class on the widget's root element. After toggling, it triggers
 *   a focus cache refresh on the OSD so D-pad navigation stays correct.
 *
 *   To prevent thrashing at timestamp boundaries, we require 3 consecutive
 *   "hide" evaluations before actually hiding a widget (hysteresis).
 *
 * Usage:
 *   const host = new PluginWidgetHost(osdController);
 *   host.addWidget({ id: 'skip-intro', render() { ... }, shouldShow(t) { ... } }, api);
 *   host.onTimeUpdate(positionTicks);  // called by PluginManager
 *   host.destroy();
 * ============================================================================
 */

import { logger } from '../utils/Logger.js';

const log = logger.create('PluginWidgetHost');

// ============================================================================
// Constants
// ============================================================================

// Number of consecutive "hide" evaluations required before hiding a widget.
// This prevents flickering when playback position sits exactly on a boundary.
const HIDE_HYSTERESIS = 3;

// ============================================================================
// PluginWidgetHost Class
// ============================================================================
class PluginWidgetHost {
    /**
     * @param {Object} osd - OSDController instance
     */
    constructor(osd) {
        // Reference to the OSDController — needed for cache invalidation
        this._osd = osd;

        // Map<widgetId, WidgetEntry> where WidgetEntry = {
        //   widget: Object,       — the widget descriptor
        //   api: PluginAPI,       — the owning plugin's API (for onSelect callbacks)
        //   el: HTMLElement,      — the mounted root element
        //   pluginId: string,     — the owning plugin's ID
        //   hideCounter: number,  — consecutive hide evaluations (for hysteresis)
        //   visible: boolean      — current visibility state
        // }
        this._widgets = new Map();

        // The .osd-overlays container from the OSD — set in _attachToOSD()
        this._overlaysContainer = null;

        // Grab the container reference from the OSD
        this._attachToOSD();
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Find and store a reference to the .osd-overlays DOM container.
     * We do this once so we don't query the DOM on every widget add.
     * @private
     */
    _attachToOSD() {
        if (!this._osd || !this._osd._osdEl) {
            log.warn('OSD not yet rendered — widget host will attach lazily');
            return;
        }
        this._overlaysContainer = this._osd._osdEl.querySelector('.osd-overlays');
        if (!this._overlaysContainer) {
            log.error('.osd-overlays container not found in OSD DOM');
        } else {
            log.debug('Attached to .osd-overlays container');
        }
    }

    /**
     * Lazily attach to the OSD overlay container if it wasn't ready at construction time.
     * @private
     */
    _ensureAttached() {
        if (!this._overlaysContainer) {
            this._attachToOSD();
        }
        return !!this._overlaysContainer;
    }

    // ========================================================================
    // Widget Management
    // ========================================================================

    /**
     * Add a plugin widget to the OSD overlay layer.
     *
     * @param {Object} widget - Widget descriptor
     * @param {string} widget.id - Unique namespaced ID (e.g., 'skip-intro:skip-intro-btn')
     * @param {Function} widget.render - Returns an HTMLElement (the widget's root)
     * @param {Function} [widget.shouldShow] - (positionTicks) => boolean
     * @param {Function} [widget.onSelect] - Called when Enter is pressed while focused
     * @param {Function} [widget.handleKey] - (key) => boolean for custom input handling
     * @param {PluginAPI} api - The owning plugin's API instance
     */
    addWidget(widget, api) {
        if (!widget || !widget.id) {
            log.error('addWidget: widget must have an id');
            return;
        }

        if (this._widgets.has(widget.id)) {
            log.warn(`Widget '${widget.id}' is already registered — ignoring`);
            return;
        }

        if (!this._ensureAttached()) {
            log.error(`Cannot add widget '${widget.id}' — OSD overlay container not available`);
            return;
        }

        // Render the widget's root element
        let el;
        try {
            el = widget.render(api);
        } catch (err) {
            log.error(`Widget '${widget.id}' render() threw:`, err);
            return;
        }

        if (!el || !(el instanceof HTMLElement)) {
            log.error(`Widget '${widget.id}' render() must return an HTMLElement`);
            return;
        }

        // Add plugin widget marker classes for easy identification/cleanup
        el.classList.add('plugin-widget');
        el.dataset.pluginWidget = widget.id;

        // Widgets start hidden — shouldShow() controls visibility on timeupdate
        // If the widget has no shouldShow(), it's always visible once added
        const alwaysVisible = typeof widget.shouldShow !== 'function';
        if (alwaysVisible) {
            el.classList.add('visible');
        }

        // Extract the owner plugin's ID from the namespaced widget ID
        // Widget IDs follow the pattern '<pluginId>:<widgetId>'
        const pluginId = widget.id.split(':')[0];

        // Mount the element into the OSD overlays container
        this._overlaysContainer.appendChild(el);

        // Store full widget entry
        this._widgets.set(widget.id, {
            widget,
            api,
            el,
            pluginId,
            hideCounter: 0,
            visible: alwaysVisible
        });

        // Bind Enter key action on the element (via click — standard OSD click delegation)
        if (typeof widget.onSelect === 'function') {
            el.addEventListener('click', (e) => {
                // Only handle clicks directly on focusable children (buttons)
                const btn = e.target.closest('button, [data-action]');
                if (btn) {
                    try {
                        widget.onSelect(api);
                    } catch (err) {
                        log.error(`Widget '${widget.id}' onSelect() threw:`, err);
                    }
                }
            });
        }

        // Refresh OSD focus cache so the new widget's buttons are navigable
        this._refreshOSDCache();

        log.info(`Widget '${widget.id}' added to OSD overlays`);
    }

    /**
     * Remove a specific widget from the OSD overlay layer.
     * @param {string} widgetId - The namespaced widget ID
     */
    removeWidget(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry) return;

        // Remove from DOM
        if (entry.el && entry.el.parentNode) {
            entry.el.parentNode.removeChild(entry.el);
        }

        this._widgets.delete(widgetId);
        this._refreshOSDCache();

        log.debug(`Widget '${widgetId}' removed`);
    }

    /**
     * Remove all widgets belonging to a specific plugin.
     * Called by PluginAPI._destroy() when a plugin is unloaded.
     * @param {string} pluginId - The plugin's ID
     */
    removeAllWidgetsForPlugin(pluginId) {
        for (const [widgetId, entry] of this._widgets) {
            // Widget IDs are namespaced as '<pluginId>:<widgetId>'
            if (entry.pluginId === pluginId) {
                if (entry.el && entry.el.parentNode) {
                    entry.el.parentNode.removeChild(entry.el);
                }
                this._widgets.delete(widgetId);
            }
        }
        if (this._widgets.size === 0 || true) {
            this._refreshOSDCache();
        }
        log.debug(`All widgets for plugin '${pluginId}' removed`);
    }

    // ========================================================================
    // Visibility Control (called by PluginManager on timeupdate)
    // ========================================================================

    /**
     * Evaluate widget visibility for the current playback position.
     * Called on every timeupdate tick (~500ms).
     *
     * @param {number} positionTicks - Current playback position in ticks
     * @param {number} durationTicks - Total duration in ticks
     */
    onTimeUpdate(positionTicks, durationTicks) {
        if (this._widgets.size === 0) return;

        let cacheInvalidated = false;

        for (const [, entry] of this._widgets) {
            const { widget, el } = entry;

            // Widgets without shouldShow() are always visible — skip
            if (typeof widget.shouldShow !== 'function') continue;

            let shouldShow;
            try {
                shouldShow = widget.shouldShow(positionTicks, durationTicks);
            } catch (err) {
                log.error(`Widget '${widget.id}' shouldShow() threw:`, err);
                continue;
            }

            if (shouldShow && !entry.visible) {
                // Show the widget
                entry.hideCounter = 0;
                entry.visible = true;
                el.classList.add('visible');
                cacheInvalidated = true;
                log.debug(`Widget '${widget.id}' shown at ${positionTicks}`);
            } else if (!shouldShow && entry.visible) {
                // Hysteresis: require HIDE_HYSTERESIS consecutive "false" results before hiding
                entry.hideCounter++;

                if (entry.hideCounter >= HIDE_HYSTERESIS) {
                    entry.hideCounter = 0;
                    entry.visible = false;
                    el.classList.remove('visible');
                    cacheInvalidated = true;
                    log.debug(`Widget '${widget.id}' hidden at ${positionTicks}`);
                }
            } else if (shouldShow) {
                // Currently visible and should remain visible — reset hide counter
                entry.hideCounter = 0;
            }
        }

        // Only refresh OSD focus cache if any visibility changed
        if (cacheInvalidated) {
            this._refreshOSDCache();
        }
    }

    /**
     * Forward a key event to the currently focused plugin widget.
     * Called by OSDController.handleInput() when focus is in the overlay row.
     *
     * @param {string} key - The key event name (e.g., 'enter', 'left', 'right')
     * @param {HTMLElement} focusedEl - The currently focused DOM element
     * @returns {boolean} True if the event was consumed by a widget
     */
    handleKey(key, focusedEl) {
        // Find which widget owns the focused element
        for (const [, entry] of this._widgets) {
            if (entry.visible && entry.el.contains(focusedEl)) {
                if (typeof entry.widget.handleKey === 'function') {
                    try {
                        // Let the widget handle it first
                        if (entry.widget.handleKey(key, entry.api)) {
                            return true;
                        }
                    } catch (err) {
                        log.error(`Widget '${entry.widget.id}' handleKey() threw:`, err);
                    }
                }

                // If key is Enter and widget has onSelect, trigger it
                if (key === 'enter' && typeof entry.widget.onSelect === 'function') {
                    try {
                        entry.widget.onSelect(entry.api);
                        return true;
                    } catch (err) {
                        log.error(`Widget '${entry.widget.id}' onSelect() threw:`, err);
                    }
                }

                // Widget found but didn't consume — break out to prevent other widgets from reacting
                break;
            }
        }
        return false;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Hide and remove all widgets, detach from OSD.
     */
    destroy() {
        for (const [, entry] of this._widgets) {
            if (entry.el && entry.el.parentNode) {
                entry.el.parentNode.removeChild(entry.el);
            }
        }
        this._widgets.clear();
        this._overlaysContainer = null;
        this._osd = null;
        log.debug('PluginWidgetHost destroyed');
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    /**
     * Tell the OSD to refresh its focusable element cache.
     * This is critical after any visibility change so D-pad navigation
     * correctly includes/excludes the plugin widget's buttons.
     * @private
     */
    _refreshOSDCache() {
        if (this._osd && typeof this._osd._cacheFocusableElements === 'function') {
            this._osd._cacheFocusableElements();
        }
    }
}

export default PluginWidgetHost;
