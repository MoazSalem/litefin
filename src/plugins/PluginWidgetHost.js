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
const HIDE_HYSTERESIS = 1;

// Ticks per second (Jellyfin standard)
const TICKS_PER_SECOND = 10_000_000;

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
        //   syncTimer: number|null— setTimeout ID for 8-second independent visibility window
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
            visible: alwaysVisible,
            syncTimer: null
        });

        // Bind Enter key action on the element (via click — standard OSD click delegation)
        if (typeof widget.onSelect === 'function') {
            el.addEventListener('click', (e) => {
                /*
                 * ========================================================================
                 * STOP EVENT BUBBLING:
                 * Prevent the click event (whether physical mouse/pointer click or JS
                 * focusedEl.click()) from bubbling up to OSDController's global click
                 * handler. This completely avoids executing OSD background click rules
                 * (e.g. togglePlay) for elements inside plugin widgets.
                 * ========================================================================
                 */
                e.stopPropagation();

                // Only handle clicks directly on focusable children (buttons)
                const btn = e.target.closest('button, [data-action]');
                if (btn) {
                    /*
                     * ========================================================================
                     * DETACHED WIDGET DELEGATION GUARD
                     * ========================================================================
                     * On Smart TV hardware (like Samsung Tizen and LG WebOS), the browser engine
                     * natively schedules and dispatches a synthetic mouse click event after the
                     * user presses the Enter/OK key on the remote control.
                     *
                     * If the keydown event handler immediately switches the track or destroys the
                     * OSD overlay, the old widget's DOM node is detached. However, the browser's
                     * event queue still holds the pending click event and dispatches it onto the
                     * detached element.
                     *
                     * By checking whether the widget's container is still connected to the active
                     * document body, we successfully intercept and ignore these stale events,
                     * preventing them from carrying over and skipping the next episode.
                     * ========================================================================
                     */
                    if (!document.body.contains(el)) {
                        log.info(`Ignoring click event on detached widget '${widget.id}'`);
                        return;
                    }

                    /*
                     * ========================================================================
                     * LOCKOUT ACTIVE GUARD:
                     * Prevent click event processing if the OSD is currently locked out
                     * (e.g. during track transition/cooldown phase). This blocks pointer
                     * clicks or synthesized click events from triggering skip actions
                     * immediately after track loading.
                     * ========================================================================
                     */
                    if (this._osd && this._osd._focusRestoreLockout) {
                        log.info(`Ignoring click event on widget '${widget.id}' during active focus restore lockout`);
                        return;
                    }

                    try {
                        /*
                         * ========================================================================
                         * SYNCHRONOUS VISIBILITY RESET ON SELECT
                         * ========================================================================
                         * When a widget action is selected (e.g. Skip Intro), we immediately hide the
                         * widget elements by setting visible=false and removing .visible/.sync-osd classes.
                         * This prevents the widget button from lingering on the screen for up to a second
                         * while waiting for the player's asynchronous seek and timeupdate to update.
                         * ========================================================================
                         */
                        const entry = this._widgets.get(widget.id);
                        if (entry) {
                            entry.visible = false;
                            entry.hideCounter = 0;
                            if (entry.syncTimer) {
                                clearTimeout(entry.syncTimer);
                                entry.syncTimer = null;
                            }
                            el.classList.remove('visible');
                            el.classList.remove('sync-osd');
                        }

                        widget.onSelect(api);

                        /*
                         * ========================================================================
                         * PREEMPTIVE FOCUS RESTORATION:
                         * Immediately shift OSD focus back to the Play/Pause playback controls.
                         * Selecting a segment skip action (like skip intro or skip outro) renders
                         * the current overlay button defunct/obsolete (either because we seeked
                         * past it, or because the track is ending). Leaving focus stranded on
                         * Row -1 causes navigation issues or carry-over bugs on next episode.
                         * ========================================================================
                         */
                        if (this._osd && typeof this._osd.restoreControlsFocus === 'function') {
                            this._osd.restoreControlsFocus();
                        }
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

        if (entry.syncTimer) {
            clearTimeout(entry.syncTimer);
        }

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
        /*
         * Track whether any of the removed widgets were actually visible before
         * teardown. If so, the OSD's focus row may be stranded at -1 (overlay row)
         * pointing at a now-defunct button — we need to explicitly restore focus.
         */
        let hadVisibleWidget = false;

        for (const [widgetId, entry] of this._widgets) {
            // Widget IDs are namespaced as '<pluginId>:<widgetId>'
            if (entry.pluginId === pluginId) {
                // Check visibility BEFORE removing so we know whether focus was active
                if (entry.visible) hadVisibleWidget = true;

                if (entry.syncTimer) {
                    clearTimeout(entry.syncTimer);
                }
                if (entry.el && entry.el.parentNode) {
                    entry.el.parentNode.removeChild(entry.el);
                }
                this._widgets.delete(widgetId);
            }
        }

        /*
         * ====================================================================
         * FOCUS RECOVERY:
         * If any of the removed widgets were visible, focus was likely parked
         * in the overlay row (Row -1) by focusPluginWidget(). Since the widget
         * is gone, we must pull focus back to the controls row — the same
         * recovery path taken by onTimeUpdate() when all widgets hide naturally.
         * ====================================================================
         */
        if (hadVisibleWidget && this._osd && typeof this._osd.restoreControlsFocus === 'function') {
            this._osd.restoreControlsFocus();
        } else {
            // No visible widgets were removed — a plain cache refresh is sufficient
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

        // Guard: During track transitions/lockouts, the player's position and duration
        // are unreliable and may briefly reflect the previous track's end state.
        if (this._osd && (this._osd._trackTransitionLockoutActive || (this._osd._playerPage && this._osd._playerPage._isSwitching))) {
            return;
        }

        let cacheInvalidated = false;
        // Track whether any widget just became visible (to trigger auto-focus)
        let justBecameVisible = false;

        // Detect manual seek (jump > 2 seconds) to bypass hysteresis
        const isSeek =
            this._lastPositionTicks !== undefined &&
            Math.abs(positionTicks - this._lastPositionTicks) > TICKS_PER_SECOND * 2;
        this._lastPositionTicks = positionTicks;

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
                // Widget just became visible — show it and flag for auto-focus
                entry.hideCounter = 0;
                entry.visible = true;
                el.classList.remove('sync-osd'); // Start completely independent
                el.classList.add('visible');

                // Clear any old timer
                if (entry.syncTimer) clearTimeout(entry.syncTimer);

                // After 5 seconds, sync visibility with the OSD
                entry.syncTimer = setTimeout(() => {
                    entry.syncTimer = null;
                    if (entry.visible) {
                        el.classList.add('sync-osd');
                        log.debug(`Widget '${widget.id}' now syncing visibility with OSD`);
                    }
                }, 5000);

                cacheInvalidated = true;
                justBecameVisible = true;
                log.debug(`Widget '${widget.id}' shown at ${positionTicks}`);
            } else if (!shouldShow && entry.visible) {
                // Hysteresis: require HIDE_HYSTERESIS consecutive "false" results before hiding
                // UNLESS the user just performed a manual seek (jumped > 2s of playback)
                entry.hideCounter++;

                if (isSeek || entry.hideCounter >= HIDE_HYSTERESIS) {
                    entry.hideCounter = 0;
                    entry.visible = false;
                    el.classList.remove('visible');
                    el.classList.remove('sync-osd');
                    if (entry.syncTimer) {
                        clearTimeout(entry.syncTimer);
                        entry.syncTimer = null;
                    }
                    cacheInvalidated = true;
                    log.debug(`Widget '${widget.id}' hidden at ${positionTicks} (isSeek=${isSeek})`);
                }
            } else if (shouldShow) {
                // Currently visible and should remain visible — reset hide counter
                entry.hideCounter = 0;
            }
        }

        if (cacheInvalidated) {
            // Check how many widgets are now visible
            const anyVisible = [...this._widgets.values()].some((e) => e.visible);

            if (justBecameVisible && anyVisible) {
                // A widget just appeared — claim focus only when the OSD is
                // hidden (user is watching without controls visible). If the OSD
                // is visible the user is actively in controls; let them navigate
                // up to the button themselves instead of stealing focus.
                // focusPluginWidget() also refreshes the cache internally.
                const osdIsHidden = this._osd && !this._osd._isOsdVisible;
                if (osdIsHidden && this._osd && typeof this._osd.focusPluginWidget === 'function') {
                    this._osd.focusPluginWidget(0);
                } else {
                    this._refreshOSDCache();
                }
            } else if (!anyVisible) {
                // All widgets are now hidden — return focus to the controls row
                // and re-enable the auto-hide timer.
                if (this._osd && typeof this._osd.restoreControlsFocus === 'function') {
                    this._osd.restoreControlsFocus();
                } else {
                    this._refreshOSDCache();
                }
            } else {
                // Some visibility changed but no new widget appeared — just refresh cache
                this._refreshOSDCache();
            }
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
                    /*
                     * ========================================================================
                     * LOCKOUT ACTIVE GUARD:
                     * Prevent key execution if the OSD is currently locked out. This blocks
                     * Enter/OK keys delegated to the widget from triggering skips on startup.
                     * ========================================================================
                     */
                    if (this._osd && this._osd._focusRestoreLockout) {
                        log.info(
                            `Ignoring enter key on widget '${entry.widget.id}' during active focus restore lockout`
                        );
                        return true;
                    }

                    try {
                        /*
                         * ========================================================================
                         * SYNCHRONOUS VISIBILITY RESET ON SELECT
                         * ========================================================================
                         * When a widget action is selected (e.g. Skip Intro), we immediately hide the
                         * widget elements by setting visible=false and removing .visible/.sync-osd classes.
                         * This prevents the widget button from lingering on the screen for up to a second
                         * while waiting for the player's asynchronous seek and timeupdate to update.
                         * ========================================================================
                         */
                        entry.visible = false;
                        entry.hideCounter = 0;
                        if (entry.syncTimer) {
                            clearTimeout(entry.syncTimer);
                            entry.syncTimer = null;
                        }
                        entry.el.classList.remove('visible');
                        entry.el.classList.remove('sync-osd');

                        entry.widget.onSelect(entry.api);

                        /*
                         * ========================================================================
                         * PREEMPTIVE FOCUS RESTORATION:
                         * Immediately pull focus back to the primary playback row after executing
                         * the skip segment action. This ensures the focus border does not linger
                         * on a button that is either about to hide or belongs to a track that is
                         * terminating, avoiding accidental double-skips.
                         * ========================================================================
                         */
                        if (this._osd && typeof this._osd.restoreControlsFocus === 'function') {
                            this._osd.restoreControlsFocus();
                        }
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
            if (entry.syncTimer) clearTimeout(entry.syncTimer);
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
