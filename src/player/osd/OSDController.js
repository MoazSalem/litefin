import Component from '../../core/Component.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { playQueue } from '../../core/PlayQueue.js';
import { i18n } from '../../utils/i18n.js';
import { ICONS } from './icons.js';

import TrackMenu from './TrackMenu.js';
import SettingsMenu from './SettingsMenu.js';
import SubtitleOffset from './SubtitleOffset.js';
import SubtitleQuickSettings from './SubtitleQuickSettings.js';
import PlaybackInfo from './PlaybackInfo.js';
import AspectRatioMenu from './AspectRatioMenu.js';
import PlaybackSpeedMenu from './PlaybackSpeedMenu.js';
import QualityMenu from './QualityMenu.js';
import PlaybackModeMenu from './PlaybackModeMenu.js';
import RepeatModeMenu from './RepeatModeMenu.js';
import UpNextDialog from './UpNextDialog.js';

const log = logger.create('OSDController');

/**
 * OSDController
 * 
 * Manages the On-Screen Display (OSD) for the video player.
 * It handles:
 * - OSD visibility and timeout (auto-hide).
 * - Focus management between the Header, Main Controls, and Seekbar.
 * - Integration with sub-menus (Settings, Track Selection, Playback Info, Subtitle Offset).
 * - Key event delegation to the appropriate active menu or control.
 * - Player state updates (time, progress, play/pause state).
 */
export default class OSDController extends Component {
    constructor(player, options = {}) {
        super(options);
        this._player = player;
        this._api = options.api || window.ApiClient;
        this._config = {
            autoHideDelay: 3500,
            seekStepBack: 10,
            seekStepForward: 30,
            updateInterval: 500,
            ...options
        };

        // State
        this._isOsdVisible = false;
        this._autoHideTimer = null;
        this._updateTimer = null;
        this._isDraggingSeekbar = false;
        
        // Seek Session
        this._seekTargetTicks = null;
        this._seekStartTime = null;
        this._seekDebounceTimer = null;

        // Focus State
        // Row -1: Overlays (persistent widgets)
        // Row 0: Header (Back)
        // Row 1: Controls
        // Row 2: Seekbar
        this._currentFocusRow = 1;
        this._currentFocusIndex = 2; // Default to Play/Pause

        this._cachedOverlayRow = [];
        this._cachedHeaderRow = [];
        this._cachedControlsRow = [];
        this._cachedSeekbar = null;

        /*
         * Up Next dialog state.
         * _upNextShown: true once the dialog has been triggered for the current
         *   item — prevents re-triggering on every tick while still visible.
         * _upNextHiddenByUser: true when the user pressed "Hide" manually —
         *   prevents re-showing until they seek back past the threshold.
         */
        this._upNextShown = false;
        this._upNextHiddenByUser = false;

        // Ensure playQueue updates visually
        this._boundHandleQueueUpdate = this._handleQueueUpdate.bind(this);
        import('../../core/EventBus.js').then(({ eventBus }) => {
            eventBus.on('playqueue:updated', this._boundHandleQueueUpdate);
        });

        this._initMenus();

        if (options.item) {
            this._currentItem = options.item;
        }

        // Bindings
        this._onMouseMove = this._onMouseMove.bind(this);
    }

    _handleQueueUpdate() {
        // Redraw active menu if open to show checks
        if (this.repeatModeMenu && this.repeatModeMenu.isVisible) {
            this.repeatModeMenu.render();
        }
    }

    _initMenus() {
        this.audioMenu = new TrackMenu(this, 'audio');
        this.subtitleMenu = new TrackMenu(this, 'subtitle');
        this.settingsMenu = new SettingsMenu(this);
        this.subtitleOffset = new SubtitleOffset(this);
        this.subtitleQuickSettings = new SubtitleQuickSettings(this);
        this.playbackInfo = new PlaybackInfo(this);
        
        // Player Settings Sub-menus
        this.aspectRatioMenu = new AspectRatioMenu(this);
        this.playbackSpeedMenu = new PlaybackSpeedMenu(this);
        this.qualityMenu = new QualityMenu(this);
        this.playbackModeMenu = new PlaybackModeMenu(this);
        this.repeatModeMenu = new RepeatModeMenu(this);

        // Up Next dialog — persistent overlay card, not modal
        this.upNextDialog = new UpNextDialog(this);

        this.menus = [
            this.audioMenu,
            this.subtitleMenu,
            this.settingsMenu,
            this.subtitleOffset,
            this.subtitleQuickSettings,
            this.playbackInfo,
            this.aspectRatioMenu,
            this.playbackSpeedMenu,
            this.qualityMenu,
            this.playbackModeMenu,
            this.repeatModeMenu,
            this.upNextDialog
        ];
    }

    // Public API for components
    get player() { return this._player; }
    get api() { return this._api; } 

    // Proxy track indices for compatibility with menus
    get currentAudioIndex() { return this._currentAudioIndex; }
    set currentAudioIndex(val) { this._currentAudioIndex = val; }
    get currentSubtitleIndex() { return this._currentSubtitleIndex; }
    set currentSubtitleIndex(val) { this._currentSubtitleIndex = val; }
    get currentSecondarySubtitleIndex() { return this._currentSecondarySubtitleIndex; }
    set currentSecondarySubtitleIndex(val) { this._currentSecondarySubtitleIndex = val; }

    // Lifecycle
    onMounted() {
        this._startUpdates();
        
        // Sync tracks initially
        this.syncTracks();

        if (this._currentItem) {
            this.setMetadata(this._currentItem);
        }

        // Mouse move to show OSD (attached to container)
        if (this._player) {
            this._player.on('mediastreamschange', (e) => this._onMediaStreamsChange(e));
            this._player.on('play', () => this._updatePlayPauseButton());
            this._player.on('pause', () => this._updatePlayPauseButton());
            this._player.on('chaptersloaded', () => this._updateChapterButtons());
            this._player.on('seek', (e) => this._onPlayerSeek(e));
            // Also update markers when duration becomes available
            this._player.on('durationchange', () => this._renderChapterMarkers());
            this._player.on('loadedmetadata', () => this._renderChapterMarkers());
        }

        // Initial render attempt
        this._updateChapterButtons();
        this._renderChapterMarkers();

        // Bind keys
        this._bindKeyEvents();

        // Initial cache
        this._cacheFocusableElements();
        
        // Start hidden
        this.hide();
    }

    onBeforeDestroy() {
        this._stopUpdates();
        if (this._updateTimer) clearInterval(this._updateTimer);
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        
        import('../../core/EventBus.js').then(({ eventBus }) => {
            eventBus.off('playqueue:updated', this._boundHandleQueueUpdate);
        });

        this.menus.forEach(menu => menu.hide?.());

        if (this._player) {
            this._player.removeAllListeners('mediastreamschange');
            this._player.removeAllListeners('play');
            this._player.removeAllListeners('pause');
            this._player.removeAllListeners('chaptersloaded');
            this._player.removeAllListeners('seek');
            this._player.removeAllListeners('durationchange');
            this._player.removeAllListeners('loadedmetadata');
        }
        
        if (this.container) {
            this.container.removeEventListener('mousemove', this._onMouseMove);
        }
    }

