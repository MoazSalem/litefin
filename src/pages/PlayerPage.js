/**
 * ============================================================================
 * Litefin Tizen - Player Page
 * ============================================================================
 * Full-screen video player page with OSD (On-Screen Display) controls.
 * Hosts the Jellyfin Player and manages playback lifecycle.
 *
 * Features:
 * - Tizen AVPlay integration for hardware-accelerated playback
 * - OSD controls with remote navigation support
 * - Subtitle display and track selection
 * - Progress reporting to Jellyfin server
 * ============================================================================
 */

import Page from './Page.js';
import { api } from '../api/index.js';
import { router } from '../core/Router.js';
import { eventBus } from '../core/EventBus.js';
import { state } from '../core/StateManager.js';
import { playQueue } from '../core/PlayQueue.js';
import { focusManager } from '../ui/FocusManager.js';
import PlayerOSD from '../player/jellyfin-player-osd.js';
import { JellyfinPlayer } from '../player/core/JellyfinPlayer.js';
import SubtitleStyles from '../utils/SubtitleStyles.js';
import FontLoader from '../utils/FontLoader.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('Player');

class PlayerPage extends Page {
    constructor() {
        super();

        // Player instance
        this._player = null;

        // Current item being played
        this._item = null;

        // Resume position (if resuming)
        this._resumePosition = 0;

        // OSD controller reference
        this._osd = null;

        // Track reporting state
        this._hasReportedStart = false;

        // Cached media source for stop reporting
        // (player clears this internally after stop, so we need a copy)
        this._cachedMediaSource = null;

        // Concurrency lock for item switching
        this._isSwitching = false;
    }

    render() {
        return `
            <div class="page player-page">
                <!-- Video Container -->
                <div id="player-container" class="player-container">
                    <!-- Video element will be injected by JellyfinPlayer -->
                </div>



                <!-- Error Overlay (Redesigned for TV) -->
                <div class="player-error hidden" id="player-error">
                    <div class="error-panel glass-panel">
                        <div class="error-content">
                            <div class="error-icon-container">
                                <svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="8" x2="12" y2="10"></line>
                                    <line x1="12" y1="12" x2="12" y2="16"></line>
                                </svg>
                            </div>
                            <h2 class="error-title">Playback Error</h2>
                            <p class="error-message"></p>
                        </div>
                        <div class="error-actions">
                            <button class="btn btn-primary focusable" id="error-retry-btn" tabindex="0">Retry</button>
                            <button class="btn btn-secondary focusable" id="error-back-btn" tabindex="0">Go Back</button>
                        </div>
                    </div>
                </div>

                <!-- OSD Overlay (controlled by jellyfin-player-osd.js) -->
                <div id="osd-overlay" class="player-osd"></div>

                <!-- Subtitle Overlay -->
                <div id="subtitle-overlay" class="subtitle-overlay"></div>
            </div>
        `;
    }

