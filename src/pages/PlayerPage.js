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
import { focusManager } from '../ui/FocusManager.js';

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
        // Get the container element
        const container = this.$('#player-container');

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

        // Start playback using the player's internal logic
        // This handles PlaybackInfo fetching, media source selection, and stream URL building
        await this._player.play({
            itemId: item.Id,
            userId: api.userId, // Required for playback info
            startPositionTicks: this._resumePosition,
            mediaSourceId: item.MediaSources?.[0]?.Id,
            audioStreamIndex: undefined, // Let player select default
            subtitleStreamIndex: undefined // Let player select default
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
     * Initialize the OSD controller
     */
    _initOSD() {
        // OSD is loaded as a global script (jellyfin-player-osd.js)
        if (typeof window.PlayerOSD !== 'undefined') {
            this._osd = window.PlayerOSD;
            this._osd.init({
                container: this.$('#osd-overlay'),
                player: this._player,
                item: this._item
            });

            // Pass title manually since OSD looks for it in URL
            const titleEl = document.getElementById('osdTitle');
            if (titleEl && this._item.Name) {
                titleEl.textContent = this._item.Name;
            }
        } else {
            console.warn('[PlayerPage] PlayerOSD global object NOT found');
        }
    }

    /**
     * Check if running on Tizen platform
     */
    _isTizen() {
        return typeof window.tizen !== 'undefined' ||
            typeof window.webapis?.avplay !== 'undefined';
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
        if (!this._lastReportTime || (now - this._lastReportTime > 10000)) {
            this._reportPlaybackProgress();
            this._lastReportTime = now;
        }
    }

    async _reportPlaybackStart() {
        if (!this._player || !this._item) return;

        try {
            const mediaSource = this._player.getCurrentMediaSource();
            const playerState = this._getPlayerState();

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

        return {
            // Core position and volume
            PositionTicks: positionTicks,
            VolumeLevel: this._player?.getVolume?.() ?? 100,
            IsMuted: this._player?.isMuted?.() ?? false,

            // Stream indices
            AudioStreamIndex: this._player?.getCurrentAudioStreamIndex?.(),
            SubtitleStreamIndex: this._player?.getCurrentSubtitleStreamIndex?.(),

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
            // Use captured values or read from player (if still available)
            const mediaSource = capturedMediaSource ?? this._player?.getCurrentMediaSource?.();
            const positionTicks = capturedPosition ?? this._player?.getCurrentPositionTicks?.() ?? 0;

            const playSessionId = mediaSource?.PlaySessionId || mediaSource?.LiveStreamId;

            if (!playSessionId) {
                console.warn('[PlayerPage] Skipping stopped report - no PlaySessionId');
                return;
            }

            console.log('[PlayerPage] Reporting playback stopped, position:', positionTicks);

            await api.reportPlaybackStopped({
                ItemId: this._item.Id,
                // Critical: Include session identifiers for proper server cleanup
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                PositionTicks: positionTicks
            });

            console.log('[PlayerPage] ✓ Playback stopped reported');
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
            }).catch(err => {
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

        // Remove app exit listener
        if (this._onAppBeforeExit) {
            eventBus.off('app:beforeExit', this._onAppBeforeExit);
            this._onAppBeforeExit = null;
        }

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