    render() {
        // Main OSD structure
        this._osdEl = document.createElement('div');
        this._osdEl.className = 'player-osd'; // Match CSS
        this._osdEl.innerHTML = `
            <div class="osd-main">
                <!-- Header -->
                <div class="osd-header" id="osdHeader">
                    <div class="osd-header-left">
                        <button class="osd-btn osd-back-btn" data-action="exit" aria-label="${i18n.t('ButtonBack')}" tabindex="0">
                            ${ICONS.arrowBack}
                        </button>
                        <span class="osd-title" id="osdTitle"></span>
                    </div>
                    <div class="osd-header-right">
                        <span class="osd-clock" id="osdClock"></span>
                    </div>
                </div>

                <!-- Bottom Area -->
                <div class="osd-bottom">
                    <!-- Controls Row (above slider) -->
                    <div class="osd-controls-row">
                        <div class="osd-controls-left">
                            <button class="osd-btn" data-action="previousTrack" tabindex="0" id="osdPrevBtn">${ICONS.skipPrevious}</button>
                            <button class="osd-btn osd-btn-disabled" data-action="previousChapter" tabindex="-1" id="osdPrevChapterBtn">${ICONS.chapterPrevious}</button>
                            <button class="osd-btn" data-action="rewind" tabindex="0">${ICONS.fastRewind}</button>
                            <button class="osd-btn osd-btn-play" id="osdPlayPauseBtn" data-action="togglePlay" tabindex="0">${ICONS.pause}</button>
                            <button class="osd-btn" data-action="fastForward" tabindex="0">${ICONS.fastForward}</button>
                            <button class="osd-btn osd-btn-disabled" data-action="nextChapter" tabindex="-1" id="osdNextChapterBtn">${ICONS.chapterNext}</button>
                            <button class="osd-btn" data-action="nextTrack" tabindex="0" id="osdNextBtn">${ICONS.skipNext}</button>
                        </div>
                        <div class="osd-ends-at" id="osdEndsAt"></div>
                        <div class="osd-spacer"></div>
                        <div class="osd-controls-right">
                            <button class="osd-btn" id="osdFavoriteBtn" data-action="favorite" tabindex="0">${ICONS.favorite}</button>
                            <button class="osd-btn" data-action="subtitles" tabindex="0">${ICONS.closedCaption}</button>
                            <button class="osd-btn" data-action="audio" tabindex="0">${ICONS.audiotrack}</button>
                            <button class="osd-btn" data-action="settings" tabindex="0">${ICONS.settings}</button>
                        </div>
                    </div>

                    <!-- Seekbar Container (below controls) -->
                    <div class="osd-slider-row">
                        <span class="osd-time osd-time-current" id="osdCurrentTime">00:00</span>
                        <div class="osd-slider-container">
                            <div class="osd-seek-tooltip" id="osdSeekTooltip"></div>
                            <div class="osd-chapter-markers" id="osdChapterMarkers"></div>
                            <div class="osd-slider-track">
                                <div class="osd-slider-fill" id="osdPositionFill"></div>
                            </div>
                            <input type="range" class="osd-slider" id="osdPositionSlider" min="0" max="100" step="0.01" value="0" tabindex="0">
                        </div>
                        <span class="osd-time osd-time-total" id="osdTotalTime">00:00</span>
                    </div>
                </div>
            </div>
            <div class="osd-overlays"></div>
        `;

        // Bind slider
        const slider = this._osdEl.querySelector('#osdPositionSlider');
        slider.addEventListener('input', (e) => this._handlePositionSliderInput(e));
        slider.addEventListener('change', (e) => this._handlePositionSliderChange(e));

        // Bind clicks
        // Bind clicks (Delegate for dynamic content)
        this._osdEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                e.stopPropagation();
                // If it's a slider check if we should ignore? No, slider doesn't have data-action usually.
                 this._executeAction(btn.dataset.action);
            }
        });

        // Initial update
        this._updatePlayPauseButton();

        return this._osdEl;
    }

    _onMouseMove() {
        this.show();
        this.resetAutoHide();
    }

    // ===================================
    // API for Components
    // ===================================

    get isMenuOpen() {
        return this.activeMenu && this.activeMenu.isVisible;
    }

    get isModalOpen() {
        return this.activeMenu && this.activeMenu.isModal && this.activeMenu.isVisible;
    }

    show() {
        const main = this._osdEl.querySelector('.osd-main');
        if (main) main.classList.remove('osd-hidden');
        if (this._osdEl) this._osdEl.classList.remove('osd-is-hidden');
        this._isOsdVisible = true;
        this.resetAutoHide();
        this._updateNavigationButtons();
    }

    /**
     * Called by PluginWidgetHost when a plugin widget becomes visible.
     * Moves OSD focus to the overlay row (Row -1) and shows the OSD,
     * so the button is immediately reachable with a single Enter press.
     *
     * @param {number} [widgetIndex=0] - Index within the overlay row to focus
     */
    focusPluginWidget(widgetIndex = 0) {
        // Rebuild the cache so newly visible buttons are included
        this._cacheFocusableElements();

        // Nothing to focus if there are no focusable buttons in the overlay
        if (this._cachedOverlayRow.length === 0) return;

        // Plugin widget overlays are independent — they float above the video
        // without requiring the main OSD controls to be visible (same pattern
        // as subtitle offset / playback info panels).
        // Do NOT force show() or suppress auto-hide here.

        // Move focus to the overlay row
        this._currentFocusRow = -1;
        this._currentFocusIndex = Math.min(widgetIndex, this._cachedOverlayRow.length - 1);
        this._updateFocus();
    }

    /**
     * Called by PluginWidgetHost when all plugin widgets hide.
     * Returns focus to the Controls row (Row 1) at the Play/Pause button,
     * and re-enables the normal auto-hide timer.
     */
    restoreControlsFocus() {
        // Rebuild cache so the now-hidden widget buttons are removed
        this._cacheFocusableElements();

        // Only restore if focus was actually in the overlay row
        if (this._currentFocusRow === -1) {
            this._currentFocusRow = 1;
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this._updateFocus();
        }

        // Resume normal auto-hide behaviour
        this.resetAutoHide();
    }

    _updateNavigationButtons() {
        if (!this._osdEl) return;
        
        const hasPrev = playQueue.hasPrevious();
        const hasNext = playQueue.hasNext();
        
        const prevBtn = this._osdEl.querySelector('[data-action="previousTrack"]');
        if (prevBtn) {
            if (hasPrev) {
                prevBtn.classList.remove('osd-btn-disabled');
                prevBtn.setAttribute('tabindex', '0');
            } else {
                prevBtn.classList.add('osd-btn-disabled');
                prevBtn.setAttribute('tabindex', '-1');
            }
        }

        const nextBtn = this._osdEl.querySelector('[data-action="nextTrack"]');
        if (nextBtn) {
            if (hasNext) {
                nextBtn.classList.remove('osd-btn-disabled');
                nextBtn.setAttribute('tabindex', '0');
            } else {
                nextBtn.classList.add('osd-btn-disabled');
                nextBtn.setAttribute('tabindex', '-1');
            }
        }
    }

    _updateChapterButtons() {
        if (!this._osdEl || !this._player) return;

        const chapters = this._player.getChapters ? this._player.getChapters() : [];
        const hasChapters = chapters && chapters.length > 0;

        const prevChapterBtn = this._osdEl.querySelector('[data-action="previousChapter"]');
        const nextChapterBtn = this._osdEl.querySelector('[data-action="nextChapter"]');

        if (hasChapters) {
             if (prevChapterBtn) {
                 prevChapterBtn.classList.remove('osd-btn-disabled');
                 prevChapterBtn.setAttribute('tabindex', '0');
             }
             if (nextChapterBtn) {
                 nextChapterBtn.classList.remove('osd-btn-disabled');
                 nextChapterBtn.setAttribute('tabindex', '0');
             }
             this._renderChapterMarkers();
        } else {
             if (prevChapterBtn) {
                 prevChapterBtn.classList.add('osd-btn-disabled');
                 prevChapterBtn.setAttribute('tabindex', '-1');
             }
             if (nextChapterBtn) {
                 nextChapterBtn.classList.add('osd-btn-disabled');
                 nextChapterBtn.setAttribute('tabindex', '-1');
             }
             this._renderChapterMarkers();
        }
    }

    _renderChapterMarkers() {
        if (!this._osdEl || !this._player) return;

        const container = this._osdEl.querySelector('#osdChapterMarkers');
        if (!container) {
            // Container might not be in DOM yet if this is called early
            log.debug('#osdChapterMarkers not found, retrying in 500ms');
            setTimeout(() => this._renderChapterMarkers(), 500);
            return;
        }

        const chapters = this._player.getChapters ? this._player.getChapters() : [];
        const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;

        log.debug(`Rendering chapter markers. Count: ${chapters.length}, Duration: ${duration}`);

        if (!chapters.length || duration <= 0) {
            // If we have chapters but duration is 0, we MUST retry once we get duration
            if (chapters.length > 0 && duration === 0) {
                 log.debug('Chapters found but duration is 0, will retry when duration changes');
            }
            container.innerHTML = '';
            return;
        }

        // Clear existing
        container.innerHTML = '';

        chapters.forEach((chapter, index) => {
            // First chapter is usually at 0, skipping it for visual clarity as the start is obvious
            if (index === 0 && (chapter.StartPositionTicks === 0 || !chapter.StartPositionTicks)) return;

            const percent = (chapter.StartPositionTicks / duration) * 100;
            if (percent > 0 && percent < 100) {
                const marker = document.createElement('div');
                marker.className = 'osd-chapter-marker';
                marker.style.left = `${percent}%`;
                container.appendChild(marker);
            }
        });

        log.debug(`Rendered ${container.children.length} markers`);
    }

    hide() {
        // Don't hide if a modal menu is open
        if (this.isModalOpen) return; 
        
        const main = this._osdEl.querySelector('.osd-main');
        if (main) main.classList.add('osd-hidden');
        if (this._osdEl) this._osdEl.classList.add('osd-is-hidden');
        this._isOsdVisible = false;
    }

    resetAutoHide() {
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        // Do not auto-hide if a modal menu is open
        if (this.isModalOpen) return;
        this._autoHideTimer = setTimeout(() => this.hide(), this._config.autoHideDelay);
    }

    closeMenu() {
        if (this.activeMenu) {
            const menu = this.activeMenu;
            menu.hide(); 
            this.activeMenu = null;
            
            // Refresh cache before restoring focus
            this._cacheFocusableElements();
            
            this.show(); // Restore OSD visibility
            // The menu.hide() call internally updates OSD focus row/index 
            // and calls _updateFocus()
        }
    }

    togglePlaybackInfo(show) {
        if (show) {
            this.activeMenu = this.playbackInfo;
            this.playbackInfo.toggle(true);
            this._cacheFocusableElements();
            
            // Force focus to overlay (Close button usually index 0)
            this._currentFocusRow = -1;
            const closeIdx = this._cachedOverlayRow.findIndex(el => el.classList.contains('playback-info-close'));
            this._currentFocusIndex = closeIdx !== -1 ? closeIdx : 0;
            this._updateFocus();
        } else {
            if (this.activeMenu === this.playbackInfo) {
                this.activeMenu = null;
            }
            this.playbackInfo.toggle(false);
            this._cacheFocusableElements();
            
            // Ensure OSD is visible when returning from menu
            this.show();

            // Restore focus to Controls (Row 1) -> Play/Pause
            this._currentFocusRow = 1; 
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this._updateFocus();
        }
    }

    toggleSubtitleOffset(show) {
        if (show) {
            this.activeMenu = this.subtitleOffset; // Enable key delegation
            this.subtitleOffset.toggle(true);
            this._cacheFocusableElements();
            
            // Force focus to overlay (Slider usually index 1, Close index 0)
            this._currentFocusRow = -1;
            // Default to slider for better UX? Or close? User said "can't reach seekbar".
            // Let's default to slider (index 1 if close is 0).
            const sliderIdx = this._cachedOverlayRow.findIndex(el => el.classList.contains('osd-slider'));
            this._currentFocusIndex = sliderIdx !== -1 ? sliderIdx : 0;
            this._updateFocus();
        } else {
            if (this.activeMenu === this.subtitleOffset) {
                this.activeMenu = null;
            }
            this.subtitleOffset.toggle(false);
            this._cacheFocusableElements();
            
            // Ensure OSD is visible when returning from menu
            this.show();

            // Restore focus (e.g. to settings button or options)
            // If we came from Options -> Settings -> Offset, Settings is closed.
            // Focus should go back to OSD -> Play/Pause
            this._currentFocusRow = 1; // Controls
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this._updateFocus();
        }
    }

    toggleSubtitleQuickSettings(force) {
        if (force === undefined) {
             force = !this.subtitleQuickSettings.isVisible;
        }

        if (force) {
            this.subtitleQuickSettings.open();
            this.activeMenu = this.subtitleQuickSettings;
        } else {
            this.subtitleQuickSettings.hide();
            if (this.activeMenu === this.subtitleQuickSettings) {
                this.activeMenu = null;
            }
            this.show();
            this._updateFocus();
        }
    }

    toggleAspectRatioMenu(force) {
        if (force === undefined) {
             force = !this.aspectRatioMenu.isVisible;
        }

        if (force) {
            this.aspectRatioMenu.open();
            this.activeMenu = this.aspectRatioMenu;
        } else {
            this.aspectRatioMenu.hide();
            if (this.activeMenu === this.aspectRatioMenu) {
                this.activeMenu = null;
            }
            this.show();
            this._updateFocus();
        }
    }

    toggleSettings(force) {
        if (force === undefined) {
             force = !this.settingsMenu.isVisible;
        }

        if (force) {
            this.settingsMenu.open();
            this.activeMenu = this.settingsMenu;
        } else {
            this.settingsMenu.hide();
            if (this.activeMenu === this.settingsMenu) {
                this.activeMenu = null;
            }
            this.show();
            this._updateFocus();
        }
    }

    togglePlaybackModeMenu(force) {
        if (force === undefined) {
             force = !this.playbackModeMenu.isVisible;
        }

        if (force) {
            this.playbackModeMenu.open();
            this.activeMenu = this.playbackModeMenu;
        } else {
            this.playbackModeMenu.hide();
            if (this.activeMenu === this.playbackModeMenu) {
                this.activeMenu = null;
            }
            this.show();
            this._updateFocus();
        }
    }

    syncTracks() {
        if (!this._player) return;
        if (this._player.getCurrentAudioStreamIndex) {
            const idx = this._player.getCurrentAudioStreamIndex();
            if (idx !== undefined && idx !== null) this._currentAudioIndex = idx;
        }
        if (this._player.getCurrentSubtitleStreamIndex) {
            const idx = this._player.getCurrentSubtitleStreamIndex();
            if (idx !== undefined && idx !== null) this._currentSubtitleIndex = idx;
        }
        if (this._player.getCurrentSecondarySubtitleStreamIndex) {
            const idx = this._player.getCurrentSecondarySubtitleStreamIndex();
            if (idx !== undefined && idx !== null) this._currentSecondarySubtitleIndex = idx;
        }
    }

    // ===================================
    // Input Handling
    // ===================================

    _bindKeyEvents() {
        // ENTER
        this.on('key:enter', (e) => {
            // Do NOT prevent default here. We want the browser to trigger 'click' on focused buttons.
            this.handleInput('enter');
        });

        // DIRECTIONAL
        this.on('key:up', (e) => {
            e?.preventDefault();
            this.handleInput('up');
        });
        this.on('key:down', (e) => {
            e?.preventDefault();
            this.handleInput('down');
        });
        this.on('key:left', (e) => {
            e?.preventDefault();
            this.handleInput('left');
        });
        this.on('key:right', (e) => {
            e?.preventDefault();
            this.handleInput('right');
        });

        // MEDIA KEYS
        this.on('key:play', (e) => {
            e?.preventDefault();
            this.handleInput('play');
        });
        this.on('key:pause', (e) => {
            e?.preventDefault();
            this.handleInput('pause'); 
        });
        this.on('key:playPause', (e) => {
            e?.preventDefault();
            this.handleInput('playPause');
        });
        this.on('key:rewind', (e) => {
            e?.preventDefault();
            this.handleInput('rewind');
        });
        this.on('key:fastForward', (e) => {
            e?.preventDefault();
            this.handleInput('fastForward');
        });
        this.on('key:options', (e) => {
            e?.preventDefault();
            this._executeAction('settings');
        });
        this.on('key:info', (e) => {
            e?.preventDefault();
            this._executeAction('playbackInfo');
        });
    }

    handleInput(key) {
        const wasHidden = !this._isOsdVisible;

        // Delegate to modal menu first (TrackMenu, SettingsMenu)
        if (this.isModalOpen) {
            if (this.activeMenu.handleKey(key)) return true;
            
            // If a modal is open, we consume all directional/enter/back keys 
            // even if the menu didn't explicitly handle it (to prevent OSD background move)
            if (['up', 'down', 'left', 'right', 'enter', 'back'].includes(key)) return true;
        }

        // Show OSD on Enter press if hidden (Directional keys fall through to _navigate)
        if (wasHidden && key === 'enter') {
            this.show();
            this._updateFocus();
            return true;
        }

        // Delegate to active 2nd-layer widget if focus is on Row -1 AND
        // the currently focused element belongs to that widget.
        // Without the second check, pressing Right on the skip-outro button
        // (also in Row -1) would be incorrectly forwarded to the Up Next dialog
        // because activeMenu is set to upNextDialog for the whole session.
        if (this._currentFocusRow === -1 && this.activeMenu && !this.activeMenu.isModal) {
            const focusedEl = this._cachedOverlayRow[this._currentFocusIndex];
            const menuOwnsElement = !this.activeMenu.$el || (focusedEl && this.activeMenu.$el.contains(focusedEl));
            if (menuOwnsElement && this.activeMenu.handleKey(key)) return true;
        }

        // Internal OSD Nav
        switch (key) {
            case 'up': return this._navigate('up');
            case 'down': return this._navigate('down');
            case 'left': return this._navigate('left');
            case 'right': return this._navigate('right');
            case 'enter': return this._executeFocused();
            case 'back': return this._handleBack();
        }

        // Media keys
        if (key === 'play' || key === 'playPause') {
             this.show(); // Always show/reset timer
             
             // Only force focus to Play button if OSD was previously hidden
             if (wasHidden) {
                 this._currentFocusRow = 1;
                 const playIdx = this._findActionIndex('togglePlay');
                 if (playIdx !== -1) this._currentFocusIndex = playIdx;
                 this._updateFocus();
             }

             this._executeAction('togglePlay');
             return true;
        }
        if (key === 'pause') {
            this._player.pause();
            this._updatePlayPauseButton();
            return true;
        }
        if (key === 'fastForward') {
            this._executeAction('fastForward');
            return true;
        }
        if (key === 'rewind') {
            this._executeAction('rewind');
            return true;
        }
        
        return false; 
    }

    _navigate(direction) {
        const wasHidden = !this._isOsdVisible;
        
        // First D-pad press always reveals OSD if hidden
        // User requested single-press move: trigger show AND allow navigation to proceed.
        if (wasHidden) {
            this.show();
            // Do NOT return here. Let the navigation logic below run.
        } else {
            this.show(); // Always reset auto-hide if already visible
        }

        if (direction === 'up') {
            if (this._currentFocusRow === 2) {
                this._currentFocusRow = 1;
            } else if (this._currentFocusRow === 1) {
                // If plugin widgets are visible in the overlay row, go there directly.
                // The overlay row is visually ABOVE the controls, so Up from controls = overlay.
                // Only fall through to header (Row 0) when no overlay widgets are present.
                if (this._cachedOverlayRow.length > 0) {
                    this._currentFocusRow = -1;
                    /*
                     * When the Up Next dialog is visible, land on "Play Now" specifically
                     * rather than blindly using index 0 (which may be the skip-outro button
                     * or any other widget at the front of the overlay DOM order).
                     */
                    if (this.upNextDialog?.isVisible && this.upNextDialog.$el) {
                        const playNow = this.upNextDialog.$el.querySelector('.upnext-btn-play');
                        const idx = playNow ? this._cachedOverlayRow.indexOf(playNow) : -1;
                        this._currentFocusIndex = idx !== -1 ? idx : 0;
                    } else {
                        this._currentFocusIndex = 0;
                    }
                } else {
                    this._currentFocusRow = 0;
                }
            } else if (this._currentFocusRow === -1) {
                // Overlay → Header (back button). Completes the chain:
                // Seekbar ↑ Controls ↑ Overlay ↑ Header
                // From Header the user can then right/left into subtitle offset / playback info.
                this._currentFocusRow = 0;
            } else if (this._currentFocusRow === 0) {
                // Header → overlay (for subtitle offset / playback info panels
                // which are also in the overlay row but triggered via menu buttons)
                if (this._cachedOverlayRow.length > 0) {
                    this._currentFocusRow = -1;
                    this._currentFocusIndex = 0;
                }
            }
        } else if (direction === 'down') {
            if (this._currentFocusRow === -1) {
                // Return from overlay row straight to Controls, landing on Play/Pause
                this._currentFocusRow = 1;
                const playIdx = this._findActionIndex('togglePlay');
                this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            } else if (this._currentFocusRow === 0) {
                // Mirror of Up from Row 1: if overlay widgets are visible, stop there first.
                // Header ↓ Overlay ↓ Controls (symmetric with Controls ↑ Overlay ↑ Header)
                if (this._cachedOverlayRow.length > 0) {
                    this._currentFocusRow = -1;
                    this._currentFocusIndex = 0;
                } else {
                    this._currentFocusRow = 1;
                }
            } else if (this._currentFocusRow === 1) {
                this._currentFocusRow = 2;
            }
        } else if (direction === 'left') {
            if (this._currentFocusRow === -1) {
                /*
                 * Overlay row Left/Right: In LTR, Left = lower cache index.
                 * In RTL, the physical Left key moves focus to a HIGHER index
                 * (spatially right) — swap the direction so navigation matches
                 * what the user sees on screen.
                 */
                const isRTL = document.documentElement.dir === 'rtl';
                if (isRTL) {
                    if (this._currentFocusIndex < this._cachedOverlayRow.length - 1) this._currentFocusIndex++;
                } else {
                    if (this._currentFocusIndex > 0) this._currentFocusIndex--;
                }
            } else if (this._currentFocusRow === 1) {
                if (this._currentFocusIndex > 0) this._currentFocusIndex--;
            } else if (this._currentFocusRow === 2) {
                this._executeAction('rewind');
            } else if (this._currentFocusRow === 0 && document.documentElement.dir === 'rtl') {
                // In RTL, Left from Header (Back) goes to Overlays (which are visually on the left)
                this._enterOverlaysFromHeader();
            }
        } else if (direction === 'right') {
            if (this._currentFocusRow === -1) {
                /*
                 * In RTL, physical Right = spatially left = lower cache index.
                 */
                const isRTL = document.documentElement.dir === 'rtl';
                if (isRTL) {
                    if (this._currentFocusIndex > 0) this._currentFocusIndex--;
                } else {
                    if (this._currentFocusIndex < this._cachedOverlayRow.length - 1) this._currentFocusIndex++;
                }
            } else if (this._currentFocusRow === 1) {
                const controls = this._getControls();
                if (this._currentFocusIndex < controls.length - 1) this._currentFocusIndex++;
            } else if (this._currentFocusRow === 2) {
                this._executeAction('fastForward');
            } else if (this._currentFocusRow === 0 && document.documentElement.dir !== 'rtl') {
                // In LTR, Right from Header (Back) goes to Overlays (which are visually on the right)
                this._enterOverlaysFromHeader();
            }
        }
        
        this._updateFocus();
        return true;
    }

    _enterOverlaysFromHeader() {
        // 1. Try Subtitle Offset Close
        let idx = this._cachedOverlayRow.findIndex(el => el.classList.contains('osd-offset-close'));
        if (idx !== -1) {
            this._currentFocusRow = -1;
            this._currentFocusIndex = idx;
            // Explicitly activate menu so its handleKey takes over for Down/Left
            this.activeMenu = this.subtitleOffset;
        } else {
            // 2. Try Playback Info Close
            idx = this._cachedOverlayRow.findIndex(el => el.classList.contains('playback-info-close'));
            if (idx !== -1) {
                this._currentFocusRow = -1;
                this._currentFocusIndex = idx;
                // Explicitly activate menu
                this.activeMenu = this.playbackInfo;
            }
        }
    }




    // Public API for PlayerPage
    handleBack() {
        return this._handleBack();
    }

    _handleBack() {
        if (this.activeMenu && this.activeMenu.isVisible) {
            // Priority: Try to let the active menu handle the 'back' key itself.
            // This allows sub-menus to return to their parent menus (e.g. Sub-menu -> Settings).
            if (this.activeMenu.handleKey('back')) {
                return true;
            }

            // Fallback: Manually handle specific built-in widgets that might not handle 'back'
            if (this.activeMenu === this.playbackInfo) {
                this.togglePlaybackInfo(false);
                return true;
            }
            if (this.activeMenu === this.subtitleOffset) {
                this.toggleSubtitleOffset(false);
                return true;
            }
            if (this.activeMenu.isModal) {
                this.closeMenu();
                return true;
            }
        }
        
        if (this._isOsdVisible) {
            this.hide();
        } else {
            this._executeAction('exit');
        }
        return true;
    }

    _getFocused() {
        return this._osdEl.querySelector('.focused');
    }


    _getControls() {
        // Return only focusable controls
        const left = Array.from(this._osdEl.querySelectorAll('.osd-controls-left .osd-btn'))
            .filter(btn => btn.offsetParent && btn.getAttribute('tabindex') !== '-1');
        const right = Array.from(this._osdEl.querySelectorAll('.osd-controls-right .osd-btn'))
            .filter(btn => btn.offsetParent && btn.getAttribute('tabindex') !== '-1');
        return [...left, ...right];
    }

    _cacheFocusableElements() {
        // Overlay Row (-1)
        this._cachedOverlayRow = [];
        const overlays = this._osdEl.querySelectorAll('.osd-overlays > *');
        overlays.forEach(overlay => {
            if (overlay.classList.contains('visible')) {
                // Find focusables inside visible overlay
                const focusables = Array.from(overlay.querySelectorAll('button, input[type="range"]'));
                this._cachedOverlayRow.push(...focusables);
            }
        });

        // Header (0)
        const backBtn = this._osdEl.querySelector('.osd-back-btn');
        this._cachedHeaderRow = (backBtn && backBtn.offsetParent) ? [backBtn] : [];

        // Controls (1) handled by _getControls()

        // Seekbar (2)
        const slider = this._osdEl.querySelector('#osdPositionSlider');
        this._cachedSeekbar = (slider && slider.offsetParent) ? slider : null;
    }

    _updateFocus() {
        this._osdEl.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'));

        if (this._currentFocusRow === -1) {
            const btn = this._cachedOverlayRow[Math.min(this._currentFocusIndex, this._cachedOverlayRow.length - 1)];
            if (btn) {
                btn.classList.add('focused');
                btn.focus();

                /*
                 * If the focused button lives inside the Up Next dialog, sync its
                 * internal _focusedButton counter. This handles the case where the
                 * user navigates FROM the skip-outro button INTO the dialog via
                 * OSD's _navigate() — without this sync the dialog's counter is
                 * stale and left/right navigation would jump to the wrong button.
                 */
                if (this.upNextDialog?.isVisible && this.upNextDialog.$el?.contains(btn)) {
                    const btns = Array.from(this.upNextDialog.$el.querySelectorAll('.upnext-btn'));
                    const btnIdx = btns.indexOf(btn);
                    if (btnIdx !== -1) this.upNextDialog._focusedButton = btnIdx;
                }
            } else {
                // Fallback if overlay closed
                this._currentFocusRow = 0;
                this._updateFocus();
            }
        } else if (this._currentFocusRow === 0) {
            const btn = this._cachedHeaderRow[0];
            if (btn) {
                btn.classList.add('focused');
                btn.focus();
            }
        } else if (this._currentFocusRow === 1) {
            const controls = this._getControls();
            const btn = controls[Math.min(this._currentFocusIndex, controls.length - 1)];
            if (btn) {
                btn.classList.add('focused');
                btn.focus();
            }
        } else if (this._currentFocusRow === 2) {
            const slider = this._cachedSeekbar;
            if (slider) {
                slider.classList.add('focused');
                slider.focus();
            }
        }
    }

    _executeFocused() {
        // We rely on the browser's native 'click' event behavior for focused buttons when 'Enter' is pressed.
        // This avoids double-firing actions (once by us, once by browser).
        
        if (this._currentFocusRow === -1) {
            // Unused btn
            /* const btn = this._cachedOverlayRow[this._currentFocusIndex]; */
            // Only trigger click if it's NOT a data-action button (which browser handles?)
            // Actually, browser handles all focused buttons on Enter.
            // But let's be safe: if it's a range input, we might need focus.
            // For buttons, doing nothing is safer.
        } else if (this._currentFocusRow === 0) {
            // Header: Back button. Browser handles click.
        } else if (this._currentFocusRow === 1) {
            // Controls: Buttons. Browser handles click.
        }
        
        // Return true to indicate we handled the 'logic' of the key (preventing default scrolling etc if needed?)
        // If we return true here, handleInput returns true.
        return true;
    }

    _findActionIndex(action) {
        const controls = this._getControls();
        return controls.findIndex(btn => btn.dataset.action === action);
    }

    // ===================================
    // Actions & Logic
    // ===================================
    
    _executeAction(action) {
        log.info('Execute Action:', action);
        switch (action) {
            case 'back': this._handleBack(); break;
            case 'exit': 
                this.emit('exit'); 
                break;
            case 'togglePlay': 
                if (this._player.togglePlay) this._player.togglePlay();
                this._updatePlayPauseButton();
                break;
            case 'rewind': {
                const skipBackMs = PlayerSettings.get('skipBackLength') || this._config.seekStepBack; 
                this._performDebouncedSeek(-skipBackMs * 10000);
                this.resetAutoHide();
                break;
            }
            case 'fastForward': {
                const skipFwdMs = PlayerSettings.get('skipForwardLength') || this._config.seekStepForward;
                this._performDebouncedSeek(skipFwdMs * 10000);
                this.resetAutoHide();
                break;
            }
            case 'previousTrack': this.emit('previous'); break;
            case 'previousChapter':
                log.info('executeAction previousChapter');
                if (this._player && this._player.previousChapter) {
                    this._player.previousChapter();
                    this.resetAutoHide();
                }
                break;
            case 'nextChapter':
                log.info('executeAction nextChapter');
                if (this._player && this._player.nextChapter) {
                    this._player.nextChapter();
                    this.resetAutoHide();
                }
                break;
            case 'nextTrack': this.emit('next'); break;
            case 'subtitles': 
                this.activeMenu = this.subtitleMenu;
                this.subtitleMenu.open('subtitles'); 
                break;
            case 'audio': 
                this.activeMenu = this.audioMenu;
                this.audioMenu.open('audio'); 
                break;
            case 'settings': 
                this.activeMenu = this.settingsMenu;
                this.settingsMenu.open(); 
                break;
            case 'favorite': 
                // Toggle favorite
                this._toggleFavorite();
                break;
            case 'closeSubtitleOffset':
                this.toggleSubtitleOffset(false);
                break;
            case 'subtitleSettings':
                this.toggleSubtitleQuickSettings(true);
                break;
            case 'closePlaybackInfo':
                this.togglePlaybackInfo(false);
                break;
            case 'playbackInfo':
                // Toggle based on current state
                this.togglePlaybackInfo(!this.playbackInfo.isVisible);
                break;
        }
    }

    async _toggleFavorite() {
        if (!this._api || !this._currentItem) return;
        const wasFavorite = this._currentItem.UserData?.IsFavorite;
        try {
            if (wasFavorite) await this._api.unmarkFavorite(this._currentItem.Id);
            else await this._api.markFavorite(this._currentItem.Id);
            this._currentItem.UserData.IsFavorite = !wasFavorite;
            
            const btn = this._osdEl.querySelector('#osdFavoriteBtn');
            if (btn) {
                btn.classList.remove('pulse-trigger');
                void btn.offsetWidth; // Force reflow
                btn.classList.add('pulse-trigger');
                setTimeout(() => btn.classList.remove('pulse-trigger'), 500);
            }

            this._updateFavoriteButton(this._currentItem);
        } catch (e) { 
            log.error('Fav toggle failed. API:', !!this._api, 'Item:', !!this._currentItem, 'Error:', e); 
        }
    }

    _performDebouncedSeek(offsetTicks) {
         try {
            this.show();
            this.resetAutoHide();

            if (this._seekTargetTicks === null) {
                this._seekTargetTicks = (this._player.getCurrentPositionTicks && this._player.getCurrentPositionTicks()) || 0;
                this._seekStartTime = Date.now();
            }

            const seekDuration = (Date.now() - this._seekStartTime) / 1000;
            let speedMultiplier = 1;
            if (seekDuration >= 8) speedMultiplier = 5;
            else if (seekDuration >= 6) speedMultiplier = 4;
            else if (seekDuration >= 4) speedMultiplier = 3;
            else if (seekDuration >= 2) speedMultiplier = 2;

            if (isNaN(offsetTicks)) return;
            const adjustedOffset = offsetTicks * speedMultiplier;
            this._seekTargetTicks += adjustedOffset;

            const duration = (this._player.getDurationTicks && this._player.getDurationTicks()) || 0;
            if (this._seekTargetTicks < 0) this._seekTargetTicks = 0;
            if (this._seekTargetTicks > duration) this._seekTargetTicks = duration;

            if (this._seekDebounceTimer) clearTimeout(this._seekDebounceTimer);

            const previewPlayer = {
                getCurrentPositionTicks: () => this._seekTargetTicks,
                getDurationTicks: () => duration
            };
            this._updateTimeDisplay(previewPlayer);
            this._updatePositionSlider(previewPlayer);
            
             const tooltip = this._osdEl.querySelector('#osdSeekTooltip');
             if (tooltip) {
                 const speedIndicator = speedMultiplier > 1 ? ` (${speedMultiplier}x)` : '';
                 const forceHours = duration >= 3600 * 10000000;
                 tooltip.textContent = this._formatTime(this._seekTargetTicks, forceHours) + speedIndicator;
                 tooltip.classList.add('visible');
                 const percent = duration > 0 ? (this._seekTargetTicks / duration) * 100 : 0;
                 tooltip.style.left = percent + '%';
             }

            this._seekDebounceTimer = setTimeout(() => {
                try {
                    if (this._seekTargetTicks !== null && this._player.seek) {
                        this._player.seek(this._seekTargetTicks);
                    }
                } catch (e) {
                    log.error('Deferred seek failed:', e);
                } finally {
                    this._seekTargetTicks = null;
                    this._seekStartTime = null;
                    this._seekDebounceTimer = null;
                    if (tooltip) tooltip.classList.remove('visible');
                }
            }, 500);

        } catch (err) {
            // Log the error but do NOT wipe _seekTargetTicks — an error in
            // show()/resetAutoHide() must not destroy the accumulated seek position.
            log.error('Seek error (non-critical):', err);
        }
    }
    
    _updatePlayPauseButton() {
        const btn = this._osdEl.querySelector('#osdPlayPauseBtn');
        if (!btn) return;
        const isPaused = this._player.isPaused ? this._player.isPaused() : false;
        btn.innerHTML = isPaused ? ICONS.play : ICONS.pause;
    }

    _startUpdates() {
        this._updateTimer = setInterval(() => this._updateState(), this._config.updateInterval);
    }

    _stopUpdates() {
        if (this._updateTimer) clearInterval(this._updateTimer);
    }

    _updateState() {
        try {
            if (this.activeMenu && this.activeMenu === this.playbackInfo) {
                this.playbackInfo.update();
            }
            
            if (this._seekTargetTicks !== null) {
                // Safety net: if seek state somehow gets stuck (debounce never fired),
                // reset after an extended timeout. Normal usage is already handled by
                // the debounce timer's finally block, so this only fires in edge cases.
                // 5s was too short — users legitimately hold fast-forward for many seconds.
                if (this._seekStartTime && (Date.now() - this._seekStartTime > 30000)) {
                    log.warn('Seek session safety timeout reached (30s). Resetting stuck state.');
                    this._seekTargetTicks = null;
                    this._seekStartTime = null;
                    const tooltip = this._osdEl.querySelector('#osdSeekTooltip');
                    if (tooltip) tooltip.classList.remove('visible');
                } else {
                    return;
                }
            }

            this._updateTimeDisplay(this._player);
            this._updateClock();
            if (!this._isDraggingSeekbar) {
                this._updatePositionSlider(this._player);
            }
            this._updatePlayPauseButton();
        } catch (e) {
            log.error('Error in OSD update loop:', e);
        }
    }
    
    _updateTimeDisplay(player) {
        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        // If duration is > 1 hour, force hours format to keep display stable
        const forceHours = duration >= 3600 * 10000000;

        const currentEl = this._osdEl.querySelector('#osdCurrentTime');
        const totalEl = this._osdEl.querySelector('#osdTotalTime');

        if (currentEl) currentEl.textContent = this._formatTime(current, forceHours);
        if (totalEl) totalEl.textContent = this._formatTime(duration, forceHours);
        
        const endsAtEl = this._osdEl.querySelector('#osdEndsAt');
        if (endsAtEl && duration > 0 && player.getCurrentPositionTicks) {
            const remainingMs = (duration - current) / 10000;
            const endTime = new Date(Date.now() + remainingMs);
            endsAtEl.textContent = i18n.t('EndsAtValue', [i18n.formatLocalTime(endTime)]);
        }
    }

    _updatePositionSlider(player) {
        const slider = this._osdEl.querySelector('#osdPositionSlider');
        if (!slider) return;

        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const percent = duration > 0 ? (current / duration) * 100 : 0;
        slider.value = percent;

        const fill = this._osdEl.querySelector('#osdPositionFill');
        if (fill) fill.style.width = percent + '%';
    }
    
    _updateClock() {
        const clockEl = this._osdEl.querySelector('#osdClock');
        if (clockEl) {
            const now = new Date();
            clockEl.textContent = i18n.formatLocalTime(now);
        }
    }

    _formatTime(ticks, forceHours = false) {
        if (!ticks) return forceHours ? '0:00:00' : '00:00';
        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0 || forceHours) return `${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
        return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
    }
    _handlePositionSliderInput(e) {
        this._isDraggingSeekbar = true;
        this.resetAutoHide();
        const percentRaw = e.target.value;
        const fill = this._osdEl.querySelector('#osdPositionFill');
        if (fill) fill.style.width = percentRaw + '%';

        const duration = this._player.getDurationTicks();
        const percent = percentRaw / 100;
        const forceHours = duration >= 3600 * 10000000;
        const currentEl = this._osdEl.querySelector('#osdCurrentTime');
        if (currentEl) currentEl.textContent = this._formatTime(duration * percent, forceHours);
    }

    _handlePositionSliderChange(e) {
        this._isDraggingSeekbar = false;
        try {
            const duration = this._player.getDurationTicks();
            const percent = e.target.value / 100;
            const targetTicks = duration * percent;
            
            // Optimistic update
            this._updatePositionSlider({
                getCurrentPositionTicks: () => targetTicks,
                getDurationTicks: () => duration
            });

            this._player.seek(targetTicks);
        } catch (err) {
            log.error('Slider seek failed:', err);
        }
    }

    _onMediaStreamsChange(e) {
        if (e.audioStreamIndex !== undefined) {
             this._currentAudioIndex = e.audioStreamIndex;
        }
        if (e.subtitleStreamIndex !== undefined) {
             this._currentSubtitleIndex = e.subtitleStreamIndex;
        }
        if (e.secondarySubtitleStreamIndex !== undefined) {
             this._currentSecondarySubtitleIndex = e.secondarySubtitleStreamIndex;
        }
    }

    _clearSeekState() {
        if (this._seekDebounceTimer) {
            clearTimeout(this._seekDebounceTimer);
            this._seekDebounceTimer = null;
        }
        this._seekTargetTicks = null;
        this._seekStartTime = null;
        this._isDraggingSeekbar = false;
        
        const tooltip = this._osdEl.querySelector('#osdSeekTooltip');
        if (tooltip) tooltip.classList.remove('visible');
    }

    _onPlayerSeek(e) {
        // Clear OSD's internal seek state whenever a seek happens (could be remote or chapter)
        this._clearSeekState();

        if (e && e.positionTicks !== undefined) {
             // Optimistic update for UI responsiveness
             const tempPlayer = {
                 getCurrentPositionTicks: () => e.positionTicks,
                 getDurationTicks: () => this._player.getDurationTicks ? this._player.getDurationTicks() : 0
             };
             this._updateTimeDisplay(tempPlayer);
             this._updatePositionSlider(tempPlayer);

             /*
              * If the user seeks BEFORE the Up Next trigger threshold, reset the
              * shown/hidden flags so the dialog can re-trigger when they naturally
              * reach the outro again.
              *
              * Use the cached _upNextShowAtTicks (computed from the last chapter or
              * time-based method) so seeks WITHIN the outro region don't reset the
              * flags and cause the dialog to reappear with a focus-stealing
              * toggleUpNext(true) call.
              *
              * Fall back to 45 s remaining if _upNextShowAtTicks is not yet set
              * (e.g. the user seeks before playback reaches the threshold calculation).
              */
             const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;
             if (duration > 0) {
                 const threshold = this._upNextShowAtTicks ?? (duration - 45 * 10_000_000);
                 if (e.positionTicks < threshold) {
                     // Genuinely before the outro region — allow the dialog to re-trigger
                     if (this._upNextShown || this._upNextHiddenByUser) {
                         log.debug('[UpNext] Seek reset — dialog will re-trigger near end');
                         this._upNextShown = false;
                         this._upNextHiddenByUser = false;
                         // Hide the dialog if it's still visible
                         if (this.upNextDialog?.isVisible) {
                             this.upNextDialog.hide();
                             if (this.activeMenu === this.upNextDialog) {
                                 this.activeMenu = null;
                             }
                             this._cacheFocusableElements();
                         }
                     }
                 }
                 // Seeking within the outro: keep flags as-is, no retrigger
             }
        }
    }

    // =========================================================================
    // Up Next Dialog management
    // =========================================================================

    /**
     * Show or hide the Up Next dialog.
     * Follows the same toggle pattern as togglePlaybackInfo() / toggleSubtitleOffset().
     *
     * @param {boolean} show - True to show, false to hide
     */
    toggleUpNext(show) {
        if (show) {
            // Guard: only show if there's something to preview
            if (!this.upNextDialog._nextItem) return;

            /*
             * Set activeMenu so handleInput() at the Row -1 delegation gate
             * (line: `if this._currentFocusRow === -1 && this.activeMenu && !isModal`)
             * will forward Left/Right/Enter/Back to the dialog's handleKey().
             *
             * We do NOT switch _currentFocusRow here — the user navigates to
             * the dialog by pressing Up from the controls row, same as any
             * other overlay widget (subtitle offset, skip-outro, etc.).
             */
            this.activeMenu = this.upNextDialog;
            this.upNextDialog.show();
            this._cacheFocusableElements();

            /*
             * Immediately place OSD focus on Row -1 at the "Play Now" button.
             *
             * Without this, _currentFocusRow stays wherever it was (controls or
             * seekbar) so Right/Left keys hit _navigate() for the wrong row and
             * cause unexpected seeks or control moves instead of moving between
             * Play Now ↔ Hide.
             */
            this._currentFocusRow = -1;
            const playNowBtn = this.upNextDialog.$el?.querySelector('.upnext-btn-play');
            const playNowIdx = playNowBtn ? this._cachedOverlayRow.indexOf(playNowBtn) : 0;
            this._currentFocusIndex = playNowIdx !== -1 ? playNowIdx : 0;
            this._updateFocus();
        } else {
            this.upNextDialog.hide();
            // Only clear activeMenu if the dialog was the active one —
            // don't accidentally clobber a settings menu that might be open.
            if (this.activeMenu === this.upNextDialog) {
                this.activeMenu = null;
            }
            this._cacheFocusableElements();
        }
    }

    /**
     * Evaluate whether to auto-show the Up Next dialog based on playback position.
     * Called from PlayerPage on every timeupdate tick (~500 ms).
     *
     * Scaling thresholds (mirrors jellyfin-web upnextdialog):
     *   episode ≥ 50 min → show at 40 s remaining
     *   episode ≥ 40 min → show at 35 s remaining
     *   everything else (but ≥ 10 min) → show at 30 s remaining
     *
     * @param {number} positionTicks  - Current playback position in 100-ns ticks
     * @param {number} durationTicks  - Total episode duration in 100-ns ticks
     * @param {Object|null} currentItem - The currently playing media item
     */
    showUpNextIfNeeded(positionTicks, durationTicks, currentItem) {
        // Ticks constants (10 million ticks = 1 second, 600 million = 1 minute)
        const TICKS_PER_SECOND = 10_000_000;
        const TICKS_PER_MINUTE = 600_000_000;
        const MIN_DURATION = 10 * TICKS_PER_MINUTE; // Minimum 10-minute episode

        // -------------------------------------------------------------------
        // Fast path: dialog is already visible — just update the countdown.
        // Do NOT re-call toggleUpNext(true) (that would recapture focus on
        // every keyframe while the user is seeking through the outro).
        // -------------------------------------------------------------------
        if (this.upNextDialog.isVisible) {
            const timeRemainingTicks = durationTicks - positionTicks;
            const secondsRemaining = Math.ceil(timeRemainingTicks / TICKS_PER_SECOND);
            this.upNextDialog.updateCountdown(secondsRemaining);
            return;
        }

        // -------------------------------------------------------------------
        // Pre-conditions: bail early if we should not show the dialog
        // -------------------------------------------------------------------

        // Already shown or user explicitly dismissed it this playthrough
        if (this._upNextShown || this._upNextHiddenByUser) return;

        // Only trigger for episodes
        if (!currentItem || currentItem.Type !== 'Episode') return;

        // Need valid timing data
        if (!positionTicks || !durationTicks || durationTicks < MIN_DURATION) return;

        /*
         * Use the module-scope playQueue singleton imported at the top of this file.
         * It is always available synchronously — no dynamic import required.
         */
        if (!playQueue.hasNext()) return;

        // Check user setting
        if (!PlayerSettings.get('enableNextEpisodeAutoPlay')) return;

        // -------------------------------------------------------------------
        // Calculate the "show at" threshold
        // Priority: start of the last chapter (semantic) → time-based fallback
        // -------------------------------------------------------------------
        let showAtTicks;

        /*
         * If the player exposes chapters, use the last chapter's start position
         * as the trigger point. This is semantically correct — the last chapter
         * is typically the "credits" or "epilogue" section, which is exactly
         * when viewers are ready to move on to the next episode.
         */
        const chapters = this._player?.getChapters ? this._player.getChapters() : [];

        if (chapters && chapters.length >= 2) {
            // At least two chapters: use the LAST chapter's start position.
            // We require ≥2 so we don't trigger on a single dummy chapter at 0.
            const lastChapter = chapters[chapters.length - 1];
            const lastChapterTicks = lastChapter.StartPositionTicks || 0;

            // Sanity check: the last chapter must start at least 30 s into the
            // episode and leave at least 5 s before the end, otherwise ignore it
            // and fall through to the time-based method.
            const MIN_CHAPTER_OFFSET = 30 * TICKS_PER_SECOND;
            const MIN_REMAINING = 5 * TICKS_PER_SECOND;
            if (lastChapterTicks >= MIN_CHAPTER_OFFSET && (durationTicks - lastChapterTicks) >= MIN_REMAINING) {
                showAtTicks = lastChapterTicks;
            }
        }

        if (showAtTicks == null) {
            // No usable chapters — fall back to "X seconds remaining" method
            let showAtSeconds = 30;
            if (durationTicks >= 50 * TICKS_PER_MINUTE) {
                showAtSeconds = 40;
            } else if (durationTicks >= 40 * TICKS_PER_MINUTE) {
                showAtSeconds = 35;
            }
            showAtTicks = durationTicks - showAtSeconds * TICKS_PER_SECOND;
        }

        /*
         * Cache the threshold so _onPlayerSeek can compare against the real
         * chapter-aware value instead of a hardcoded 45-second buffer.
         */
        this._upNextShowAtTicks = showAtTicks;

        const timeRemainingTicks = durationTicks - positionTicks;

        // Must have at least 5 seconds remaining to avoid showing for a split second
        const MIN_REMAINING_TICKS = 5 * TICKS_PER_SECOND;

        if (positionTicks >= showAtTicks && timeRemainingTicks >= MIN_REMAINING_TICKS) {
            // Lock the flag so we don't re-trigger on every subsequent tick
            this._upNextShown = true;

            // Populate the next item from the queue
            const nextItem = playQueue.peekNext();
            if (nextItem) {
                this.upNextDialog.setNextItem(nextItem);
                const secondsRemaining = Math.ceil(timeRemainingTicks / TICKS_PER_SECOND);
                this.upNextDialog.updateCountdown(secondsRemaining);
                this.toggleUpNext(true);
                log.debug(`[UpNext] Showing dialog. ${secondsRemaining}s remaining.`);
            } else {
                // Queue check passed but peekNext() returned null — don't spam
                this._upNextShown = false;
            }
        }
    }

    /**
     * Hide the Up Next dialog and mark it as user-dismissed.
     * Called by UpNextDialog itself (Hide button / Back key) and by PlayerPage
     * when a new item starts playing.
     *
     * @param {boolean} [userDismissed=true] - Pass false to reset without marking
     *   as user-dismissed (e.g. on item change).
     */
    hideUpNext(userDismissed = true) {
        if (userDismissed) {
            // Mark as explicitly dismissed so we don't re-trigger for this playthrough
            this._upNextHiddenByUser = true;
        }
        this.toggleUpNext(false);
    }

    /**
     * Reset Up Next dialog state entirely.
     * Called by PlayerPage when a new item starts playing so the dialog can
     * trigger fresh for the new episode.
     */
    resetUpNext() {
        this._upNextShown = false;
        this._upNextHiddenByUser = false;
        // Clear the cached trigger threshold so the next episode recalculates fresh
        this._upNextShowAtTicks = null;
        // Hide the dialog if it's still visible from the previous item
        if (this.upNextDialog && this.upNextDialog.isVisible) {
            this.upNextDialog.hide();
            if (this.activeMenu === this.upNextDialog) {
                this.activeMenu = null;
            }
            this._cacheFocusableElements();
        }
    }

    togglePlaybackSpeedMenu(show) {
        if (show) {
            this.settingsMenu.hide();
            this.playbackSpeedMenu.open();
            this.activeMenu = this.playbackSpeedMenu;
        } else {
            this.playbackSpeedMenu.hide();
            this.activeMenu = null;
        }
    }

    toggleQualityMenu(show) {
        if (show) {
            this.settingsMenu.hide();
            this.qualityMenu.open();
            this.activeMenu = this.qualityMenu;
        } else {
            this.qualityMenu.hide();
            this.activeMenu = null;
        }
    }

    toggleRepeatModeMenu(show) {
        if (show) {
            this.closeMenu();
            this.repeatModeMenu.open();
            this.activeMenu = this.repeatModeMenu;
        } else {
            this.repeatModeMenu.hide();
            if (this.activeMenu === this.repeatModeMenu) {
                this.activeMenu = null;
            }
        }
    }

    setMetadata(item) {
        this._currentItem = item;
        const titleEl = this._osdEl.querySelector('#osdTitle');
        if (titleEl) titleEl.textContent = this._getFormattedTitle(item);
        this._updateFavoriteButton(item);
        this._updateNavigationButtons();
    }

    updateItem(item) {
        this.setMetadata(item);
    }

    _getFormattedTitle(item) {
        if (!item) return '';
        if (item.SeriesName) {
            let text = item.SeriesName;
            if (item.IndexNumber !== undefined) {
                const s = item.ParentIndexNumber || 1;
                const e = item.IndexNumber;
                text += ` S${String(s).padStart(2,'0')}:E${String(e).padStart(2,'0')}`;
            }
            if (item.Name) text += ` - ${item.Name}`;
            if (item.ProductionYear) text += ` (${item.ProductionYear})`;
            return text;
        }
        let text = item.Name || '';
        if (item.ProductionYear) text += ` (${item.ProductionYear})`;
        return text;
    }
    
    _updateFavoriteButton(item) {
        const btn = this._osdEl.querySelector('#osdFavoriteBtn');
        if (!btn || !item?.UserData) return;
        const isFavorite = item.UserData.IsFavorite;
        btn.innerHTML = isFavorite ? ICONS.favoriteFilled : ICONS.favorite;
        
        if (isFavorite) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
        btn.style.color = '';
    }
}