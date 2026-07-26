/**
 * ============================================================================
 * QueueModal
 * ============================================================================
 * Full-screen modal overlay that shows the current play queue. The currently
 * playing item is highlighted and scrolled into view when the modal opens.
 *
 * Key behaviours:
 *  - Up/Down  : Navigate between queue rows.
 *  - Enter    : Instantly skip to the selected queue item.
 *  - Back     : Close without changing playback.
 *  - Live update: Listens for 'playqueue:updated' to refresh the list if the
 *                 queue changes (e.g. next episode loads).
 *
 * Extends BaseMenu so OSDController treats it as a full-screen blocking modal.
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';
import { playQueue } from '../../core/PlayQueue.js';
import { eventBus } from '../../core/EventBus.js';
import lazyLoader from '../../utils/LazyLoader.js';

export default class QueueModal extends BaseMenu {

    constructor(osdController) {
        super(osdController);

        /* Full-screen blocking modal. */
        this.isModal = true;

        /**
         * Snapshot of the queue at the time the modal was opened (or last
         * refreshed after a playqueue:updated event).
         * @type {Object[]}
         */
        this._queueSnapshot = [];

        /**
         * Index of the currently playing item inside _queueSnapshot.
         * @type {number}
         */
        this._currentIndex = 0;

        /* Bind so we can remove the listener in destroy(). */
        this._onQueueUpdated = this._handleQueueUpdate.bind(this);
        eventBus.on('playqueue:updated', this._onQueueUpdated);
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Clean up the event listener when the OSD is destroyed.
     */
    destroy() {
        eventBus.off('playqueue:updated', this._onQueueUpdated);
        super.destroy();
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Open the queue modal.
     * Takes a snapshot of the current queue and renders the list.
     */
    open() {
        this._takeQueueSnapshot();
        this.focusIndex = this._currentIndex;

        this.render();
        this.show();
        
        /* Ignore Enter keys for 300ms after opening */
        this._openedAt = Date.now();
    }

    show() {
        /* Capture focus context before opening */
        this._prevRow = this.osd._currentFocusRow;
        this._prevIndex = this.osd._currentFocusIndex;
        super.show();

        /*
         * Scroll the active item into view AFTER .visible is applied so the
         * panel is already transitioning on-screen. Calling scrollIntoView()
         * while the panel is still at translate3d(100%, 0, 0) (off-screen)
         * confuses the browser’s scroll container detection on WebOS and can
         * produce a viewport shift that compounds the flicker.
         */
        this._scrollActiveIntoView();
    }

    hide() {
        super.hide();
        
        /* Restore focus conditionally */
        if (this._restoreFocusToPlayPause) {
            this.osd._currentFocusRow = 1;
            const playIdx = this.osd._findActionIndex('togglePlay');
            this.osd._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this.osd._updateFocus();
            this._restoreFocusToPlayPause = false; // Reset for next time
        } else if (this._prevRow !== undefined) {
            this.osd._currentFocusRow = this._prevRow;
            this.osd._currentFocusIndex = this._prevIndex;
            this.osd._updateFocus();
        }
    }

    // =========================================================================
    // BaseMenu Overrides
    // =========================================================================

    /**
     * Renders the modal DOM and appends it into .osd-overlays.
     * Safe to call multiple times — replaces the existing element if present.
     */
    render() {
        /* Remove any stale render before rebuilding. */
        if (this.$el) {
            const savedFocusIndex = this.focusIndex;
            this.$el.remove();
            this.$el = null;
            this.focusIndex = savedFocusIndex;
        }

        const overlay = document.createElement('div');
        overlay.className = 'queue-modal-overlay';

        const rowsHtml = this._queueSnapshot.map((item, index) => {
            /* Poster art — use the API client reachable via osd._api,
             * following the same pattern as UpNextDialog._buildThumbnailUrl(). */
            /* Poster art — use the API client reachable via osd._api */
            const apiClient = this.osd._api;
            const thumbUrl = apiClient
                ? apiClient.getImageUrl(item.Id, 'Primary', { maxHeight: 120 })
                : '';

            const name = item.Name || 'Unknown';

            // --- Fallback Data ---
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = name.charCodeAt(i) + ((hash << 5) - hash);
            }
            const gradIndex = (Math.abs(hash) % 6) + 1;
            const words = name.split(/[\s_-]+/);
            let initials = words[0] ? words[0][0] : '?';
            if (words.length > 1 && words[1]) initials += words[1][0];
            initials = initials.toUpperCase();

            /* Build a subtitle line for episodes: "S01E03 — Show Name". */
            let subtitle = '';
            if (item.Type === 'Episode') {
                const s = item.ParentIndexNumber != null ? `S${item.ParentIndexNumber.toString().padStart(2, '0')}` : '';
                const e = item.IndexNumber != null ? `E${item.IndexNumber.toString().padStart(2, '0')}` : '';
                const badge = [s, e].filter(Boolean).join('');
                subtitle = badge ? `${badge}${item.SeriesName ? ` — ${item.SeriesName}` : ''}` : (item.SeriesName || '');
            } else if (item.AlbumArtist) {
                subtitle = item.AlbumArtist;
            } else if (item.ProductionYear) {
                subtitle = String(item.ProductionYear);
            }

            const isActive = index === this._currentIndex;

            return `
                <div class="queue-row ${isActive ? 'queue-row--active' : ''}"
                     data-index="${index}"
                     tabindex="${isActive ? '0' : '-1'}">

                    <!-- Queue position badge -->
                    <span class="queue-row__number">${index + 1}</span>

                    <!-- Poster thumbnail -->
                    <div class="queue-row__thumb-wrap ${thumbUrl ? 'skeleton-shimmer' : ''}">
                        ${thumbUrl
                            ? `<img class="queue-row__thumb lazy" 
                                    src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" 
                                    data-src="${thumbUrl}" 
                                    data-fb-grad="${gradIndex}"
                                    data-fb-init="${initials}"
                                    data-fb-name="${name}"
                                    alt="" />`
                            : this._getFallbackHtml(name)
                        }
                        ${isActive ? '<div class="queue-row__playing-indicator"></div>' : ''}
                    </div>

                    <!-- Item info -->
                    <div class="queue-row__info">
                        <span class="queue-row__name">${item.Name || 'Unknown'}</span>
                        ${subtitle ? `<span class="queue-row__subtitle">${subtitle}</span>` : ''}
                    </div>
                </div>
            `;
        }).join('');

        overlay.innerHTML = `
            <div class="queue-modal">
                <!-- Modal header -->
                <div class="queue-modal__header">
                    <span class="queue-modal__title">Up Next</span>
                    <span class="queue-modal__count">${this._queueSnapshot.length} items</span>
                </div>

                <!-- Scrollable queue list -->
                <div class="queue-modal__list" id="queueModalList">
                    ${rowsHtml || '<p class="queue-modal__empty">Queue is empty.</p>'}
                </div>
            </div>
        `;

        const overlaysEl = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlaysEl) {
            overlaysEl.appendChild(overlay);
        }

        this.$el = overlay;

        /*
         * ---------------------------------------------------------------------
         * BACKDROP CLICK DISMISSAL
         * ---------------------------------------------------------------------
         * Add event listener to the outer overlay backdrop. Clicking on the
         * empty space surrounding the queue modal panel will dismiss it and
         * restore control focus to the OSD.
         * ---------------------------------------------------------------------
         */
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                this.log.info('QueueModal backdrop clicked, closing queue overlay');
                this._close();
            }
        });

        /* Enable lazy loading for thumbnails. */
        const listEl = overlay.querySelector('.queue-modal__list');
        if (listEl) {
            lazyLoader.observe(listEl);
        }

        /*
         * NOTE: _scrollActiveIntoView() is intentionally NOT called here.
         * render() runs before show() adds the .visible class, meaning the
         * panel is still at translate3d(100%, 0, 0) (off-screen). Scrolling
         * an off-screen element causes undefined browser behavior on WebOS.
         * The scroll is deferred to show() instead.
         */
    }

    /**
     * Handle key input while the modal is open.
     *
     * @param {string} key - Action key name.
     * @returns {boolean} True if the key was consumed.
     */
    handleKey(key) {
        switch (key) {
            case 'up':
                this._moveFocus(-1);
                return true;

            case 'down':
                this._moveFocus(1);
                return true;

            case 'enter': {
                /* DEBOUNCE: Ignore Enter keys fired immediately after opening */
                if (this._openedAt && (Date.now() - this._openedAt < 300)) {
                    this.log.info('Ignoring Enter key immediately after modal open');
                    return true;
                }

                /* Instant skip: override the queue index and emit a play event
                 * so OSDController / PlayerPage can react to the jump. */
                if (this.focusIndex !== this._currentIndex) {
                    this.log.info(`Queue jump: index ${this._currentIndex} → ${this.focusIndex}`);

                    /* Move the queue cursor to the selected item. */
                    playQueue.setQueue(this._queueSnapshot, this.focusIndex);

                    /* Tell the player page to load the new current item. */
                    this.osd.emit('playQueueItem', this.focusIndex);
                }
                
                /* Selection made: route focus to Play/Pause when hiding. */
                this._restoreFocusToPlayPause = true;
                this._close();
                return true;
            }

            case 'back':
                /*
                 * -------------------------------------------------------------
                 * BACK KEY EXIT PATH
                 * -------------------------------------------------------------
                 * Close the modal and return focus to the previous item.
                 * -------------------------------------------------------------
                 */
                this._close();
                return true;

            case 'left':
                /*
                 * -------------------------------------------------------------
                 * DPAD LEFT EXIT PATH
                 * -------------------------------------------------------------
                 * Added to provide a swift, intuitive D-pad navigation flow.
                 * Pressing left will dismiss the modal, returning focus to the
                 * player's main playback controls bar.
                 * -------------------------------------------------------------
                 */
                this._close();
                return true;

            default:
                return false;
        }
    }

    /**
     * Update the visual focus ring.
     * Called by BaseMenu.show() and by _moveFocus().
     */
    updateFocus() {
        if (!this.$el) return;

        this.$el.querySelectorAll('.queue-row').forEach((row) => {
            row.classList.remove('focused');
        });

        const focused = this.$el.querySelector(`.queue-row[data-index="${this.focusIndex}"]`);
        if (focused) {
            focused.classList.add('focused');
            /*
             * Use 'instant' instead of 'smooth' here — this is called during the
             * panel’s slide-in animation, and running a smooth scroll simultaneously
             * creates two competing animations on the same element. On WebOS this
             * can cause the renderer to drop frames and produce additional flicker.
             */
            focused.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            focused.focus({ preventScroll: true });
        }
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Take a snapshot of the current queue state for rendering.
     * @private
     */
    _takeQueueSnapshot() {
        this._queueSnapshot = playQueue.getQueue() || [];
        this._currentIndex  = playQueue.getCurrentIndex() ?? 0;
    }

    /**
     * Move the focus cursor by a delta and clamp to list boundaries.
     * @param {number} delta
     * @private
     */
    _moveFocus(delta) {
        const count = this._queueSnapshot.length;
        if (count === 0) return;

        this.focusIndex = Math.max(0, Math.min(count - 1, this.focusIndex + delta));
        this.updateFocus();
    }

    /**
     * Close the modal and return OSD focus to the controls row.
     * @private
     */
    _close() {
        this.osd.closeMenu();
    }

    /**
     * Scroll the currently-playing queue row to the middle of the list
     * without animation so the user sees it immediately on open.
     * @private
     */
    _scrollActiveIntoView() {
        if (!this.$el) return;

        const activeRow = this.$el.querySelector('.queue-row--active');
        if (activeRow) {
            activeRow.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    }

    /**
     * React to external queue changes (e.g. a new episode auto-loads).
     * Re-takes a snapshot and re-renders the list while keeping isVisible state.
     * @private
     */
    _handleQueueUpdate() {
        if (!this.isVisible) return;

        this.log.info('Queue updated while modal is open — re-rendering.');
        this._takeQueueSnapshot();
        this.render();
        this.updateFocus();
    }

    /**
     * Helper to load a fallback gradient card with initials
     * @private
     */
    _getFallbackHtml(name) {
        // Simple hash to consistently pick a gradient (1-6)
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        const gradNum = (Math.abs(hash) % 6) + 1;

        // Get Initials (up to 2 characters)
        const words = name.split(/[\s_-]+/);
        let initials = words[0] ? words[0][0] : '?';
        if (words.length > 1 && words[1]) initials += words[1][0];
        initials = initials.toUpperCase();

        return `
            <div class="media-fallback grad-${gradNum}">
                <div class="media-fallback-initials">${initials}</div>
                <div class="media-fallback-name">${name}</div>
            </div>
        `;
    }
}