    async onInit() {
        const itemId = this.params.id;
        const resume = this.params.resume === 'true';

        try {
            // Show loading
            this._showLoading(true);

            // Render cached backdrop if available (for smooth transition)
            const backdropUrl = state.get('player:backdropUrl');
            if (backdropUrl) {
                // Apply directly to the loading overlay to ensure visibility
                const loader = this.el.querySelector('.page-loading');
                if (loader) {
                    loader.style.backgroundSize = 'cover';
                    loader.style.backgroundPosition = 'center';

                    // IMPORTANT: Override the solid background color from base.css
                    // We need a gradient over the image for text contrast, but base color must be transparent
                    loader.style.backgroundColor = 'transparent';

                    // Add a pseudo-element-like gradient overlay via background-image
                    loader.style.backgroundImage = `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.8) 100%), url('${backdropUrl}')`;

                    this._loadingBackdrop = loader; // Mark for cleanup
                }
            }

            // Enable Tizen AVPlayer transparency mode
            // This makes body/app transparent so hardware video plane is visible
            document.body.classList.add('player-active');
            document.documentElement.classList.add('player-active');

            // Preload the selected subtitle font so it's ready before subtitles appear
            const fontId = SubtitleStyles.getCurrentFontId();
            if (fontId) {
                await FontLoader.loadFont(fontId);
            }

            // Load item details
            this._item = await api.getItem(itemId);
            this.title = this._item.Name;

            // Initialize Play Queue
            const contextType = state.get('player:contextType');
            const contextId = state.get('player:contextId');
            log.debug('Initializing PlayQueue with context:', { contextType, contextId });
            await playQueue.init(this._item, contextType, contextId);

            // Clear context state so it doesn't leak to next playback
            state.set('player:contextType', null);
            state.set('player:contextId', null);

            // Calculate resume position if needed
            if (resume && this._item.UserData?.PlaybackPositionTicks) {
                this._resumePosition = this._item.UserData.PlaybackPositionTicks;
            }

            // Initialize the player
            await this._initPlayer();

            // Listen for app close/hide events to report playback stopped
            this._onAppBeforeExit = () => this._handleAppExit();
            eventBus.on('app:beforeExit', this._onAppBeforeExit);

            // ================================================================
            // REMOTE CONTROL HANDLERS
            // ================================================================
            // Handle remote pause/play/stop commands from Jellyfin dashboard
            // IMPORTANT: These must also report state changes to the server!

            this._onRemotePause = () => {
                log.info('Remote: Pause');
                if (this._player?.pause) {
                    this._player.pause();
                    // Report pause state to server
                    this._reportPlaybackProgress('pause');
                }
            };
            eventBus.on('remote:pause', this._onRemotePause);

            this._onRemotePlay = () => {
                log.info('Remote: Play/Resume');
                // Player library uses unpause() or togglePlay() - not play()
                if (this._player?.unpause) {
                    this._player.unpause();
                } else if (this._player?.togglePlay && this._player?.isPaused?.()) {
                    // Only toggle if paused (to avoid pausing when already playing)
                    this._player.togglePlay();
                }
                // Report unpause state to server
                this._reportPlaybackProgress('unpause');
            };
            eventBus.on('remote:play', this._onRemotePlay);

            this._onRemotePlayPause = () => {
                log.info('Remote: PlayPause');
                const wasPaused = this._player?.isPaused?.();
                if (this._player?.togglePlay) {
                    this._player.togglePlay();
                }
                // Report state change based on what state we WERE in
                if (wasPaused) {
                    this._reportPlaybackProgress('unpause');
                } else {
                    this._reportPlaybackProgress('pause');
                }
            };
            eventBus.on('remote:playpause', this._onRemotePlayPause);

            this._onRemoteStop = () => {
                log.info('Remote: Stop');
                // _stopAndExit already handles reporting stopped to server
                this._stopAndExit();
            };
            eventBus.on('remote:stop', this._onRemoteStop);

            this._onRemoteSeek = (positionTicks) => {
                log.info('Remote: Seek to', positionTicks);
                // Player uses seek() not seekTo() - same as OSD
                if (this._player?.seek) {
                    this._player.seek(positionTicks);
                    // Report new position to server after a brief delay for seek to complete
                    setTimeout(() => this._reportPlaybackProgress('timeupdate'), 200);
                } else {
                    log.warn('Player has no seek method');
                }
            };
            eventBus.on('remote:seek', this._onRemoteSeek);

            // Volume controls - these don't need server reporting (volume is local)
            // Note: On Tizen, volume may be controlled via system API not player API
            this._onRemoteVolume = (volume) => {
                log.info('Remote: SetVolume', volume);
                if (this._player?.setVolume) {
                    this._player.setVolume(volume);
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    // Tizen system volume (0-100)
                    try {
                        tizen.tvaudiocontrol.setVolume(Math.round(volume));
                        log.info('Set Tizen system volume to', volume);
                    } catch (e) {
                        log.warn('Tizen volume control failed:', e);
                    }
                } else {
                    log.warn('No volume control available');
                }
            };
            eventBus.on('remote:volume', this._onRemoteVolume);

            this._onRemoteVolumeUp = () => {
                log.info('Remote: VolumeUp');
                if (this._player?.getVolume && this._player?.setVolume) {
                    const vol = this._player.getVolume();
                    this._player.setVolume(Math.min(100, vol + 10));
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setVolumeUp();
                    } catch (e) {
                        log.warn('Tizen volume up failed:', e);
                    }
                }
            };
            eventBus.on('remote:volumeup', this._onRemoteVolumeUp);

            this._onRemoteVolumeDown = () => {
                log.info('Remote: VolumeDown');
                if (this._player?.getVolume && this._player?.setVolume) {
                    const vol = this._player.getVolume();
                    this._player.setVolume(Math.max(0, vol - 10));
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setVolumeDown();
                    } catch (e) {
                        log.warn('Tizen volume down failed:', e);
                    }
                }
            };
            eventBus.on('remote:volumedown', this._onRemoteVolumeDown);

