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
import OSDController from '../player/osd/OSDController.js';
import { JellyfinPlayer } from '../player/core/JellyfinPlayer.js';
import SubtitleStyles from '../utils/SubtitleStyles.js';
import FontLoader from '../utils/FontLoader.js';
import { PlayerSettings } from '../utils/PlayerSettings.js';
import { logger } from '../utils/Logger.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { platformInfo } from '../utils/PlatformInfo.js';

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

        // End-time tracker for primary subtitle cue clearing
        // (set during _onSubtitleChange, checked on _onTimeUpdate)
        this._subtitleEndTime = null;

        // End-time tracker for secondary subtitle cue clearing
        this._secondarySubtitleEndTime = null;
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

                <!-- Primary Subtitle Overlay (Bottom) -->
                <div id="subtitle-overlay" class="subtitle-overlay"></div>

                <!-- Secondary Subtitle Overlay (Top) -->
                <!-- Positioned via CSS .subtitle-overlay.secondary (top: 10%) -->
                <!-- Styles are inherited from primary, only size/position are independent -->
                <div id="secondary-subtitle-overlay" class="subtitle-overlay secondary hidden"></div>
            </div>
        `;
    }

    async onInit() {
        // Reset state for new playback session
        this._item = null;
        this._resumePosition = 0;
        this._hasReportedStart = false;

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
                    // Make the main loader background transparent so the backdrop shows through
                    loader.style.backgroundColor = 'transparent';

                    // Create a dedicated background layer to fade in independently of the spinner
                    let backdropLayer = loader.querySelector('.loading-backdrop-layer');
                    if (!backdropLayer) {
                        backdropLayer = document.createElement('div');
                        backdropLayer.className = 'loading-backdrop-layer';
                        backdropLayer.style.position = 'absolute';
                        backdropLayer.style.top = '0';
                        backdropLayer.style.left = '0';
                        backdropLayer.style.width = '100%';
                        backdropLayer.style.height = '100%';
                        backdropLayer.style.backgroundSize = 'cover';
                        backdropLayer.style.backgroundPosition = 'center';
                        backdropLayer.style.opacity = '0';
                        backdropLayer.style.transition = 'opacity 0.6s ease-in-out';
                        backdropLayer.style.zIndex = '-1';
                        loader.insertBefore(backdropLayer, loader.firstChild);
                    }

                    // Preload the image to prevent "half sliced" progressive loading artifact
                    const img = new Image();
                    img.onload = () => {
                        backdropLayer.style.backgroundImage = `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.8) 100%), url('${backdropUrl}')`;
                        requestAnimationFrame(() => {
                            backdropLayer.style.opacity = '1';
                        });
                    };
                    img.src = backdropUrl;

                    this._loadingBackdrop = backdropLayer; // Mark for cleanup
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

            // Repeat and Shuffle
            this._onRemoteRepeatMode = (mode) => {
                log.info('Remote: SetRepeatMode', mode);
                playQueue.setRepeatMode(mode);
            };
            eventBus.on('remote:repeatmode', this._onRemoteRepeatMode);

            this._onRemoteShuffleMode = (isShuffled) => {
                log.info('Remote: SetShuffleMode', isShuffled);
                playQueue.setShuffleMode(isShuffled);
            };
            eventBus.on('remote:shufflemode', this._onRemoteShuffleMode);

            // ---------------------------------------------------------------
            // Remote D-Pad navigation inside the player.
            //
            // When the player is active, FocusManager is suspended and the OSD
            // manages its own focus.  We therefore forward remote:navigate and
            // remote:select directly to OSDController.handleInput(), which is
            // the same codepath used by physical TV-remote key events.
            // ---------------------------------------------------------------
            this._onRemoteNavigate = (direction) => {
                log.info('Remote: Navigate', direction);
                if (this._osd) {
                    this._osd.handleInput(direction);
                }
            };
            eventBus.on('remote:navigate', this._onRemoteNavigate);

            this._onRemoteSelect = () => {
                log.info('Remote: Select');
                if (this._osd) {
                    this._osd.handleInput('enter');
                }
            };
            eventBus.on('remote:select', this._onRemoteSelect);

            this._onRemoteAudioTrack = (index) => {
                log.info('Remote: SetAudioStreamIndex', index);
                if (this._player && typeof this._player.setAudioStreamIndex === 'function') {
                    this._player.setAudioStreamIndex(index);
                    this._refreshSubtitleStyles(); // In case track change affects OSD state
                }
            };
            eventBus.on('remote:audiotrack', this._onRemoteAudioTrack);

            this._onRemoteSubtitle = (index) => {
                log.info('Remote: SetSubtitleStreamIndex', index);
                if (this._player && typeof this._player.setSubtitleStreamIndex === 'function') {
                    this._player.setSubtitleStreamIndex(index);
                }
            };
            eventBus.on('remote:subtitle', this._onRemoteSubtitle);

            // ---------------------------------------------------------------
            // Remote queue manipulation
            //
            // Emitted by App.js when a remote:playnow arrives while the player
            // is active.  This covers: remove item, reorder, jump-to-item —
            // all of which Jellyfin sends as a fresh Play(PlayNow) command
            // with the complete new ordered item list and a StartIndex.
            // ---------------------------------------------------------------
            this._onRemoteQueueUpdate = ({ itemIds, startIndex, startPositionTicks }) => {
                log.info('Remote queue update received:', itemIds?.length, 'items, startIndex:', startIndex);
                this._handleRemoteQueueUpdate(itemIds, startIndex || 0, startPositionTicks || 0);
            };
            eventBus.on('remote:queueupdate', this._onRemoteQueueUpdate);

            // ---------------------------------------------------------------
            // UserDataChanged — another client toggled favourite / watched state.
            // The server pushes a UserDataList array; we find the entry matching
            // the currently-playing item and patch the OSD favourite button.
            // ---------------------------------------------------------------
            this._onRemoteUserDataChanged = (userDataList) => {
                if (!this._item || !this._osd || !Array.isArray(userDataList)) return;

                // Find the entry that matches the currently-playing item
                const entry = userDataList.find((u) => u.ItemId === this._item.Id);
                if (!entry) return;

                log.info('Remote UserDataChanged for current item — IsFavorite:', entry.IsFavorite);

                // Patch the in-memory item so local toggle logic stays in sync
                if (!this._item.UserData) this._item.UserData = {};
                this._item.UserData.IsFavorite = entry.IsFavorite;

                // Reflect the new state on the OSD heart button immediately
                this._osd._updateFavoriteButton(this._item);
            };
            eventBus.on('remote:userdatachanged', this._onRemoteUserDataChanged);

            // Start playback
            await this._startPlayback();

            // Hide loading
            // effective hide happens on 'playing' event to prevent flash
            // this._showLoading(false);
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

        // Resolve backend choice
        const playerBackend = PlayerSettings.get('playerBackend') || 'auto';
        let useTizenPlayer = this._isTizen();

        if (playerBackend === 'avplay') {
            useTizenPlayer = true;
        } else if (playerBackend === 'html5') {
            useTizenPlayer = false;
        }

        log.info(`Resolved player backend: ${playerBackend} (useTizenPlayer: ${useTizenPlayer})`);

        // Construct the player directly — no bridge, no window global
        this._player = new JellyfinPlayer({
            container: this.$('#player-container'),
            serverUrl: api.serverUrl,
            authToken: api.accessToken,
            useTizenPlayer: useTizenPlayer
        });
        log.info('Player initialized:', !!this._player);

        // Listen for player events
        // Note: 'ready' is not emitted by JellyfinPlayer, so we call it manually below
        // this._player.on('play', () => this._onPlaying()); // Handled by 'playing'
        this._player.on('pause', () => this._onPaused());
        this._player.on('ended', () => this._onEnded());
        this._player.on('error', (err) => this._onPlayerError(err));
        this._player.on('timeupdate', (time) => this._onTimeUpdate(time));
        this._player.on('subtitlechange', (data) => this._onSubtitleChange(data));
        this._player.on('secondarysubtitlechange', (data) => this._onSecondarySubtitleChange(data));
        this._player.on('mediastreamschange', (data) => this._onMediaStreamsChange(data));
        this._player.on('refreshsubtitles', () => this._refreshSubtitleStyles());
        this._player.on('volumechange', () => this._reportPlaybackProgress('timeupdate'));
        this._player.on('seek', (data) => {
            if (data && data.positionTicks !== undefined) {
                this._onTimeUpdate(data.positionTicks);
            } else {
                this._reportPlaybackProgress('timeupdate');
            }
        });
        // Waiting listener removed to prevent loading screen during seek/buffer
        this._player.on('restarting', () => {
            log.info('Player restarting (quality change), showing loading');
            this._showLoading(true);
        });

        this._player.on('playing', () => {
            this._showLoading(false);
            this._onPlaying();
        });

        this._player.on('loadedmetadata', (data) => {
            log.debug('Loaded metadata', data);
            // If starting from scratch, hide loading now.
            // This is safer than the immediate _onPlayerReady as backend is prepared.
            if (!this._resumePosition) {
                this._showLoading(false);
            }
        });

        // Manually trigger ready state (removed loading logic from here)
        this._onPlayerReady();
    }

    _onPlayerReady() {
        log.info('Player ready');
        // Loading is now handled by 'loadedmetadata' event
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
        try {
            await this._player.play({
                item: item, // Pass full item which might have Chapters
                itemId: item.Id,
                userId: api.userId, // Required for playback info
                startPositionTicks: this._resumePosition,
                mediaSourceId: mediaSource?.Id,
                audioStreamIndex: savedAudioIndex,
                subtitleStreamIndex: savedSubtitleIndex
            });
        } catch (err) {
            if (err.name === 'NotAllowedError') {
                log.warn('_startPlayback: Autoplay blocked. Forcing mute and retrying.');
                this._player.setMuted(true);
                await this._player.play({
                    item: item,
                    itemId: item.Id,
                    userId: api.userId,
                    startPositionTicks: this._resumePosition,
                    mediaSourceId: mediaSource?.Id,
                    audioStreamIndex: savedAudioIndex,
                    subtitleStreamIndex: savedSubtitleIndex
                });
            } else {
                throw err;
            }
        }

        // Report playback start to server
        // Note: The player emits PLAYBACK_START event which could be used,
        // but for now we'll rely on the player's internal logic or add reporting here if needed.

        // Initialize OSD
        this._initOSD();

        // === Plugin System ===
        // Notify all loaded plugins that player + OSD are ready.
        // Doing this here rather than inside _initOSD ensures plugins
        // are restarted properly when we advance to the next track.
        pluginManager
            .notifyPlayerStart(this._item, this._player, this._osd)
            .catch((err) => log.error('pluginManager.notifyPlayerStart failed:', err));

        // Render audio visuals if applicable
        this._renderAudioVisuals();
    }

    /**
     * Renders the blurred backdrop and square album art for audio items.
     * Hides the overlay for video items.
     */
    _renderAudioVisuals() {
        const isAudioItem = this._item?.MediaType === 'Audio' || this._item?.Type === 'AudioBook';

        let overlay = this.$('#audio-visual-overlay');

        if (!isAudioItem) {
            if (overlay) overlay.remove();
            return;
        }

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'audio-visual-overlay';
            overlay.className = 'audio-visual-overlay hidden';
            overlay.innerHTML = `
                <div class="audio-backdrop"></div>
                <div class="audio-album-art"></div>
            `;
            const osd = this.$('#osd-overlay');
            if (osd && osd.parentNode) {
                osd.parentNode.insertBefore(overlay, osd);
            } else {
                this.el.querySelector('.player-page')?.appendChild(overlay);
            }
        }

        // Show the overlay
        overlay.classList.remove('hidden');

        const backdropEl = overlay.querySelector('.audio-backdrop');
        const artEl = overlay.querySelector('.audio-album-art');
        const itemId = this._item.Id;

        // Image resolution settings
        const screenWidth = window.innerWidth || 1920;

        // 1. Fetch Album Art (Square)
        // Try item Primary, then Album Primary
        let artUrl = null;
        if (this._item.ImageTags?.Primary) {
            artUrl = api.getImageUrl(itemId, 'Primary', {
                maxWidth: 600,
                quality: 90,
                tag: this._item.ImageTags.Primary
            });
        } else if (this._item.AlbumId && this._item.AlbumPrimaryImageTag) {
            artUrl = api.getImageUrl(this._item.AlbumId, 'Primary', {
                maxWidth: 600,
                quality: 90,
                tag: this._item.AlbumPrimaryImageTag
            });
        }

        if (artEl) {
            if (artUrl) {
                artEl.style.backgroundImage = `url('${artUrl}')`;
                artEl.style.display = 'block';
            } else {
                artEl.style.display = 'none'; // Hide if no art
            }
        }

        // 2. Fetch Backdrop (Blurred Background)
        // Try Backdrop, then fallback to the same Album Art we just found
        let backdropUrl = null;
        if (this._item.BackdropImageTags && this._item.BackdropImageTags.length > 0) {
            backdropUrl = api.getImageUrl(itemId, 'Backdrop', { maxWidth: screenWidth, quality: 80 });
        } else if (
            this._item.ParentBackdropImageTags &&
            this._item.ParentBackdropImageTags.length > 0 &&
            this._item.ParentBackdropItemId
        ) {
            backdropUrl = api.getImageUrl(this._item.ParentBackdropItemId, 'Backdrop', {
                maxWidth: screenWidth,
                quality: 80
            });
        } else {
            backdropUrl = artUrl; // Fallback to square art, which gets blurred heavily
        }

        if (backdropEl) {
            if (backdropUrl) {
                backdropEl.style.backgroundImage = `url('${backdropUrl}')`;
                backdropEl.style.display = 'block';
            } else {
                backdropEl.style.display = 'none';
            }
        }
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
        // Detect audio-only items (Music, Audiobooks) so the OSD can hide
        // video-specific controls like subtitle/track buttons and chapters.
        const isAudioItem = this._item?.MediaType === 'Audio' || this._item?.Type === 'AudioBook';

        this._osd = new OSDController(this._player, {
            item: this._item,
            api: api,
            isAudio: isAudioItem
        });

        // Bind events
        this._osd.on('exit', () => this._stopAndExit());
        this._osd.on('next', () => this._playNextItem()); // Ensure OSD emits this
        this._osd.on('previous', () => this._playPreviousItem()); // Ensure OSD emits this
        /* Queue modal: instant skip to a specific index in the play queue. */
        this._osd.on('playQueueItem', (index) => this._playQueueItemAtIndex(index));

        // Initial metadata
        // this._osd.setMetadata(this._item); // passed in options or set here

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
        return platformInfo.isTizen;
    }

    // ========================================================================
    // Player Event Handlers
    // ========================================================================

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

        // If an in-progress track switch (next/previous/queue-jump) explicitly
        // called stop(), the resulting 'ended' event must NOT trigger navigation.
        // The switching method is responsible for starting the new item.
        if (this._isSwitching) {
            log.info('Ignoring ended event during in-progress track switch.');
            return;
        }

        const repeatMode = playQueue.getRepeatMode();

        // 1. Handle RepeatOne: simply loop the current item
        if (repeatMode === 'RepeatOne') {
            log.info('Item ended, RepeatOne is active. Restarting current item.');
            this._isSwitching = true;
            this._showLoading(true);

            // Report the stop of the current play session
            const mediaSource = this._player?.getCurrentMediaSource?.();
            const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

            // Notify plugins that the previous session ended before starting the same item again
            pluginManager.notifyPlayerStop();

            if (this._player?.stop) this._player.stop();

            this._reportPlaybackStopped(mediaSource, positionTicks, false).then(() => {
                // Settle and restart
                setTimeout(async () => {
                    this._resumePosition = 0;
                    this._cachedMediaSource = null;
                    this._hasReportedStart = false;
                    this._lastReportTime = 0;

                    try {
                        await this._startPlayback();
                    } catch (err) {
                        log.error('Failed to restart for RepeatOne:', err);
                        this._showError('Failed to restart item');
                    } finally {
                        this._isSwitching = false;
                        this._showLoading(false);
                    }
                }, 500);
            });

            eventBus.emit('player:ended', { item: this._item });
            return;
        }

        // 2. Main Flow: Check if we can play next item (RepeatAll is handled inside hasNext())
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

            // Notify plugins that old playback stopped
            pluginManager.notifyPlayerStop();

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
                // Reset Up Next state so the dialog re-triggers for the new episode
                this._osd.resetUpNext();
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
     * Handle an incoming queue update from a remote controller.
     *
     * The server sends the COMPLETE new ordered item list whenever the remote
     * user removes, reorders, or jumps to an item.  We need to:
     *   1. Fetch the full item details for each ID (to match PlayQueue format)
     *   2. Replace PlayQueue in-place via setQueue()
     *   3. If the active slot has changed, switch playback to the new item.
     *
     * @param {string[]} itemIds         - New ordered list of item IDs
     * @param {number}   startIndex      - Index that should be active now
     * @param {number}   startPositionTicks - Position to seek to (usually 0 for queue ops)
     */
    async _handleRemoteQueueUpdate(itemIds, startIndex, startPositionTicks) {
        if (this._isSwitching) {
            log.warn('Ignoring remote queue update — already switching tracks');
            return;
        }

        try {
            // ----------------------------------------------------------------
            // Fetch all items in parallel while preserving order.
            // We need the full item objects (not just IDs) to build a proper
            // PlayQueue that _buildNowPlayingQueue() and the OSD can use.
            // ----------------------------------------------------------------
            log.info('Fetching', itemIds.length, 'items for remote queue update...');
            const itemPromises = itemIds.map((id) => api.getItem(id).catch(() => null));
            const fetchedItems = (await Promise.all(itemPromises)).filter(Boolean);

            if (fetchedItems.length === 0) {
                log.warn('Remote queue update: no items fetched — ignoring');
                return;
            }

            // Clamp startIndex to the fetched list length
            const safeIndex = Math.min(startIndex, fetchedItems.length - 1);
            const targetItem = fetchedItems[safeIndex];
            const currentItemId = this._item?.Id;

            // ----------------------------------------------------------------
            // Rebuild the queue.
            // If the remote queue strictly consists of episodes from the same
            // series, we delegate to PlayQueue.init() to fetch the FULL series.
            // This ensures "Previous" episodes are preserved (Jellyfin Web
            // PlayNow typically only sends upcoming episodes).
            // For mixed or custom playlists, we respect the exact remote list.
            // ----------------------------------------------------------------
            const isSingleSeriesContent =
                fetchedItems.length > 0 &&
                fetchedItems.every((i) => i.Type === 'Episode' && i.SeriesId === targetItem.SeriesId);

            if (isSingleSeriesContent) {
                log.info('Remote queue update: Restoring full series queue for episode:', targetItem.Name);
                await playQueue.init(targetItem);
            } else {
                playQueue.setQueue(fetchedItems, safeIndex);
                log.info('Queue rebuilt via remote update:', fetchedItems.length, 'items, active:', targetItem?.Name);
            }

            if (targetItem.Id === currentItemId) {
                // ----------------------------------------------------------
                // Same item remains active — this was a remove-other or
                // reorder that didn't change the playing track.  Just report
                // the new queue to the server so the dashboard reflects it.
                // ----------------------------------------------------------
                log.info('Remote queue update: active item unchanged, reporting updated queue');
                this._reportPlaybackProgress();
            } else {
                // ----------------------------------------------------------
                // A different item is now at startIndex — this is a
                // jump-to-item or reorder that changed what should play.
                // Perform an in-place track switch exactly like _playNextItem.
                // ----------------------------------------------------------
                log.info('Remote queue update: switching to new active item:', targetItem.Name);

                this._isSwitching = true;
                this._showLoading(true);

                try {
                    // Capture position before stopping
                    const mediaSource = this._player?.getCurrentMediaSource?.();
                    const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

                    // Notify plugins before switch
                    pluginManager.notifyPlayerStop();

                    if (this._player?.stop) {
                        await this._player.stop();
                    }

                    await this._reportPlaybackStopped(mediaSource, positionTicks, false);

                    // Brief settle delay (same as _playNextItem)
                    await new Promise((resolve) => setTimeout(resolve, 500));

                    // Switch to target item
                    this._item = targetItem;
                    this._resumePosition = startPositionTicks || 0;
                    this._cachedMediaSource = null;
                    this._hasReportedStart = false;
                    this._lastReportTime = 0;

                    if (this._osd) {
                        this._osd.updateItem(targetItem);
                    }

                    await this._startPlayback();

                    this._showLoading(false);
                } catch (switchError) {
                    log.error('Remote queue update: track switch failed:', switchError);
                    this._showError('Failed to switch to requested item');
                } finally {
                    this._isSwitching = false;
                }
            }
        } catch (error) {
            log.error('Remote queue update failed:', error);
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

                // Notify plugins before traversing back
                pluginManager.notifyPlayerStop();

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
                    // Reset Up Next state so the dialog can re-trigger for the new episode
                    this._osd.resetUpNext();
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

    /**
     * Instantly jump to a specific index in the play queue.
     * Called when the user selects any row in the QueueModal and presses Enter.
     *
     * The queue cursor has already been moved by QueueModal via playQueue.setQueue(),
     * so here we only need to perform the in-place track switch to start playing
     * the item at that position.
     *
     * @param {number} targetIndex - The new active index in the play queue.
     */
    async _playQueueItemAtIndex(targetIndex) {
        if (this._isSwitching) {
            log.warn('_playQueueItemAtIndex: already switching, ignoring jump to', targetIndex);
            return;
        }

        /* The queue cursor was already set by QueueModal.handleKey('enter'),
         * so getCurrentItem() already returns the item we want to play. */
        const targetItem = playQueue.getCurrentItem();
        if (!targetItem) {
            log.warn('_playQueueItemAtIndex: no item at index', targetIndex);
            return;
        }

        /* If the user selected the already-playing item, just seek back to start. */
        if (targetItem.Id === this._item?.Id) {
            log.info('_playQueueItemAtIndex: same item selected — seeking to start.');
            this._player?.seek(0);
            return;
        }

        log.info('_playQueueItemAtIndex: jump to', targetItem.Name, '(index', targetIndex, ')');

        this._isSwitching = true;
        this._showLoading(true);

        try {
            /* Capture current position before stopping. */
            const mediaSource = this._player?.getCurrentMediaSource?.();
            const positionTicks = this._player?.getCurrentPositionTicks?.() || 0;

            /* Notify plugins that the previous session ended. */
            pluginManager.notifyPlayerStop();

            if (this._player?.stop) {
                await this._player.stop();
            }

            await this._reportPlaybackStopped(mediaSource, positionTicks, false);

            /* Brief settle delay — same as _playNextItem/_playPreviousItem. */
            await new Promise((resolve) => setTimeout(resolve, 500));

            /* In-place switch to the target item. */
            this._item = targetItem;
            this._resumePosition = 0;
            this._cachedMediaSource = null;
            this._hasReportedStart = false;
            this._lastReportTime = 0;

            if (this._osd) {
                this._osd.updateItem(targetItem);
                /* Reset Up Next so the dialog re-triggers for the new item. */
                this._osd.resetUpNext();
            }

            await this._startPlayback();

            this._showLoading(false);
        } catch (error) {
            log.error('_playQueueItemAtIndex failed:', error);
            this._showError('Failed to switch to selected item');
        } finally {
            this._isSwitching = false;
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
        // Ensure we have a valid number for ticks
        const ticks = typeof positionTicks === 'number' ? positionTicks : 0;

        // 1. Check primary subtitle sync — clear if cue end time has passed
        if (this._subtitleEndTime !== null && ticks >= this._subtitleEndTime) {
            this._clearSubtitle();
        }

        // 2. Check secondary subtitle sync — clear if cue end time has passed
        if (this._secondarySubtitleEndTime !== null && ticks >= this._secondarySubtitleEndTime) {
            this._clearSecondarySubtitle();
        }

        // 3. Report progress periodically (every 10 seconds approx)
        const now = Date.now();
        if (!this._lastReportTime || now - this._lastReportTime > 10000) {
            this._reportPlaybackProgress();
            this._lastReportTime = now;
        }

        // 4. Forward tick to plugin manager for widget visibility evaluation
        //    (PluginWidgetHost.onTimeUpdate toggles .visible on plugin buttons)
        pluginManager.notifyTimeUpdate(ticks, 0);

        // 5. Evaluate whether the Up Next episode dialog should be shown.
        //    Delegates all threshold maths and state tracking to OSDController.
        if (this._osd) {
            const duration = this._player?.getDurationTicks?.() || 0;
            this._osd.showUpNextIfNeeded(ticks, duration, this._item);
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
                ...playerState,

                // Include the full queue so the server can display "up next" in the
                // session inspector and respond to remote skip commands correctly.
                NowPlayingQueue: this._buildNowPlayingQueue()
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

    /**
     * Handle secondary subtitle cue events (fired by SubtitleManager via JellyfinPlayer).
     *
     * Secondary subtitles inherit ALL visual styles from the primary (color, shadow,
     * font, weight, opacity, background) but use independent size + position settings.
     * They render into #secondary-subtitle-overlay which is positioned at the top.
     *
     * @param {Object} data - Cue data: { text, duration }
     */
    _onSecondarySubtitleChange(data) {
        const overlay = document.getElementById('secondary-subtitle-overlay');
        if (!overlay) return;

        if (data && data.text && data.text.trim().length > 0) {
            // Render the secondary subtitle text
            overlay.innerHTML = `<span class="subtitle-line">${data.text}</span>`;
            overlay.classList.remove('hidden');

            // Apply secondary text styles — inherits primary appearance, overrides size
            const styles = SubtitleStyles.getSecondaryTextStyles();
            const span = overlay.querySelector('.subtitle-line');
            if (span) {
                SubtitleStyles.applyStyles(span, styles);

                // Ensure font is loaded (same font as primary — likely already cached)
                const fontId = SubtitleStyles.getCurrentFontId();
                if (fontId) {
                    FontLoader.loadFont(fontId).then(() => {
                        // Re-apply after font loads to trigger repaint
                        SubtitleStyles.applyStyles(span, styles);
                    });
                }
            }

            // Apply secondary window/position styles (independent from primary position)
            const windowStyles = SubtitleStyles.getSecondaryWindowStyles();
            SubtitleStyles.applyStyles(overlay, windowStyles);

            // Track when this cue ends so _onTimeUpdate can clear it
            if (data.duration > 0) {
                const currentTicks = this._player?.getCurrentPositionTicks?.() || 0;
                this._secondarySubtitleEndTime = currentTicks + data.duration * 10000;
            } else {
                this._secondarySubtitleEndTime = null;
            }
        } else {
            // Empty cue — clear the overlay
            this._clearSecondarySubtitle();
        }
    }

    /**
     * Clear the secondary subtitle overlay.
     */
    _clearSecondarySubtitle() {
        const overlay = document.getElementById('secondary-subtitle-overlay');
        if (overlay) {
            overlay.innerHTML = '';
            overlay.classList.add('hidden');
        }
        this._secondarySubtitleEndTime = null;
    }

    _onMediaStreamsChange(data) {
        if (!this._item || !this._player) return;

        log.info('Media streams changed, reporting progress to persist selection');
        const isPaused = this._player.isPaused();
        this._reportPlaybackProgress(isPaused ? 'pause' : 'timeupdate');
    }

    /**
     * Re-apply styles to the currently displayed subtitle(s).
     * Called when user changes subtitle appearance settings (e.g. from SubtitleQuickSettings).
     * Both primary and secondary overlays are refreshed here.
     */
    _refreshSubtitleStyles() {
        // Refresh primary overlay
        const overlay = document.getElementById('subtitle-overlay');
        if (overlay && !overlay.classList.contains('hidden')) {
            const span = overlay.querySelector('.subtitle-line');
            if (span) {
                log.debug('Refreshing primary subtitle styles');

                // Re-apply text styles
                const styles = SubtitleStyles.getTextStyles();
                SubtitleStyles.applyStyles(span, styles);

                // Re-apply container styles (position/window)
                const windowStyles = SubtitleStyles.getWindowStyles();
                SubtitleStyles.applyStyles(overlay, windowStyles);

                // Handle font loading if changed
                const fontId = SubtitleStyles.getCurrentFontId();
                if (fontId) {
                    FontLoader.loadFont(fontId).then(() => {
                        SubtitleStyles.applyStyles(span, styles);
                    });
                }
            }
        }

        // Refresh secondary overlay (inherits primary appearance — always re-apply on any change)
        const secondaryOverlay = document.getElementById('secondary-subtitle-overlay');
        if (secondaryOverlay && !secondaryOverlay.classList.contains('hidden')) {
            const span = secondaryOverlay.querySelector('.subtitle-line');
            if (span) {
                log.debug('Refreshing secondary subtitle styles');

                // Secondary uses inherited styles with its own size override
                const styles = SubtitleStyles.getSecondaryTextStyles();
                SubtitleStyles.applyStyles(span, styles);

                const windowStyles = SubtitleStyles.getSecondaryWindowStyles();
                SubtitleStyles.applyStyles(secondaryOverlay, windowStyles);

                const fontId = SubtitleStyles.getCurrentFontId();
                if (fontId) {
                    FontLoader.loadFont(fontId).then(() => {
                        SubtitleStyles.applyStyles(span, styles);
                    });
                }
            }
        }
    }

    /**
     * Report playback progress to server
     * @param {string} eventName - Event type: 'timeupdate', 'pause', 'unpause'
     * @param {number} [manualPositionTicks=null] - Optional manual position override
     */
    async _reportPlaybackProgress(eventName = 'timeupdate', manualPositionTicks = null) {
        if (!this._player || !this._item) return;

        try {
            const mediaSource = this._player.getCurrentMediaSource();
            const playerState = this._getPlayerState(manualPositionTicks);
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
                EventName: eventName,

                // Report the current queue state so the dashboard can reflect what's
                // up next and remote control queue operations work correctly.
                NowPlayingQueue: this._buildNowPlayingQueue()
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
     * @param {number} [manualPositionTicks=null] - Optional manual position override
     * @returns {Object} Player state object
     */
    _getPlayerState(manualPositionTicks = null) {
        const mediaSource = this._player?.getCurrentMediaSource?.();
        const positionTicks =
            manualPositionTicks !== null && manualPositionTicks !== undefined
                ? manualPositionTicks
                : this._player?.getCurrentPositionTicks?.() || 0;

        // Build base state
        const state = {
            // Core position and volume - cast strictly to integers to avoid server 400s
            PositionTicks: Math.max(0, Math.round(Number(positionTicks)) || 0),
            VolumeLevel: Math.min(100, Math.max(0, Math.round(Number(this._player?.getVolume?.())) || 100)),
            IsMuted: Boolean(this._player?.isMuted?.()),

            // Playback method (DirectPlay, DirectStream, Transcode)
            PlayMethod: mediaSource?.PlayMethod || 'DirectPlay',

            // Seeking capability
            CanSeek: Boolean(mediaSource?.RunTimeTicks > 0),

            // Playback rate (1.0 = normal speed)
            PlaybackRate: Number(this._player?.getPlaybackRate?.()) || 1.0,

            // Queue modes (litefin doesn't support playlists yet)
            RepeatMode: 'RepeatNone',
            ShuffleMode: 'Sorted'
        };

        // Only include stream indices if they are valid numbers (strings or undefined cause 400 errors)
        const audioIndex = Number(this._player?.getCurrentAudioStreamIndex?.());
        if (!isNaN(audioIndex) && audioIndex !== null) {
            state.AudioStreamIndex = audioIndex;
        }

        const subtitleIndex = Number(this._player?.getCurrentSubtitleStreamIndex?.());
        if (!isNaN(subtitleIndex) && subtitleIndex !== null) {
            state.SubtitleStreamIndex = subtitleIndex;
        }

        return state;
    }

    /**
     * Build the NowPlayingQueue array for playback reports.
     *
     * The server expects an array of minimal queue entry objects so it can display
     * "up next" in the session inspector and handle remote queue-skip commands.
     * Each entry carries:
     *   - Id:             the Jellyfin item Id (media item)
     *   - PlaylistItemId: a session-unique token assigned by PlayQueue, used by the
     *                     server to reference specific queue slots independently of
     *                     item identity (e.g., when the same movie appears twice).
     *
     * @returns {Array<{Id: string, PlaylistItemId: string}>}
     */
    _buildNowPlayingQueue() {
        // getQueue() returns a shallow copy of the current queue array,
        // with PlaylistItemId already stamped on every item by PlayQueue.
        return playQueue.getQueue().map((item) => ({
            Id: item.Id,
            PlaylistItemId: item.PlaylistItemId
        }));
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

            // Notify plugins that playback is ending — they clean up OSD widgets
            pluginManager.notifyPlayerStop();

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
        if (this._onRemoteRepeatMode) eventBus.off('remote:repeatmode', this._onRemoteRepeatMode);
        if (this._onRemoteShuffleMode) eventBus.off('remote:shufflemode', this._onRemoteShuffleMode);
        if (this._onRemoteNavigate) eventBus.off('remote:navigate', this._onRemoteNavigate);
        if (this._onRemoteSelect) eventBus.off('remote:select', this._onRemoteSelect);
        if (this._onRemoteAudioTrack) eventBus.off('remote:audiotrack', this._onRemoteAudioTrack);
        if (this._onRemoteSubtitle) eventBus.off('remote:subtitle', this._onRemoteSubtitle);
        if (this._onRemoteQueueUpdate) eventBus.off('remote:queueupdate', this._onRemoteQueueUpdate);
        if (this._onRemoteUserDataChanged) eventBus.off('remote:userdatachanged', this._onRemoteUserDataChanged);

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
