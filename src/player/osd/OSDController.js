import Component from '../../core/Component.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { playQueue } from '../../core/PlayQueue.js';
import { i18n } from '../../utils/i18n.js';
import { api } from '../../api/index.js';
import { osdIcons } from '../../utils/Icons.js';
import { TrickplayManager } from './TrickplayManager.js';

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
import ChaptersModal from './ChaptersModal.js';
import QueueModal from './QueueModal.js';
import LyricsModal from './LyricsModal.js';
import DescriptionModal from './DescriptionModal.js';
import SyncPlayNotification from './SyncPlayNotification.js';

import '../../styles/description-modal.css';

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
        this._api = options.api || api;
        this._playerPage = options.playerPage;
        this._config = {
            autoHideDelay: 3500,
            seekStepBack: 10,
            seekStepForward: 30,
            updateInterval: 500,
            ...options
        };

        /*
         * Audio mode: when playing Music, Audiobooks, or Podcasts the OSD
         * hides subtitle selection and audio-track buttons (video-only features).
         * Everything else — seekbar, play/pause, skip, rewind, settings, etc.
         * — works identically for audio and video.
         */
        this._isAudio = !!(options.isAudio);

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
        this._trackTransitionLockoutActive = false;

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

        this._boundHandleQueueUpdate = this._handleQueueUpdate.bind(this);
        this._boundHandleSyncPlayNotification = this._handleSyncPlayNotification.bind(this);
        this._boundSyncPlayButtonState = this._syncPlayButtonState.bind(this);

        import('../../core/EventBus.js').then(({ eventBus }) => {
            eventBus.on('playqueue:updated', this._boundHandleQueueUpdate);
            eventBus.on('syncplay:command', this._boundHandleSyncPlayNotification);
            eventBus.on('syncplay:groupupdate', this._boundHandleSyncPlayNotification);
            // Listen to plugin state changes for the button
            eventBus.on('syncplay:enabled', this._boundSyncPlayButtonState);
            eventBus.on('syncplay:disabled', this._boundSyncPlayButtonState);
        });

        this._initMenus();

        if (options.item) {
            this._currentItem = options.item;
        }

        // Bindings
        this._onMouseMove = this._onMouseMove.bind(this);

        /*
         * TrickplayManager — handles sprite-sheet thumbnail math for seek previews.
         * Initialised eagerly so it's always available; actual data is loaded
         * lazily in setMetadata() once we have the item and mediaSource.
         */
        this._trickplay = new TrickplayManager();

        /* Cached media source ID set by PlayerPage after playback starts */
        this._currentMediaSourceId = null;

        /*
         * ========================================================================
         * GHOST CLICK LOCKOUT STATE:
         * Tracks whether we are currently in the 350ms lockout protection window
         * right after focus has transitioned back from overlay widgets (Row -1).
         *
         * _trackTransitionLockoutActive is set by updateItem() when the player
         * switches to a new episode/track. It gates the syncTracks() method,
         * ensuring only a genuine track-start event (not a pause/resume) triggers
         * the 1500ms countdown that releases the lockout.
         * ========================================================================
         */
        this._focusRestoreLockout = false;
        this._focusRestoreLockoutTimer = null;
        this._trackTransitionLockoutActive = false;
    }

    _handleQueueUpdate() {
        // Redraw active menu if open to show checks
        if (this.repeatModeMenu && this.repeatModeMenu.isVisible) {
            this.repeatModeMenu.render();
        }
    }

    _handleSyncPlayNotification(...args) {
        if (!this.syncPlayNotification) return;

        // EventBus might pass (eventName, data) or just (data) depending on its API
        const data = args.length > 1 ? args[1] : args[0];
        if (!data) return;

        let action = null;
        let primaryStr = '';
        let secondaryStr = 'SyncPlay';
        let duration = 3000;

        if (data.Command) {
            const cmd = data.Command.toLowerCase();
            if (cmd === 'unpause' || cmd === 'play') {
                action = 'play';
                primaryStr = i18n.t('Play');
            } else if (cmd === 'pause') {
                action = 'pause';
                primaryStr = i18n.t('Pause');
            } else if (cmd === 'seek') {
                action = 'seek';
                primaryStr = i18n.t('Seek');
            } else if (cmd === 'stop') {
                action = 'stop';
                primaryStr = i18n.t('Stop');
            }
        } else if (data.Type) {
            if (data.Type === 'StateUpdate' && data.State === 'Waiting' && data.Reason === 'Buffering') {
                action = 'buffering';
                primaryStr = i18n.t('Buffering');
                secondaryStr = i18n.t('SyncPlay Waiting');
                duration = 0; // Keep showing until another action replaces it or we start playing
            } else if (data.Type === 'UserJoined') {
                action = 'join';
                primaryStr = i18n.t('Joined Group');
            } else if (data.Type === 'UserLeft') {
                action = 'leave';
                primaryStr = i18n.t('Left Group');
            } else if (data.Type === 'GroupLeft') {
                action = 'leave';
                primaryStr = i18n.t('Left Group');
                secondaryStr = i18n.t('Disconnected');
            }
        }

        if (action) {
            this.syncPlayNotification.show(action, primaryStr, secondaryStr, duration);
        }
    }

    _syncPlayButtonState() {
        if (!this._osdEl) return;

        import('../../plugins/PluginManager.js').then(({ pluginManager }) => {
            const btn = this._osdEl.querySelector('#osdSyncPlayBtn');
            if (!btn) return;

            const isInstalled = pluginManager.isEnabled('syncplay');

            if (isInstalled) {
                btn.classList.remove('hidden');
                btn.setAttribute('tabindex', '0');

                // Check if actively in a group
                const syncPlayActive = window.__syncPlayManager && window.__syncPlayManager.isEnabled;
                btn.classList.toggle('syncplay-active', syncPlayActive);

                // Update icon content (Filled/Outline variants handled by CSS based on syncplay-active class)
                btn.innerHTML = `
                    <div class="osd-syncplay-icon-wrap">
                        ${osdIcons.group}
                        <span class="osd-syncplay-dot ${syncPlayActive ? 'visible' : ''}" id="osdSyncPlayDot"></span>
                    </div>
                `;
            } else {
                btn.classList.add('hidden');
                btn.setAttribute('tabindex', '-1');
            }

            this._cacheFocusableElements();
        });
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

        // Chapters modal — shows all chapters with current chapter highlighted
        this.chaptersModal = new ChaptersModal(this);

        // Queue modal — shows the full play queue with the current item highlighted
        this.queueModal = new QueueModal(this);

        // Lyrics modal — shows scrolling lyrics for audio items
        this.lyricsModal = new LyricsModal(this);

        // Description modal — shows item details and overview
        this.descriptionModal = new DescriptionModal(this);

        // SyncPlay notification overlay
        this.syncPlayNotification = new SyncPlayNotification(this);

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
            this.upNextDialog,
            this.chaptersModal,
            this.queueModal,
            this.lyricsModal,
            this.descriptionModal,
            this.syncPlayNotification
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
            log.info('OSD Mounted - Setting initial metadata for:', this._currentItem.Name);
            this.setMetadata(this._currentItem);
        }

        // Mouse move to show OSD (attached to container)
        if (this._player) {
            this._player.on('mediastreamschange', (e) => this._onMediaStreamsChange(e));
            this._player.on('play', () => this.updatePlayPauseButton());
            this._player.on('pause', () => this.updatePlayPauseButton());
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

        // Pin the initial focus index to the actual play/pause button position.
        // The constructor defaults _currentFocusIndex=2 as a static guess, but that
        // drifts whenever buttons are disabled/enabled (prev track, chapter nav, etc.).
        // Resolving it now guarantees showAndFocusPlayPause() lands correctly on startup.
        const initialPlayIdx = this._findActionIndex('togglePlay');
        if (initialPlayIdx !== -1) {
            this._currentFocusRow = 1;
            this._currentFocusIndex = initialPlayIdx;
        }

        // Start hidden
        this.hide();
    }

    onBeforeDestroy() {
        this._stopUpdates();
        if (this._updateTimer) clearInterval(this._updateTimer);
        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);
        import('../../core/EventBus.js').then(({ eventBus }) => {
            eventBus.off('playqueue:updated', this._boundHandleQueueUpdate);
            if (this._boundSyncPlayButtonState) {
                eventBus.off('syncplay:enabled', this._boundSyncPlayButtonState);
                eventBus.off('syncplay:disabled', this._boundSyncPlayButtonState);
            }
            if (this._boundHandleSyncPlayNotification) {
                eventBus.off('syncplay:command', this._boundHandleSyncPlayNotification);
                eventBus.off('syncplay:groupupdate', this._boundHandleSyncPlayNotification);
            }
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

        /* Clean up trickplay state to release image references and settings cache */
        this._trickplay.destroy();
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
                            ${osdIcons.arrowBack}
                        </button>
                        <div class="osd-title-wrap">
                            <div class="osd-title-main">
                                <span class="osd-title" id="osdTitle"></span>
                                <img class="osd-title-logo hidden" id="osdLogo" alt="Logo">
                            </div>
                            <span class="osd-title-secondary" id="osdTitleSecondary"></span>
                        </div>
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
                            <button class="osd-btn" data-action="previousTrack" tabindex="0" id="osdPrevBtn">${osdIcons.skipPrevious}</button>
                            <button class="osd-btn osd-btn-disabled" data-action="previousChapter" tabindex="-1" id="osdPrevChapterBtn">${osdIcons.chapterPrevious}</button>
                            <button class="osd-btn" data-action="rewind" tabindex="0">${osdIcons.fastRewind}</button>
                            <button class="osd-btn osd-btn-play" id="osdPlayPauseBtn" data-action="togglePlay" tabindex="0">${osdIcons.pause}</button>
                            <button class="osd-btn" data-action="fastForward" tabindex="0">${osdIcons.fastForward}</button>
                            <button class="osd-btn osd-btn-disabled" data-action="nextChapter" tabindex="-1" id="osdNextChapterBtn">${osdIcons.chapterNext}</button>
                            <button class="osd-btn" data-action="nextTrack" tabindex="0" id="osdNextBtn">${osdIcons.skipNext}</button>
                            
                        </div>
                        <div class="osd-ends-at" id="osdEndsAt"></div>
                        <div class="osd-spacer"></div>
                        <div class="osd-controls-right">
                            <button class="osd-btn" data-action="subtitles" tabindex="0">${osdIcons.closedCaption}</button>
                            <button class="osd-btn" data-action="audio" tabindex="0">${osdIcons.audiotrack}</button>
                            <!-- Chapters modal button (hidden initially; revealed when chapters exist) -->
                            <button class="osd-btn osd-btn-disabled" data-action="chapters" id="osdChaptersBtn" tabindex="-1" aria-label="Chapters">${osdIcons.viewList}</button>
                            <!-- Queue modal button (always available) -->
                            <button class="osd-btn" data-action="queue" id="osdQueueBtn" tabindex="0" aria-label="Queue">${osdIcons.queue}</button>
                            <!-- Lyrics modal button -->
                            <button class="osd-btn osd-btn-disabled hidden" data-action="lyrics" id="osdLyricsBtn" tabindex="-1" aria-label="Lyrics">${osdIcons.lyrics}</button>
                            <!-- SyncPlay group management — only the icon; menu opens on click -->
                            <button class="osd-btn" id="osdSyncPlayBtn" data-action="syncplay" tabindex="0" aria-label="SyncPlay">
                                <div class="osd-syncplay-icon-wrap">
                                    ${osdIcons.group}
                                    <span class="osd-syncplay-dot" id="osdSyncPlayDot"></span>
                                </div>
                            </button>
                            <button class="osd-btn" data-action="description" id="osdInfoBtn" tabindex="0" aria-label="Description">${osdIcons.info}</button>
                            <button class="osd-btn" id="osdFavoriteBtn" data-action="favorite" tabindex="0">${osdIcons.favorite}</button>
                            <button class="osd-btn" data-action="settings" tabindex="0">${osdIcons.settings}</button>
                        </div>
                    </div>

                    <!-- Seekbar Container (below controls) -->
                    <div class="osd-slider-row">
                        <span class="osd-time osd-time-current" id="osdCurrentTime">00:00</span>
                        <div class="osd-slider-container">
                            <div class="osd-seek-tooltip" id="osdSeekTooltip">
                                <!-- Trickplay thumbnail (hidden when not available) -->
                                <div class="osd-trickplay-thumb" id="osdTrickplayThumb"></div>
                                <!-- Time / speed indicator text -->
                                <span class="osd-seek-tooltip-text" id="osdSeekTooltipText"></span>
                            </div>
                            <div class="osd-chapter-markers" id="osdChapterMarkers"></div>
                            <div class="osd-slider-track">
                                <div class="osd-slider-fill" id="osdPositionFill"></div>
                            </div>
                            <!-- tabindex=-1: prevents the browser from giving this range input native DOM focus.
                                 On TV hardware, focusing a range input causes OK/Enter to synthesize a click
                                 at clientX=0, which our seek math interprets as 'seek to 0%' and resets playback.
                                 D-pad row focus is tracked internally via _currentFocusRow=2 instead. -->
                            <input type="range" class="osd-slider" id="osdPositionSlider" min="0" max="100" step="0.01" value="0" tabindex="-1">
                        </div>
                        <span class="osd-time osd-time-total" id="osdTotalTime">00:00</span>
                    </div>
                </div>
            </div>
            <div class="osd-overlays"></div>
        `;

        // Cache main elements to avoid redundant querySelector calls in the update loop
        this._osdMainEl = this._osdEl.querySelector('.osd-main');
        this._osdCurrentTimeEl = this._osdEl.querySelector('#osdCurrentTime');
        this._osdTotalTimeEl = this._osdEl.querySelector('#osdTotalTime');
        this._osdPositionFillEl = this._osdEl.querySelector('#osdPositionFill');
        this._osdPositionSliderEl = this._osdEl.querySelector('#osdPositionSlider');
        this._osdClockEl = this._osdEl.querySelector('#osdClock');
        this._osdPlayPauseBtnEl = this._osdEl.querySelector('#osdPlayPauseBtn');

        /* Cache trickplay tooltip sub-elements to avoid repeated queries during seek */
        this._cachedThumbEl = this._osdEl.querySelector('#osdTrickplayThumb');
        this._cachedTooltipTextEl = this._osdEl.querySelector('#osdSeekTooltipText');

        // Bind slider
        this._osdPositionSliderEl.addEventListener('input', (e) => this._handlePositionSliderInput(e));
        this._osdPositionSliderEl.addEventListener('change', (e) => this._handlePositionSliderChange(e));

        // Bind clicks (Delegate for dynamic content)
        this._osdEl.addEventListener('click', (e) => {
            /*
             * ========================================================================
             * GHOST CLICK LOCKOUT CHECK
             * ========================================================================
             * If focus was recently restored back to the controls row from the overlay
             * widgets (e.g. after selecting Skip Intro), we ignore all click events
             * within a 350ms window. This completely blocks any browser-synthesized
             * ghost click events that might target the newly focused Play/Pause button.
             * ========================================================================
             */
            if (this._focusRestoreLockout) {
                log.info('OSDController: Discarding click event during focus restore lockout window');
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            /*
             * ========================================================================
             * TV SYNTHESIZED GHOST CLICK GUARD
             * ========================================================================
             * On WebOS/Tizen, pressing the remote OK button on a focused element
             * synthesizes a native click event at coordinates clientX = 0, clientY = 0.
             * Since we handle Enter/OK keydown events 100% in JS for all OSD rows
             * (via handleInput('enter')), executing actions for these ghost clicks
             * would trigger them twice in rapid succession.
             * 
             * This double-execution is extremely noticeable for cumulative,
             * non-idempotent actions like skip forward and skip backward (fastForward /
             * rewind), which would seek by double the user-configured step.
             * 
             * A real user cursor or mouse click can never land precisely at the
             * coordinate (0, 0) of the viewport. Thus, we safely discard all
             * synthesized click events with (0, 0) coordinates.
             * 
             * ADDITIONAL PROTECTION:
             * When focus is shifted synchronously during an Enter keydown handler
             * (e.g., from the skip-intro button to the Play/Pause button on seek),
             * the browser may synthesize a click event on the newly focused element
             * (Play/Pause) with coordinates corresponding to its center (non-zero).
             * However, all keyboard-synthesized click events natively carry a
             * detail count of 0 (e.detail === 0). Discarding them prevents ghost
             * events from double-triggering actions like play/pause.
             * ========================================================================
             */
            if ((e.clientX === 0 && e.clientY === 0) || e.detail === 0) {
                return;
            }

            /* 
             * DELIBERATE PHYSICAL CLICK EXEMPTION:
             * We do NOT return early even if 'enableMagicCursor' is disabled.
             * Disabling cursor controls prevents highly sensitive gyro movements
             * (mousemove) from waking the OSD or styling hovers. However, physical clicks
             * (via mouse or Magic Remote center/wheel clicks) are always deliberate actions
             * and must register. If the OSD is currently showing, clicking a button
             * should activate it.
             */

            // Every click inside the OSD resets the auto-hide timer.
            this.resetAutoHide();

            /*
             * WEBOS / TIZEN POINTER-EVENTS BUG WORKAROUND
             *
             * On WebOS Chrome 108, `pointer-events: none` on .osd-overlays (z-index: 1000)
             * is sometimes ignored, causing that transparent container to swallow all clicks
             * that should have landed on the OSD buttons in .osd-main (z-index: 10).
             *
             * When we detect that the click target IS the .osd-overlays div itself
             * (i.e. not a child widget), we use document.elementsFromPoint() to walk the
             * full stacking order at the click coordinates and find the real intended target.
             * This completely bypasses the z-index / pointer-events interaction.
             */
            let resolvedTarget = e.target;
            if (resolvedTarget.classList && resolvedTarget.classList.contains('osd-overlays')) {
                // Find all elements at the click position, then pick the first one that
                // actually has a [data-action] ancestor or is inside .osd-slider-container.
                const els = document.elementsFromPoint(e.clientX, e.clientY);
                for (const el of els) {
                    // Skip the problematic overlay container itself
                    if (el.classList && el.classList.contains('osd-overlays')) continue;
                    // Accept any element that is inside .osd-main (buttons, slider, etc.)
                    if (el.closest?.('.osd-main') || el.closest?.('[data-action]')) {
                        resolvedTarget = el;
                        break;
                    }
                }
            }

            // Resolve the [data-action] button from the (possibly remapped) target
            const btn = resolvedTarget.closest('[data-action]');
            if (btn) {
                e.stopPropagation();

                /*
                 * MAGIC CURSOR STATE SYNC — keep the OSD's internal D-pad position in
                 * sync with what was clicked so subsequent _updateFocus() calls restore
                 * the highlight to the correct button, not some stale position.
                 */
                if (btn.classList.contains('osd-back-btn')) {
                    this._currentFocusRow = 0;
                    this._currentFocusIndex = 0;
                } else {
                    const controls = this._getControls();
                    const idx = controls.indexOf(btn);
                    if (idx !== -1) {
                        this._currentFocusRow = 1;
                        this._currentFocusIndex = idx;
                    }
                }

                this._executeAction(btn.dataset.action);
                return;
            }

            /*
             * Magic Cursor: Clicking anywhere in the 36px tall slider container seeks to
             * that position. Without this, the user would have to hit the 8px tall range
             * input precisely, which is nearly impossible with a TV magic cursor.
             */
            const sliderContainer = resolvedTarget.closest?.('.osd-slider-container');
            if (sliderContainer && !resolvedTarget.closest?.('.osd-overlays')) {
                e.stopPropagation();

                // Sync focus state to seekbar row so D-pad resumes from here
                this._currentFocusRow = 2;

                /*
                 * TV SYNTHESIZED CLICK GUARD (redundant, handled globally)
                 *
                 * Any synthesized OK ghost click (clientX=0, clientY=0) is already discarded
                 * at the very top of the click handler, so it never reaches this block.
                 */

                const slider = sliderContainer.querySelector('input[type="range"]');
                if (slider) {
                    const rect = sliderContainer.getBoundingClientRect();
                    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    slider.value = percent * 100;
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                    slider.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return;
            }

            /*
             * OSD background click: any click inside the OSD that doesn't land on a
             * specific button or the seekbar is treated as a play/pause toggle. This
             * mirrors the standard media player convention (clicking "somewhere" = pause).
             * Modals/overlays are excluded since their content may handle clicks internally.
             */
            if (!this.isModalOpen && !resolvedTarget.closest?.('.osd-overlays > *')) {
                this._executeAction('togglePlay');
            }
        });

        /*
         * Audio mode: hide buttons that only apply to video.
         */
        if (this._isAudio) {
            const audioBtn = this._osdEl.querySelector('[data-action="audio"]');
            const subtitleBtn = this._osdEl.querySelector('[data-action="subtitles"]');
            audioBtn?.remove();
            subtitleBtn?.remove();
            this._osdEl.classList.add('osd-audio-mode');
        } else {
            this._osdEl.classList.add('osd-video-mode');
            const lyricsBtn = this._osdEl.querySelector('#osdLyricsBtn');
            lyricsBtn?.remove();
        }

        // Initial setup for SyncPlay button visibility
        import('../../plugins/PluginManager.js').then(({ pluginManager }) => {
            if (!pluginManager.isEnabled('syncplay')) {
                const btn = this._osdEl.querySelector('#osdSyncPlayBtn');
                if (btn) {
                    btn.classList.add('hidden');
                    btn.setAttribute('tabindex', '-1');
                    this._cacheFocusableElements();
                }
            }
        });

        if (PlayerSettings.get('osdButtonsLocation') === 'below') {
            const bottomEl = this._osdEl.querySelector('.osd-bottom');
            if (bottomEl) {
                bottomEl.classList.add('buttons-below');
            }
        }

        if (PlayerSettings.get('osdLayout') === 'centered') {
            const leftControls = this._osdEl.querySelector('.osd-controls-left');
            const rightControls = this._osdEl.querySelector('.osd-controls-right');
            const bottomEl = this._osdEl.querySelector('.osd-bottom');

            if (leftControls && rightControls && bottomEl) {
                bottomEl.classList.add('osd-layout-centered');

                const queueBtn = leftControls.querySelector('#osdQueueBtn');
                const lyricsBtn = leftControls.querySelector('#osdLyricsBtn');
                const chaptersBtn = leftControls.querySelector('#osdChaptersBtn');

                if (lyricsBtn) rightControls.insertBefore(lyricsBtn, rightControls.firstChild);
                if (queueBtn) rightControls.insertBefore(queueBtn, rightControls.firstChild);
                if (chaptersBtn) rightControls.insertBefore(chaptersBtn, rightControls.firstChild);
            }
        }

        if (PlayerSettings.get('osdHideFavorite') === true) {
            const favoriteBtn = this._osdEl.querySelector('#osdFavoriteBtn');
            if (favoriteBtn) {
                favoriteBtn.remove();
            }
        }

        if (PlayerSettings.get('osdHideInfo') === true) {
            const infoBtn = this._osdEl.querySelector('#osdInfoBtn');
            if (infoBtn) {
                infoBtn.remove();
            }
        }

        if (PlayerSettings.get('osdHideBackButton') === true) {
            const backBtn = this._osdEl.querySelector('.osd-back-btn');
            if (backBtn) {
                backBtn.remove();
            }
        }

        if (PlayerSettings.get('osdCombineSkipButtons') === true) {
            const rewindBtn = this._osdEl.querySelector('[data-action="rewind"]');
            const fastForwardBtn = this._osdEl.querySelector('[data-action="fastForward"]');
            if (rewindBtn) {
                rewindBtn.innerHTML = osdIcons.chapterPrevious;
            }
            if (fastForwardBtn) {
                fastForwardBtn.innerHTML = osdIcons.chapterNext;
            }

            const prevBtn = this._osdEl.querySelector('#osdPrevBtn');
            const prevChapterBtn = this._osdEl.querySelector('#osdPrevChapterBtn');
            const nextChapterBtn = this._osdEl.querySelector('#osdNextChapterBtn');
            const nextBtn = this._osdEl.querySelector('#osdNextBtn');

            if (prevBtn) prevBtn.remove();
            if (prevChapterBtn) prevChapterBtn.remove();
            if (nextChapterBtn) nextChapterBtn.remove();
            if (nextBtn) nextBtn.remove();
        }

        this.updatePlayPauseButton();

        return this._osdEl;
    }

    _onMouseMove(e) {
        this.show();
        this.resetAutoHide();

        if (!e) return;

        // PROGRAMMATIC HOVER SUPPORT
        // Since WebOS 108 ignores pointer-events: none on .osd-overlays, 
        // native CSS :hover is broken for OSD buttons. We simulate it here.
        const els = document.elementsFromPoint(e.clientX, e.clientY);
        let targetBtn = null;

        for (const el of els) {
            // Find the first OSD button or slider under the cursor
            const btn = el.closest?.('[data-action], .osd-slider-container');
            if (btn) {
                targetBtn = btn;
                break;
            }
        }

        // Clean up previous hover
        if (this._lastHoveredEl && this._lastHoveredEl !== targetBtn) {
            this._lastHoveredEl.classList.remove('magic-hover');
        }

        // Apply new hover
        if (targetBtn) {
            targetBtn.classList.add('magic-hover');
            this._lastHoveredEl = targetBtn;

            /* Handle OSD slider interaction (scrubbing) */
            if (targetBtn.classList.contains('osd-slider-container')) {
                /* 
                 * If the user is HOLDING the button (e.buttons === 1), we treat 
                 * this as an active drag. This bypasses the WebOS pointer-events 
                 * bug where the native <input type="range"> might not receive 
                 * the drag events through the transparent overlays.
                 */
                if (e.buttons === 1) {
                    this._handlePositionSliderManualDrag(e);
                } else {
                    this._handlePositionSliderMouseMove(e);
                }
            } else {
                this._handlePositionSliderMouseLeave(e);
            }
        } else {
            this._lastHoveredEl = null;
            this._handlePositionSliderMouseLeave(e);
        }
    }

    /**
     * Clear all programmatic hover effects (Magic Cursor).
     * Called when the OSD hides or when D-pad navigation resumes.
     */
    _clearMagicHover() {
        if (this._osdEl) {
            this._osdEl.querySelectorAll('.magic-hover').forEach(el => el.classList.remove('magic-hover'));
        }
        this._lastHoveredEl = null;
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
        /*
         * Exit lock: if the player is in the process of shutting down (e.g. the back
         * button was clicked and _stopAndExit is awaiting async operations), do not
         * allow cursor movement to resurrect the OSD. Without this guard, _onMouseMove()
         * calling show() during the async shutdown gap makes the OSD flicker back.
         */
        if (this._isExiting) return;

        /*
         * Cancel the pending focus-reset timer (timeout mode) if the user
         * returns to the OSD before the 10-second deadline.
         * Focus stays wherever they left it — the timer firing early would be wrong.
         */
        if (!this._isOsdVisible && this._focusResetTimer) {
            clearTimeout(this._focusResetTimer);
            this._focusResetTimer = null;
        }

        if (this._osdMainEl) this._osdMainEl.classList.remove('osd-hidden');
        if (this._osdEl) this._osdEl.classList.remove('osd-is-hidden');
        this._isOsdVisible = true;

        // Start background polling when OSD becomes visible
        this._startUpdates();

        // Force an immediate layout update so the slider and time text don't
        // visually jump from 00:00 to the actual position on the next 500ms tick.
        this._updateState();

        this.resetAutoHide();
        this._updateNavigationButtons();
    }

    /**
     * Shows the OSD and forces focus to the Play/Pause button 
     * ONLY if the OSD was previously hidden.
     */
    showAndFocusPlayPause() {
        const wasHidden = !this._isOsdVisible;
        this.show();

        if (wasHidden) {
            this._currentFocusRow = 1;
            const playIdx = this._findActionIndex('togglePlay');
            if (playIdx !== -1) {
                this._currentFocusIndex = playIdx;
                this._updateFocus();
            }
        }
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

            /*
             * ========================================================================
             * GHOST CLICK LOCKOUT WINDOW:
             * Activating the Skip Intro button synchronously hides the widget, which
             * triggers this focus restore. To prevent TV browser-synthesized ghost click
             * events from immediately triggering the newly focused Play/Pause button,
             * we trigger a 350ms lockout during which OSD click events are completely
             * discarded.
             *
             * TRACK TRANSITION EXCEPTION:
             * If a full track transition lockout is already in effect (set by updateItem
             * and timed-out by syncTracks), we do NOT override the longer 1500ms timer
             * with this short 350ms one. Allowing that overwrite is what previously
             * caused the skip-intro button on the next episode to become responsive
             * only 350ms after the track switch — well within remote key repeat range.
             * ========================================================================
             */
            if (!this._trackTransitionLockoutActive) {
                /*
                 * Normal focus restore path (no track switch in progress):
                 * set a 350ms lockout to absorb ghost clicks after a widget action.
                 */
                this._focusRestoreLockout = true;
                if (this._focusRestoreLockoutTimer) {
                    clearTimeout(this._focusRestoreLockoutTimer);
                }
                this._focusRestoreLockoutTimer = setTimeout(() => {
                    this._focusRestoreLockout = false;
                    this._focusRestoreLockoutTimer = null;
                }, 350);
            } else {
                /*
                 * Track transition lockout is in effect — syncTracks() owns the timer.
                 * Just ensure the flag is set; do NOT start a competing 350ms timer
                 * that would prematurely clear the lock before the new episode settles.
                 */
                this._focusRestoreLockout = true;
                log.debug('OSDController.restoreControlsFocus: skipping 350ms timer — track transition lockout is active');
            }

            /*
             * ========================================================================
             * DEFER DOM FOCUS TRANSITION:
             * Deferring the _updateFocus() call by 50ms ensures that all events of the
             * current Enter/Click event cycle are completely finished propagating
             * before the DOM focus is shifted to the playback controls.
             * ========================================================================
             */
            setTimeout(() => {
                this._updateFocus();
            }, 50);
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

        const queueBtn = this._osdEl.querySelector('#osdQueueBtn');
        if (queueBtn) {
            const queueLength = playQueue.getQueue ? playQueue.getQueue().length : 0;
            if (queueLength <= 1) {
                queueBtn.classList.add('hidden');
                queueBtn.setAttribute('tabindex', '-1');
            } else {
                queueBtn.classList.remove('hidden');
                queueBtn.setAttribute('tabindex', '0');
            }
        }
    }

    _updateChapterButtons() {
        if (!this._osdEl || !this._player) return;

        const chapters = this._player.getChapters ? this._player.getChapters() : [];
        const hasChapters = chapters && chapters.length > 0;

        // Sync button enabled state and render/clear markers
        this._syncChapterButtonState(hasChapters);
        this._renderChapterMarkers();
    }

    /**
     * Enable or disable the lyrics button.
     * @param {boolean} available 
     */
    setLyricsAvailable(available) {
        if (!this._isAudio) return;
        const btn = this._osdEl.querySelector('#osdLyricsBtn');
        if (!btn) return;

        if (available) {
            btn.classList.remove('osd-btn-disabled', 'hidden');
            btn.tabIndex = 0;
        } else {
            btn.classList.add('osd-btn-disabled', 'hidden');
            btn.tabIndex = -1;
        }

        // Re-cache focusable elements since DOM structure changed
        this._cacheFocusableElements();
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

        /*
         * On slower devices (Tizen 5.0), the 'chaptersloaded' event from the player
         * can fire BEFORE OSDController has mounted and registered its listener,
         * leaving the chapter buttons permanently disabled even though chapters
         * are actually available. The seekbar markers render correctly because
         * _renderChapterMarkers() is also triggered by 'durationchange' and
         * 'loadedmetadata' — which always fire after mount.
         *
         * When we reach here, we know chapters are definitely loaded and valid
         * (we just rendered markers). Sync the button state so the buttons are
         * always consistent with what the seekbar shows, regardless of event ordering.
         */
        this._syncChapterButtonState(true);
    }

    /**
     * Enable or disable the prev/next chapter buttons without re-rendering markers.
     * Called from both _updateChapterButtons() and _renderChapterMarkers() so that
     * either code path can recover from missed or out-of-order events.
     * @param {boolean} enabled
     * @private
     */
    _syncChapterButtonState(enabled) {
        const prevChapterBtn = this._osdEl?.querySelector('[data-action="previousChapter"]');
        const nextChapterBtn = this._osdEl?.querySelector('[data-action="nextChapter"]');
        /* The dedicated chapters-list modal button — only enabled when chapters exist. */
        const chaptersModalBtn = this._osdEl?.querySelector('[data-action="chapters"]');

        // Music files generally do not have chapters, and we want to free up space on the OSD
        if (this._isAudio) {
            if (prevChapterBtn) {
                prevChapterBtn.classList.add('hidden');
                prevChapterBtn.setAttribute('tabindex', '-1');
            }
            if (nextChapterBtn) {
                nextChapterBtn.classList.add('hidden');
                nextChapterBtn.setAttribute('tabindex', '-1');
            }
            if (chaptersModalBtn) {
                chaptersModalBtn.classList.add('hidden');
                chaptersModalBtn.setAttribute('tabindex', '-1');
            }
            return;
        }

        if (enabled) {
            prevChapterBtn?.classList.remove('osd-btn-disabled');
            prevChapterBtn?.setAttribute('tabindex', '0');
            nextChapterBtn?.classList.remove('osd-btn-disabled');
            nextChapterBtn?.setAttribute('tabindex', '0');
            chaptersModalBtn?.classList.remove('hidden', 'osd-btn-disabled');
            chaptersModalBtn?.setAttribute('tabindex', '0');
        } else {
            prevChapterBtn?.classList.add('osd-btn-disabled');
            prevChapterBtn?.setAttribute('tabindex', '-1');
            nextChapterBtn?.classList.add('osd-btn-disabled');
            nextChapterBtn?.setAttribute('tabindex', '-1');
            chaptersModalBtn?.classList.add('hidden', 'osd-btn-disabled');
            chaptersModalBtn?.setAttribute('tabindex', '-1');
        }
    }

    hide() {
        // Don't hide if a modal menu is open
        if (this.isModalOpen) return;

        if (this._osdMainEl) this._osdMainEl.classList.add('osd-hidden');
        if (this._osdEl) this._osdEl.classList.add('osd-is-hidden');
        this._isOsdVisible = false;

        // Clear Magic Cursor hover when hiding
        this._clearMagicHover();

        // Potential timer stop: only stop if no menus or overlays are currently
        // active and requiring background updates (like PlaybackInfo).
        if (!this.activeMenu && !this.upNextDialog?.isVisible) {
            this._stopUpdates();
        }

        if (this._autoHideTimer) clearTimeout(this._autoHideTimer);

        /*
         * FOCUS RESTORE — pre-park focus based on user preference.
         *
         * The root problem: on Tizen (and some WebOS) runtimes, pressing OK/Enter
         * while the OSD is hidden generates a ghost click on the DOM-focused element
         * (whatever was last focused before the OSD hid). There is no reliable way
         * to swallow this click after the fact — blur(), e.preventDefault() and
         * capture-phase listeners all arrive too late or are ignored by the platform.
         *
         * The only reliable fix is to ensure the DOM-focused element is ALREADY
         * Play/Pause by the time the user presses OK. Then the ghost click just
         * toggles play/pause, which is the correct and expected behaviour.
         *
         *   'always'  → park focus immediately on hide.
         *   'timeout' → park focus after 10 s via a standalone one-shot timer
         *               (outside the update loop — _stopUpdates() above is unaffected).
         *               show() cancels this timer if the user returns early.
         *   'remember'→ leave focus wherever it is (original behaviour).
         */

        // Cancel any previous pending timer before possibly starting a new one
        if (this._focusResetTimer) {
            clearTimeout(this._focusResetTimer);
            this._focusResetTimer = null;
        }

        // Exception: Do not park focus if the subtitle offset is pinned
        if (this.activeMenu === this.subtitleOffset && PlayerSettings.get('keepFocusOnSubtitleOffset')) {
            return;
        }

        // Exception: Do not park focus if a plugin widget currently holds focus
        // (overlay row / Row -1). The widget stays visible even when the main OSD
        // controls hide — e.g. the skip-intro button floats above the video
        // independently. Resetting focus to play/pause here would cause the NEXT
        // OK/Enter press (intended for the widget) to fire togglePlay instead.
        if (this._currentFocusRow === -1) {
            return;
        }

        const mode = PlayerSettings.get('osdFocusRestoreMode') || 'always';

        if (mode === 'always') {
            // Park immediately — next OK press ghost-click hits Play/Pause
            this._resetFocusToPlayPause();
        } else if (mode === 'timeout') {
            // Park after 10 s. One-shot timer, cancelled by show() if OSD reveals early.
            this._focusResetTimer = setTimeout(() => {
                this._focusResetTimer = null;
                this._resetFocusToPlayPause();
            }, 10_000);
        } else if (mode === 'seekbar') {
            // Park immediately on the seekbar
            this._resetFocusToSeekbar();
        }
        // 'remember' → do nothing, focus stays on the last button
    }

    /**
     * Moves focus state to the Play/Pause button and updates the DOM.
     *
     * Called by hide() for 'always' mode, and by the timeout timer for
     * 'timeout' mode. Safe to call while the OSD is hidden — _updateFocus()
     * will move DOM focus (via btn.focus()) to Play/Pause so that any
     * subsequent OK/Enter ghost click fires on the correct element.
     *
     * @private
     */
    _resetFocusToPlayPause() {
        this._currentFocusRow = 1;
        const playIdx = this._findActionIndex('togglePlay');
        if (playIdx !== -1) this._currentFocusIndex = playIdx;
        this._updateFocus();
    }

    /**
     * Moves focus state to the Position Slider (seekbar) and updates the DOM.
     *
     * Called by hide() for 'seekbar' mode. Safe to call while the OSD is hidden.
     * @private
     */
    _resetFocusToSeekbar() {
        this._currentFocusRow = 2; // Position Slider row
        this._currentFocusIndex = 0;
        this._updateFocus();
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

            this._focusRestoreLockout = true;
            if (this._focusRestoreLockoutTimer) {
                clearTimeout(this._focusRestoreLockoutTimer);
            }
            this._focusRestoreLockoutTimer = setTimeout(() => {
                this._focusRestoreLockout = false;
                this._focusRestoreLockoutTimer = null;
            }, 350);

            setTimeout(() => {
                this._updateFocus();
            }, 50);
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

            this._focusRestoreLockout = true;
            if (this._focusRestoreLockoutTimer) {
                clearTimeout(this._focusRestoreLockoutTimer);
            }
            this._focusRestoreLockoutTimer = setTimeout(() => {
                this._focusRestoreLockout = false;
                this._focusRestoreLockoutTimer = null;
            }, 350);

            setTimeout(() => {
                this._updateFocus();
            }, 50);
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

    /**
     * Called by PlayerPage._onPlaying() every time playback begins (including
     * after a track-to-track transition). When a track switch has occurred,
     * this starts the 1.5-second input lockout countdown to absorb any ghost
     * key presses from the remote that triggered the transition.
     *
     * Design:
     *   updateItem() sets _focusRestoreLockout = true with NO timer because the
     *   loading duration is unknown. syncTracks() fires once the player emits
     *   'playing' (media is live), and only then starts the timed release.
     *
     *   CRITICAL: _trackTransitionLockoutActive must remain TRUE for the entire
     *   1500ms window. Clearing it early would let restoreControlsFocus() see a
     *   false flag and overwrite the 1500ms timer with a shorter 350ms one.
     *   It is cleared inside the timer callback when the window expires.
     */
    syncTracks() {
        if (!this._player) return;

        if (this._trackTransitionLockoutActive) {
            log.info('OSDController.syncTracks: New track playing — starting 1500ms input lockout');

            /* Cancel any existing stale timer before starting the authoritative one */
            if (this._focusRestoreLockoutTimer) {
                clearTimeout(this._focusRestoreLockoutTimer);
            }

            /* Lock out enter/click inputs for 1.5 seconds from playback start */
            this._focusRestoreLockout = true;
            this._focusRestoreLockoutTimer = setTimeout(() => {
                this._focusRestoreLockout = false;
                this._focusRestoreLockoutTimer = null;
                /* Now safe to clear — restoreControlsFocus guard can relax */
                this._trackTransitionLockoutActive = false;
                log.info('OSDController.syncTracks: Transition lockout cleared — widgets re-enabled');
            }, 1500);
        }

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
            // Conditionally prevent default inside handleInput based on what is focused
            this.handleInput('enter', e);
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

        // MEDIA KEYS (Play, Pause, stop, etc) are handled by PlayerPage.js
        // to ensure server reporting is preserved and to avoid double-firing.
        // The OSD is notified via direct method calls or internal state updates.

        this.on('key:options', (e) => {
            e?.preventDefault();
            this._executeAction('settings');
        });
        this.on('key:info', (e) => {
            e?.preventDefault();
            this._executeAction('playbackInfo');
        });
    }

    handleInput(key, e) {
        // ====================================================================
        // INPUT PROCESSING TRANSITION GUARD
        // ====================================================================
        // If the parent PlayerPage is transitioning between tracks, swallow all
        // remote navigation, clicks, and keys immediately. This isolates the 
        // OSD UI from any stray inputs or focus resets caused by cycling 
        // the video element out of/into the DOM.
        // ====================================================================
        if (this._playerPage && this._playerPage._isSwitching) {
            log.debug('OSDController: Ignoring input key event during active track switch:', key);
            return true;
        }

        const wasHidden = !this._isOsdVisible;

        // Delegate to modal menu first (TrackMenu, SettingsMenu)
        if (this.isModalOpen) {
            if (this.activeMenu.handleKey(key)) return true;

            // If a modal is open, we consume all directional/enter/back keys 
            // even if the menu didn't explicitly handle it (to prevent OSD background move)
            if (['up', 'down', 'left', 'right', 'enter', 'back'].includes(key)) return true;
        }

        // Special case for LyricsMenu: Since we intentionally leave _currentFocusRow at 1
        // to keep the "Lyrics" button highlighted, the Row -1 check above won't catch it.
        // If LyricsModal is active, give it first dibs on all navigational input.
        if (this.activeMenu === this.lyricsModal && ['up', 'down', 'left', 'right', 'enter', 'back'].includes(key)) {
            if (this.lyricsModal.handleKey(key)) return true;
        }

        // Show OSD on Enter press if hidden (Directional keys fall through to _navigate)
        if (wasHidden && key === 'enter') {
            /*
             * ========================================================================
             * GHOST KEY LOCKOUT GUARD:
             * Discards any wake-up Enter key events received during the active 350ms
             * lockout window. This blocks rapid TV key bounces or repeat inputs from
             * waking the OSD and triggering double executions.
             * ========================================================================
             */
            if (this._focusRestoreLockout) {
                log.info('OSDController: Discarding wake-up enter key event during focus restore lockout window');
                if (e) e.preventDefault();
                return true;
            }

            if (e) e.preventDefault();
            this.show();
            this._updateFocus();

            /*
             * ========================================================================
             * UNIFIED KEYBOARD OK/ENTER DISPATCH WHEN WAKING OSD
             * ========================================================================
             * When the OSD is hidden, pressing OK/Enter must wake the OSD and
             * immediately execute the action of whatever holds the pre-parked focus.
             * Since we discard the TV browser's synthesized ghost clicks globally
             * to prevent double-execution, we must execute the focused action
             * entirely in JavaScript during the wake-up sequence.
             * ========================================================================
             */
            if (this._currentFocusRow === -1) {
                // Overlay row (Row -1): a plugin widget (e.g. skip-intro) holds focus.
                // The widget's container has a click listener registered by PluginWidgetHost
                // that routes to the widget's onSelect() callback — so clicking the
                // focused button is sufficient to dispatch the action correctly.
                // We do NOT fall through to togglePlay; the widget owns this press.
                const focusedEl = this._cachedOverlayRow[this._currentFocusIndex];
                /*
                 * ====================================================================
                 * HIDDEN WIDGET & OVERLAY VISIBILITY GUARD
                 * ====================================================================
                 * If the overlay widget (such as Skip Outro or Up Next dialog) that
                 * claimed focus has since been hidden (e.g., episode transitioned or
                 * dismissed), the focused element might either be detached or hidden.
                 * We must only route the click action if the element remains connected
                 * to the active DOM tree and resides inside a visible overlay context.
                 *
                 * Built-in overlay widgets (like Up Next, Subtitle Offset, and Playback
                 * Info) are checked along with plugin widgets using their active classes.
                 * If the target is invalid, we fall back to controls recovery.
                 * ====================================================================
                 */
                if (focusedEl && focusedEl.isConnected && (
                    focusedEl.closest('.plugin-widget.visible') ||
                    focusedEl.closest('.upnext-dialog.visible') ||
                    focusedEl.closest('.osd-offset-popup.visible') ||
                    focusedEl.closest('.playback-info-popup.visible')
                )) {
                    focusedEl.click();
                    return true;
                }

                // Widget is hidden/gone — recover: reset row to controls and
                // execute play/pause as the user's intent for this wakeup press.
                this._currentFocusRow = 1;
                const playIdx = this._findActionIndex('togglePlay');
                if (playIdx !== -1) this._currentFocusIndex = playIdx;
                this._updateFocus();
                this._executeAction('togglePlay');
            } else if (this._currentFocusRow === 2) {
                // Seekbar row: OK = toggle play/pause
                this._executeAction('togglePlay');
            } else if (this._currentFocusRow === 1) {
                // Controls row: execute focused action (e.g. play/pause or subtitles)
                const controls = this._getControls();
                const btn = controls[Math.min(this._currentFocusIndex, controls.length - 1)];
                if (btn?.dataset?.action) {
                    this._executeAction(btn.dataset.action);
                }
            } else if (this._currentFocusRow === 0) {
                // Header row (back button)
                const btn = this._cachedHeaderRow[0];
                if (btn?.dataset?.action) {
                    this._executeAction(btn.dataset.action);
                } else {
                    this._executeAction('exit');
                }
            }

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
            case 'back': return this._handleBack();
            case 'enter': {
                /*
                 * ========================================================================
                 * GHOST KEY LOCKOUT GUARD:
                 * Discards any standard Enter key events received during the active 350ms
                 * lockout window. This blocks rapid TV key bounces or repeat inputs from
                 * triggering double executions.
                 * ========================================================================
                 */
                if (this._focusRestoreLockout) {
                    log.info('OSDController: Discarding enter key event during focus restore lockout window');
                    if (e) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                    return true;
                }

                /*
                 * On TV hardware, pressing OK synthesizes a click at clientX=0, clientY=0.
                 * The OSD click handler uses elementsFromPoint(clientX, clientY) to resolve
                 * the target — but (0,0) is the top-left corner of the viewport, nowhere near
                 * any OSD element. As a result, button presses and slider resets all fail.
                 *
                 * Fix: handle OK entirely in JS for all rows, never relying on the synthesized click.
                 */
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }

                if (this._currentFocusRow === -1) {
                    // Overlay row (Row -1): plugin widget holds focus.
                    // Click the focused button directly in JavaScript.
                    const focusedEl = this._cachedOverlayRow[this._currentFocusIndex];
                    /*
                     * ====================================================================
                     * HIDDEN WIDGET & OVERLAY VISIBILITY GUARD
                     * ====================================================================
                     * Only dispatch the synthetic click action if the focused element is
                     * connected to the DOM and resides inside a visible overlay widget.
                     * This ensures built-in overlays (Up Next, Subtitle Offset, and
                     * Playback Info) handle Enter key clicks correctly on TV adapters.
                     * ====================================================================
                     */
                    if (focusedEl && focusedEl.isConnected && (
                        focusedEl.closest('.plugin-widget.visible') ||
                        focusedEl.closest('.upnext-dialog.visible') ||
                        focusedEl.closest('.osd-offset-popup.visible') ||
                        focusedEl.closest('.playback-info-popup.visible')
                    )) {
                        focusedEl.click();
                        return true;
                    }

                    // Widget is hidden/gone — recover to controls row so the
                    // subsequent row checks below will dispatch correctly.
                    this._currentFocusRow = 1;
                    const recoverPlayIdx = this._findActionIndex('togglePlay');
                    if (recoverPlayIdx !== -1) this._currentFocusIndex = recoverPlayIdx;
                    this._updateFocus();
                }

                if (this._currentFocusRow === 2) {
                    // Seekbar row: OK = toggle play/pause
                    this._executeAction('togglePlay');
                    return true;
                }

                if (this._currentFocusRow === 1) {
                    // Controls row: activate the currently focused button's action directly
                    const controls = this._getControls();
                    const btn = controls[Math.min(this._currentFocusIndex, controls.length - 1)];
                    if (btn?.dataset?.action) {
                        this._executeAction(btn.dataset.action);
                        return true;
                    }
                }

                if (this._currentFocusRow === 0) {
                    // Header row (back button)
                    const btn = this._cachedHeaderRow[0];
                    if (btn?.dataset?.action) {
                        this._executeAction(btn.dataset.action);
                    } else {
                        this._executeAction('exit');
                    }
                    return true;
                }

                break;
            }
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

            if (key === 'playPause') {
                this._executeAction('togglePlay');
            } else {
                if (this._player.unpause) this._player.unpause();
                else if (this._player.play) this._player.play();
                this.updatePlayPauseButton();
            }
            return true;
        }
        if (key === 'pause') {
            this.show();
            if (this._player.pause) this._player.pause();
            this.updatePlayPauseButton();
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
        // When the user picks up the D-pad, clear any Magic Cursor hover state
        // so the two input methods don't visually conflict.
        this._clearMagicHover();

        const wasHidden = !this._isOsdVisible;
        const seekWithArrows = PlayerSettings.get('seekWithArrows') !== false;

        // First D-pad press always reveals OSD if hidden
        // User requested single-press move: trigger show AND allow navigation to proceed.
        if (wasHidden) {
            this.show();

            if (seekWithArrows && (direction === 'left' || direction === 'right')) {
                // Focus the seekbar so subsequent presses continue seeking
                this._currentFocusRow = 2;
                this._updateFocus();
                this._executeAction(direction === 'left' ? 'rewind' : 'fastForward');
                return true;
            }
            // Do NOT return here. Let the navigation logic below run.
        } else {
            this.show(); // Always reset auto-hide if already visible
        }

        if (direction === 'up') {
            const buttonsBelow = PlayerSettings.get('osdButtonsLocation') === 'below';
            if (buttonsBelow) {
                if (this._currentFocusRow === 1) {
                    this._currentFocusRow = 2; // Controls -> Seekbar
                } else if (this._currentFocusRow === 2) {
                    // Seekbar -> Overlay or Header
                    if (this._cachedOverlayRow.length > 0) {
                        this._currentFocusRow = -1;
                        if (this.upNextDialog?.isVisible && this.upNextDialog.$el) {
                            const playNow = this.upNextDialog.$el.querySelector('.upnext-btn-play');
                            const idx = playNow ? this._cachedOverlayRow.indexOf(playNow) : -1;
                            this._currentFocusIndex = idx !== -1 ? idx : 0;
                        } else {
                            this._currentFocusIndex = 0;
                        }
                    } else if (this._cachedHeaderRow.length > 0) {
                        this._currentFocusRow = 0;
                    }
                } else if (this._currentFocusRow === -1) {
                    if (this._cachedHeaderRow.length > 0) {
                        this._currentFocusRow = 0;
                    }
                } else if (this._currentFocusRow === 0) {
                    if (this._cachedOverlayRow.length > 0) {
                        this._currentFocusRow = -1;
                        this._currentFocusIndex = 0;
                    }
                }
            } else {
                if (this._currentFocusRow === 2) {
                    this._currentFocusRow = 1;
                    // Always target Play/Pause when moving UP from the seekbar
                    const playIdx = this._findActionIndex('togglePlay');
                    if (playIdx !== -1) {
                        this._currentFocusIndex = playIdx;
                    }
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
                    } else if (this._cachedHeaderRow.length > 0) {
                        this._currentFocusRow = 0;
                    }
                } else if (this._currentFocusRow === -1) {
                    // Overlay → Header (back button). Completes the chain:
                    // Seekbar ↑ Controls ↑ Overlay ↑ Header
                    // From Header the user can then right/left into subtitle offset / playback info.
                    if (this._cachedHeaderRow.length > 0) {
                        this._currentFocusRow = 0;
                    }
                } else if (this._currentFocusRow === 0) {
                    // Header → overlay (for subtitle offset / playback info panels
                    // which are also in the overlay row but triggered via menu buttons)
                    if (this._cachedOverlayRow.length > 0) {
                        this._currentFocusRow = -1;
                        this._currentFocusIndex = 0;
                    }
                }
            }
        } else if (direction === 'down') {
            const buttonsBelow = PlayerSettings.get('osdButtonsLocation') === 'below';
            if (buttonsBelow) {
                if (this._currentFocusRow === 0) {
                    if (this._cachedOverlayRow.length > 0) {
                        this._currentFocusRow = -1;
                        this._currentFocusIndex = 0;
                    } else {
                        this._currentFocusRow = 2; // Header -> Seekbar
                    }
                } else if (this._currentFocusRow === -1) {
                    this._currentFocusRow = 2; // Overlay -> Seekbar
                } else if (this._currentFocusRow === 2) {
                    this._currentFocusRow = 1; // Seekbar -> Controls
                    const playIdx = this._findActionIndex('togglePlay');
                    if (playIdx !== -1) {
                        this._currentFocusIndex = playIdx;
                    }
                }
            } else {
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
                // Fallback if overlay closed, but NOT if a full-screen modal is open
                // (since modals handle their own internal focus arrays and might not
                // populate _cachedOverlayRow with buttons).
                if (!this.isModalOpen) {
                    this._currentFocusRow = 0;
                    this._updateFocus();
                }
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
            /*
             * Focus the slider CONTAINER, not the <input type="range"> itself.
             * Giving the range input native DOM focus causes the TV browser to
             * synthesize a click at clientX=0 when OK is pressed, which seeks the
             * video to 0% via our own click handler. The container div is
             * focusable (tabindex=0 set below) and visually identical for the user.
             */
            const sliderContainer = this._osdEl.querySelector('.osd-slider-container');
            if (sliderContainer) {
                // Make it focusable if it isn't already
                if (!sliderContainer.hasAttribute('tabindex')) sliderContainer.setAttribute('tabindex', '0');
                sliderContainer.classList.add('focused');
                sliderContainer.focus();
            }
        }
    }





    _findActionIndex(action) {
        const controls = this._getControls();
        return controls.findIndex(btn => btn.dataset.action === action);
    }

    // ===================================
    // Actions & Logic
    // ===================================

    _executeAction(action) {
        // ====================================================================
        // ACTIVE TRACK SWITCH GUARD
        // ====================================================================
        // When transitioning between media tracks (e.g., auto-advancing to the 
        // next episode in the queue), the player temporarily cycles the video 
        // element out of and back into the DOM to purge webOS GPU surfaces. 
        // This DOM manipulation triggers synthetic focus resets, blurs, or 
        // ghost key events on Chromium-based TV platforms.
        //
        // If the player page is currently switching tracks, we discard all OSD 
        // actions globally to prevent these synthetic signals from closing 
        // the player mid-transition.
        // ====================================================================
        if (this._playerPage && this._playerPage._isSwitching) {
            log.info('OSDController: Ignoring action during active track switch:', action);
            return;
        }

        if (PlayerSettings.get('osdCombineSkipButtons') === true) {
            if (action === 'fastForward') {
                this._forwardClicks = (this._forwardClicks || 0) + 1;
                if (this._forwardTimeout) clearTimeout(this._forwardTimeout);
                this._forwardTimeout = setTimeout(() => {
                    const count = this._forwardClicks;
                    this._forwardClicks = 0;
                    this._forwardTimeout = null;

                    let targetAction = 'fastForward';
                    if (count === 2) targetAction = 'nextChapter';
                    else if (count >= 3) targetAction = 'nextTrack';

                    this._executeActionDirect(targetAction);
                }, 350);
                return;
            }
            if (action === 'rewind') {
                this._rewindClicks = (this._rewindClicks || 0) + 1;
                if (this._rewindTimeout) clearTimeout(this._rewindTimeout);
                this._rewindTimeout = setTimeout(() => {
                    const count = this._rewindClicks;
                    this._rewindClicks = 0;
                    this._rewindTimeout = null;

                    let targetAction = 'rewind';
                    if (count === 2) targetAction = 'previousChapter';
                    else if (count >= 3) targetAction = 'previousTrack';

                    this._executeActionDirect(targetAction);
                }, 350);
                return;
            }
        }

        this._executeActionDirect(action);
    }

    _executeActionDirect(action) {

        if (action !== 'fastForward' && action !== 'rewind') {
            log.info('Execute Action:', action);
        }

        /* 
         * DEBOUNCE: On many TVs (Tizen/WebOS), pressing OK triggers both our explicit
         * remote:select event handler AND the browser's native translated `click`.
         * This causes opening modals to instantly close.
         * Ignore rapid duplicate actions dispatched within 200ms.
         * OVERRIDE: FastForward and Rewind triggers from D-Pad holds (30fps)
         * must bypass this to prevent dropped inputs. They have their own debounce.
         */
        const now = Date.now();
        if (action !== 'fastForward' && action !== 'rewind') {
            if (this._lastActionTime && (now - this._lastActionTime) < 200) {
                log.info(`Ignoring rapid duplicate action: ${action} (last was: ${this._lastActionName})`);
                return;
            }
        }

        this._lastActionName = action;
        this._lastActionTime = now;

        switch (action) {
            case 'back': this._handleBack(); break;
            case 'exit':
                /*
                 * Lock out show() immediately so cursor movement during the async
                 * _stopAndExit() shutdown cannot flicker the OSD back into view.
                 * Then hide the OSD visually before the event fires.
                 */
                this._isExiting = true;
                clearTimeout(this._autoHideTimer);
                this.hide();
                this.emit('exit');
                break;
            case 'togglePlay':
                if (this._player.togglePlay) this._player.togglePlay();
                this.updatePlayPauseButton();
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
                /*
                 * ============================================================================
                 * SUBTITLES OVERLAY TOGGLE
                 * ============================================================================
                 * If the subtitle track selection menu is already visible on the screen,
                 * close it. Otherwise, open the menu and focus the first element.
                 * ============================================================================
                 */
                if (this.activeMenu === this.subtitleMenu && this.subtitleMenu.isVisible) {
                    log.info('Subtitles menu already open, closing.');
                    this.closeMenu();
                } else {
                    log.info('Opening subtitles menu.');
                    this.activeMenu = this.subtitleMenu;
                    this.subtitleMenu.open('subtitles');
                }
                break;
            case 'audio':
                /*
                 * ============================================================================
                 * AUDIO OVERLAY TOGGLE
                 * ============================================================================
                 * If the audio track selection menu is already visible on the screen,
                 * close it. Otherwise, open the menu and focus the first element.
                 * ============================================================================
                 */
                if (this.activeMenu === this.audioMenu && this.audioMenu.isVisible) {
                    log.info('Audio menu already open, closing.');
                    this.closeMenu();
                } else {
                    log.info('Opening audio menu.');
                    this.activeMenu = this.audioMenu;
                    this.audioMenu.open('audio');
                }
                break;
            case 'settings':
                /*
                 * ============================================================================
                 * QUICK SETTINGS MENU TOGGLE
                 * ============================================================================
                 * If the quick settings menu is already visible on the screen,
                 * close it. Otherwise, open the menu and focus the first element.
                 * ============================================================================
                 */
                if (this.activeMenu === this.settingsMenu && this.settingsMenu.isVisible) {
                    log.info('Settings menu already open, closing.');
                    this.closeMenu();
                } else {
                    log.info('Opening settings menu.');
                    this.activeMenu = this.settingsMenu;
                    this.settingsMenu.open();
                }
                break;
            case 'favorite':
                // Toggle favorite
                this._toggleFavorite();
                break;
            case 'subtitleOffset':
                this.toggleSubtitleOffset(!this.subtitleOffset.isVisible);
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
            case 'chapters':
                /*
                 * ============================================================================
                 * CHAPTERS OVERLAY TOGGLE
                 * ============================================================================
                 * Toggle the full list of chapters. If the chapters modal is currently open,
                 * close it. Otherwise, construct the list, render layout, and open it.
                 * ============================================================================
                 */
                if (this.activeMenu === this.chaptersModal && this.chaptersModal.isVisible) {
                    log.info('Chapters modal already open, closing.');
                    this.toggleChaptersModal(false);
                } else {
                    log.info('Opening chapters modal.');
                    this.toggleChaptersModal(true);
                }
                break;
            case 'queue':
                /*
                 * ============================================================================
                 * PLAYBACK QUEUE OVERLAY TOGGLE
                 * ============================================================================
                 * Toggle the Up Next playback queue overlay. If the queue modal is open,
                 * close it. Otherwise, retrieve the active list and show it.
                 * ============================================================================
                 */
                if (this.activeMenu === this.queueModal && this.queueModal.isVisible) {
                    log.info('Queue modal already open, closing.');
                    this.toggleQueueModal(false);
                } else {
                    log.info('Opening queue modal.');
                    this.toggleQueueModal(true);
                }
                break;
            case 'lyrics':
                this.toggleLyricsModal(true);
                break;
            case 'description':
                this.toggleDescriptionModal(true);
                break;
            case 'syncplay':
                // Lazy-import to avoid loading the group menu CSS on every startup
                // Opens the SyncPlay group management modal overlay
                import('../../core/syncplay/SyncPlayGroupMenu.js').then(({ SyncPlayGroupMenu }) => {
                    const menu = new SyncPlayGroupMenu(this);
                    menu.open();
                }).catch(err => log.error('Failed to open SyncPlayGroupMenu:', err));
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
                const startPos = (this._player.getCurrentPositionTicks && this._player.getCurrentPositionTicks()) || 0;
                this._seekTargetTicks = startPos;
                this._seekStartTime = Date.now();
                log.info(`Seek scrub session started from: ${this._formatTime(startPos)}`);
            }

            /*
             * ── SEEK ACCELERATION LOGIC ───────────────────────────────────────
             * The longer the user holds the seek button, the faster we skip.
             * This provides fine-grained control for short skips and massive
             * throughput for traversing long movies.
             */
            const seekDuration = (Date.now() - this._seekStartTime) / 1000;
            let speedMultiplier = 1;

            if (seekDuration >= 12) speedMultiplier = 10;      // Warp Speed: 10x
            else if (seekDuration >= 8) speedMultiplier = 5;   // Very Fast: 5x
            else if (seekDuration >= 6) speedMultiplier = 4;   // Fast: 4x
            else if (seekDuration >= 4) speedMultiplier = 3;   // Medium: 3x
            else if (seekDuration >= 2) speedMultiplier = 2;   // Slow Ramp: 2x

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
            this._updateTimeDisplay(previewPlayer, true); // true = skipHeavy
            this._updatePositionSlider(previewPlayer);

            // Cache the tooltip to avoid querySelector thrashing at 30fps
            if (!this._cachedTooltipEl) this._cachedTooltipEl = this._osdEl.querySelector('#osdSeekTooltip');
            const tooltip = this._cachedTooltipEl;

            if (tooltip) {
                const speedIndicator = speedMultiplier > 1 ? ` (${speedMultiplier}x)` : '';
                const forceHours = duration >= 3600 * 10000000;
                const timeText = this._formatTime(this._seekTargetTicks, forceHours) + speedIndicator;

                /* Update the text span (always shown) */
                if (this._cachedTooltipTextEl) {
                    this._cachedTooltipTextEl.textContent = timeText;
                } else {
                    /* Fallback: element without child structure (shouldn't happen) */
                    tooltip.textContent = timeText;
                }

                tooltip.classList.add('visible');
                const percent = duration > 0 ? (this._seekTargetTicks / duration) * 100 : 0;
                tooltip.style.left = percent + '%';

                /* Update trickplay thumbnail (only if enabled and data is available) */
                this._updateTrickplayTooltip(this._seekTargetTicks);
            }

            this._seekDebounceTimer = setTimeout(() => {
                try {
                    if (this._seekTargetTicks !== null && this._player.seek) {
                        log.info(`Seek scrub session committed. Jumping to: ${this._formatTime(this._seekTargetTicks, duration >= 3600 * 10000000)}`);
                        this._player.seek(this._seekTargetTicks);
                    }
                } catch (e) {
                    log.error('Deferred seek failed:', e);
                } finally {
                    this._seekTargetTicks = null;
                    this._seekStartTime = null;
                    this._seekDebounceTimer = null;
                    this._isDraggingSeekbar = false;
                    if (tooltip) tooltip.classList.remove('visible');

                    /* Hide trickplay thumbnail when seek session ends */
                    this._hideTrickplayThumb();
                }
            }, 800);

        } catch (err) {
            // Log the error but do NOT wipe _seekTargetTicks — an error in
            // show()/resetAutoHide() must not destroy the accumulated seek position.
            log.error('Seek error (non-critical):', err);
        }
    }

    updatePlayPauseButton() {
        if (!this._osdPlayPauseBtnEl || !this._player) return;

        const isPaused = this._player.isPaused();
        // Toggle only osd-btn-paused — avoid replacing the entire className which
        // would wipe transient classes like .magic-hover and .focused on every call.
        this._osdPlayPauseBtnEl.classList.toggle('osd-btn-paused', isPaused);

        // Update the inner SVG icons directly from unified properties
        this._osdPlayPauseBtnEl.innerHTML = isPaused ? osdIcons.play : osdIcons.pause;
    }

    _startUpdates() {
        if (this._updateTimer) return;

        log.debug('Starting OSD update loop (Interval:', this._config.updateInterval, 'ms)');
        this._updateTimer = setInterval(() => this._updateState(), this._config.updateInterval);
    }

    _stopUpdates() {
        if (!this._updateTimer) return;

        log.debug('Stopping OSD update loop');
        clearInterval(this._updateTimer);
        this._updateTimer = null;
    }

    /**
     * Main OSD update tick. Handles time/progress updates and 
     * synchronized state changes.
     * @private
     */
    _updateState() {
        try {
            // Always update playback info if active (it has its own visibility check)
            if (this.activeMenu && this.activeMenu === this.playbackInfo) {
                this.playbackInfo.update();
            }

            // Optimization: If OSD is completely hidden (no menus, no overlays),
            // skip DOM updates. The timer should ideally be stopped, but we guard here too.
            if (!this._isOsdVisible && !this.activeMenu && !this.upNextDialog?.isVisible) {
                return;
            }

            // Seek Safety: skip updates while the user is actively scrubbing
            if (this._seekTargetTicks !== null) {
                if (this._seekStartTime && (Date.now() - this._seekStartTime > 30000)) {
                    log.warn('Seek session safety timeout (30s). Resetting.');
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

            this.updatePlayPauseButton();
        } catch (e) {
            log.error('Error in OSD update loop:', e);
        }
    }

    /**
     * Update the current/total time strings on the OSD.
     * @param {Object} player 
     * @param {boolean} skipHeavy - Skip less critical updates during rapid seeks
     * @private
     */
    _updateTimeDisplay(player, skipHeavy = false) {
        if (!this._osdCurrentTimeEl || !this._osdTotalTimeEl) return;

        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        // Force hours if > 1h to prevent layout shifts when jumping between hours
        const forceHours = duration >= 3600 * 10000000;

        // Current time
        const timeStr = this._formatTime(current, forceHours);
        if (this._osdCurrentTimeEl.textContent !== timeStr) {
            this._osdCurrentTimeEl.textContent = timeStr;
        }

        // Time string for the duration label (right side)
        const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
        const isRemaining = timeDisplayMode === 'remaining';
        const durationDisplayTicks = isRemaining ? (duration - current) : duration;

        const totalStr = (isRemaining ? '-' : '') + this._formatTime(durationDisplayTicks, forceHours);
        if (this._osdTotalTimeEl.textContent !== totalStr) {
            this._osdTotalTimeEl.textContent = totalStr;
        }

        // Heavy updates (localization/extra elements)
        if (skipHeavy) return;

        // Update "Ends at" time
        const endsAtEl = this._osdEl.querySelector('#osdEndsAt');
        if (endsAtEl && duration > 0) {
            const remaining = duration - current;
            const endTime = new Date(Date.now() + (remaining / 10000));
            // Use 12h/24h format based on user preference via i18n helper
            const endStr = i18n.t('EndsAtValue', [i18n.formatLocalTime(endTime)]);
            if (endsAtEl.textContent !== endStr) {
                endsAtEl.textContent = endStr;
            }
        }
    }

    /**
     * Sync the position slider and fill bar with the player position.
     * @param {Object} player 
     * @private
     */
    _updatePositionSlider(player) {
        if (!this._osdPositionSliderEl || !this._osdPositionFillEl) return;

        const current = player.getCurrentPositionTicks ? player.getCurrentPositionTicks() : 0;
        const duration = player.getDurationTicks ? player.getDurationTicks() : 0;

        const percent = duration > 0 ? (current / duration) * 100 : 0;

        // Only update DOM if value changed significantly (save paint cycles)
        const currentVal = parseFloat(this._osdPositionSliderEl.value);
        if (Math.abs(currentVal - percent) > 0.01) {
            this._osdPositionSliderEl.value = percent;
        }

        /* Always update the fill bar width to ensure visual sync, even if the value was set manually */
        this._osdPositionFillEl.style.width = percent + '%';
    }

    /**
     * Update the wall clock on the OSD.
     * @private
     */
    _updateClock() {
        if (!this._osdClockEl) return;

        if (PlayerSettings.get('timeFormat') === 'none') {
            this._osdClockEl.style.display = 'none';
            return;
        }
        this._osdClockEl.style.display = '';
        const timeStr = i18n.formatLocalTime(new Date());
        if (this._osdClockEl.textContent !== timeStr) {
            this._osdClockEl.textContent = timeStr;
        }
    }

    _formatTime(ticks, forceHours = false) {
        if (!ticks) return forceHours ? '0:00:00' : '00:00';
        const totalSeconds = Math.floor(ticks / 10000000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0 || forceHours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    _handlePositionSliderInput(e) {
        if (this._suppressSliderChange) {
            if (this._player) this._updatePositionSlider(this._player);
            return;
        }

        this._isDraggingSeekbar = true;
        this.resetAutoHide();

        const percentRaw = e.target.value;
        const percent = parseFloat(percentRaw);

        /* Update fill bar visually - use cached element for performance */
        if (this._osdPositionFillEl) {
            this._osdPositionFillEl.style.width = percent + '%';
        }

        /* Update time labels live */
        this._syncTimeDisplayToPercent(percent);
    }

    /**
     * Manually sync the current and remaining time displays to a given percentage.
     * Used during dragging/scrubbing to avoid waiting for the next update loop.
     * @param {number} percent - 0 to 100
     * @private
     */
    _syncTimeDisplayToPercent(percent) {
        if (!this._player) return;

        const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;
        if (!duration) return;

        const currentTicks = duration * (percent / 100);
        const forceHours = duration >= 3600 * 10000000;

        if (this._osdCurrentTimeEl) {
            this._osdCurrentTimeEl.textContent = this._formatTime(currentTicks, forceHours);
        }

        const timeDisplayMode = PlayerSettings.get('osdTimeDisplayMode') || 'total';
        const isRemaining = timeDisplayMode === 'remaining';
        const durationDisplayTicks = isRemaining ? (duration - currentTicks) : duration;
        const totalStr = (isRemaining ? '-' : '') + this._formatTime(durationDisplayTicks, forceHours);

        if (this._osdTotalTimeEl) {
            this._osdTotalTimeEl.textContent = totalStr;
        }
    }

    /**
     * Handle manual dragging with the Magic Cursor or Mouse.
     * This simulates the native range input behavior for smoother scrubbing.
     * @param {MouseEvent} e 
     * @private
     */
    _handlePositionSliderManualDrag(e) {
        if (!this._osdPositionSliderEl || !this._player) return;

        const rect = this._osdPositionSliderEl.getBoundingClientRect();
        let percent = ((e.clientX - rect.left) / rect.width) * 100;
        percent = Math.max(0, Math.min(100, percent));

        /* Update the native input value so a subsequent 'change' event works */
        this._osdPositionSliderEl.value = percent;

        /* Force input logic to fire */
        this._handlePositionSliderInput({ target: this._osdPositionSliderEl });

        /* Also show the tooltip since we are dragging */
        this._handlePositionSliderMouseMove(e);
    }

    _handlePositionSliderChange(e) {
        if (this._suppressSliderChange) {
            this._suppressSliderChange = false;
            // Revert the rogue value=0 change that the TV browser forced upon us
            if (this._player) {
                this._updatePositionSlider(this._player);
            }
            return;
        }

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

    _handlePositionSliderMouseMove(e) {
        if (!PlayerSettings.get('enableHoverTrickplay') || this._seekTargetTicks !== null || !this._player) return;

        const duration = this._player.getDurationTicks ? this._player.getDurationTicks() : 0;
        if (!duration) return;

        const rect = this._osdPositionSliderEl.getBoundingClientRect();
        // Calculate relative position to the slider
        let percent = (e.clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));

        const targetTicks = duration * percent;

        if (!this._cachedTooltipEl) this._cachedTooltipEl = this._osdEl.querySelector('#osdSeekTooltip');
        const tooltip = this._cachedTooltipEl;

        if (tooltip) {
            const forceHours = duration >= 3600 * 10000000;
            const timeText = this._formatTime(targetTicks, forceHours);

            if (this._cachedTooltipTextEl) {
                this._cachedTooltipTextEl.textContent = timeText;
            } else {
                tooltip.textContent = timeText;
            }

            tooltip.classList.add('visible');
            tooltip.style.left = (percent * 100) + '%';

            this._updateTrickplayTooltip(targetTicks);
        }
    }

    _handlePositionSliderMouseLeave(e) {
        if (this._isDraggingSeekbar || this._seekTargetTicks !== null) return; // Scrubbing handles its own hide logic

        const tooltip = this._cachedTooltipEl || this._osdEl.querySelector('#osdSeekTooltip');
        if (tooltip) {
            tooltip.classList.remove('visible');
        }
        this._hideTrickplayThumb();
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
        // Only clear if we aren't currently in the middle of a scrub session.
        // If we are scrubbing, we want to IGNORE intermediate platform seek events
        // that might have been triggered by a previous partial commit, otherwise
        // they will wipe our targetTicks and cause the slider to jump.
        if (this._seekTargetTicks !== null) {
            log.info('Ignoring player seek event during active scrub session');
            return;
        }

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
     * Open or close the Chapters list modal.
     * Follows the same pattern as togglePlaybackInfo().
     *
     * @param {boolean} show - True to open, false to close.
     */
    toggleChaptersModal(show) {
        if (show) {
            /* Gather chapters and current playback position from the player. */
            const chapters = this._player?.getChapters?.() || [];
            const currentItem = this._currentItem ?? null;
            const positionTicks = this._player?.getCurrentPositionTicks?.() ?? 0;

            if (chapters.length === 0) {
                log.info('toggleChaptersModal: no chapters available, skipping.');
                return;
            }

            this.activeMenu = this.chaptersModal;
            this.chaptersModal.open(chapters, positionTicks, currentItem);

            /* Rebuild cache now that the modal DOM has been injected. */
            this._cacheFocusableElements();

            /* Move focus to the overlay row where the chapter list lives. */
            this._currentFocusRow = -1;
            this._currentFocusIndex = 0;
            this._updateFocus();
        } else {
            if (this.activeMenu === this.chaptersModal) {
                this.activeMenu = null;
            }
            this.chaptersModal.hide();
            this._cacheFocusableElements();

            /* Restore OSD and return focus to controls. */
            this.show();
            this._currentFocusRow = 1;
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this._updateFocus();
        }
    }

    /**
     * Open or close the Queue modal.
     * Follows the same pattern as togglePlaybackInfo().
     *
     * @param {boolean} show - True to open, false to close.
     */
    toggleQueueModal(show) {
        if (show) {
            this.activeMenu = this.queueModal;
            this.queueModal.open();

            /* Rebuild cache now that the modal DOM has been injected. */
            this._cacheFocusableElements();

            this._currentFocusRow = -1;
            this._currentFocusIndex = 0;
            this._updateFocus();
        } else {
            if (this.activeMenu === this.queueModal) {
                this.activeMenu = null;
            }
            this.queueModal.hide();
            this._cacheFocusableElements();

            this.show();
            this._currentFocusRow = 1;
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
            this._updateFocus();
        }
    }

    /**
     * Open or close the Lyrics modal.
     * Follows the same pattern as toggleChaptersModal().
     *
     * @param {boolean} show - True to open, false to close.
     */
    toggleLyricsModal(show) {
        if (show) {
            // TOGGLE: If it's already open, close it instead.
            if (this.activeMenu === this.lyricsModal && this.lyricsModal._isVisible) {
                this.toggleLyricsModal(false);
                return;
            }

            // PlayerPage is responsible for fetching and maintaining lyrics data.
            // We just ask for the current cached lyrics.
            if (!this._playerPage || !this._playerPage._currentLyrics) {
                log.info('toggleLyricsModal: No lyrics available yet.');
                return;
            }

            const positionTicks = this._player?.getCurrentPositionTicks?.() ?? 0;

            this.activeMenu = this.lyricsModal;
            this.lyricsModal.open(this._playerPage._currentLyrics, positionTicks);

            document.body.classList.add('lyrics-active');

            /* Rebuild cache now that the modal DOM has been injected. */
            this._cacheFocusableElements();

            /* 
             * -----------------------------------------------------------------
             * LYRICS MODAL FOCUS TRANSITION
             * -----------------------------------------------------------------
             * Shift focus from the controls row to the overlay row (Row -1),
             * targeting the close button in the lyrics modal header. This
             * allows immediate keyboard navigation and D-pad control.
             * -----------------------------------------------------------------
             */
            this._currentFocusRow = -1;
            const closeBtn = this.lyricsModal.el?.querySelector('.osd-offset-close');
            const closeIdx = closeBtn ? this._cachedOverlayRow.indexOf(closeBtn) : -1;
            this._currentFocusIndex = closeIdx !== -1 ? closeIdx : 0;
            this._updateFocus();
        } else {
            if (this.activeMenu === this.lyricsModal) {
                this.activeMenu = null;
            }
            this.lyricsModal.hide();
            document.body.classList.remove('lyrics-active');
            this._cacheFocusableElements();

            this.show();
            this._currentFocusRow = 1;
            // Ensure focus is restored to the lyrics button specifically
            const lyricsIdx = this._findActionIndex('lyrics');
            this._currentFocusIndex = lyricsIdx !== -1 ? lyricsIdx : 0;
            this._updateFocus();
        }
    }

    /**
     * Open or close the Description modal.
     * Follows the same pattern as toggleChaptersModal().
     *
     * @param {boolean} show - True to open, false to close.
     */
    toggleDescriptionModal(show) {
        if (show) {
            this.activeMenu = this.descriptionModal;
            this.descriptionModal.open(this._currentItem);
        } else {
            if (this.activeMenu === this.descriptionModal) {
                this.activeMenu = null;
            }
            this.descriptionModal.hide();
            this._cacheFocusableElements();
            this.show();
        }
    }

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
            /* 
             * ========================================================================
             * DIALOG FOCUS ESCAPE RECOVERY
             * ========================================================================
             * Before hiding the Up Next dialog, determine if focus is currently held
             * inside it. If the dialog has active focus, hiding it would leave the D-pad
             * focus row stranded in Row -1 (Overlay row) with no active targets, causing
             * subsequent key events (such as the Back button or Enter) to route into
             * fallback exit actions that exit/close the entire player page.
             *
             * If focus was inside the dialog, we restore it back to the controls row.
             * ========================================================================
             */
            const focusedEl = this._cachedOverlayRow[this._currentFocusIndex];
            const wasDialogFocused = focusedEl && this.upNextDialog.$el?.contains(focusedEl);

            this.upNextDialog.hide();

            // Only clear activeMenu if the dialog was the active one —
            // don't accidentally clobber a settings menu that might be open.
            if (this.activeMenu === this.upNextDialog) {
                this.activeMenu = null;
            }
            this._cacheFocusableElements();

            // Restore focus back to Play/Pause on the primary OSD playback controls
            if (wasDialogFocused) {
                this.show();
                this._currentFocusRow = 1;
                const playIdx = this._findActionIndex('togglePlay');
                this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
                this._updateFocus();

                // Lock out inputs for 350ms to absorb keyboard-synthesized click events on the newly focused play button
                this._focusRestoreLockout = true;
                if (this._focusRestoreLockoutTimer) {
                    clearTimeout(this._focusRestoreLockoutTimer);
                }
                this._focusRestoreLockoutTimer = setTimeout(() => {
                    this._focusRestoreLockout = false;
                    this._focusRestoreLockoutTimer = null;
                }, 350);
            }
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

        // Check the dedicated user setting for whether the Up Next dialog
        // should be displayed. Toggling autoplay off no longer prevents the dialog
        // from showing, allowing users to manually click "Play Now" or dismiss it.
        if (!PlayerSettings.get('enableNextUpDialog')) return;

        // -------------------------------------------------------------------
        // Calculate the "show at" threshold
        // Based on the user's preferred trigger mode setting
        // -------------------------------------------------------------------
        const triggerMode = PlayerSettings.get('nextUpTriggerMode') || 'default';
        let showAtTicks = null;

        if (triggerMode === 'default') {
            /*
             * Default behavior:
             * Priority: start of the last chapter (semantic) -> time-based fallback
             */
            const chapters = this._player?.getChapters ? this._player.getChapters() : [];
            if (chapters && chapters.length >= 2) {
                const lastChapter = chapters[chapters.length - 1];
                const lastChapterTicks = lastChapter.StartPositionTicks || 0;
                const minChapterOffsetTicks = durationTicks * 0.9;
                const MIN_REMAINING = 5 * TICKS_PER_SECOND;
                if (lastChapterTicks >= minChapterOffsetTicks && (durationTicks - lastChapterTicks) >= MIN_REMAINING) {
                    showAtTicks = lastChapterTicks;
                }
            }
        }

        if (showAtTicks == null) {
            // Either 'time_fallback', 'seconds_20', 'seconds_30', or 'default' with no usable chapters
            let showAtSeconds = 30;

            if (triggerMode === 'seconds_20') {
                showAtSeconds = 20;
            } else if (triggerMode === 'seconds_30') {
                showAtSeconds = 30;
            } else {
                // 'time_fallback' or 'default' fallback
                if (durationTicks >= 50 * TICKS_PER_MINUTE) {
                    showAtSeconds = 40;
                } else if (durationTicks >= 40 * TICKS_PER_MINUTE) {
                    showAtSeconds = 35;
                }
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

    /**
     * Reset Lyrics state entirely.
     * Called by PlayerPage when a new item starts playing to ensure the 
     * lyrics modal is closed and the background state is cleared.
     */
    resetLyrics() {
        if (this.lyricsModal && this.lyricsModal._isVisible) {
            this.lyricsModal.hide();
            if (this.activeMenu === this.lyricsModal) {
                this.activeMenu = null;
            }
            document.body.classList.remove('lyrics-active');
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

    /**
     * Provide the resolved media source ID so TrickplayManager can look up
     * the correct resolution map inside item.Trickplay.
     *
     * Called by PlayerPage after PLAYBACK_START, once the server has chosen
     * the actual media source (which may differ from the originally requested one).
     *
     * @param {string} mediaSourceId
     */
    setMediaSourceId(mediaSourceId) {
        this._currentMediaSourceId = mediaSourceId;

        /* Re-initialise trickplay now that we have both the item and the source ID.
           This is a no-op if the item isn't set yet — setMetadata will pick it up. */
        if (this._currentItem && mediaSourceId) {
            const serverUrl = this._player?.serverUrl || '';
            const authToken = this._player?.authToken || '';
            this._trickplay.init(this._currentItem, mediaSourceId, serverUrl, authToken);
        }
    }

    setMetadata(item) {
        this._currentItem = item;
        this._isAudio = (item?.MediaType === 'Audio' || item?.Type === 'AudioBook');

        const titleEl = this._osdEl.querySelector('#osdTitle');
        const secondaryEl = this._osdEl.querySelector('#osdTitleSecondary');
        const logoEl = this._osdEl.querySelector('#osdLogo');
        const showLogoSetting = PlayerSettings.get('osdShowLogo');
        const hideShowNameSetting = PlayerSettings.get('osdHideShowName');

        // Reset title wrap classes
        const wrapEl = this._osdEl.querySelector('.osd-title-wrap');
        if (wrapEl) {
            wrapEl.classList.remove('has-logo-small', 'has-logo-medium', 'has-logo-large', 'has-logo-extralarge', 'has-logo-xxl');
        }

        // Always reset to visible title and hidden logo initially to avoid stale images
        if (titleEl) titleEl.classList.remove('hidden');
        if (logoEl) {
            logoEl.classList.add('hidden');
            logoEl.src = '';
            logoEl.classList.remove('logo-small', 'logo-medium', 'logo-large', 'logo-extralarge', 'logo-xxl');
        }
        if (secondaryEl) secondaryEl.textContent = '';

        // Get the split title components
        const titleData = this._getFormattedTitle(item);

        // Set the text titles
        if (titleEl) titleEl.textContent = titleData.main;
        if (secondaryEl) secondaryEl.textContent = titleData.secondary;

        // If logo feature is enabled, try to resolve and show the logo for the MAIN part only
        // Skip if it's an episode and we are hiding the show name (logo represents show)
        const isEpisode = !!item.SeriesName;
        if (showLogoSetting && logoEl && item && !this._isAudio && !(isEpisode && hideShowNameSetting)) {
            /* 
             * Resolve the item ID that has the logo image.
             * 1. Check current item (Movie, Series, Channel)
             * 2. Check parent (Episode -> Series)
             * 3. Check ParentLogoItemId (Metadata fallback)
             */
            let logoItemId = null;
            if (item.ImageTags && item.ImageTags.Logo) {
                logoItemId = item.Id;
            } else if (item.SeriesId && item.SeriesImageTags && item.SeriesImageTags.Logo) {
                logoItemId = item.SeriesId;
            } else if (item.ParentLogoItemId && item.ParentLogoImageTag) {
                logoItemId = item.ParentLogoItemId;
            } else if (item.ChannelId) {
                logoItemId = item.ChannelId;
            }

            if (logoItemId) {
                // Get the custom logo size from player settings (default to medium)
                const logoSize = PlayerSettings.get('osdLogoSize') || 'medium';
                let maxImgHeight = 52;
                let maxImgWidth = 200;
                if (logoSize === 'small') {
                    maxImgHeight = 36;
                    maxImgWidth = 140;
                } else if (logoSize === 'medium') {
                    maxImgHeight = 52;
                    maxImgWidth = 200;
                } else if (logoSize === 'large') {
                    maxImgHeight = 68;
                    maxImgWidth = 260;
                } else if (logoSize === 'extralarge') {
                    maxImgHeight = 84;
                    maxImgWidth = 320;
                } else if (logoSize === 'xxl') {
                    maxImgHeight = 100;
                    maxImgWidth = 380;
                }

                // Add size class to the logo element
                logoEl.classList.add('logo-' + logoSize);

                // Add corresponding class to title wrap to adjust row height dynamically
                if (wrapEl) {
                    wrapEl.classList.add('has-logo-' + logoSize);
                }

                // Retrieve optimized contain-scaled image by specifying exact OSD dimensions and DPR
                const dpr = window.devicePixelRatio || 1;
                const logoUrl = this._api.getImageUrl(logoItemId, 'Logo', {
                    fillWidth: Math.round(maxImgWidth * dpr),
                    fillHeight: Math.round(maxImgHeight * dpr),
                    tag: item.ImageTags?.Logo || item.SeriesImageTags?.Logo || item.ParentLogoImageTag
                });

                logoEl.onload = () => {
                    // Only switch if this is still the active item
                    if (this._currentItem && (this._currentItem.Id === item.Id)) {
                        logoEl.classList.remove('hidden');
                        if (titleEl) titleEl.classList.add('hidden');
                    }
                };

                logoEl.onerror = () => {
                    if (titleEl) titleEl.classList.remove('hidden');
                    logoEl.classList.add('hidden');
                    logoEl.classList.remove('logo-small', 'logo-medium', 'logo-large', 'logo-extralarge', 'logo-xxl');
                    if (wrapEl) {
                        wrapEl.classList.remove('has-logo-small', 'has-logo-medium', 'has-logo-large', 'has-logo-extralarge', 'has-logo-xxl');
                    }
                };

                logoEl.src = logoUrl;
            }
        }

        this._updateFavoriteButton(item);
        this._updateNavigationButtons();

        /*
         * Initialise (or reset) trickplay for the new item.
         * mediaSourceId may be null here if PlayerPage hasn't called setMediaSourceId yet —
         * in that case TrickplayManager.init() will bail out gracefully, and a subsequent
         * setMediaSourceId() call will re-initialise it once the source is known.
         */
        const mediaSourceId = this._currentMediaSourceId || null;
        const serverUrl = this._player?.serverUrl || '';
        const authToken = this._player?.authToken || '';
        this._trickplay.init(item, mediaSourceId, serverUrl, authToken);
    }

    updateItem(item) {
        this.setMetadata(item);

        /*
         * ============================================================================
         * TRACK TRANSITION FOCUS RESET GUARD
         * ============================================================================
         * When switching tracks or advancing to the next episode (e.g., after clicking
         * Skip Outro), the OSD Controller instance is preserved and reused.
         *
         * If the user previously had focus on an overlay widget (Row -1), such as
         * the skip-outro button, we must explicitly reset the focus row to the
         * Controls row (Row 1, Play/Pause) to ensure that the new track does not
         * inherit a stranded Row -1 focus. This prevents accidental double-skips
         * on the newly loaded item's skip-intro button.
         * ============================================================================
         */
        if (this._currentFocusRow === -1) {
            this._currentFocusRow = 1;
            const playIdx = this._findActionIndex('togglePlay');
            this._currentFocusIndex = playIdx !== -1 ? playIdx : 0;
        }

        /*
         * ============================================================================
         * INDEFINITE TRANSITION LOCKOUT:
         * Enforce an active focus restore lockout when switching items. This lockout
         * persists through the entire track loading and buffering transition phase.
         * The countdown to clear the lockout begins only once the media playback
         * starts and calls syncTracks().
         * ============================================================================
         */
        this._trackTransitionLockoutActive = true;
        this._focusRestoreLockout = true;
    }

    _getFormattedTitle(item) {
        if (!item) return { main: '', secondary: '' };

        const hideYear = PlayerSettings.get('osdHideYear');
        const hideShowName = PlayerSettings.get('osdHideShowName');

        // Live TV: Channel/Program handling
        if (item.Type === 'TvChannel' || item.ChannelId) {
            const channelNumber = item.Number || item.ChannelNumber;
            const channelName = item.ChannelName || (item.Type === 'TvChannel' ? item.Name : '');
            const programName = (item.Type === 'TvChannel' || item.Name === channelName) ? '' : item.Name;

            let main = '';
            if (channelNumber) main += `${channelNumber} `;
            if (channelName) main += `${channelName}`;

            return {
                main: main.trim() || item.Name || '',
                secondary: programName ? ` - ${programName}` : ''
            };
        }

        if (item.SeriesName) {
            let secondary = '';
            if (item.IndexNumber !== undefined) {
                const s = item.ParentIndexNumber || 1;
                const e = item.IndexNumber;
                secondary += ` S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`;
            }
            if (item.Name) secondary += ` - ${item.Name}`;

            if (item.ProductionYear && !hideYear) {
                secondary += ` (${item.ProductionYear})`;
            }

            const mainTitle = hideShowName ? '' : item.SeriesName;

            return {
                main: mainTitle,
                secondary: (mainTitle && secondary) ? ` - ${secondary.trim()}` : secondary.trim()
            };
        }

        let secondary = '';
        if (item.ProductionYear && !hideYear) {
            secondary = ` (${item.ProductionYear})`;
        }

        return {
            main: item.Name || '',
            secondary: secondary
        };
    }

    _updateFavoriteButton(item) {
        const btn = this._osdEl.querySelector('#osdFavoriteBtn');
        if (!btn || !item?.UserData) return;
        const isFavorite = item.UserData.IsFavorite;

        if (isFavorite) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
        btn.style.color = '';
    }

    // -------------------------------------------------------------------------
    // Trickplay Thumbnail Helpers
    // -------------------------------------------------------------------------

    /**
     * Calculate the correct sprite-sheet tile for the given position and apply
     * it to the cached thumbnail div using CSS background properties.
     *
     * This must be as lightweight as possible — it's called on every seek tick
     * (up to ~30fps when the user holds the D-pad).
     *
     * @param {number} positionTicks
     * @private
     */
    _updateTrickplayTooltip(positionTicks) {
        /* Fast exit: no thumbnail element or trickplay not ready */
        if (!this._cachedThumbEl || !this._trickplay.isEnabled()) {
            this._hideTrickplayThumb();
            return;
        }

        const thumb = this._trickplay.getThumbnail(positionTicks);
        if (!thumb) {
            this._hideTrickplayThumb();
            return;
        }

        const el = this._cachedThumbEl;

        /*
         * Apply CSS background shorthand to show the correct tile.
         *
         * background-size MUST match the full sprite sheet dimensions so the
         * browser doesn't scale the image before calculating the offset.
         *   e.g. for a 10×10 grid of 320×180 frames: 3200px 1800px
         *
         * background-position is a negative pixel offset to shift the sheet
         * so only the target tile is visible within the element's fixed w/h.
         */
        el.style.backgroundImage = `url(${thumb.url})`;
        el.style.backgroundSize = `${thumb.spriteWidth}px ${thumb.spriteHeight}px`;
        el.style.backgroundPosition = `${thumb.backgroundX}px ${thumb.backgroundY}px`;
        el.style.backgroundRepeat = 'no-repeat';
        el.style.width = `${thumb.thumbWidth}px`;
        el.style.height = `${thumb.thumbHeight}px`;
        el.style.display = 'block';

        /* Switch tooltip to flex layout so thumb sits above the time text */
        if (this._cachedTooltipEl) {
            this._cachedTooltipEl.classList.add('has-trickplay');
        }
    }

    /**
     * Hide the trickplay thumbnail div and reset the tooltip layout.
     * @private
     */
    _hideTrickplayThumb() {
        if (this._cachedThumbEl) {
            this._cachedThumbEl.style.display = 'none';
        }
        if (this._cachedTooltipEl) {
            this._cachedTooltipEl.classList.remove('has-trickplay');
        }
    }
}