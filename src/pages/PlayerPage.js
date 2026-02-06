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
    }

    render() {
        return `
            <div class="page player-page">
                <!-- Video Container -->
                <div id="player-container" class="player-container">
                    <!-- Video element will be injected by JellyfinPlayer -->
                </div>

                <!-- Loading Overlay -->
                <div class="player-loading" id="player-loading">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">Loading...</div>
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

            // Load item details
            this._item = await api.getItem(itemId);
            this.title = this._item.Name;

            // Calculate resume position if needed
            if (resume && this._item.UserData?.PlaybackPositionTicks) {
                this._resumePosition = this._item.UserData.PlaybackPositionTicks;
            }

            // Initialize the player
            await this._initPlayer();

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

        // Check if JellyfinPlayer is available (loaded from jellyfin-player.min.js)
        // Handle UMD bundle potentially having .default
        const playerLib = window.JellyfinPlayer?.default || window.JellyfinPlayer;

        if (!playerLib || typeof playerLib.init !== 'function') {
            throw new Error('JellyfinPlayer library not loaded correctly');
        }

        this._player = playerLib.init({
            container: this.$('#player-container'),
            serverUrl: api.serverUrl,
            authToken: api.accessToken,
            useTizenPlayer: this._isTizen()
        });

        // Listen for player events
        this._player.on('ready', () => this._onPlayerReady());
        this._player.on('playing', () => this._onPlaying());
        this._player.on('paused', () => this._onPaused());
        this._player.on('ended', () => this._onEnded());
        this._player.on('error', (err) => this._onPlayerError(err));
        this._player.on('timeupdate', (time) => this._onTimeUpdate(time));

        // Expose player instance globally for OSD
        window.playerInstance = this._player;
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
    }

    _onPaused() {
        console.log('[PlayerPage] Paused');
        eventBus.emit('player:paused', { item: this._item });
    }

    _onEnded() {
        console.log('[PlayerPage] Ended');

        // Report playback stopped
        this._reportPlaybackStopped().then(() => {
            // Navigate back
            router.back();
        });

        eventBus.emit('player:ended', { item: this._item });
    }

    _onPlayerError(error) {
        console.error('[PlayerPage] Player error:', error);
        this._showError(error.message || 'Playback error');
    }

    _onTimeUpdate(positionTicks) {
        // Report progress periodically (handled by player internally)
    }

    // ========================================================================
    // UI Helpers
    // ========================================================================

    _showLoading(show) {
        const loadingEl = this.$('#player-loading');
        if (loadingEl) {
            loadingEl.classList.toggle('hidden', !show);
        }
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

    async _reportPlaybackStopped() {
        if (!this._player) return;

        try {
            const currentPosition = this._player.getCurrentPositionTicks?.() || 0;

            await api.reportPlaybackStopped({
                ItemId: this._item.Id,
                PositionTicks: currentPosition
            });
        } catch (error) {
            console.warn('[PlayerPage] Failed to report playback stopped:', error);
        }
    }

    // ========================================================================
    // Navigation
    // ========================================================================

    onBack() {
        // If OSD is showing a menu, close it first
        if (this._osd?.isMenuOpen?.()) {
            this._osd.closeMenu();
            return true;
        }

        // Stop playback and go back
        this._stopAndExit();
        return true;
    }

    async _stopAndExit() {
        try {
            // Stop the player
            if (this._player?.stop) {
                await this._player.stop();
            }

            // Report stopped
            await this._reportPlaybackStopped();
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
        // Stop playback
        if (this._player?.stop) {
            this._player.stop();
        }

        // Clean up focus sections
        focusManager.unregister('player-error');

        // Clean up OSD
        if (this._osd?.destroy) {
            this._osd.destroy();
        }

        // Remove global reference
        window.playerInstance = null;

        super.destroy();
    }
}

export default PlayerPage;
