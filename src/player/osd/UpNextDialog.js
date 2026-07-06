/**
 * ============================================================================
 * Litefin Tizen - Up Next Dialog
 * ============================================================================
 *
 * Displays a "Coming Up Next" card near the end of an episode (roughly the
 * last 30-40 seconds, scaled by runtime length — same thresholds as Jellyfin
 * Web's upnextdialog).
 *
 * Architecture:
 *   - Extends BaseMenu with isModal = false, so it is a persistent overlay
 *     that does NOT block the OSD's auto-hide or other widgets.
 *   - Lives inside .osd-overlays (Row -1 in OSD focus navigation).
 *   - Focus can freely move between the dialog buttons, skip-outro buttons,
 *     subtitle offset, and playback info — they all share the overlay row.
 *   - RTL-aware: positioned bottom-right (LTR) or bottom-left (RTL) via CSS.
 *
 * Trigger logic (managed externally by OSDController.showUpNextIfNeeded()):
 *   - Auto-shows when time remaining falls within the threshold window.
 *   - Auto-hides when the user seeks back past the threshold.
 *   - Never shows when there is no next item in the queue, the current item is
 *     not an Episode, or the enableNextEpisodeAutoPlay setting is off.
 * ============================================================================
 */

import BaseMenu from './BaseMenu.js';
import { i18n } from '../../utils/i18n.js';
import { shouldShowScore } from '../../utils/visibility.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { detailsIcons } from '../../utils/Icons.js';

/**
 * UpNextDialog
 *
 * Persistent overlay card that previews the next episode in the queue.
 * Shown automatically near the end of an episode; dismissed or acted upon
 * by the user via "Play Now" or "Hide" buttons.
 */
