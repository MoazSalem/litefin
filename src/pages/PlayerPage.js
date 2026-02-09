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
import { focusManager } from '../ui/FocusManager.js';
import SubtitleStyles from '../utils/SubtitleStyles.js';

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

            // Enable Tizen AVPlayer transparency mode
            // This makes body/app transparent so hardware video plane is visible
            document.body.classList.add('player-active');
            document.documentElement.classList.add('player-active');

            // Load item details
            this._item = await api.getItem(itemId);
            this.title = this._item.Name;

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
                console.log('[PlayerPage] Remote: Pause');
                if (this._player?.pause) {
                    this._player.pause();
                    // Report pause state to server
                    this._reportPlaybackProgress('pause');
                }
            };
            eventBus.on('remote:pause', this._onRemotePause);

            this._onRemotePlay = () => {
                console.log('[PlayerPage] Remote: Play/Resume');
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
                console.log('[PlayerPage] Remote: PlayPause');
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
                console.log('[PlayerPage] Remote: Stop');
                // _stopAndExit already handles reporting stopped to server
                this._stopAndExit();
            };
            eventBus.on('remote:stop', this._onRemoteStop);

            this._onRemoteSeek = (positionTicks) => {
                console.log('[PlayerPage] Remote: Seek to', positionTicks);
                // Player uses seek() not seekTo() - same as OSD
                if (this._player?.seek) {
                    this._player.seek(positionTicks);
                    // Report new position to server after a brief delay for seek to complete
                    setTimeout(() => this._reportPlaybackProgress('timeupdate'), 200);
                } else {
                    console.warn('[PlayerPage] Player has no seek method');
                }
            };
            eventBus.on('remote:seek', this._onRemoteSeek);

            // Volume controls - these don't need server reporting (volume is local)
            // Note: On Tizen, volume may be controlled via system API not player API
            this._onRemoteVolume = (volume) => {
                console.log('[PlayerPage] Remote: SetVolume', volume);
                if (this._player?.setVolume) {
                    this._player.setVolume(volume);
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    // Tizen system volume (0-100)
                    try {
                        tizen.tvaudiocontrol.setVolume(Math.round(volume));
                        console.log('[PlayerPage] Set Tizen system volume to', volume);
                    } catch (e) {
                        console.warn('[PlayerPage] Tizen volume control failed:', e);
                    }
                } else {
                    console.warn('[PlayerPage] No volume control available');
                }
            };
            eventBus.on('remote:volume', this._onRemoteVolume);

            this._onRemoteVolumeUp = () => {
                console.log('[PlayerPage] Remote: VolumeUp');
                if (this._player?.getVolume && this._player?.setVolume) {
                    const vol = this._player.getVolume();
                    this._player.setVolume(Math.min(100, vol + 10));
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setVolumeUp();
                    } catch (e) {
                        console.warn('[PlayerPage] Tizen volume up failed:', e);
                    }
                }
            };
            eventBus.on('remote:volumeup', this._onRemoteVolumeUp);

            this._onRemoteVolumeDown = () => {
                console.log('[PlayerPage] Remote: VolumeDown');
                if (this._player?.getVolume && this._player?.setVolume) {
                    const vol = this._player.getVolume();
                    this._player.setVolume(Math.max(0, vol - 10));
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setVolumeDown();
                    } catch (e) {
                        console.warn('[PlayerPage] Tizen volume down failed:', e);
                    }
                }
            };
            eventBus.on('remote:volumedown', this._onRemoteVolumeDown);

            this._onRemoteMute = (muted) => {
                console.log('[PlayerPage] Remote: Mute', muted);
                if (this._player?.setMuted) {
                    this._player.setMuted(muted);
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        tizen.tvaudiocontrol.setMute(muted);
                    } catch (e) {
                        console.warn('[PlayerPage] Tizen mute control failed:', e);
                    }
                }
                // Report mute state to server
                this._reportPlaybackProgress('timeupdate');
            };
            eventBus.on('remote:mute', this._onRemoteMute);

            this._onRemoteToggleMute = () => {
                console.log('[PlayerPage] Remote: ToggleMute');
                if (this._player?.isMuted && this._player?.setMuted) {
                    this._player.setMuted(!this._player.isMuted());
                } else if (typeof tizen !== 'undefined' && tizen.tvaudiocontrol) {
                    try {
                        const isMuted = tizen.tvaudiocontrol.isMute();
                        tizen.tvaudiocontrol.setMute(!isMuted);
                    } catch (e) {
                        console.warn('[PlayerPage] Tizen toggle mute failed:', e);
                    }
                }
                // Report mute state to server
                this._reportPlaybackProgress('timeupdate');
            };
            eventBus.on('remote:togglemute', this._onRemoteToggleMute);

            // Next/Previous track handlers
            // Note: Litefin doesn't support playlists yet, so these navigate series episodes
            this._onRemoteNext = async () => {
                console.log('[PlayerPage] Remote: NextTrack');
                // TODO: If this is a series, could navigate to next episode
                // For now, log that this feature isn't supported
                console.warn('[PlayerPage] Next track not supported - no playlist support yet');
            };
            eventBus.on('remote:next', this._onRemoteNext);

            this._onRemotePrevious = async () => {
                console.log('[PlayerPage] Remote: PreviousTrack');
                // TODO: If this is a series, could navigate to previous episode
                // For now, log that this feature isn't supported
                console.warn('[PlayerPage] Previous track not supported - no playlist support yet');
            };
            eventBus.on('remote:previous', this._onRemotePrevious);

            // Start playback
            await this._startPlayback();

            // Hide loading
            this._showLoading(false);
        } catch (error) {
            console.error('[PlayerPage] Failed to initialize:', error);
            this._showError(error.message || 'Failed to load video');
        }
    }

    /**
     * Initialize the Jellyfin Player instance
     */
    async _initPlayer() {
        // Debug: Log the state of window.JellyfinPlayer
        console.log('[PlayerPage] _initPlayer called');
        console.log('[PlayerPage] window.JellyfinPlayer exists:', !!window.JellyfinPlayer);
        console.log('[PlayerPage] window.JellyfinPlayer.default exists:', !!window.JellyfinPlayer?.default);
        console.log('[PlayerPage] window.JellyfinPlayer type:', typeof window.JellyfinPlayer);
        if (window.JellyfinPlayer) {
            console.log('[PlayerPage] window.JellyfinPlayer.init exists:', typeof window.JellyfinPlayer.init);
            console.log('[PlayerPage] window.JellyfinPlayer keys:', Object.keys(window.JellyfinPlayer).join(', '));
        }

        // Check if JellyfinPlayer is available (loaded from jellyfin-player.min.js)
        // Handle UMD bundle potentially having .default
        const playerLib = window.JellyfinPlayer?.default || window.JellyfinPlayer;

        if (!playerLib || typeof playerLib.init !== 'function') {
            console.error('[PlayerPage] playerLib validation failed:', {
                playerLib: !!playerLib,
                initType: typeof playerLib?.init
            });
            throw new Error('JellyfinPlayer library not loaded correctly');
        }

        console.log('[PlayerPage] Calling playerLib.init...');
        this._player = playerLib.init({
            container: this.$('#player-container'),
            serverUrl: api.serverUrl,
            authToken: api.accessToken,
            useTizenPlayer: this._isTizen()
        });
        console.log('[PlayerPage] Player initialized:', !!this._player);

        // Listen for player events
        this._player.on('ready', () => this._onPlayerReady());
        this._player.on('playing', () => this._onPlaying());
        this._player.on('paused', () => this._onPaused());
        this._player.on('ended', () => this._onEnded());
        this._player.on('error', (err) => this._onPlayerError(err));
        this._player.on('timeupdate', (time) => this._onTimeUpdate(time));
        this._player.on('subtitlechange', (data) => this._onSubtitleChange(data));
        this._player.on('mediastreamschange', (data) => this._onMediaStreamsChange(data));

        // Expose player instance globally for OSD
        window.playerInstance = this._player;

        // Expose functions for OSD to call proper reporting
        // These bridge the gap between the standalone OSD and PlayerPage's server reporting
        window.playerExit = () => this._stopAndExit();
        window.reportPauseState = (isPaused) => {
            if (isPaused) {
                this._reportPlaybackProgress('pause');
            } else {
                this._reportPlaybackProgress('unpause');
            }
        };
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

        console.log('[PlayerPage] Starting playback with resolved preferences:', {
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
        await this._initOSD();
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
     * Initialize the OSD controller
     */
    async _initOSD() {
        // Dynamically import the OSD script if it hasn't been loaded yet
        // This keeps the OSD code out of the main bundle until needed
        if (typeof window.PlayerOSD === 'undefined') {
            try {
                await import('../player/jellyfin-player-osd.js');
                console.log('[PlayerPage] PlayerOSD dynamically loaded');
            } catch (err) {
                console.error('[PlayerPage] Failed to load PlayerOSD script:', err);
                return;
            }
        }

        if (typeof window.PlayerOSD !== 'undefined') {
            this._osd = window.PlayerOSD;
            this._osd.init({
                container: this.$('#osd-overlay'),
                player: this._player,
                item: this._item,
                api: api
            });

            // Pass title manually since OSD looks for it in URL
            const titleEl = document.getElementById('osdTitle');
            if (titleEl && this._item.Name) {
                titleEl.textContent = this._item.Name;
            }
        } else {
            console.warn('[PlayerPage] PlayerOSD global object NOT found after import attempt');
        }
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
        console.log('[PlayerPage] Player ready');
        this._showLoading(false);
    }

    _onPlaying() {
        console.log('[PlayerPage] Playing');
        eventBus.emit('player:playing', { item: this._item });

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
        console.log('[PlayerPage] Paused');
        eventBus.emit('player:paused', { item: this._item });

        // Report paused state with explicit 'pause' event
        this._reportPlaybackProgress('pause');
    }

    _onEnded() {
        console.log('[PlayerPage] Ended event received');

        // If we're already exiting (e.g., user pressed back which called stop()),
        // don't call router.back() again - _stopAndExit already handles navigation
        if (this._isExiting) {
            console.log('[PlayerPage] Already exiting, skipping duplicate navigation');
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

    _onPlayerError(error) {
        console.error('[PlayerPage] Player error:', error);
        this._showError(error.message || 'Playback error');
    }

    _onTimeUpdate(positionTicks) {
        // Report progress periodically (every 10 seconds approx)
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
            console.warn('[PlayerPage] Failed to report playback start:', error);
        }
    }

    _onSubtitleChange(data) {
        const overlay = document.getElementById('subtitle-overlay');
        if (!overlay) return;

        // Clear existing timeout
        if (this._subtitleTimeout) {
            clearTimeout(this._subtitleTimeout);
            this._subtitleTimeout = null;
        }

        if (data && data.text) {
            // Render subtitle
            overlay.innerHTML = `<span class="subtitle-line">${data.text}</span>`;
            overlay.classList.remove('hidden');

            // Apply user styles
            const styles = SubtitleStyles.getTextStyles();
            // Apply to the span
            const span = overlay.querySelector('.subtitle-line');
            if (span) {
                SubtitleStyles.applyStyles(span, styles);
            }

            // Apply container styles (position)
            const windowStyles = SubtitleStyles.getWindowStyles();
            SubtitleStyles.applyStyles(overlay, windowStyles);

            // Clear after duration
            if (data.duration > 0) {
                this._subtitleTimeout = setTimeout(() => {
                    overlay.innerHTML = '';
                    overlay.classList.add('hidden');
                }, data.duration);
            }
        } else {
            // Clear subtitle
            overlay.innerHTML = '';
            overlay.classList.add('hidden');
        }
    }

    _onMediaStreamsChange(data) {
        if (!this._item || !this._player) return;

        console.log('[PlayerPage] Media streams changed, reporting progress to persist selection');
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
                console.warn('[PlayerPage] Skipping progress report - no PlaySessionId');
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
                console.log(`[PlayerPage] Reporting ${eventName}, IsPaused:`, isPaused);
            }

            await api.reportPlaybackProgress(info);
        } catch (error) {
            console.warn('[PlayerPage] Failed to report progress:', error);
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
            console.error('[PlayerPage] Retry failed:', error);
            this._showError(error.message || 'Retry failed. Check your connection.');
        }
    }

    /**
     * Report playback stopped to server
     * @param {Object} [capturedMediaSource] - Pre-captured media source (for when called after stop)
     * @param {number} [capturedPosition] - Pre-captured position ticks
     */
    async _reportPlaybackStopped(capturedMediaSource = null, capturedPosition = null) {
        if (!this._item) return;

        try {
            // Use captured values, then player methods, then cached values as fallback
            const mediaSource =
                capturedMediaSource ?? this._player?.getCurrentMediaSource?.() ?? this._cachedMediaSource;
            const positionTicks = capturedPosition ?? this._player?.getCurrentPositionTicks?.() ?? 0;

            const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

            if (!playSessionId) {
                console.warn(
                    '[PlayerPage] Skipping stopped report - no PlaySessionId (mediaSource:',
                    !!mediaSource,
                    ')'
                );
                return;
            }

            console.log('[PlayerPage] Reporting playback stopped, position:', positionTicks);

            // ================================================================
            // TIZEN FIX: Use synchronous XHR to ensure request completes
            // before navigation. Async fetch gets cancelled during page cleanup
            // on Tizen but not on web browsers.
            // ================================================================
            const data = {
                ItemId: this._item.Id,
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                PositionTicks: positionTicks
            };

            const url = `${api.serverUrl}/Sessions/Playing/Stopped`;
            const authHeader = api.getAuthHeader();

            try {
                // Use synchronous XHR - it blocks but ensures completion
                const xhr = new XMLHttpRequest();
                xhr.open('POST', url, false); // false = synchronous
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('X-Emby-Authorization', authHeader);
                xhr.send(JSON.stringify(data));

                if (xhr.status >= 200 && xhr.status < 300) {
                    console.log('[PlayerPage] ✓ Playback stopped reported (sync)');
                } else {
                    console.warn('[PlayerPage] Stop report failed:', xhr.status, xhr.statusText);
                }
            } catch (xhrError) {
                console.warn('[PlayerPage] Sync XHR failed, falling back to async:', xhrError);
                // Fallback to async (works on web)
                await api.reportPlaybackStopped(data);
                console.log('[PlayerPage] ✓ Playback stopped reported (async fallback)');
            }
        } catch (error) {
            console.warn('[PlayerPage] Failed to report playback stopped:', error);
        }
    }

    /**
     * Handle app exit/hide - report playback stopped immediately
     * Called when app is about to close or go to background
     */
    _handleAppExit() {
        console.log('[PlayerPage] App exit detected, reporting playback stopped');

        // Capture info before it's too late
        const mediaSource = this._player?.getCurrentMediaSource?.();
        const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;
        const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

        if (!playSessionId) {
            console.warn('[PlayerPage] Skipping exit report - no PlaySessionId');
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
                console.warn('[PlayerPage] Failed to report on exit:', err);
            });
        }
    }

    // ========================================================================
    // Navigation
    // ========================================================================

    onBack() {
        console.log('[PlayerPage] onBack() called');

        // If OSD is showing a menu, close it first
        if (this._osd?.isMenuOpen?.()) {
            console.log('[PlayerPage] OSD menu is open, closing menu');
            this._osd.closeMenu();
            return true;
        }

        console.log('[PlayerPage] No menu open, calling _stopAndExit()');
        // Stop playback and go back
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
            console.warn('[PlayerPage] Error during stop:', error);
        }

        // Navigate back
        router.back();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy() {
        console.log('[PlayerPage] destroy() called');

        // Destroy player (this also calls stop internally)
        if (this._player?.destroy) {
            console.log('[PlayerPage] Destroying player instance');
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

        // Clean up OSD
        if (this._osd?.destroy) {
            console.log('[PlayerPage] Destroying OSD');
            this._osd.destroy();
        }

        // Remove global reference
        window.playerInstance = null;

        // Disable Tizen AVPlayer transparency mode
        document.body.classList.remove('player-active');
        document.documentElement.classList.remove('player-active');

        console.log('[PlayerPage] destroy() complete');
        super.destroy();
    }
}

export default PlayerPage;
