/**
 * ============================================================================
 * ChaptersModal
 * ============================================================================
 * Full-screen modal overlay that lists all chapters for the currently playing
 * item. The active (currently playing) chapter is highlighted and automatically
 * scrolled into view when the modal opens.
 *
 * Key behaviours:
 *  - Up/Down  : Navigate between chapter rows.
 *  - Enter    : Seek to the selected chapter's StartPositionTicks and close.
 *  - Back     : Close without seeking.
 *  - Auto-scroll: On open, the active chapter is always visible without manual
 *                 scrolling.
 *
 * Extends BaseMenu so OSDController treats it as a modal (blocks OSD
 * auto-hide, forwards all key events here).
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';

export default class ChaptersModal extends BaseMenu {

    constructor(osdController) {
        super(osdController);

        /* Tell OSDController this is a full-screen blocking modal. */
        this.isModal = true;

        /**
         * The full chapters array for the current item.
         * Set by open() before show() is called.
         * @type {Array<{Name:string, StartPositionTicks:number}>}
         */
        this._chapters = [];

        /**
         * Index of the currently active (playing) chapter.
         * Calculated in open() from the current playback position.
         * @type {number}
         */
        this._activeChapterIndex = 0;

        /**
         * The media item being played (needed for chapter thumbnails).
         * @type {Object|null}
         */
        this._currentItem = null;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Open the chapters modal.
     *
     * @param {Array}   chapters            - Array of chapter objects from the
     *                                        Jellyfin item (item.Chapters).
     * @param {number}  currentPositionTicks - Current playback position in
     *                                        100-nanosecond ticks.
     * @param {Object}  item               - The currently playing media item.
     */
    open(chapters, currentPositionTicks, item) {
        /* Store the data needed for rendering. */
        this._chapters = chapters || [];
        this._currentItem = item;

        /* Determine which chapter is currently active by finding the last
         * chapter whose StartPositionTicks is ≤ the current position. */
        this._activeChapterIndex = 0;
        for (let i = this._chapters.length - 1; i >= 0; i--) {
            if (this._chapters[i].StartPositionTicks <= currentPositionTicks) {
                this._activeChapterIndex = i;
                break;
            }
        }

        /* Set the initial focus to the active chapter. */
        this.focusIndex = this._activeChapterIndex;

        /* Render (or re-render if called again while open). */
        this.render();
        this.show();
        
        /* Ignore Enter keys for 300ms after opening */
        this._openedAt = Date.now();
    }

    // =========================================================================
    // BaseMenu Overrides
    // =========================================================================

    /**
     * Renders the modal DOM and appends it into .osd-overlays.
     * Safe to call multiple times — replaces the existing element if present.
     */
    render() {
        /* Remove any previous render before building a fresh one. */
        if (this.$el) {
            this.$el.remove();
            this.$el = null;
        }

        /* The outer overlay covers the whole screen with a translucent backdrop. */
        const overlay = document.createElement('div');
        overlay.className = 'chapters-modal-overlay';

        /* Build each chapter row. */
        const rowsHtml = this._chapters.map((chapter, index) => {
            /* Format StartPositionTicks (100-ns units) → HH:MM:SS or MM:SS. */
            const timestamp = this._formatTicks(chapter.StartPositionTicks);

            /* Chapter thumbnail URL — Jellyfin serves chapter images via the
             * Items/{itemId}/Images/Chapter/{index} endpoint.
             * We access the API client via osd._api (same pattern as UpNextDialog).
             * Avoid the import-level `api` — that doesn't exist as a module export. */
            const apiClient = this.osd._api;
            let thumbUrl = null;
            if (apiClient && this._currentItem) {
                /* Build the URL manually because getImageUrl only builds paths for
                 * Primary/Backdrop/etc. — Chapter images need the index in the path. */
                const params = new URLSearchParams({ maxWidth: '200' });
                const path = `/Items/${this._currentItem.Id}/Images/Chapter/${index}?${params.toString()}`;
                thumbUrl = apiClient.buildUrl(path);
            }

            /* Active chapter gets a highlighted class and the playing indicator. */
            const isActive = index === this._activeChapterIndex;

            return `
                <div class="chapter-row ${isActive ? 'chapter-row--active' : ''}"
                     data-index="${index}"
                     tabindex="${isActive ? '0' : '-1'}">

                    <!-- Chapter thumbnail (optional) -->
                    <div class="chapter-row__thumb-wrap">
                        ${thumbUrl
                            ? `<img class="chapter-row__thumb" src="${thumbUrl}" alt="" loading="lazy" />`
                            : '<div class="chapter-row__thumb-placeholder"></div>'
                        }
                        ${isActive ? '<div class="chapter-row__playing-dot"></div>' : ''}
                    </div>

                    <!-- Chapter info -->
                    <div class="chapter-row__info">
                        <span class="chapter-row__name">${chapter.Name || `Chapter ${index + 1}`}</span>
                        <span class="chapter-row__time">${timestamp}</span>
                    </div>
                </div>
            `;
        }).join('');

        overlay.innerHTML = `
            <div class="chapters-modal">
                <!-- Header -->
                <div class="chapters-modal__header">
                    <span class="chapters-modal__title">Chapters</span>
                    <span class="chapters-modal__count">${this._chapters.length} chapters</span>
                </div>

                <!-- Scrollable chapter list -->
                <div class="chapters-modal__list" id="chaptersModalList">
                    ${rowsHtml || '<p class="chapters-modal__empty">No chapters available.</p>'}
                </div>
            </div>
        `;

        /* Append into the OSD overlays container so it sits above the video. */
        const overlaysEl = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlaysEl) {
            overlaysEl.appendChild(overlay);
        }

        this.$el = overlay;

        /* After the DOM is in place, scroll the active chapter into view. */
        this._scrollActiveIntoView();
    }

    /**
     * Handle key input while the modal is open.
     * OSDController delegates to here when isModal is true and the modal is
     * the activeMenu.
     *
     * @param {string} key - Action key name ('up', 'down', 'enter', 'back').
     * @returns {boolean} True if the key was handled, false to bubble up.
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

                /* Seek to the selected chapter and close the modal. */
                const chapter = this._chapters[this.focusIndex];
                if (chapter && this.osd.player && this.osd.player.seek) {
                    this.log.info(`Seeking to chapter ${this.focusIndex}: "${chapter.Name}" @ ${chapter.StartPositionTicks}`);
                    this.osd.player.seek(chapter.StartPositionTicks);
                }
                this._close();
                return true;
            }

            case 'back':
                this._close();
                return true;

            default:
                return false;
        }
    }

    /**
     * Update focus highlight within the chapter list.
     * Called by BaseMenu.show() and by _moveFocus().
     */
    updateFocus() {
        if (!this.$el) return;

        /* Remove focused class from all rows. */
        this.$el.querySelectorAll('.chapter-row').forEach((row) => {
            row.classList.remove('focused');
        });

        /* Highlight the currently focused row. */
        const focused = this.$el.querySelector(`.chapter-row[data-index="${this.focusIndex}"]`);
        if (focused) {
            focused.classList.add('focused');
            /* Keep the focused row visible within the scrollable list. */
            focused.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            /* Physically move DOM focus to catch remote key events safely. */
            focused.focus({ preventScroll: true });
        }
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /**
     * Move the focus cursor by a delta and wrap at the list boundaries.
     * @param {number} delta - +1 to move down, -1 to move up.
     * @private
     */
    _moveFocus(delta) {
        const count = this._chapters.length;
        if (count === 0) return;

        /* Clamp instead of wrap — more natural on TV D-pad. */
        this.focusIndex = Math.max(0, Math.min(count - 1, this.focusIndex + delta));
        this.updateFocus();
    }

    /**
     * Close the modal and restore OSD controls focus.
     * @private
     */
    _close() {
        this.osd.closeMenu();
    }

    /**
     * Scroll the active chapter row into the centre of the list container
     * without any animation so it's instantly visible on open.
     * @private
     */
    _scrollActiveIntoView() {
        if (!this.$el) return;

        const activeRow = this.$el.querySelector('.chapter-row--active');
        if (activeRow) {
            activeRow.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    }

    /**
     * Format Jellyfin ticks (100-ns units) to a readable timestamp string.
     * Uses h:mm:ss for content longer than an hour, otherwise mm:ss.
     *
     * @param  {number} ticks - Position in 100-nanosecond ticks.
     * @returns {string}        Formatted timestamp, e.g. "1:23:45" or "05:30".
     * @private
     */
    _formatTicks(ticks) {
        /* Convert 100-ns ticks → whole seconds. */
        const totalSeconds = Math.floor(ticks / 10_000_000);
        const hours   = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const pad = (n) => String(n).padStart(2, '0');

        if (hours > 0) {
            return `${hours}:${pad(minutes)}:${pad(seconds)}`;
        }
        return `${pad(minutes)}:${pad(seconds)}`;
    }
}
