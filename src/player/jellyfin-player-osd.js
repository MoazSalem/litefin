/**
 * ============================================================================
 * Litefin Tizen - Player OSD (On-Screen Display) Component
 * ============================================================================
 * Manages the video player overlay UI for Litefin.
 * Layout matches Jellyfin Tizen TV OSD.
 *
 * Architecture:
 *   - Extends Component for lifecycle management (mount/destroy)
 *   - Subscribes to EventBus key events (auto-cleaned on destroy)
 *   - Uses FocusManager pushTrap/popTrap for focus containment
 *   - No global window.* variables — communicates via callbacks
 *
 * Usage:
 *   const osd = new PlayerOSD({
 *       container: document.getElementById('osd-overlay'),
 *       player: playerInstance,
 *       item: mediaItem,
 *       api: apiClient,
 *       onExit: () => this._stopAndExit(),
 *       onReportPause: (isPaused) => this._reportPlaybackProgress(...)
 *   });
 *   osd.mount();
 * ============================================================================
 */

import Component from '../core/Component.js';
import { focusManager } from '../ui/FocusManager.js';
import { playQueue } from '../core/PlayQueue.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('OSD');

// ============================================================================
// Configuration defaults
// ============================================================================
const DEFAULT_CONFIG = {
    autoHideDelay: 5000,
    updateInterval: 500,
    seekStepBack: 5000,      // 5 seconds
    seekStepForward: 10000   // 10 seconds
};

// ============================================================================
// SVG Icons (inline for zero-dependency rendering)
// ============================================================================

// Helper to create a compact SVG icon from a path
const createIcon = (path) => `<svg class="osd-icon" viewBox="0 0 24 24"><path d="${path}"/></svg>`;

const ICONS = {
    arrowBack: createIcon('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z'),
    skipPrevious: createIcon('M6 6h2v12H6zm3.5 6l8.5 6V6z'),
    skipNext: createIcon('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'),
    fastRewind: createIcon('M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z'),
    fastForward: createIcon('M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z'),
    play: createIcon('M8 5v14l11-7z'),
    pause: createIcon('M6 19h4V5H6v14zm8-14v14h4V5h-4z'),
    closedCaption: createIcon('M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z'),
    audiotrack: createIcon('M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z'),
    settings: createIcon('M19.14 12.94c0.04-0.3 0.06-0.61 0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14 0.23-0.41 0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39 0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4 2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24 0-0.43 0.17-0.47 0.41L9.25 5.35c-0.59 0.24-1.13 0.57-1.62 0.94L5.24 5.33c-0.22-0.08-0.47 0-0.59 0.22L2.74 8.87c-0.12 0.21-0.08 0.47 0.12 0.61l2.03 1.58c-0.05 0.3-0.07 0.63-0.07 0.94s0.02 0.64 0.07 0.94l-2.03 1.58c-0.18 0.14-0.23 0.41-0.12 0.61l1.92 3.32c0.12 0.22 0.37 0.29 0.59 0.22l2.39-0.96c0.5 0.38 1.03 0.7 1.62 0.94l0.36 2.54c0.05 0.24 0.24 0.41 0.48 0.41h3.84c0.24 0 0.43-0.17 0.47-0.41l0.36-2.54c0.59-0.24 1.13-0.56 1.62-0.94l2.39 0.96c0.22 0.08 0.47 0 0.59-0.22l1.92-3.32c0.12-0.22 0.07-0.47-0.12-0.61L19.14 12.94zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z'),
    favorite: createIcon('M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z'),
    favoriteFilled: createIcon('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'),
    sync: createIcon('M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z'),
    check: createIcon('M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z')
};

// ============================================================================
// PlayerOSD Component
// ============================================================================

class PlayerOSD extends Component {

    /**
     * Create a PlayerOSD
     * @param {Object} options
     * @param {HTMLElement} options.container - The #osd-overlay element
     * @param {Object} options.player - JellyfinPlayer instance
     * @param {Object} options.item - Media item metadata (for title, favorite, etc.)
     * @param {Object} options.api - ApiClient instance (for favorite toggling)
     * @param {Function} options.onExit - Callback to stop playback and navigate back
     * @param {Function} options.onReportPause - Callback to report pause/unpause to server
     */
    constructor(options = {}) {
        super(options);

        // ====================================================================
        // Player + API references (passed from PlayerPage, not globals!)
        // ====================================================================
        this._player = options.player || null;
        this._item = options.item || null;
        this._api = options.api || null;
        this._onExit = options.onExit || (() => {});
        this._onReportPause = options.onReportPause || (() => {});
        this._onPrevious = options.onPrevious || (() => {});
        this._onNext = options.onNext || (() => {});

        // ====================================================================
        // Configuration
        // ====================================================================
        this._config = { ...DEFAULT_CONFIG };

        // ====================================================================
        // Internal state
        // ====================================================================
        this._isOsdVisible = false;
        this._autoHideTimer = null;
        this._updateTimer = null;
        this._isDraggingSeekbar = false;
        this._seekDebounceTimer = null;
        this._seekTargetTicks = null;
        this._seekStartTime = null;

        // ====================================================================
        // Focus tracking — row-based navigation (header / controls / seekbar)
        // ====================================================================
        this._currentFocusRow = 1;       // Start on controls row
        this._currentFocusIndex = 2;     // Start on play button (index 2)
        this._cachedHeaderRow = [];
        this._cachedControlsRow = [];
        this._cachedSeekbar = null;

        // ====================================================================
        // Track menu state
        // ====================================================================
        this._trackMenuOverlay = null;
        this._isTrackMenuOpen = false;
        this._trackMenuType = null;        // 'subtitles' or 'audio'
        this._trackMenuFocusIndex = 0;
        this._currentSubtitleIndex = -1;
        this._currentSecondarySubtitleIndex = -1;
        this._currentAudioIndex = 0;
        this._trackMenuSubtitleMode = 'primary';

        // Settings menu state
        this._settingsMenuOverlay = null;
        this._isSettingsMenuOpen = false;
        this._settingsMenuFocusIndex = 0;
        
        // ====================================================================
        // Subtitle Offset State
        // ====================================================================
        this._showSubtitleOffset = false;
        this._subtitleOffset = 0;
    }

    // ========================================================================
    // Component Lifecycle
    // ========================================================================

    /**
     * Update the displayed item (e.g. when playlist advances)
     * @param {Object} item - New item metadata
     */
    updateItem(item) {
        this._item = item;
        const titleEl = this._osdEl.querySelector('#osdTitle');
        if (titleEl) {
            titleEl.textContent = this._getFormattedTitle(item);
        }

        // Update Prev/Next buttons
        this._updateNavigationButtons();

        // Reset track state for the new item
        this._currentAudioIndex = 0;
        this._currentSubtitleIndex = -1;
        this._currentSecondarySubtitleIndex = -1;
        this._syncTrackState();

        // Update favorite button for new item
        this._updateFavoriteButton();

        // Re-cache focusable elements because Prev/Next might have changed tabindex
        this._cacheFocusableElements();

        // If OSD is visible, refresh focus to ensure we aren't on a now-disabled button
        if (this._isOsdVisible) {
            this._updateFocus();
        }
    }

    /**
     * Get a formatted title string for the OSD
     * @private
     * @param {Object} item 
     * @returns {string}
     */
    _getFormattedTitle(item) {
        if (!item) return 'Now Playing';

        const name = item.Name || '';
        const year = item.ProductionYear ? ` (${item.ProductionYear})` : '';

        if (item.Type === 'Episode') {
            const seriesName = item.SeriesName || '';
            const season = item.ParentIndexNumber !== undefined ? `S${String(item.ParentIndexNumber).padStart(2, '0')}` : '';
            const episode = item.IndexNumber !== undefined ? `E${String(item.IndexNumber).padStart(2, '0')}` : '';
            
            let parts = [];
            if (seriesName) parts.push(seriesName);
            
            let numbering = [];
            if (season) numbering.push(season);
            if (episode) numbering.push(episode);
            
            if (numbering.length > 0) {
                parts.push(numbering.join(':'));
            }
            
            if (name) parts.push(name);
            
            return parts.join(' - ') + year;
        }

        return name + year;
    }