export default class UpNextDialog extends BaseMenu {
    constructor(osdController) {
        super(osdController);

        /*
         * Not a modal — this dialog floats above the video without blocking
         * OSD controls or other overlay widgets. It stays visible even when
         * the user navigates away to subtitles offset or skip-outro buttons.
         */
        this.isModal = false;

        /**
         * The next media item currently being previewed.
         * Set via setNextItem() before show() is called.
         * @type {Object|null}
         */
        this._nextItem = null;

        /**
         * Tracks which button has focus within this dialog (0 = Play Now, 1 = Hide).
         * @type {number}
         */
        this._focusedButton = 0;

        /**
         * Countdown interval ID while the dialog is visible.
         * @type {number|null}
         */
        this._countdownInterval = null;

        /**
         * Remaining seconds when the dialog was first shown — used for initial
         * countdown display before the first interval tick.
         * @type {number}
         */
        this._initialSecondsRemaining = 0;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /**
     * Populate the card with the next item's metadata and thumbnail.
     * Must be called before show().
     *
     * @param {Object} item - Jellyfin media item object from PlayQueue.peekNext()
     */
    setNextItem(item) {
        this._nextItem = item;

        // If already rendered, update the content live
        if (this.$el) {
            this._populateContent();
        }
    }

    /**
     * Update the countdown text ("Starting in X seconds" / static next-up label).
     * Called every second from showUpNextIfNeeded() in OSDController.
     *
     * =========================================================================
     * AUTO PLAY ADAPTIVITY GUARD
     * =========================================================================
     * If the user disabled 'enableNextEpisodeAutoPlay' (play next episode
     * automatically), we STILL want to show the dialog so they can manually
     * trigger playback if desired. However, telling them that the episode is
     * "Starting in X seconds" when autoplay is off is extremely misleading.
     * In this case, we simply blank out the countdown text entirely.
     * =========================================================================
     *
     * @param {number} secondsRemaining - Number of full seconds left in the episode
     */
    updateCountdown(secondsRemaining) {
        // Fast exit: do nothing if DOM element is not ready or the dialog isn't visible
        if (!this.$el || !this.isVisible) return;

        // Cache the remaining seconds for potential subsequent updates
        this._initialSecondsRemaining = secondsRemaining;

        // Locate the countdown text wrapper inside our card template
        const countdownEl = this.$el.querySelector('.upnext-countdown');
        
        // Ensure the element is found before manipulating it
        if (countdownEl) {
            // Read active style to determine formatting
            const style = PlayerSettings.get('nextUpDialogStyle') || 'normal';
            // =================================================================
            // AutoPlay State Branching
            // =================================================================
            // Read active preference to see if automatic queue traversal is active.
            if (PlayerSettings.get('enableNextEpisodeAutoPlay')) {
                // If it is compact, we wrap it in parentheses for the button label context, e.g. " (15s)"
                if (style === 'compact') {
                    countdownEl.textContent = ` (${secondsRemaining}s)`;
                } else {
                    // Autoplay is enabled: show the standard live countdown text
                    // "Starting in 28s" - falls back gracefully to default translation
                    countdownEl.textContent = i18n.t('NextEpisodeStartsIn', [secondsRemaining]);
                }
            } else {
                // Autoplay is disabled: blank out countdown to avoid false promises
                countdownEl.textContent = '';
            }
        }
    }

    // =========================================================================
    // BaseMenu overrides
    // =========================================================================

    /**
     * Render the dialog DOM and append it into .osd-overlays.
     * Following the exact pattern used by PlaybackInfo.render().
     */
    render() {
        const style = PlayerSettings.get('nextUpDialogStyle') || 'normal';
        let html = '';

        if (style === 'compact') {
            /*
             * Compact Style:
             * Renders as a single skip-intro style pill button with localized CTA text,
             * countdown, and arrow micro-animation.
             */
            html = `
                <div class="upnext-dialog upnext-style-compact" id="upNextDialog">
                    <button
                        class="upnext-btn upnext-btn-play"
                        tabindex="0"
                        data-upnext-action="play"
                    >
                        <span class="upnext-compact-label">${i18n.t('StartNextEpisode') || 'Start Next Episode'}</span>
                        <span class="upnext-countdown"></span>
                        <span class="upnext-compact-arrow">➔</span>
                    </button>
                </div>
            `;
        } else if (style === 'no_image') {
            /*
             * No Image Style:
             * Identical to the standard layout but omits the thumbnail wrap.
             */
            html = `
                <div class="upnext-dialog upnext-style-no-image" id="upNextDialog">
                    <div class="upnext-content-row">
                        <div class="upnext-info">
                            <span class="upnext-label">${i18n.t('HeaderUpNext')}</span>
                            <span class="upnext-series"></span>
                            <span class="upnext-title"></span>
                            <div class="upnext-meta">
                                <span class="upnext-rating"></span>
                                <span class="upnext-countdown"></span>
                            </div>
                        </div>
                    </div>
                    <div class="upnext-actions">
                        <button
                            class="upnext-btn upnext-btn-play"
                            tabindex="0"
                            data-upnext-action="play"
                        >${i18n.t('ButtonPlay')}</button>
                        <button
                            class="upnext-btn upnext-btn-hide"
                            tabindex="0"
                            data-upnext-action="hide"
                        >${i18n.t('ButtonHide')}</button>
                    </div>
                </div>
            `;
        } else {
            /*
             * Normal Style:
             * Standard layout with thumbnail + details metadata.
             */
            html = `
                <div class="upnext-dialog" id="upNextDialog">
                    <div class="upnext-content-row">
                        <div class="upnext-thumbnail-wrap">
                            <img class="upnext-thumbnail" alt="" />
                            <span class="upnext-badge"></span>
                        </div>
                        <div class="upnext-info">
                            <span class="upnext-label">${i18n.t('HeaderUpNext')}</span>
                            <span class="upnext-series"></span>
                            <span class="upnext-title"></span>
                            <div class="upnext-meta">
                                <span class="upnext-rating"></span>
                                <span class="upnext-countdown"></span>
                            </div>
                        </div>
                    </div>
                    <div class="upnext-actions">
                        <button
                            class="upnext-btn upnext-btn-play"
                            tabindex="0"
                            data-upnext-action="play"
                        >${i18n.t('ButtonPlay')}</button>
                        <button
                            class="upnext-btn upnext-btn-hide"
                            tabindex="0"
                            data-upnext-action="hide"
                        >${i18n.t('ButtonHide')}</button>
                    </div>
                </div>
            `;
        }

        // Inject into the shared overlay container (same as PlaybackInfo / SubtitleOffset)
        const overlays = this.osd._osdEl.querySelector('.osd-overlays');
        if (overlays) {
            const temp = document.createElement('div');
            temp.innerHTML = html.trim();
            this.$el = temp.firstElementChild;
            
            // Set customization scale CSS property variable
            const scale = PlayerSettings.get('nextUpDialogScale') || 1.0;
            this.$el.style.setProperty('--upnext-scale', scale);

            overlays.appendChild(this.$el);

            // Wire click handlers for mouse/touch users
            const playBtn = this.$el.querySelector('[data-upnext-action="play"]');
            if (playBtn) {
                playBtn.addEventListener('click', () => {
                    this._triggerPlayNow();
                });
            }
            
            const hideBtn = this.$el.querySelector('[data-upnext-action="hide"]');
            if (hideBtn) {
                hideBtn.addEventListener('click', () => {
                    this.osd.hideUpNext();
                });
            }
        }

        // Populate with whatever item was already set
        if (this._nextItem) {
            this._populateContent();
        }
    }

    /**
     * Show the dialog, render if not yet built, and move focus to "Play Now".
     * After the base show() we refresh the OSD's focusable element cache so
     * the buttons are immediately reachable via D-pad navigation.
     */
    show() {
        // Lazy-render on first show
        if (!this.$el) {
            this.render();
        } else {
            // Update scale if already rendered
            const scale = PlayerSettings.get('nextUpDialogScale') || 1.0;
            this.$el.style.setProperty('--upnext-scale', scale);
        }

        if (!this.$el) return; // Bail if render failed (no overlay container yet)

        // Call BaseMenu.show() to add .visible class
        super.show();

        // Always start focus on "Play Now" when the dialog appears
        this._focusedButton = 0;
        this._updateButtonFocus();

        // Rebuild overlay focus cache so D-pad navigation sees these buttons
        this.osd._cacheFocusableElements();
    }

    /**
     * Hide the dialog and clean up the countdown timer.
     */
    hide() {
        // Call BaseMenu.hide() to remove .visible class
        super.hide();

        // Stop the countdown interval if it was running
        this._stopCountdown();

        // Rebuild cache so D-pad no longer routes to these (now invisible) buttons
        if (this.osd && this.osd._cacheFocusableElements) {
            this.osd._cacheFocusableElements();
        }
    }

    /**
     * Handle key input when focus is on this dialog (Row -1, activeMenu = this).
     * Returns true if the key was consumed, false to let OSDController handle it.
     *
     * @param {string} key - Key name from OSDController.handleInput()
     * @returns {boolean}
     */
    handleKey(key) {
        if (!this.isVisible) return false;

        /*
         * In RTL layouts (e.g. Arabic), Play Now is physically on the RIGHT
         * and Hide is on the LEFT. Swap left/right so the physical direction
         * of the D-pad matches what the user expects to happen.
         */
        const isRTL = document.documentElement.dir === 'rtl';
        const prevAction = isRTL ? 'right' : 'left';
        const nextAction = isRTL ? 'left' : 'right';

        const buttons = this.$el?.querySelectorAll('.upnext-btn') || [];

        switch (key) {
            case prevAction: {
                // Move from Hide → Play Now, or exit left to other overlay widgets
                if (this._focusedButton > 0 && buttons.length > 1) {
                    this._focusedButton--;
                    this._updateButtonFocus();
                    return true;
                }
                // At leftmost button — let OSD navigate to sibling widgets
                return false;
            }

            case nextAction: {
                // Move from Play Now → Hide, or exit right to other overlay widgets
                if (this._focusedButton < buttons.length - 1 && buttons.length > 1) {
                    this._focusedButton++;
                    this._updateButtonFocus();
                    return true;
                }
                return false;
            }

            case 'up':
                // Up exits overlay row — let OSD _navigate handle row change
                return false;

            case 'down':
                // Down exits overlay row to Controls
                return false;

            case 'back':
                this.osd.hideUpNext();
                return true;

            default:
                return false;
        }
    }

    /**
     * Implements BaseMenu.updateFocus() — called by BaseMenu.show().
     * Applies .focused to the currently active button.
     */
    updateFocus() {
        this._updateButtonFocus();
    }

    /**
     * Clean up when the OSD is destroyed.
     */
    destroy() {
        this._stopCountdown();
        super.destroy();
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    /**
     * Populate thumbnail, series name, episode title and countdown from
     * this._nextItem. Called after render and after setNextItem() if already
     * rendered.
     * @private
     */
    _populateContent() {
        if (!this.$el || !this._nextItem) return;

        const item = this._nextItem;

        // ---- Episode title --------------------------------------------------
        const titleEl = this.$el.querySelector('.upnext-title');
        if (titleEl) {
            // For episodes use "Episode N – Name", fallback to raw Name
            const epNum = item.IndexNumber ? `E${item.IndexNumber}` : '';
            const epName = item.Name || '';
            titleEl.textContent = epNum && epName ? `${epNum} – ${epName}` : epName;
        }

        // ---- Series name (parent series title) ------------------------------
        const seriesEl = this.$el.querySelector('.upnext-series');
        if (seriesEl) {
            seriesEl.textContent = item.SeriesName || '';
        }

        // ---- Episode badge (e.g. "S02E05") ----------------------------------
        const badgeEl = this.$el.querySelector('.upnext-badge');
        if (badgeEl) {
            const season = item.ParentIndexNumber != null ? `S${item.ParentIndexNumber.toString().padStart(2, '0')}` : '';
            const ep = item.IndexNumber != null ? `E${item.IndexNumber.toString().padStart(2, '0')}` : '';
            badgeEl.textContent = season || ep ? `${season}${ep}` : '';
        }

        // ---- Community rating (e.g. SVG star + "8.0") --------------------------------
        const ratingEl = this.$el.querySelector('.upnext-rating');
        if (ratingEl) {
            const score = item.CommunityRating;
            if (score != null && !isNaN(score) && shouldShowScore(item)) {
                // Render rating score with modern unified SVG star icon
                ratingEl.innerHTML = `${detailsIcons.ratingStar}${parseFloat(score).toFixed(1)}`;
                ratingEl.style.display = '';
            } else {
                // No community rating available — hide the element cleanly
                ratingEl.style.display = 'none';
            }
        }

        // ---- Thumbnail image ------------------------------------------------
        const imgEl = this.$el.querySelector('.upnext-thumbnail');
        if (imgEl) {
            const url = this._buildThumbnailUrl(item);
            if (url) {
                imgEl.src = url;
                imgEl.style.display = 'block';
            } else {
                // No image available — hide the thumbnail slot
                imgEl.style.display = 'none';
            }
        }

        // ---- Initial countdown text -----------------------------------------
        if (this._initialSecondsRemaining > 0) {
            this.updateCountdown(this._initialSecondsRemaining);
        }
    }

    /**
     * Build the URL for the episode thumbnail image.
     * Prefers the episode's Primary image, falls back to the season/series backdrop.
     *
     * @param {Object} item - Jellyfin media item
     * @returns {string|null} Absolute URL or null if no image is available
     * @private
     */
    _buildThumbnailUrl(item) {
        /*
         * Use the API client's `getImageUrl()` helper which already knows the
         * server base URL and constructs the correct endpoint path.
         * `this.osd._api` is the ApiClient singleton (set in OSDController constructor).
         */
        const api = this.osd._api;
        if (!api || !item.Id) return null;

        // Prefer episode Primary image
        if (item.ImageTags && item.ImageTags.Primary) {
            return api.getImageUrl(item.Id, 'Primary', {
                tag: item.ImageTags.Primary,
                maxWidth: 320,
                quality: 80
            });
        }

        // Fall back to parent (season) backdrop
        if (item.ParentBackdropItemId && item.ParentBackdropImageTags && item.ParentBackdropImageTags[0]) {
            return api.getImageUrl(item.ParentBackdropItemId, 'Backdrop', {
                tag: item.ParentBackdropImageTags[0],
                maxWidth: 320,
                quality: 80
            });
        }

        // Fall back to series primary
        if (item.SeriesId && item.SeriesPrimaryImageTag) {
            return api.getImageUrl(item.SeriesId, 'Primary', {
                tag: item.SeriesPrimaryImageTag,
                maxWidth: 320,
                quality: 80
            });
        }

        return null;
    }

    /**
     * Apply the .focused CSS class to the currently active button and remove it
     * from the other. Also updates tabindex for accessibility.
     * @private
     */
    _updateButtonFocus() {
        if (!this.$el) return;

        const buttons = this.$el.querySelectorAll('.upnext-btn');
        
        // Force focus index to 0 if there is only 1 button (e.g., compact mode)
        if (buttons.length === 1) {
            this._focusedButton = 0;
        }

        /*
         * IMPORTANT: Clear .focused from the ENTIRE OSD overlay section first.
         * This prevents stale .focused state on other widgets (e.g. skip-outro
         * button keeping its focus ring after we navigate into the dialog).
         * We target only the overlay row to avoid disrupting header/controls.
         */
        if (this.osd?._osdEl) {
            const overlayEl = this.osd._osdEl.querySelector('.osd-overlays');
            if (overlayEl) {
                overlayEl.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'));
            }
        }

        // Apply .focused and tabindex to the correct button
        buttons.forEach((btn, idx) => {
            const active = idx === this._focusedButton;
            btn.classList.toggle('focused', active);
            btn.setAttribute('tabindex', active ? '0' : '-1');
            if (active) btn.focus({ preventScroll: true });
        });

        // Keep OSD's cache index in sync so _navigate boundary checks stay correct.
        // Find the target button's absolute position in the overlay focusable cache.
        const targetBtn = buttons[this._focusedButton];
        if (targetBtn && this.osd?._cachedOverlayRow) {
            const absIdx = this.osd._cachedOverlayRow.indexOf(targetBtn);
            if (absIdx !== -1) this.osd._currentFocusIndex = absIdx;
        }
    }

    /**
     * Animate out and play the next episode immediately.
     * Emits the 'next' event on the OSD so PlayerPage can handle the navigation.
     * @private
     */
    _triggerPlayNow() {
        // Hide the dialog first, then signal PlayerPage to advance the queue
        this.osd.hideUpNext();
        // OSDController re-emits this as 'next' so PlayerPage._playNextItem() fires
        this.osd.emit('next');
    }

    /**
     * Stop the active countdown interval if any.
     * @private
     */
    _stopCountdown() {
        if (this._countdownInterval !== null) {
            clearInterval(this._countdownInterval);
            this._countdownInterval = null;
        }
    }
}