            this._onRemoteMute = (muted) => {
                log.info('Remote: Mute', muted);
                if (this._player?.setMuted) {
                    this._player.setMuted(muted);
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setMute(muted);
                    } catch (e) {
                        log.warn('Tizen mute control failed:', e);
                    }
                }
                // Report mute state to server
                this._reportPlaybackProgress('timeupdate');
            };
            eventBus.on('remote:mute', this._onRemoteMute);

            this._onRemoteToggleMute = () => {
                log.info('Remote: ToggleMute');
                if (this._player?.isMuted && this._player?.setMuted) {
                    this._player.setMuted(!this._player.isMuted());
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        const isMuted = tizen.tvaudiocontrol.isMute();
                        tizen.tvaudiocontrol.setMute(!isMuted);
                    } catch (e) {
                        log.warn('Tizen toggle mute failed:', e);
                    }
                }
                // Report mute state to server
                this._reportPlaybackProgress('timeupdate');
            };
            eventBus.on('remote:togglemute', this._onRemoteToggleMute);

            // Next/Previous track handlers
            // Next/Previous track handlers
            this._onRemoteNext = async () => {
                log.info('Remote: NextTrack');
                this._playNextItem();
            };
            eventBus.on('remote:next', this._onRemoteNext);

            this._onRemotePrevious = async () => {
                log.info('Remote: PreviousTrack');
                this._playPreviousItem();
            };
            eventBus.on('remote:previous', this._onRemotePrevious);

            // Start playback
            await this._startPlayback();

            // Hide loading
            this._showLoading(false);
        } catch (error) {
            log.error('Failed to initialize:', error);
            this._showError(error.message || 'Failed to load video');
        }
    }

    /**
     * Initialize the Jellyfin Player instance.
     * Directly imports JellyfinPlayer as an ES module — no UMD bundle or
     * window global required.
     */
    async _initPlayer() {
        log.info('_initPlayer called');

        // Construct the player directly — no bridge, no window global
        this._player = new JellyfinPlayer({
            container: this.$('#player-container'),
            serverUrl: api.serverUrl,
            authToken: api.accessToken,
            useTizenPlayer: this._isTizen()
        });
        log.info('Player initialized:', !!this._player);

        // Listen for player events
        this._player.on('ready', () => this._onPlayerReady());
        this._player.on('playing', () => this._onPlaying());
        this._player.on('paused', () => this._onPaused());
        this._player.on('ended', () => this._onEnded());
        this._player.on('error', (err) => this._onPlayerError(err));
        this._player.on('timeupdate', (time) => this._onTimeUpdate(time));
        this._player.on('subtitlechange', (data) => this._onSubtitleChange(data));
        this._player.on('mediastreamschange', (data) => this._onMediaStreamsChange(data));

        // NOTE: No more window.playerInstance / window.playerExit / window.reportPauseState
        // globals. The OSD Component receives these as constructor options instead.
    }

    /**
     * Start playback of the current item
     */
    async _startPlayback() {
        const item = this._item;

        // Get saved stream preferences from MediaSource
        const mediaSource = item.MediaSources?.[0];

        // 1. Check for pre-selected tracks from DetailsPage (stored in state)
        const preSelectedAudio = state.get('player:initialAudioIndex');
        const preSelectedSubtitle = state.get('player:initialSubtitleIndex');

        // Clear state to prevent persistence to future playbacks
        state.set('player:initialAudioIndex', null);
        state.set('player:initialSubtitleIndex', null);

        // 2. Fallback to default from MediaSource
        // Handle case where index might be 0 (falsey)
        const savedAudioIndex =
            preSelectedAudio !== null && preSelectedAudio !== undefined
                ? preSelectedAudio
                : mediaSource?.DefaultAudioStreamIndex;

        const savedSubtitleIndex =
            preSelectedSubtitle !== null && preSelectedSubtitle !== undefined
                ? preSelectedSubtitle
                : mediaSource?.DefaultSubtitleStreamIndex;

        log.info('Starting playback with resolved preferences:', {
            audio: savedAudioIndex,
            subtitle: savedSubtitleIndex,
            preSelectedAudio,
            preSelectedSubtitle
        });

        // Start playback using the player's internal logic
        // This handles PlaybackInfo fetching, media source selection, and stream URL building
        await this._player.play({
            itemId: item.Id,
            userId: api.userId, // Required for playback info
            startPositionTicks: this._resumePosition,
            mediaSourceId: mediaSource?.Id,
            audioStreamIndex: savedAudioIndex,
            subtitleStreamIndex: savedSubtitleIndex
        });

        // Report playback start to server
        // Note: The player emits PLAYBACK_START event which could be used,
        // but for now we'll rely on the player's internal logic or add reporting here if needed.

        // Initialize OSD
        this._initOSD();
    }

    /**
     * Build the stream URL from media source
     */
    _buildStreamUrl(mediaSource) {
        const baseUrl = api.serverUrl;

        // If direct stream URL is available, use it
        if (mediaSource.DirectStreamUrl) {
            return `${baseUrl}${mediaSource.DirectStreamUrl}`;
        }

        // Build HLS URL for transcoding
        const params = new URLSearchParams({
            api_key: api.accessToken,
            DeviceId: api.deviceId,
            MediaSourceId: mediaSource.Id,
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            MaxStreamingBitrate: 120000000,
            TranscodingMaxAudioChannels: 2,
            SegmentContainer: 'ts',
            MinSegments: 1,
            BreakOnNonKeyFrames: true
        });

        return `${baseUrl}/Videos/${this._item.Id}/master.m3u8?${params.toString()}`;
    }

    /**
     * Initialize the OSD controller.
     * Creates a PlayerOSD Component instance and mounts it into the overlay container.
     * The OSD subscribes to EventBus key events and manages its own focus.
     */
    _initOSD() {
        // Only initialize once. If we're advancing in a queue, the OSD is already mounted.
        if (this._osd) {
            log.info('OSD already exists, skipping re-init');
            return;
        }

        const osdContainer = this.$('#osd-overlay');
        if (!osdContainer) {
            log.error('OSD container #osd-overlay not found');
            return;
        }

        // Create OSD component with all dependencies injected (no globals!)
        this._osd = new PlayerOSD({
            container: osdContainer,
            player: this._player,
            item: this._item,
            api: api,

            // Callback: stop playback and navigate back
            onExit: () => this._stopAndExit(),

            // Callback: report pause/unpause state to Jellyfin server
            onReportPause: (isPaused) => {
                if (isPaused) {
                    this._reportPlaybackProgress('pause');
                } else {
                    this._reportPlaybackProgress('unpause');
                }
            },

            // Queue navigation callbacks
            onNext: () => this._playNextItem(),
            onPrevious: () => this._playPreviousItem()
        });

        // Mount OSD — this triggers render + event binding
        this._osd.mount(osdContainer);

        // Register as child component for automatic cleanup on page destroy
        this.addChild(this._osd);

        log.info('OSD initialized');
    }

    /**
     * Check if running on Tizen platform
     */
    _isTizen() {
        return typeof window.tizen !== 'undefined' || typeof window.webapis?.avplay !== 'undefined';
    }

    // ========================================================================
    // Player Event Handlers
    // ========================================================================

    _onPlayerReady() {
        log.info('Player ready');
        this._showLoading(false);

        // Reset the loading backdrop styles if we modified them
        if (this._loadingBackdrop) {
            // this._loadingBackdrop is a reference to the .page-loading element
            this._loadingBackdrop.style.backgroundImage = '';
            this._loadingBackdrop.style.backgroundSize = '';
            this._loadingBackdrop.style.backgroundPosition = '';
            this._loadingBackdrop.style.backgroundColor = ''; // Reverts to CSS default

            this._loadingBackdrop = null;

            // Clear from state
            state.set('player:backdropUrl', null);
        }
    }

    _onPlaying() {
        log.info('Playing');
        eventBus.emit('player:playing', { item: this._item });

        // Sync OSD track state (especially important for queue switches)
        if (this._osd) {
            this._osd.syncTracks();
        }

        // Report progress (Start/Unpause)
        // If we haven't reported start yet, do it now
        if (!this._hasReportedStart) {
            this._reportPlaybackStart();
            this._hasReportedStart = true;
        } else {
            // Send 'unpause' event when resuming from pause
            this._reportPlaybackProgress('unpause');
        }
    }

    _onPaused() {
        log.info('Paused');
        eventBus.emit('player:paused', { item: this._item });

        // Report paused state with explicit 'pause' event
        this._reportPlaybackProgress('pause');
    }

    _onEnded() {
        log.info('Ended event received');

        // If we're already exiting (e.g., user pressed back which called stop()),
        // don't call router.back() again - _stopAndExit already handles navigation
        if (this._isExiting) {
            log.info('Already exiting, skipping duplicate navigation');
            eventBus.emit('player:ended', { item: this._item });
            return;
        }

        // Check if we can play next item
        if (playQueue.hasNext()) {
            log.info('Item ended, auto-advancing to next item');
            this._playNextItem();
            eventBus.emit('player:ended', { item: this._item });
            return;
        }

        // Natural end of playback - report and navigate back
        this._isExiting = true;
        this._reportPlaybackStopped().then(() => {
            router.back();
        });

        eventBus.emit('player:ended', { item: this._item });
    }

    /**
     * Play next item in queue if available
     */
    async _playNextItem() {
        if (this._isSwitching || !playQueue.hasNext()) {
            return;
        }

        this._isSwitching = true;
        this._showLoading(true);

        try {
            const nextItem = playQueue.advance();
            log.info('Advancing to next item:', nextItem.Name);

            // Capture current info before stopping
            const mediaSource = this._player?.getCurrentMediaSource?.();
            const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

            // Stop current playback cleanly
            if (this._player?.stop) {
                await this._player.stop();
            }

            // Report stopped (async)
            await this._reportPlaybackStopped(mediaSource, positionTicks, false);

            // Give Tizen/Player a moment to settle
            await new Promise((resolve) => setTimeout(resolve, 500));

            // In-place switch
            this._item = nextItem;
            this._resumePosition = 0;
            this._cachedMediaSource = null;
            this._hasReportedStart = false;
            this._lastReportTime = 0;

            // Update OSD title
            if (this._osd) {
                this._osd.updateItem(nextItem);
            }

            // Restart playback
            await this._startPlayback();

            // Hide loading (ready event might not fire on subsequent plays)
            this._showLoading(false);
        } catch (error) {
            log.error('Failed to play next item:', error);
            this._showError('Failed to load next item');
        } finally {
            this._isSwitching = false;
        }
    }

    /**
     * Play previous item in queue if available
     */
    async _playPreviousItem() {
        if (this._isSwitching) return;

        if (playQueue.hasPrevious()) {
            this._isSwitching = true;
            this._showLoading(true);

            try {
                const prevItem = playQueue.goBack();
                log.info('Going back to previous item:', prevItem.Name);

                // Capture current info before stopping
                const mediaSource = this._player?.getCurrentMediaSource?.();
                const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

                // Stop current playback cleanly
                if (this._player?.stop) {
                    await this._player.stop();
                }

                await this._reportPlaybackStopped(mediaSource, positionTicks, false);

                await new Promise((resolve) => setTimeout(resolve, 500));

                this._item = prevItem;
                this._resumePosition = 0;
                this._cachedMediaSource = null;
                this._hasReportedStart = false;
                this._lastReportTime = 0;

                if (this._osd) {
                    this._osd.updateItem(prevItem);
                }

                await this._startPlayback();

                // Hide loading
                this._showLoading(false);
            } catch (error) {
                log.error('Failed to play previous item:', error);
                this._showError('Failed to load previous item');
            } finally {
                this._isSwitching = false;
            }
        } else {
            log.info('No previous item in queue. Restarting current.');
            this._player.seek(0);
        }
    }

    _onPlayerError(error) {
        if (this._isSwitching) {
            log.warn('Ignoring player error during item switch:', error);
            return;
        }

        log.error('Player error:', error);
        this._isSwitching = false; // Reset lock on error
        this._showError(error.message || 'Playback error');
    }

    _onTimeUpdate(positionTicks) {
        // 1. Check subtitle sync
        // Using passed positionTicks is most efficient
        if (this._subtitleEndTime && positionTicks && positionTicks >= this._subtitleEndTime) {
            this._clearSubtitle();
        }

        // 2. Report progress periodically (every 10 seconds approx)
        const now = Date.now();
        if (!this._lastReportTime || now - this._lastReportTime > 10000) {
            this._reportPlaybackProgress();
            this._lastReportTime = now;
        }
    }

    async _reportPlaybackStart() {
        if (!this._player || !this._item) return;

        try {
            const mediaSource = this._player.getCurrentMediaSource();
            const playerState = this._getPlayerState();

            // Cache mediaSource for later use in stop reporting
            // (player clears internal state after stop, so we need this)
            this._cachedMediaSource = mediaSource;

            const info = {
                ItemId: this._item.Id,
                PlaySessionId: mediaSource?.PlaySessionId || mediaSource?.LiveStreamId,
                MediaSourceId: mediaSource?.Id,
                ...playerState
            };

            await api.reportPlaybackStart(info);
        } catch (error) {
            log.warn('Failed to report playback start:', error);
        }
    }

    _onSubtitleChange(data) {
        const overlay = document.getElementById('subtitle-overlay');
        if (!overlay) return;

        // timeout logic replaced by _onTimeUpdate check

        if (data && data.text && data.text.trim().length > 0) {
            // Render subtitle
            overlay.innerHTML = `<span class="subtitle-line">${data.text}</span>`;
            overlay.classList.remove('hidden');

            // Apply user styles
            const styles = SubtitleStyles.getTextStyles();
            // Apply to the span
            const span = overlay.querySelector('.subtitle-line');
            if (span) {
                SubtitleStyles.applyStyles(span, styles);

                // Ensure the selected font is loaded, then re-apply if needed
                const fontId = SubtitleStyles.getCurrentFontId();
                if (fontId) {
                    FontLoader.loadFont(fontId).then(() => {
                        // Re-apply styles after font is loaded to trigger repaint
                        SubtitleStyles.applyStyles(span, styles);
                    });
                }
            }

            // Apply container styles (position)
            const windowStyles = SubtitleStyles.getWindowStyles();
            SubtitleStyles.applyStyles(overlay, windowStyles);

            // Set end time for sync clearing (Duration is in ms, Ticks are 10000 per ms)
            if (data.duration > 0) {
                // Get current position safely
                const currentTicks = this._player?.getCurrentPositionTicks?.() || 0;
                this._subtitleEndTime = currentTicks + data.duration * 10000;
            } else {
                this._subtitleEndTime = null;
            }
        } else {
            // Clear subtitle
            this._clearSubtitle();
        }
    }

    _clearSubtitle() {
        const overlay = document.getElementById('subtitle-overlay');
        if (overlay) {
            overlay.innerHTML = '';
            overlay.classList.add('hidden');
        }
        this._subtitleEndTime = null;
    }

    _onMediaStreamsChange(data) {
        if (!this._item || !this._player) return;

        log.info('Media streams changed, reporting progress to persist selection');
        this._reportPlaybackProgress('timeupdate');
    }

    /**
     * Report playback progress to server
     * @param {string} eventName - Event type: 'timeupdate', 'pause', 'unpause'
     */
    async _reportPlaybackProgress(eventName = 'timeupdate') {
        if (!this._player || !this._item) return;

        try {
            const mediaSource = this._player.getCurrentMediaSource();
            const playerState = this._getPlayerState();
            const isPaused = eventName === 'pause';

            const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

            if (!playSessionId) {
                log.warn('Skipping progress report - no PlaySessionId');
                return;
            }

            const info = {
                ItemId: this._item.Id,
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                ...playerState,
                IsPaused: isPaused,
                EventName: eventName
            };

            // Debug: Log progress reports for pause/unpause events
            if (eventName !== 'timeupdate') {
                log.info(`Reporting ${eventName}, IsPaused:`, isPaused);
            }

            await api.reportPlaybackProgress(info);
        } catch (error) {
            log.warn('Failed to report progress:', error);
        }
    }

    /**
     * Get comprehensive player state for reporting
     * Aligned with jellyfin-web's PlayState structure
     * @returns {Object} Player state object
     */
    _getPlayerState() {
        const mediaSource = this._player?.getCurrentMediaSource?.();
        const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

        // Build base state
        const state = {
            // Core position and volume
            PositionTicks: positionTicks,
            VolumeLevel: this._player?.getVolume?.() ?? 100,
            IsMuted: this._player?.isMuted?.() ?? false,

            // Playback method (DirectPlay, DirectStream, Transcode)
            PlayMethod: mediaSource?.PlayMethod || 'DirectPlay',

            // Seeking capability
            CanSeek: (mediaSource?.RunTimeTicks || 0) > 0,

            // Playback rate (1.0 = normal speed)
            PlaybackRate: this._player?.getPlaybackRate?.() ?? 1.0,

            // Queue modes (litefin doesn't support playlists yet)
            RepeatMode: 'RepeatNone',
            ShuffleMode: 'Sorted'
        };

        // Only include stream indices if they are defined (undefined causes 400 errors)
        const audioIndex = this._player?.getCurrentAudioStreamIndex?.();
        if (audioIndex !== undefined && audioIndex !== null) {
            state.AudioStreamIndex = audioIndex;
        }

        const subtitleIndex = this._player?.getCurrentSubtitleStreamIndex?.();
        if (subtitleIndex !== undefined && subtitleIndex !== null) {
            state.SubtitleStreamIndex = subtitleIndex;
        }

        return state;
    }

    // ========================================================================
    // UI Helpers
    // ========================================================================

    _showLoading(show) {
        this.setLoading(show);
    }

    _showError(message) {
        this._showLoading(false);

        // Ensure focus manager is resumed so we can interact with error buttons
        focusManager.resume();

        // Hide OSD if it's visible
        if (this._osd) {
            this._osd.hide?.();
        }

        const errorEl = this.$('#player-error');
        const messageEl = errorEl?.querySelector('.error-message');

        if (errorEl) {
            errorEl.classList.remove('hidden');
            if (messageEl) {
                messageEl.textContent = message;
            }

            // Bind buttons
            const retryBtn = this.$('#error-retry-btn');
            const backBtn = this.$('#error-back-btn');

            if (retryBtn) {
                retryBtn.onclick = () => this._retryPlayback();
            }

            if (backBtn) {
                backBtn.onclick = () => router.back();
            }

            // Register Focus Section
            focusManager.register('player-error', errorEl.querySelector('.error-actions'), {
                orientation: 'horizontal',
                enterTo: 'last-focused'
            });

            // Focus retry button by default
            focusManager.setActiveSection('player-error');
            focusManager.focusElement(retryBtn || backBtn);
        }
    }

    /**
     * Attempt to restart playback after an error
     */
    async _retryPlayback() {
        // Hide error and unregister focus
        const errorEl = this.$('#player-error');
        if (errorEl) {
            errorEl.classList.add('hidden');
            focusManager.unregister('player-error');
        }

        try {
            this._showLoading(true);

            // Re-initialize if player instance was lost or in bad state
            if (!this._player || this._player.isDestroyed) {
                await this._initPlayer();
            }

            // Restart playback
            await this._startPlayback();

            this._showLoading(false);
        } catch (error) {
            log.error('Retry failed:', error);
            this._showError(error.message || 'Retry failed. Check your connection.');
        }
    }

    /**
     * Report playback stopped to server
     * @param {Object} [capturedMediaSource] - Pre-captured media source
     * @param {number} [capturedPosition] - Pre-captured position ticks
     * @param {boolean} [isSync=true] - Whether to use synchronous XHR
     */
    async _reportPlaybackStopped(capturedMediaSource = null, capturedPosition = null, isSync = true) {
        if (!this._item) return;

        try {
            // 1. Capture data
            const mediaSource =
                capturedMediaSource ?? this._player?.getCurrentMediaSource?.() ?? this._cachedMediaSource;

            // Ensure position is a rounded integer
            const rawPosition = capturedPosition ?? this._player?.getCurrentPositionTicks?.() ?? 0;
            const positionTicks = Math.round(rawPosition);

            const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

            if (!playSessionId) {
                log.warn('Skipping stopped report - no PlaySessionId');
                return;
            }

            // 2. Build report body - stick to core fields to avoid 400 errors
            const data = {
                ItemId: this._item.Id,
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                PositionTicks: positionTicks
            };

            // 3. Send report
            if (isSync) {
                log.info('Reporting playback stopped (sync), position:', positionTicks);
                const url = `${api.serverUrl}/Sessions/Playing/Stopped`;
                const authHeader = api.getAuthHeader();

                try {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', url, false);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.setRequestHeader('X-Emby-Authorization', authHeader);
                    xhr.send(JSON.stringify(data));

                    if (xhr.status >= 400) {
                        log.warn(`Sync stop report failed with status ${xhr.status}`);
                    }
                } catch (xhrErr) {
                    log.warn('Sync XHR failed, falling back to async');
                    await api.reportPlaybackStopped(data);
                }
            } else {
                log.info('Reporting playback stopped (async), position:', positionTicks);
                await api.reportPlaybackStopped(data);
            }
        } catch (error) {
            log.warn('Failed to report playback stopped:', error);
        }
    }

    /**
     * Handle app exit/hide - report playback stopped immediately
     * Called when app is about to close or go to background
     */
    _handleAppExit() {
        log.info('App exit detected, reporting playback stopped');

        // Capture info before it's too late
        const mediaSource = this._player?.getCurrentMediaSource?.();
        const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;
        const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

        if (!playSessionId) {
            log.warn('Skipping exit report - no PlaySessionId');
            return;
        }

        // Use synchronous-ish reporting (fire and forget, no await)
        // App may close before async completes
        if (this._item) {
            api.reportPlaybackStopped({
                ItemId: this._item.Id,
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                PositionTicks: positionTicks
            }).catch((err) => {
                log.warn('Failed to report on exit:', err);
            });
        }
    }

    // ========================================================================
    // Navigation
    // ========================================================================

    onBack() {
        log.info('onBack() called');

        // Delegate to OSD — it handles menu close → OSD hide → exit chain
        if (this._osd?.handleBack?.()) {
            log.info('OSD handled back event');
            return true;
        }

        log.info('OSD did not handle back, calling _stopAndExit()');
        // OSD is hidden and no menu is open — stop playback and go back
        this._stopAndExit();
        return true;
    }

    async _stopAndExit() {
        // Prevent multiple calls
        if (this._isExiting) {
            return;
        }
        this._isExiting = true;

        try {
            // Capture session info BEFORE stopping (stop clears internal state)
            const mediaSource = this._player?.getCurrentMediaSource?.();
            const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

            // Stop the player
            if (this._player?.stop) {
                await this._player.stop();
            }

            // Report stopped with captured values
            await this._reportPlaybackStopped(mediaSource, positionTicks);
        } catch (error) {
            log.warn('Error during stop:', error);
        }

        // Navigate back
        router.back();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy() {
        log.info('destroy() called');

        // Destroy player (this also calls stop internally)
        if (this._player?.destroy) {
            log.info('Destroying player instance');
            this._player.destroy();
        }
        this._player = null;

        // Clear subtitle timeout
        if (this._subtitleTimeout) {
            clearTimeout(this._subtitleTimeout);
            this._subtitleTimeout = null;
        }

        // Remove app exit listener
        if (this._onAppBeforeExit) {
            eventBus.off('app:beforeExit', this._onAppBeforeExit);
            this._onAppBeforeExit = null;
        }

        // Remove remote control event listeners
        if (this._onRemotePause) eventBus.off('remote:pause', this._onRemotePause);
        if (this._onRemotePlay) eventBus.off('remote:play', this._onRemotePlay);
        if (this._onRemotePlayPause) eventBus.off('remote:playpause', this._onRemotePlayPause);
        if (this._onRemoteStop) eventBus.off('remote:stop', this._onRemoteStop);
        if (this._onRemoteSeek) eventBus.off('remote:seek', this._onRemoteSeek);
        if (this._onRemoteVolume) eventBus.off('remote:volume', this._onRemoteVolume);
        if (this._onRemoteVolumeUp) eventBus.off('remote:volumeup', this._onRemoteVolumeUp);
        if (this._onRemoteVolumeDown) eventBus.off('remote:volumedown', this._onRemoteVolumeDown);
        if (this._onRemoteMute) eventBus.off('remote:mute', this._onRemoteMute);
        if (this._onRemoteToggleMute) eventBus.off('remote:togglemute', this._onRemoteToggleMute);
        if (this._onRemoteNext) eventBus.off('remote:next', this._onRemoteNext);
        if (this._onRemotePrevious) eventBus.off('remote:previous', this._onRemotePrevious);

        // Clean up focus sections
        focusManager.unregister('player-error');

        // Clean up OSD (also handled by Component._children cleanup, but explicit is better)
        if (this._osd?.destroy) {
            log.info('Destroying OSD');
            this._osd.destroy();
        }

        // Disable Tizen AVPlayer transparency mode
        document.body.classList.remove('player-active');
        document.documentElement.classList.remove('player-active');

        log.info('destroy() complete');
        super.destroy();
    }
}

export default PlayerPage;