    /**
     * Find the index of a button by its action in the controls row
     * @private
     * @param {string} action 
     * @returns {number}
     */
    _findActionIndex(action) {
        const { controlsRow } = this._getFocusableElements();
        return controlsRow.findIndex(btn => btn.dataset.action === action);
    }

    /**
     * Update the state of Previous and Next buttons based on the queue
     * @private
     */
    _updateNavigationButtons() {
        const prevBtn = this._osdEl.querySelector('#osdPrevBtn');
        const nextBtn = this._osdEl.querySelector('#osdNextBtn');

        const hasPrev = playQueue.hasPrevious();
        const hasNext = playQueue.hasNext();

        if (prevBtn) {
            prevBtn.classList.toggle('osd-btn-disabled', !hasPrev);
            prevBtn.setAttribute('tabindex', hasPrev ? '0' : '-1');
            if (!hasPrev) prevBtn.setAttribute('disabled', '');
            else prevBtn.removeAttribute('disabled');
        }

        if (nextBtn) {
            nextBtn.classList.toggle('osd-btn-disabled', !hasNext);
            nextBtn.setAttribute('tabindex', hasNext ? '0' : '-1');
            if (!hasNext) nextBtn.setAttribute('disabled', '');
            else nextBtn.removeAttribute('disabled');
        }
    }

    /**
     * Public method to hide the OSD and all overlays
     */
    hide() {
        // Close menus
        if (this._isTrackMenuOpen) {
            this._closeTrackMenu();
        }
        if (this._showSubtitleOffset) {
            this._toggleSubtitleOffset(false);
        }

        // Force hide the base element
        this._osdEl.classList.add('osd-hidden');
        this._isOsdVisible = false;
    }

    /**
     * Render the OSD HTML into the container.
     * Unlike the parent Component.render() which returns a string for mount(),
     * here we render directly because the container (#osd-overlay) already
     * exists in PlayerPage's template — we just populate its innerHTML.
     */
    render() {
        // We return empty string because we render manually in onMounted()
        return '';
    }

    /**
     * After mount, render OSD markup, cache elements, bind events, start updates.
     */
    onMounted() {
        // Use container directly (it's the #osd-overlay div from PlayerPage)
        this._osdEl = this.container;
        if (!this._osdEl) {
            log.error('OSD container not found');
            return;
        }

        // Render the OSD markup into the container
        this._renderOSD();

        // Set initial favorite state
        this._updateFavoriteButton();

        // Cache focusable DOM elements for fast navigation
        this._cacheFocusableElements();

        // Bind click handlers on OSD buttons and seekbar
        this._bindDOMEvents();

        // Subscribe to EventBus key events (auto-cleaned by Component.destroy)
        this._bindKeyEvents();

        // Start periodic UI updates (time display, play/pause icon, clock)
        this._startUpdates();

        // Initialize hidden
        this._hide();
        this._resetAutoHide();

        // Sync initial track state from the player
        this._syncTrackState();

        // Listen for dynamic track changes from the player
        if (this._player) {
            this._player.on('mediastreamschange', (e) => this._onMediaStreamsChange(e));
        }

        log.info('Initialized');

        // Suspend FocusManager — the OSD manages its own focus with
        // a simple row-based model, so FocusManager must not process
        // key events simultaneously (would cause double-dispatch)
        focusManager.suspend();
    }

    /**
     * Clean up everything on destroy
     */
    onBeforeDestroy() {
        // Stop periodic updates
        this._stopUpdates();

        // Clear auto-hide timer
        if (this._autoHideTimer) {
            clearTimeout(this._autoHideTimer);
            this._autoHideTimer = null;
        }

        // Clear seek debounce timer
        if (this._seekDebounceTimer) {
            clearTimeout(this._seekDebounceTimer);
            this._seekDebounceTimer = null;
        }

        // Remove track menu overlay from DOM
        if (this._trackMenuOverlay) {
            this._trackMenuOverlay.remove();
            this._trackMenuOverlay = null;
        }

        // Remove settings menu overlay from DOM
        if (this._settingsMenuOverlay) {
            this._settingsMenuOverlay.remove();
            this._settingsMenuOverlay = null;
        }

        // Pop focus trap if still active
        // (Component.destroy will unsubscribe EventBus listeners automatically)

        // Clear references
        this._player = null;
        this._item = null;
        this._api = null;

        // Resume FocusManager so other pages can navigate normally
        focusManager.resume();
    }

    // ========================================================================
    // Public API (called by PlayerPage)
    // ========================================================================

    /**
     * Check if any modal menu is currently open
     * @returns {boolean}
     */
    isMenuOpen() {
        return this._isTrackMenuOpen || this._isSettingsMenuOpen;
    }

    /**
     * Close any open modal menu
     */
    closeMenu() {
        if (this._isTrackMenuOpen) this._closeTrackMenu();
        if (this._isSettingsMenuOpen) this._closeSettingsMenu();
    }

    /**
     * Handle the back key from PlayerPage.onBack()
     * Returns true if handled (menu closed or OSD hidden), false if player should exit
     * @returns {boolean}
     */
    handleBack() {
        // Priority 1: Close menus
        if (this._isTrackMenuOpen) {
            this._closeTrackMenu();
            return true;
        }

        if (this._isSettingsMenuOpen) {
            this._closeSettingsMenu();
            return true;
        }

        // Priority 2: Hide main OSD if visible
        if (this._isOsdVisible) {
            this._hide();
            return true;
        }

        // Not handled — PlayerPage should exit the player
        return false;
    }

    /**
     * Handle back key internally (e.g. closing offset menu)
     * @returns {boolean} True if handled
     */
    _handleInternalBack() {
        return false;
    }

    // ========================================================================
    // OSD Rendering
    // ========================================================================

    /**
     * Render all OSD markup into the container element.
     * Generates header (back + title), controls row, and seekbar row.
     */
    _renderOSD() {
        // Get display title from the media item
        const title = this._getFormattedTitle(this._item);

        const hasPrev = playQueue.hasPrevious();
        const hasNext = playQueue.hasNext();

        this._osdEl.innerHTML = `
            <div class="osd-main">
                <!-- ============================================================ -->
                <!-- TOP HEADER: Back + Title (left), Sync icon + Clock (right)   -->
                <!-- ============================================================ -->
                <div class="osd-header">
                    <div class="osd-header-left">
                        <button class="osd-btn osd-back-btn" data-action="exit" tabindex="0" title="Back">
                            ${ICONS.arrowBack}
                        </button>
                        <span class="osd-title" id="osdTitle">${title}</span>
                    </div>
                    <div class="osd-header-right">
                        <span class="osd-sync-icon hide" id="osdSyncIcon">${ICONS.sync}</span>
                        <span class="osd-clock" id="osdClock"></span>
                    </div>
                </div>

                <!-- ============================================================ -->
                <!-- BOTTOM OSD: Controls row + Slider row                        -->
                <!-- ============================================================ -->
                <div class="osd-bottom">
                    <!-- Controls Row (above slider) -->
                    <div class="osd-controls-row">
                        <!-- Left: Playback controls -->
                        <div class="osd-controls-left">
                            <button class="osd-btn ${!hasPrev ? 'osd-btn-disabled' : ''}" 
                                    data-action="previousTrack" 
                                    tabindex="${hasPrev ? '0' : '-1'}" 
                                    title="Previous"
                                    ${!hasPrev ? 'disabled' : ''}
                                    id="osdPrevBtn">
                                ${ICONS.skipPrevious}
                            </button>
                            <button class="osd-btn" data-action="rewind" tabindex="0" title="Rewind">
                                ${ICONS.fastRewind}
                            </button>
                            
                            <!-- Big blue play/pause button -->
                            <button class="osd-btn osd-btn-play" data-action="togglePlay" tabindex="0" id="osdPlayPauseBtn">
                                ${ICONS.pause}
                            </button>
                            
                            <button class="osd-btn" data-action="fastForward" tabindex="0" title="Fast Forward">
                                ${ICONS.fastForward}
                            </button>
                            <button class="osd-btn ${!hasNext ? 'osd-btn-disabled' : ''}" 
                                    data-action="nextTrack" 
                                    tabindex="${hasNext ? '0' : '-1'}" 
                                    title="Next"
                                    ${!hasNext ? 'disabled' : ''}
                                    id="osdNextBtn">
                                ${ICONS.skipNext}
                            </button>
                            
                            <!-- Ends at (next to play buttons) -->
                            <span class="osd-ends-at" id="osdEndsAt"></span>
                        </div>

                        <!-- Spacer to push right controls to the right -->
                        <div class="osd-spacer"></div>

                        <!-- Right: Media controls -->
                        <div class="osd-controls-right">
                            <button class="osd-btn" data-action="favorite" tabindex="0" title="Favorite" id="osdFavoriteBtn">
                                ${ICONS.favorite}
                            </button>
                            <button class="osd-btn" data-action="subtitles" tabindex="0" title="Subtitles">
                                ${ICONS.closedCaption}
                            </button>
                            <button class="osd-btn" data-action="audio" tabindex="0" title="Audio">
                                ${ICONS.audiotrack}
                            </button>
                            <button class="osd-btn" data-action="settings" tabindex="0" title="Settings">
                                ${ICONS.settings}
                            </button>
                        </div>
                    </div>

                    <!-- Slider Row (at very bottom) -->
                    <div class="osd-slider-row">
                        <span class="osd-time osd-time-current" id="osdCurrentTime">00:00</span>
                        <div class="osd-slider-container">
                            <div class="osd-seek-tooltip" id="osdSeekTooltip">00:00</div>
                            <input type="range" 
                                class="osd-slider" 
                                id="osdPositionSlider"
                                min="0" max="100" value="0" step="0.01"
                                tabindex="0" />
                        </div>
                        <span class="osd-time osd-time-total" id="osdTotalTime">00:00</span>
                    </div>
                </div>
            </div>
            
            <div class="osd-overlays">
                ${this._renderSubtitleOffsetOverlay()}
            </div>
        `;
    }

    /**
     * Render the Subtitle Offset Overlay HTML.
     * All styles are defined in player-osd.css (NOT inline) because Tizen's
     * WebKit has issues with styles injected via innerHTML. Starts hidden
     * via CSS (opacity:0); the .visible class is toggled by JS.
     */
    _renderSubtitleOffsetOverlay() {
        const closeIcon = ICONS.close || '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

        return `<div id="osdOffsetOverlay"><div class="osd-offset-header"><div class="osd-offset-title-group"><span class="osd-offset-title">Subtitle Offset</span><span class="osd-offset-value" id="osdOffsetValue">0.0s</span></div><button class="osd-offset-close" data-action="closeSubtitleOffset" tabindex="0">${closeIcon}</button></div><div class="osd-offset-slider-container"><input type="range" class="osd-offset-slider" id="osdOffsetSlider" min="-30" max="30" step="0.1" value="0" tabindex="0" /></div></div>`;
    }

    // ========================================================================
    // DOM Event Binding (click, slider input/change)
    // ========================================================================

    /**
     * Bind click handlers on OSD buttons and seekbar slider.
     * These are standard DOM events on child elements, not global listeners.
     */
    _bindDOMEvents() {
        // Delegate clicks on any [data-action] button within the OSD
        this._osdEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            this._executeAction(btn.dataset.action);
            this._resetAutoHide();
        });

        // Seekbar slider interaction
        const posSlider = this._osdEl.querySelector('#osdPositionSlider');
        if (posSlider) {
            posSlider.addEventListener('input', (e) => this._handlePositionSliderInput(e));
            posSlider.addEventListener('change', (e) => this._handlePositionSliderChange(e));
            posSlider.addEventListener('mousedown', () => { this._isDraggingSeekbar = true; });
            posSlider.addEventListener('mouseup', () => { this._isDraggingSeekbar = false; });
        }
    }

    // ========================================================================
    // EventBus Key Event Subscriptions
    // ========================================================================

    /**
     * Subscribe to EventBus key events instead of raw document.addEventListener.
     * Uses this.on() from Component base class for automatic cleanup on destroy.
     *
     * Key architecture note:
     *   TizenAdapter dispatches key:back, key:enter, key:up/down/left/right,
     *   key:play, key:pause, key:playPause, key:rewind, key:fastForward, etc.
     *   FocusManager also subscribes to directional + enter keys for spatial nav.
     *   We handle our own navigation here (row-based OSD focus), so we need to
     *   prevent FocusManager from also processing these keys when the OSD is active.
     *   We do this by calling e.preventDefault() on the original DOM event, which
     *   FocusManager checks before processing.
     */
    _bindKeyEvents() {
        // ================================================================
        // BACK KEY — NOT subscribed here!
        // Back is handled by the App → PlayerPage.onBack() → osd.handleBack()
        // chain. If we also subscribed here, we'd double-handle: OSD hides the
        // overlay, then PlayerPage.onBack() sees it's hidden and exits.
        // ================================================================

        // ================================================================
        // ENTER KEY — activate focused control or toggle play
        // ================================================================
        this.on('key:enter', (e) => {
            e?.preventDefault();
            const wasHidden = !this._isOsdVisible;

            // Priority 1: Menus
            if (this._isTrackMenuOpen) {
                this._handleTrackMenuEnter();
                return;
            }

            if (this._isSettingsMenuOpen) {
                this._handleSettingsMenuEnter();
                return;
            }

            // Priority 2: Overlay row: handle action (e.g. close)
            if (this._currentFocusRow === -1) {
                const { overlayRow } = this._getFocusableElements();
                const btn = overlayRow[this._currentFocusIndex];
                if (btn) {
                    // Execute action if it has data-action
                    if (btn.dataset.action) {
                        this._executeAction(btn.dataset.action);
                    } else if (btn.id === 'osdOffsetSlider') {
                        // Slider enter -> toggle play? (standard OSD behavior)
                        this._executeAction('togglePlay');
                    }
                }
                return;
            }

            // Show OSD and reset auto-hide (for main OSD rows)
            this._show();
            this._resetAutoHide();

            if (wasHidden) {
                // OSD was hidden — focus play button and toggle play
                this._currentFocusRow = 1;
                
                // Dynamically find play button index (handles case where Prev is missing)
                const playIndex = this._findActionIndex('togglePlay');
                this._currentFocusIndex = playIndex !== -1 ? playIndex : 2;
                
                this._updateFocus();
                this._executeAction('togglePlay');
            } else {
                // OSD visible — activate the currently focused control
                const { headerRow, controlsRow } = this._getFocusableElements();
                if (this._currentFocusRow === 0 && headerRow[0]) {
                    this._executeAction('exit');
                } else if (this._currentFocusRow === 1 && controlsRow[this._currentFocusIndex]) {
                    const action = controlsRow[this._currentFocusIndex].dataset.action;
                    if (action) this._executeAction(action);
                } else if (this._currentFocusRow === 2) {
                    // On seekbar — toggle play
                    this._executeAction('togglePlay');
                }
            }
        });

        // ================================================================
        // DIRECTIONAL KEYS — navigate OSD rows or seek
        // ================================================================
        this.on('key:up', (e) => {
            e?.preventDefault();

            // Track menu: navigate up
            if (this._isTrackMenuOpen) {
                this._handleTrackMenuNav('up');
                return;
            }

            // Settings menu: navigate up
            if (this._isSettingsMenuOpen) {
                this._handleSettingsMenuNav('up');
                return;
            }

            // Overlay row: handle internal nav or block
            if (this._currentFocusRow === -1) {
                this._handleOverlayNav('up');
                return;
            }

            const wasHidden = !this._isOsdVisible;
            this._show();
            this._resetAutoHide();
            
            if (wasHidden) {
                // If it was hidden, just show it and ensure visual focus is correct
                this._updateFocus();
            } else {
                // Move up a row (overlay ← header ← controls ← seekbar)
                if (this._currentFocusRow === 0) {
                    // From header to overlay if open
                    if (this._showSubtitleOffset) {
                        this._currentFocusRow = -1;
                        this._currentFocusIndex = 0; // Default to close button
                        this._updateFocus();
                    }
                } else if (this._currentFocusRow > 0) {
                    this._currentFocusRow--;
                    this._updateFocus();
                }
            }
        });

        this.on('key:down', (e) => {
            e?.preventDefault();

            // Track menu: navigate down
            if (this._isTrackMenuOpen) {
                this._handleTrackMenuNav('down');
                return;
            }

            // Settings menu: navigate down
            if (this._isSettingsMenuOpen) {
                this._handleSettingsMenuNav('down');
                return;
            }

            // Overlay row: handle internal nav or move to main OSD
            if (this._currentFocusRow === -1) {
                const handled = this._handleOverlayNav('down');
                if (!handled) {
                    // Move from overlay to main OSD
                    this._currentFocusRow = 0;
                    this._currentFocusIndex = 0;
                    this._show();
                    this._resetAutoHide();
                    this._updateFocus();
                }
                return;
            }

            const wasHidden = !this._isOsdVisible;
            this._show();
            this._resetAutoHide();

            if (wasHidden) {
                // If it was hidden, just show it
                this._updateFocus();
            } else {
                // Move down a row (header → controls → seekbar)
                if (this._currentFocusRow < 2) {
                    this._currentFocusRow++;
                    this._updateFocus();
                }
            }
        });

        this.on('key:left', (e) => {
            e?.preventDefault();

            // Track menu: block left/right from leaving menu
            if (this._isTrackMenuOpen) return;

            // Overlay row: internal nav or adjust value
            if (this._currentFocusRow === -1) {
                this._handleOverlayNav('left');
                return;
            }

            const wasHidden = !this._isOsdVisible;
            this._show();
            this._resetAutoHide();

            if (wasHidden) {
                // OSD was hidden — focus seekbar and seek backward
                this._currentFocusRow = 2;
                this._updateFocus();
                this._executeAction('rewind');
            } else {
                // OSD visible — navigate or seek based on current row
                if (this._currentFocusRow === 1) {
                    // Controls row — navigate left
                    if (this._currentFocusIndex > 0) {
                        this._currentFocusIndex--;
                        this._updateFocus();
                    }
                } else if (this._currentFocusRow === 2) {
                    // Seekbar row — seek backward
                    this._executeAction('rewind');
                }
                // Row 0 (header) — no left/right nav
            }
        });

        this.on('key:right', (e) => {
            e?.preventDefault();

            // Track menu: block left/right from leaving menu
            if (this._isTrackMenuOpen) return;

            // Overlay row: internal nav or adjust value
            if (this._currentFocusRow === -1) {
                this._handleOverlayNav('right');
                return;
            }

            const wasHidden = !this._isOsdVisible;
            this._show();
            this._resetAutoHide();

            if (wasHidden) {
                // OSD was hidden — focus seekbar and seek forward
                this._currentFocusRow = 2;
                this._updateFocus();
                this._executeAction('fastForward');
            } else {
                // OSD visible — navigate or seek based on current row
                const { controlsRow } = this._getFocusableElements();
                if (this._currentFocusRow === 1) {
                    // Controls row — navigate right
                    if (this._currentFocusIndex < controlsRow.length - 1) {
                        this._currentFocusIndex++;
                        this._updateFocus();
                    }
                } else if (this._currentFocusRow === 2) {
                    // Seekbar row — seek forward
                    this._executeAction('fastForward');
                } else if (this._currentFocusRow === 0) {
                    // Header row — navigate right to Overlay if open
                    if (this._showSubtitleOffset) {
                        this._currentFocusRow = -1;
                        this._currentFocusIndex = 0; // Go to Close button
                        this._updateFocus();
                    }
                }
            }
        });

        // ================================================================
        // MEDIA KEYS — play, pause, playPause, rewind, fastForward
        // ================================================================
        this.on('key:play', (e) => {
            e?.preventDefault();
            this._show();
            this._resetAutoHide();
            this._executeAction('togglePlay');
        });

        this.on('key:pause', (e) => {
            e?.preventDefault();
            this._show();
            this._resetAutoHide();
            if (this._player?.pause) this._player.pause();
            this._updatePlayPauseButton();
        });

        this.on('key:playPause', (e) => {
            e?.preventDefault();
            this._show();
            this._resetAutoHide();
            this._executeAction('togglePlay');
        });

        this.on('key:rewind', (e) => {
            e?.preventDefault();
            this._show();
            this._resetAutoHide();
            // Jump to seekbar row for visual feedback
            this._currentFocusRow = 2;
            this._updateFocus();
            this._executeAction('rewind');
        });

        this.on('key:fastForward', (e) => {
            e?.preventDefault();
            this._show();
            this._resetAutoHide();
            // Jump to seekbar row for visual feedback
            this._currentFocusRow = 2;
            this._updateFocus();
            this._executeAction('fastForward');
        });
    }

    // ========================================================================
    // Focus Management (row-based, not FocusManager sections)
    // ========================================================================
    // The OSD uses a simple 3-row model:
    //   Row 0: Header row (back button)
    //   Row 1: Controls row (prev, rewind, play, ff, next, fav, subs, audio, settings)
    //   Row 2: Seekbar (single slider)

    /**
     * Cache focusable elements after render.
     * Called once to avoid repeated DOM queries during fast D-pad navigation.
     */
    _cacheFocusableElements() {
        // Overlay row (Row -1) — only include if overlay container is visible
        this._cachedOverlayRow = [];
        const overlayContainer = this._osdEl.querySelector('#osdOffsetOverlay');
        if (overlayContainer && overlayContainer.classList.contains('visible')) {
            const overlayClose = overlayContainer.querySelector('.osd-offset-close');
            const overlaySlider = overlayContainer.querySelector('#osdOffsetSlider');
            if (overlayClose) this._cachedOverlayRow.push(overlayClose);
            if (overlaySlider) this._cachedOverlayRow.push(overlaySlider);
        }

        // Header row — just the back button
        const headerBackBtn = this._osdEl.querySelector('.osd-back-btn');
        this._cachedHeaderRow = headerBackBtn ? [headerBackBtn] : [];

        // Controls row — all buttons from left + right groups
        // FILTER: Only include elements that are actually focusable
        const controlsLeft = Array.from(this._osdEl.querySelectorAll('.osd-controls-left .osd-btn'))
            .filter(btn => btn.getAttribute('tabindex') !== '-1');
        const controlsRight = Array.from(this._osdEl.querySelectorAll('.osd-controls-right .osd-btn'))
            .filter(btn => btn.getAttribute('tabindex') !== '-1');
        
        this._cachedControlsRow = [...controlsLeft, ...controlsRight];

        // Seekbar slider
        this._cachedSeekbar = this._osdEl.querySelector('.osd-slider');
    }

    /**
     * Return cached focusable elements grouped by row
     * @returns {{ overlayRow: HTMLElement[], headerRow: HTMLElement[], controlsRow: HTMLElement[], seekbar: HTMLElement|null }}
     */
    _getFocusableElements() {
        return {
            overlayRow: this._cachedOverlayRow,
            headerRow: this._cachedHeaderRow,
            controlsRow: this._cachedControlsRow,
            seekbar: this._cachedSeekbar
        };
    }

    /**
     * Apply visual focus to the current row + index.
     * Adds 'focused' class and calls native focus() for screen readers.
     */
    _updateFocus() {
        const { overlayRow, headerRow, controlsRow, seekbar } = this._getFocusableElements();

        // Clear all focus states
        overlayRow.forEach(btn => btn.classList.remove('focused'));
        headerRow.forEach(btn => btn.classList.remove('focused'));
        controlsRow.forEach(btn => btn.classList.remove('focused'));
        seekbar?.classList.remove('focused');

        // Apply focus to current element
        if (this._currentFocusRow === -1) {
            // Overlay row
            const index = Math.min(this._currentFocusIndex, overlayRow.length - 1);
            if (overlayRow[index]) {
                overlayRow[index].classList.add('focused');
                overlayRow[index].focus();
            }
        } else if (this._currentFocusRow === 0) {
            // Header row (back button)
            if (headerRow[0]) {
                headerRow[0].classList.add('focused');
                headerRow[0].focus();
            }
        } else if (this._currentFocusRow === 1) {
            // Controls row — clamp index to valid range
            const index = Math.min(this._currentFocusIndex, controlsRow.length - 1);
            if (controlsRow[index]) {
                controlsRow[index].classList.add('focused');
                controlsRow[index].focus();
            }
        } else {
            // Seekbar row
            if (seekbar) {
                seekbar.classList.add('focused');
                seekbar.focus();
            }
        }
    }

    // ========================================================================
    // Action Execution
    // ========================================================================

    /**
     * Execute a named OSD action (triggered by button click or key press)
     * @param {string} action - Action identifier from data-action attribute
     */
    _executeAction(action) {
        const player = this._player;
        if (!player) {
            log.warn('executeAction: No player instance available');
            return;
        }

        switch (action) {
            // ============================================================
            // Navigation
            // ============================================================
            case 'back':
                // Hide OSD if visible, otherwise exit player
                if (this._isOsdVisible) {
                    this._hide();
                } else {
                    this._onExit();
                }
                break;

            case 'exit':
                // Always exit — delegate to PlayerPage for proper reporting
                this._onExit();
                break;

            // ============================================================
            // Playback Controls
            // ============================================================
            case 'togglePlay':
                if (player.togglePlay) player.togglePlay();
                // Check state after toggle and update UI + report to server
                setTimeout(() => {
                    this._updatePlayPauseButton();
                    const isPaused = player.isPaused ? player.isPaused() : false;
                    this._onReportPause(isPaused);
                }, 250);
                break;

            case 'rewind': {
                const skipBackMs = parseInt(localStorage.getItem('jellyfin-player-skipBackLength')) || this._config.seekStepBack;
                this._performDebouncedSeek(-skipBackMs * 10000); // Convert MS to Ticks
                break;
            }

            case 'fastForward': {
                const skipFwdMs = parseInt(localStorage.getItem('jellyfin-player-skipForwardLength')) || this._config.seekStepForward;
                this._performDebouncedSeek(skipFwdMs * 10000); // Convert MS to Ticks
                break;
            }

            case 'previousTrack':
                this._onPrevious();
                break;

            case 'nextTrack':
                this._onNext();
                break;

            // ============================================================
            // Media Menus
            // ============================================================
            case 'subtitles':
                this._openTrackMenu('subtitles');
                break;

            case 'audio':
                this._openTrackMenu('audio');
                break;

            case 'favorite':
                this._toggleFavorite();
                break;

            case 'settings':
                this._openSettingsMenu();
                break;

            case 'closeSubtitleOffset':
                this._toggleSubtitleOffset(false);
                break;
        }
    }

    // ========================================================================
    // Debounced Seeking (with acceleration for held keys)
    // ========================================================================

    /**
     * Perform a debounced seek operation.
     * Accumulates rapid key presses into a single seek, with speed acceleration
     * the longer the user holds the key (1x → 2x → 3x → 4x → 5x).
     * @param {number} offsetTicks - Seek offset in ticks (negative = backward)
     */
    _performDebouncedSeek(offsetTicks) {
        const player = this._player;
        if (!player) return;

        try {
            this._show();
            this._resetAutoHide();

            // Initialize seek session if starting fresh
            if (this._seekTargetTicks === null) {
                this._seekTargetTicks = (player.getCurrentPositionTicks && player.getCurrentPositionTicks()) || 0;
                this._seekStartTime = Date.now();
            }

            // Calculate speed multiplier based on continuous seek duration
            // 0-3s: 1x, 3-5s: 2x, 5-8s: 3x, 8-11s: 4x, 11+: 5x
            const seekDuration = (Date.now() - this._seekStartTime) / 1000;
            let speedMultiplier = 1;
            if (seekDuration >= 11) {
                speedMultiplier = 5;
            } else if (seekDuration >= 8) {
                speedMultiplier = 4;
            } else if (seekDuration >= 5) {
                speedMultiplier = 3;
            } else if (seekDuration >= 3) {
                speedMultiplier = 2;
            }

            // Validate offset
            if (isNaN(offsetTicks)) {
                log.error('Invalid seek offset:', offsetTicks);
                return;
            }

            // Apply speed multiplier and accumulate
            const adjustedOffset = offsetTicks * speedMultiplier;
            this._seekTargetTicks += adjustedOffset;

            // Clamp to valid range [0, duration]
            const duration = (player.getDurationTicks && player.getDurationTicks()) || 0;
            if (this._seekTargetTicks < 0) this._seekTargetTicks = 0;
            if (this._seekTargetTicks > duration) this._seekTargetTicks = duration;

            // Clear existing debounce timer
            if (this._seekDebounceTimer) {
                clearTimeout(this._seekDebounceTimer);
            }

            // Preview: update UI immediately to show where we're seeking to
            const previewPlayer = {
                getCurrentPositionTicks: () => this._seekTargetTicks,
                getDurationTicks: () => duration
            };
            this._updateTimeDisplay(previewPlayer);
            this._updatePositionSlider(previewPlayer);

            // Show seek tooltip with target time and speed indicator
            const tooltip = this._osdEl.querySelector('#osdSeekTooltip');
            const slider = this._osdEl.querySelector('#osdPositionSlider');
            if (tooltip && slider) {
                const speedIndicator = speedMultiplier > 1 ? ` (${speedMultiplier}x)` : '';
                tooltip.textContent = this._formatTime(this._seekTargetTicks) + speedIndicator;
                tooltip.classList.add('visible');

                // Position tooltip above the current slider thumb position
                const percent = duration > 0 ? (this._seekTargetTicks / duration) * 100 : 0;
                tooltip.style.left = percent + '%';
            }

            // Commit seek after 500ms of inactivity
            this._seekDebounceTimer = setTimeout(() => {
                log.debug('Committing seek to:', this._seekTargetTicks);
                if (player.seek) player.seek(this._seekTargetTicks);

                // Reset seek session
                this._seekTargetTicks = null;
                this._seekStartTime = null;
                this._seekDebounceTimer = null;

                // Hide tooltip after seek commits
                if (tooltip) tooltip.classList.remove('visible');
            }, 500);

        } catch (err) {
            log.error('Seek error:', err);
            this._seekTargetTicks = null;
            this._seekStartTime = null;
        }
    }

    // ========================================================================
    // Seekbar Slider Handlers
    // ========================================================================

    /**
     * Handle slider 'input' event (thumb dragging — update time preview)
     */
    _handlePositionSliderInput(e) {
        if (!this._player) return;

        const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;
        const percent = parseFloat(e.target.value) / 100;
        const position = duration * percent;

        // Update current time display to match slider position
        const currentEl = this._osdEl.querySelector('#osdCurrentTime');
        if (currentEl) {
            currentEl.textContent = this._formatTime(position);
        }
        this._resetAutoHide();
    }

    /**
     * Handle slider 'change' event (thumb released — commit seek)
     */
    _handlePositionSliderChange(e) {
        this._isDraggingSeekbar = false;
        if (!this._player) return;

        const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;
        const percent = parseFloat(e.target.value) / 100;
        const position = Math.floor(duration * percent);

        // Commit the seek to the player
        if (this._player.seek) this._player.seek(position);
        this._resetAutoHide();
    }

    // ========================================================================
    // Periodic UI Updates
    // ========================================================================

    /** Start the periodic state update timer */
    _startUpdates() {
        this._updateTimer = setInterval(() => this._updateState(), this._config.updateInterval);
    }

    /** Stop the periodic state update timer */
    _stopUpdates() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
            this._updateTimer = null;
        }
    }

    /**
     * Periodic state update — refresh time display, clock, slider, play/pause icon.
     * Skipped during active seek (preview takes priority).
     */
    _updateState() {
        if (!this._player) return;

        // Don't overwrite UI during an active seek preview
        if (this._seekTargetTicks !== null) return;

        this._updateTimeDisplay(this._player);
        this._updateClock();
        if (!this._isDraggingSeekbar) {
            this._updatePositionSlider(this._player);
        }
        this._updatePlayPauseButton();
    }

    /** Update the clock display in the OSD header */
    _updateClock() {
        const clockEl = this._osdEl.querySelector('#osdClock');
        if (!clockEl) return;

        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        clockEl.textContent = `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    }

    /**
     * Update current time, total time, and "Ends at" display
     * @param {Object} player - Player instance (or preview mock during seek)
     */
    _updateTimeDisplay(player) {
        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const currentEl = this._osdEl.querySelector('#osdCurrentTime');
        const totalEl = this._osdEl.querySelector('#osdTotalTime');

        if (currentEl && !this._isDraggingSeekbar) {
            currentEl.textContent = this._formatTime(current);
        }
        if (totalEl) {
            totalEl.textContent = this._formatTime(duration);
        }

        // Calculate "Ends at" based on remaining time
        const endsAtEl = this._osdEl.querySelector('#osdEndsAt');
        if (endsAtEl && duration > 0) {
            const remainingMs = (duration - current) / 10000;
            const endTime = new Date(Date.now() + remainingMs);
            const hours = endTime.getHours();
            const minutes = endTime.getMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12;
            endsAtEl.textContent = `Ends at ${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
        }
    }

    /**
     * Update the position slider to reflect current playback position
     * @param {Object} player - Player instance (or preview mock during seek)
     */
    _updatePositionSlider(player) {
        const slider = this._osdEl.querySelector('#osdPositionSlider');
        if (!slider) return;

        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const percent = duration > 0 ? (current / duration) * 100 : 0;
        slider.value = percent;

        // Update CSS custom property for the progress track gradient
        slider.style.setProperty('--progress', percent + '%');
    }

    /** Update the play/pause button icon based on current player state */
    _updatePlayPauseButton() {
        const player = this._player;
        const btn = this._osdEl.querySelector('#osdPlayPauseBtn');
        if (!btn || !player) return;

        const isPaused = player.isPaused ? player.isPaused() : false;
        btn.innerHTML = isPaused ? ICONS.play : ICONS.pause;
    }

    // ========================================================================
    // Show / Hide / Auto-Hide
    // ========================================================================

    /** Show the OSD overlay */
    _show() {
        const main = this._osdEl.querySelector('.osd-main');
        if (main) {
            main.classList.remove('osd-hidden');
        }
        this._isOsdVisible = true;
    }

    /** Hide the OSD overlay */
    _hide() {
        // Don't hide if track menu is open (global overlay)
        if (this._isTrackMenuOpen) return;

        const main = this._osdEl.querySelector('.osd-main');
        if (main) {
            main.classList.add('osd-hidden');
        }
        this._isOsdVisible = false;
    }

    /** Reset the auto-hide timer (restarts the countdown) */
    _resetAutoHide() {
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        // Do not auto-hide if track menu is open
        if (this._isTrackMenuOpen) return;
        this._autoHideTimer = setTimeout(() => this._hide(), this._config.autoHideDelay);
    }

    // ========================================================================
    // Track State Sync
    // ========================================================================

    /** Sync initial track indices from the player on startup or item switch */
    syncTracks() {
        if (!this._player) return;

        if (this._player.getCurrentAudioStreamIndex) {
            const aIndex = this._player.getCurrentAudioStreamIndex();
            if (aIndex !== undefined && aIndex !== null) this._currentAudioIndex = aIndex;
        }
        if (this._player.getCurrentSubtitleStreamIndex) {
            const sIndex = this._player.getCurrentSubtitleStreamIndex();
            if (sIndex !== undefined && sIndex !== null) this._currentSubtitleIndex = sIndex;
        }
    }

    /** Sync initial track indices from the player on startup */
    _syncTrackState() {
        this.syncTracks();
    }

    /** Handle dynamic track changes from the player (e.g. after stream switch) */
    _onMediaStreamsChange(e) {
        log.info('onMediaStreamsChange:', e);
        if (e.detail) {
            if (e.detail.audioStreamIndex !== undefined) {
                this._currentAudioIndex = e.detail.audioStreamIndex;
            }
            if (e.detail.subtitleStreamIndex !== undefined) {
                this._currentSubtitleIndex = e.detail.subtitleStreamIndex;
            }
        }
    }

    // ========================================================================
    // Track Selection Menu
    // ========================================================================

    /**
     * Open the track selection menu (subtitles or audio).
     * Renders a list of available tracks with the current selection highlighted.
     * @param {string} type - 'subtitles' or 'audio'
     * @param {string} [mode] - For subtitles: 'primary' or 'secondary'
     */
    async _openTrackMenu(type, mode) {
        const player = this._player;
        if (!player) return;

        this._trackMenuType = type;
        this._trackMenuFocusIndex = 0;

        // Set subtitle mode (primary or secondary)
        if (type === 'subtitles') {
            this._trackMenuSubtitleMode = mode || 'primary';
        }

        // Fetch available tracks from the player
        let tracks = [];
        let title = '';
        let currentIndex = -1;

        try {
            if (type === 'subtitles') {
                const tracksRaw = player.getSubtitleTracks ? player.getSubtitleTracks() : [];
                tracks = Promise.resolve(tracksRaw).then ? await tracksRaw : tracksRaw;

                if (this._trackMenuSubtitleMode === 'secondary') {
                    title = 'Secondary Subtitle';
                    currentIndex = this._currentSecondarySubtitleIndex;
                } else {
                    title = 'Subtitles';
                    currentIndex = this._currentSubtitleIndex;
                }

                // Add "Off" option at the beginning
                tracks = [{ Index: -1, DisplayTitle: 'Off' }, ...tracks];
            } else if (type === 'audio') {
                const tracksRaw = player.getAudioTracks ? player.getAudioTracks() : [];
                tracks = Promise.resolve(tracksRaw).then ? await tracksRaw : tracksRaw;

                title = 'Audio';
                currentIndex = this._currentAudioIndex;
            }
        } catch (e) {
            log.error('Failed to get tracks:', e);
            return;
        }

        // Bail if no tracks are available
        if (tracks.length === 0) {
            log.info('No tracks available for', type);
            return;
        }

        // Find current selection index in menu list
        const trackListIndex = tracks.findIndex(t => t.Index === currentIndex);

        // For subtitle menus, add 1 to account for the header option
        if (type === 'subtitles') {
            this._trackMenuFocusIndex = trackListIndex < 0 ? 1 : trackListIndex + 1;
        } else {
            this._trackMenuFocusIndex = trackListIndex < 0 ? 0 : trackListIndex;
        }

        // Render and show the menu
        this._renderTrackMenu(title, tracks, currentIndex);
        this._isTrackMenuOpen = true;
        this._trackMenuOverlay.classList.add('visible');
        this._updateTrackMenuFocus();
    }

    /** Close the track selection menu */
    _closeTrackMenu() {
        if (this._trackMenuOverlay) {
            this._trackMenuOverlay.classList.remove('visible');
        }
        this._isTrackMenuOpen = false;
        this._trackMenuType = null;
    }

    /**
     * Render the track menu overlay HTML.
     * Creates the overlay on first call, then just updates innerHTML.
     */
    _renderTrackMenu(title, tracks, currentIndex) {
        // Create overlay element if it doesn't exist yet
        if (!this._trackMenuOverlay) {
            this._trackMenuOverlay = document.createElement('div');
            this._trackMenuOverlay.className = 'track-menu-overlay';
            document.body.appendChild(this._trackMenuOverlay);

            // Backdrop click to close (bound once)
            this._trackMenuOverlay.addEventListener('click', (e) => {
                if (e.target === this._trackMenuOverlay) {
                    this._closeTrackMenu();
                }
            });
        }

        // Build header option for mode switching (subtitle menu only)
        let headerOptionHtml = '';
        if (this._trackMenuType === 'subtitles') {
            if (this._trackMenuSubtitleMode === 'primary') {
                // Show "Secondary Subtitle" toggle at the top
                headerOptionHtml = `
                    <button class="track-option track-mode-switch" data-action="switch-secondary">
                        <span class="track-option-check"></span>
                        <span class="track-option-label">Secondary Subtitle</span>
                    </button>
                `;
            } else {
                // Show "← Back" to return to primary subtitle list
                headerOptionHtml = `
                    <button class="track-option track-mode-switch" data-action="switch-primary">
                        <span class="track-option-check"></span>
                        <span class="track-option-label">← Back</span>
                    </button>
                `;
            }
        }

        // Build track option buttons
        const optionsHtml = tracks.map((track, i) => {
            const isSelected = track.Index === currentIndex;
            const label = track.DisplayTitle || track.Title || `Track ${track.Index}`;
            return `
                <button class="track-option track-item ${isSelected ? 'selected' : ''}" data-index="${track.Index}" data-menu-index="${i}">
                    <span class="track-option-check">${ICONS.check}</span>
                    <span class="track-option-label">${label}</span>
                </button>
            `;
        }).join('');

        // Assemble menu HTML
        this._trackMenuOverlay.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">${title}</div>
                <div class="track-menu-options">
                    ${headerOptionHtml}
                    ${optionsHtml}
                </div>
            </div>
        `;

        // Bind click handler for mode-switch button
        const modeSwitchBtn = this._trackMenuOverlay.querySelector('.track-mode-switch');
        if (modeSwitchBtn) {
            modeSwitchBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const switchAction = modeSwitchBtn.dataset.action;
                if (switchAction === 'switch-secondary') {
                    this._openTrackMenu('subtitles', 'secondary');
                } else if (switchAction === 'switch-primary') {
                    this._openTrackMenu('subtitles', 'primary');
                }
            });
        }

        // Bind click handlers for each track option
        this._trackMenuOverlay.querySelectorAll('.track-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const menuIndex = parseInt(btn.dataset.menuIndex);
                this._selectTrackByMenuIndex(menuIndex);
            });
        });
    }

    /** Update visual focus in the track menu list */
    _updateTrackMenuFocus() {
        if (!this._trackMenuOverlay) return;
        const options = this._trackMenuOverlay.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === this._trackMenuFocusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }

    /**
     * Handle D-pad navigation within the track menu
     * @param {string} direction - 'up' or 'down'
     */
    _handleTrackMenuNav(direction) {
        const options = this._trackMenuOverlay?.querySelectorAll('.track-option') || [];
        const optionCount = options.length;

        if (direction === 'up' && this._trackMenuFocusIndex > 0) {
            this._trackMenuFocusIndex--;
            this._updateTrackMenuFocus();
        } else if (direction === 'down' && this._trackMenuFocusIndex < optionCount - 1) {
            this._trackMenuFocusIndex++;
            this._updateTrackMenuFocus();
        }
    }

    /** Handle Enter key within the track menu */
    _handleTrackMenuEnter() {
        const options = this._trackMenuOverlay?.querySelectorAll('.track-option') || [];
        const focusedOption = options[this._trackMenuFocusIndex];

        if (focusedOption && focusedOption.classList.contains('track-mode-switch')) {
            // Handle mode switch (primary ↔ secondary)
            const switchAction = focusedOption.dataset.action;
            if (switchAction === 'switch-secondary') {
                this._openTrackMenu('subtitles', 'secondary');
            } else if (switchAction === 'switch-primary') {
                this._openTrackMenu('subtitles', 'primary');
            }
        } else {
            // Handle track selection — adjust index if header exists
            const hasHeader = this._trackMenuType === 'subtitles';
            const trackIndex = hasHeader ? this._trackMenuFocusIndex - 1 : this._trackMenuFocusIndex;
            this._selectTrackByMenuIndex(trackIndex);
        }
    }

    /**
     * Select a track by its index in the menu list.
     * Updates the player's active stream and re-renders the menu.
     * @param {number} menuIndex - Index in the tracks array (0 = Off for subtitles)
     */
    _selectTrackByMenuIndex(menuIndex) {
        const player = this._player;
        if (!player) return;

        if (this._trackMenuType === 'subtitles') {
            const isSecondary = this._trackMenuSubtitleMode === 'secondary';

            // Menu index 0 = "Off" (stream index -1)
            if (menuIndex === 0) {
                if (isSecondary) {
                    this._currentSecondarySubtitleIndex = -1;
                    if (player.setSecondarySubtitleStreamIndex) {
                        player.setSecondarySubtitleStreamIndex(-1);
                    }
                    log.info('Secondary Subtitles Off');
                } else {
                    this._currentSubtitleIndex = -1;
                    if (player.setSubtitleStreamIndex) {
                        player.setSubtitleStreamIndex(-1);
                    }
                    log.info('Subtitles Off');
                }
            } else {
                // menuIndex 1+ corresponds to tracks[0+]
                const tracks = player.getSubtitleTracks ? player.getSubtitleTracks() : [];
                const track = tracks[menuIndex - 1];
                if (track) {
                    if (isSecondary) {
                        this._currentSecondarySubtitleIndex = track.Index;
                        if (player.setSecondarySubtitleStreamIndex) {
                            player.setSecondarySubtitleStreamIndex(track.Index);
                        }
                        log.info('Secondary subtitle track set to index:', track.Index);
                    } else {
                        this._currentSubtitleIndex = track.Index;
                        if (player.setSubtitleStreamIndex) {
                            player.setSubtitleStreamIndex(track.Index);
                        }
                        log.info('Subtitle track set to index:', track.Index);
                    }
                }
            }
        } else if (this._trackMenuType === 'audio') {
            // Audio has no "Off" — menu index maps directly to tracks array
            const tracks = player.getAudioTracks ? player.getAudioTracks() : [];
            const track = tracks[menuIndex];
            if (track) {
                this._currentAudioIndex = track.Index;
                if (player.setAudioStreamIndex) {
                    player.setAudioStreamIndex(track.Index);
                }
                log.info('Audio track set to index:', track.Index);
            }
        }

        // Re-render menu to update checkmarks (don't auto-close)
        if (this._trackMenuType === 'subtitles') {
            this._openTrackMenu('subtitles', this._trackMenuSubtitleMode);
        } else if (this._trackMenuType === 'audio') {
            this._openTrackMenu('audio');
        }
    }

    // ========================================================================
    // Settings Menu
    // ========================================================================

    /**
     * Open the OSD settings menu
     */
    _openSettingsMenu() {
        this._isSettingsMenuOpen = true;
        this._settingsMenuFocusIndex = 0;

        // Define available settings options
        const options = [
            { id: 'subtitleOffset', label: 'Subtitle Offset', icon: ICONS.sync }
            // Future: { id: 'skipIntro', label: 'Skip Intro', icon: ... }, etc.
        ];

        this._renderSettingsMenu(options);
        this._settingsMenuOverlay.classList.add('visible');
        this._updateSettingsMenuFocus();
    }

    /**
     * Close the OSD settings menu
     */
    _closeSettingsMenu() {
        if (this._settingsMenuOverlay) {
            this._settingsMenuOverlay.classList.remove('visible');
        }
        this._isSettingsMenuOpen = false;
    }

    /**
     * Render the settings menu overlay
     * @param {Array} options 
     */
    _renderSettingsMenu(options) {
        if (!this._settingsMenuOverlay) {
            this._settingsMenuOverlay = document.createElement('div');
            this._settingsMenuOverlay.className = 'track-menu-overlay'; // Reuse same layout as tracks
            document.body.appendChild(this._settingsMenuOverlay);

            this._settingsMenuOverlay.addEventListener('click', (e) => {
                if (e.target === this._settingsMenuOverlay) {
                    this._closeSettingsMenu();
                }
            });
        }

        const optionsHtml = options.map((opt, i) => `
            <button class="track-option track-item" data-id="${opt.id}" data-menu-index="${i}">
                <span class="track-option-icon">${opt.icon || ''}</span>
                <span class="track-option-label">${opt.label}</span>
            </button>
        `).join('');

        this._settingsMenuOverlay.innerHTML = `
            <div class="track-menu">
                <div class="track-menu-title">Settings</div>
                <div class="track-menu-options">
                    ${optionsHtml}
                </div>
            </div>
        `;

        this._settingsMenuOverlay.querySelectorAll('.track-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._settingsMenuFocusIndex = parseInt(btn.dataset.menuIndex);
                this._handleSettingsMenuEnter();
            });
        });
    }

    /** Update focus in the settings menu */
    _updateSettingsMenuFocus() {
        if (!this._settingsMenuOverlay) return;
        const options = this._settingsMenuOverlay.querySelectorAll('.track-option');
        options.forEach((opt, i) => {
            const isFocused = i === this._settingsMenuFocusIndex;
            opt.classList.toggle('focused', isFocused);
            if (isFocused) {
                opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }

    /** Handle nav in settings menu */
    _handleSettingsMenuNav(direction) {
        const options = this._settingsMenuOverlay?.querySelectorAll('.track-option') || [];
        if (direction === 'up' && this._settingsMenuFocusIndex > 0) {
            this._settingsMenuFocusIndex--;
            this._updateSettingsMenuFocus();
        } else if (direction === 'down' && this._settingsMenuFocusIndex < options.length - 1) {
            this._settingsMenuFocusIndex++;
            this._updateSettingsMenuFocus();
        }
    }

    /** Handle Enter key in settings menu */
    _handleSettingsMenuEnter() {
        const options = this._settingsMenuOverlay?.querySelectorAll('.track-option') || [];
        const focusedOption = options[this._settingsMenuFocusIndex];
        if (!focusedOption) return;

        const actionId = focusedOption.dataset.id;
        
        // Close menu first
        this._closeSettingsMenu();

        switch (actionId) {
            case 'subtitleOffset':
                // Toggle behavior: if already showing, close it.
                this._toggleSubtitleOffset(!this._showSubtitleOffset);
                break;
        }
    }

    // ========================================================================
    // Favorite Toggle
    // ========================================================================

    /** Update the favorite button icon and color based on item state */
    _updateFavoriteButton() {
        const btn = this._osdEl?.querySelector('#osdFavoriteBtn');
        if (!btn || !this._item?.UserData) return;

        const isFavorite = this._item.UserData.IsFavorite;

        // Swap icon between filled and outline heart
        btn.innerHTML = isFavorite ? ICONS.favoriteFilled : ICONS.favorite;

        // Update visual style
        if (isFavorite) {
            btn.classList.add('active');
            btn.style.color = '#e74c3c'; // Red heart for favorite
        } else {
            btn.classList.remove('active');
            btn.style.color = '';         // Inherit default (white)
        }
    }

    /** Toggle the favorite state for the current item via API */
    async _toggleFavorite() {
        if (!this._api || !this._item) return;

        const newItem = { ...this._item };
        const wasFavorite = newItem.UserData.IsFavorite;

        // Optimistic UI update — show change immediately
        newItem.UserData.IsFavorite = !wasFavorite;
        this._item = newItem;
        this._updateFavoriteButton();

        try {
            // Commit to server
            if (wasFavorite) {
                await this._api.unmarkFavorite(newItem.Id);
            } else {
                await this._api.markFavorite(newItem.Id);
            }
        } catch (error) {
            log.error('Failed to toggle favorite:', error);
            // Revert on failure
            newItem.UserData.IsFavorite = wasFavorite;
            this._item = newItem;
            this._updateFavoriteButton();
        }
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    /**
     * Format time as MM:SS or HH:MM:SS
     * @param {number} ticks
     */
    _formatTime(ticks) {
        if (!ticks) return '00:00';
        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const pad = (n) => n.toString().padStart(2, '0');
        if (hours > 0) {
            return `${hours}:${pad(minutes)}:${pad(seconds)}`;
        }
        return `${pad(minutes)}:${pad(seconds)}`;
    }

    // ========================================================================
    // Subtitle Offset Logic
    // ========================================================================

    /**
     * Toggle the subtitle offset overlay.
     * Integrates with the OSD's row-based focus model by clearing
     * the custom .focused class from all OSD elements when the overlay
     * opens (so we don't get dual focus indicators), and restoring
     * focus to the controls row when the overlay closes.
     * @param {boolean} show
     */
    _toggleSubtitleOffset(show) {
        this._showSubtitleOffset = show;
        const overlay = this._osdEl.querySelector('#osdOffsetOverlay');

        if (show) {
            // Stop any pending auto-hide timer since the menu is opening
            this._resetAutoHide();

            // Show the overlay
            overlay?.classList.add('visible');

            // Set focus to the overlay row (Row -1)
            this._currentFocusRow = -1;
            this._currentFocusIndex = 1; // Default to slider
            
            // Sync UI to current offset value
            this._updateSubtitleOffsetUI();
            
            // Refresh focusable cache to include overlay elements
            this._cacheFocusableElements();
            this._updateFocus();
        } else {
            // Hide the overlay
            overlay?.classList.remove('visible');

            // Restore OSD focus to settings button (row 1, last item)
            const { controlsRow } = this._getFocusableElements();
            this._currentFocusRow = 1;
            this._currentFocusIndex = controlsRow.length - 1; // Settings is the last button
            
            // Clear overlay elements from cache
            this._cachedOverlayRow = [];
            
            this._show(); // Re-open OSD if hidden
            this._updateFocus();
            
            // Ensure offset is synced to the player backend
            if (this._player?.setSubtitleOffset) {
                this._player.setSubtitleOffset(this._subtitleOffset);
            }
        }
    }

    /**
     * Adjust subtitle offset by delta
     * @param {number} deltaSeconds
     */
    _adjustSubtitleOffset(deltaSeconds) {
        // Round to 1 decimal place to avoid float errors
        let newOffset = Math.round((this._subtitleOffset + deltaSeconds) * 10) / 10;
        
        // Clamp to -30 to +30
        if (newOffset < -30) newOffset = -30;
        if (newOffset > 30) newOffset = 30;

        this._subtitleOffset = newOffset;
        this._updateSubtitleOffsetUI();
        
        // Apply to player
        if (this._player?.setSubtitleOffset) {
            this._player.setSubtitleOffset(this._subtitleOffset);
        }
    }

    /**
     * Update the Subtitle Offset UI elements
     */
    _updateSubtitleOffsetUI() {
        const valueEl = this._osdEl.querySelector('#osdOffsetValue');
        const slider = this._osdEl.querySelector('#osdOffsetSlider');
        
        if (valueEl) {
            const sign = this._subtitleOffset > 0 ? '+' : '';
            valueEl.textContent = `${sign}${this._subtitleOffset.toFixed(1)}s`;
        }
        
        if (slider) {
            slider.value = this._subtitleOffset;
        }
    }

    /**
     * Handle navigation within the overlay row (Row -1)
     * @param {string} direction 'up', 'down', 'left', 'right'
     * @returns {boolean} True if navigation was handled internally
     */
    _handleOverlayNav(direction) {
        const { overlayRow, controlsRow } = this._getFocusableElements();
        if (overlayRow.length === 0) return false;

        // SUBTITLE OFFSET WIDGET
        if (this._showSubtitleOffset) {
            const currentEl = overlayRow[this._currentFocusIndex];
            const isSlider = currentEl?.id === 'osdOffsetSlider';
            const isClose = currentEl?.classList.contains('osd-offset-close');

            if (direction === 'up') {
                if (isSlider) {
                    this._currentFocusIndex = 0; // Go to Close
                    this._updateFocus();
                    return true;
                }
                return true; // Block Up from Close
            }

            if (direction === 'down') {
                if (isClose) {
                    this._currentFocusIndex = 1; // Go to Slider
                    this._updateFocus();
                    return true;
                }
                
                // Down from Slider -> Action Buttons (Row 1)
                this._currentFocusRow = 1;
                // Try to find play button, else center of row
                const playIndex = this._findActionIndex('togglePlay');
                this._currentFocusIndex = playIndex !== -1 ? playIndex : Math.floor(controlsRow.length / 2);
                
                this._show();
                this._resetAutoHide();
                this._updateFocus();
                return true;
            }

            if (direction === 'left') {
                if (isSlider) {
                    this._adjustSubtitleOffset(-0.1);
                    return true;
                }
                if (isClose) {
                    // Left from Close -> Back Button (Row 0)
                    this._currentFocusRow = 0;
                    this._currentFocusIndex = 0;
                    this._show();
                    this._resetAutoHide();
                    this._updateFocus();
                    return true;
                }
            }

            if (direction === 'right') {
                if (isSlider) {
                    this._adjustSubtitleOffset(0.1);
                    return true;
                }
                return true; // Block Right from Close
            }
        }

        return false;
    }
}

export default PlayerOSD;
