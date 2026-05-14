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
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { pluginManager } from '../plugins/PluginManager.js';
import { platformInfo } from '../utils/PlatformInfo.js';
import { webosAdapter } from '../webos/WebOSAdapter.js';
import { syncPlayManager } from '../core/syncplay/SyncPlayManager.js';
import { globalClock } from '../ui/GlobalClock.js';

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
                            <button class="btn btn-secondary focusable" id="error-force-transcode-btn" tabindex="0">Force Transcode</button>
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
        // Reset state for new playback session.
        // CRITICAL: _cachedPlayMethod must be cleared here — if the previous item was
        // DirectPlay, the stale cache would bleed into the new session and cause incorrect
        // PlayMethod reporting to the server before _currentPlayMethod is resolved from
        // the new PlaybackInfo response.
        this._item = null;
        this._resumePosition = 0;
        this._hasReportedStart = false;
        this._cachedPlayMethod = null;

        // Hide global clock during player loading/playback
        globalClock.setVisibility(false);

        const itemId = this.params.id;
        const resume = this.params.resume === 'true';
        const startPositionTicks = this.params.startPositionTicks ? parseInt(this.params.startPositionTicks, 10) : null;

        try {
            // Show loading
            this._showLoading(true);

            // Render cached backdrop if available (for smooth transition)
            const backdropUrl = state.get('player:backdropUrl');
            if (backdropUrl) {
                // Apply directly to the loading overlay to ensure visibility
                const loader = this.el.querySelector('.page-loading');
                if (loader) {
                    // IMPORTANT: Do NOT make the loader background transparent yet.
                    // Setting it to transparent here would expose the black Tizen hardware plane
                    // for the entire image fetch duration. Instead keep it solidly dark and
                    // flip to transparent atomically on the same frame as the backdrop fades in.
                    loader.style.backgroundColor = '#000';

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
                        // Now that the image is ready, transition to transparent bg so the
                        // backdrop layer shows through cleanly with no visible black gap.
                        loader.style.backgroundColor = 'transparent';
                        backdropLayer.style.backgroundImage = `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.8) 100%), url('${backdropUrl}')`;
                        requestAnimationFrame(() => {
                            backdropLayer.style.opacity = '1';
                        });
                    };
                    img.onerror = () => {
                        // If the image fails, just keep the solid dark background — better than black flash
                        log.warn('Backdrop image failed to load, keeping solid loading background');
                    };
                    img.src = backdropUrl;

                    this._loadingBackdrop = backdropLayer; // Mark for cleanup
                }
            }

            // Enable Tizen AVPlayer transparency mode
            // This makes body/app transparent so hardware video plane is visible
            document.body.classList.add('player-active');
            document.documentElement.classList.add('player-active');

            // Parallelize font loading and item details loading
            const fontId = SubtitleStyles.getCurrentFontId();
            const fetchTasks = [api.getItem(itemId, { Fields: 'Chapters,Trickplay,RunTimeTicks,MediaSources' })];
            if (fontId) {
                fetchTasks.push(FontLoader.loadFont(fontId));
            }

            // Load item details (and wait for font if needed)
            const [itemResult] = await Promise.all(fetchTasks);

            // Preserve local trailer metadata mutations (Name & ProductionYear) since
            // local trailers lack parent context and the fresh API fetch wipes our changes.
            const overrideName = state.get('player:overrideName');
            const overrideYear = state.get('player:overrideYear');

            if (itemResult.Type === 'Trailer') {
                if (overrideName && overrideName !== itemResult.Name) {
                    itemResult.Name = overrideName;
                }
                if (overrideYear === 'NONE') {
                    delete itemResult.ProductionYear;
                } else if (overrideYear !== null) {
                    itemResult.ProductionYear = parseInt(overrideYear, 10);
                }
            }

            this._item = itemResult;
            this.title = this._item.Name;

            // Update title for Live TV items to show current program
            if (this._item.Type === 'TvChannel') {
                this._updateLiveTvTitle();
            }

            // Initialize Play Queue
            const contextType = state.get('player:contextType');
            const contextId = state.get('player:contextId');
            // For BoxSet queues, the sort order is forwarded from DetailsPage so the
            // full queue is ordered the same way the collection display grid is ordered.
            const boxsetSortBy = state.get('player:boxsetSortBy');
            log.debug('Initializing PlayQueue with context:', { contextType, contextId, boxsetSortBy });
            await playQueue.init(this._item, contextType, contextId, boxsetSortBy);

            // Sync the active item to the instance that PlayQueue just minted.
            // This prevents duplicate-fetch bugs with plugins like Local Intros.
            const queueItem = playQueue.getCurrentItem();
            if (queueItem && queueItem.Id === this._item.Id) {
                this._item = queueItem;
            }

            // Clear context state so it doesn't leak to next playback
            state.set('player:contextType', null);
            state.set('player:contextId', null);
            state.set('player:boxsetSortBy', null);

            // Calculate resume position if needed
            if (startPositionTicks !== null && !isNaN(startPositionTicks)) {
                // If an explicit position was passed via URL (e.g. from SyncPlay)
                this._resumePosition = startPositionTicks;
            } else if (resume && this._item.UserData?.PlaybackPositionTicks) {
                // Otherwise fallback to UserData if resume was requested
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

                    // Show OSD for feedback
                    if (this._osd) {
                        this._osd.showAndFocusPlayPause();
                        this._osd.updatePlayPauseButton();
                    }
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

                // Show OSD for feedback
                if (this._osd) {
                    this._osd.showAndFocusPlayPause();
                    this._osd.updatePlayPauseButton();
                }
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

                // Show OSD for feedback
                if (this._osd) {
                    this._osd.showAndFocusPlayPause();
                    this._osd.updatePlayPauseButton();
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

            // Channel Up/Down for Live TV
            this._onChannelUp = () => this._handleChannelChange(1);
            eventBus.on('key:channelUp', this._onChannelUp);

            this._onChannelDown = () => this._handleChannelChange(-1);
            eventBus.on('key:channelDown', this._onChannelDown);

            // ================================================================
            // MAGIC CURSOR SUPPORT (WebOS / Tizen Pointer)
            // ================================================================

            // 1. Moving the magic remote wakes up the OSD.
            //    Throttled to 200ms — without throttling, every pixel of cursor movement
            //    spams show() + resetAutoHide(), causing the timer to reset continuously
            //    and making it impossible for the OSD to settle before the user clicks.
            let _mouseMoveThrottle = null;
            this.el.addEventListener('mousemove', (e) => {
                if (!PlayerSettings.get('enableMagicCursor')) return;

                if (_mouseMoveThrottle) return;
                _mouseMoveThrottle = setTimeout(() => {
                    _mouseMoveThrottle = null;
                }, 200);
                if (this._osd) {
                    this._osd._onMouseMove(e);
                }
            });

            // 2. Clicking the video background shows/hides the OSD.
            //    Use a robust contains() guard against the entire #osd-overlay subtree
            //    so OSD button clicks can never accidentally reach this handler even if
            //    stopPropagation() is still in flight on older TV browsers.
            this.el.addEventListener('click', (e) => {
                if (!PlayerSettings.get('enableMagicCursor')) return;

                const osdOverlay = this.el.querySelector('#osd-overlay');

                // If the click originated from anywhere inside the OSD container, ignore it.
                // This covers buttons, slider, modals, overlays — anything inside #osd-overlay.
                if (osdOverlay && osdOverlay.contains(e.target)) {
                    return;
                }

                // Ignore the error panel
                if (e.target.closest('.error-panel')) {
                    return;
                }

                // Click landed on the raw video background.
                // - If OSD is hidden: wake it up.
                // - If OSD is visible: toggle play/pause (standard media player behaviour).
                //   This branch is only reached for genuine background clicks — OSD buttons
                //   and the slider are fully guarded by the contains() check above.
                if (this._osd && !this._osd._isOsdVisible) {
                    this._osd.show();
                    this._osd.resetAutoHide();
                } else {
                    this._onRemotePlayPause();
                }
            });

            // ================================================================
            // PHYSICAL REMOTE CONTROL HANDLERS (WebOS/Tizen)
            // ================================================================
            // Link physical hardware keys to our existing remote command logic.
            // Using this.on() ensures these are automatically cleaned up on page destroy.

            this.on('key:play', () => this._onRemotePlay());
            this.on('key:pause', () => this._onRemotePause());
            this.on('key:playPause', () => this._onRemotePlayPause());
            this.on('key:stop', () => this._onRemoteStop());
            this.on('key:next', () => this._onRemoteNext());
            this.on('key:previous', () => this._onRemotePrevious());

            this.on('key:rewind', () => {
                if (this._player) {
                    log.info('Hardware Remote: Rewind (10s)');
                    this._player.seekRelative(-10000);
                    if (this._osd) this._osd.show();
                }
            });

            this.on('key:fastForward', () => {
                if (this._player) {
                    log.info('Hardware Remote: FastForward (30s)');
                    this._player.seekRelative(30000);
                    if (this._osd) this._osd.show();
                }
            });

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
            // We no longer hide the loading screen here to prevent the black flash.
            // It will be hidden consistently by the 'playing' event once video is actually rendering.
        });

        // Manually trigger ready state (removed loading logic from here)
        this._onPlayerReady();
    }

    _onPlayerReady() {
        log.info('Player ready');
        // Loading is now handled by 'loadedmetadata' event
    }
    /**
     * Helper to resolve an audio or subtitle track by language and title.
     * Tries an exact match on language + title first, then falls back to language only.
     *
     * @param {Object} mediaSource - The MediaSource object
     * @param {string} type - 'Audio' or 'Subtitle'
     * @param {string} targetLang - The language to look for (e.g., 'eng')
     * @param {string} targetTitle - The title to look for (e.g., 'English [SDH]')
     * @returns {number|undefined} The resolved track index, or undefined if no match
     */
    _resolveTrackByLang(mediaSource, type, targetLang, targetTitle) {
        if (!mediaSource || !mediaSource.MediaStreams) return undefined;
        if (!targetLang) return undefined;

        // If the user explicitly disabled subtitles via session memory
        if (type === 'Subtitle' && targetLang === 'none') {
            return -1;
        }

        const streams = mediaSource.MediaStreams.filter((s) => s.Type === type);
        if (streams.length === 0) return undefined;

        // 1. Try exact match: Language + Title
        const exactMatch = streams.find(
            (s) => (s.Language || 'none') === targetLang && (s.DisplayTitle || s.Title || 'none') === targetTitle
        );
        if (exactMatch) return exactMatch.Index;

        // 2. Fall back to Language only
        const langMatch = streams.find((s) => (s.Language || 'none') === targetLang);
        if (langMatch) return langMatch.Index;

        return undefined;
    }

    /**
     * Start playback of the current item
     */
    async _startPlayback() {
        // === Plugin System ===
        // Allow plugins to perform late-stage preparation before playback actually
        // initializes. This is where Local Intros injects pre-roll videos into the queue.
        try {
            // Note: We pass the current _resumePosition so plugins (like Local Intros)
            // can decide whether to skip their logic if the user is resuming a session.
            await pluginManager.prepareItemPlayback(this._item, {
                resumePosition: this._resumePosition
            });
        } catch (err) {
            log.error('pluginManager.prepareItemPlayback failed:', err);
        }

        // Re-sync this._item with the PlayQueue's current pointer.
        // If a plugin (like Local Intros) prepended items, the "main" item is now
        // at a later index, and the current pointer (0) is the first intro.
        const queueItem = playQueue.getCurrentItem();
        if (queueItem && queueItem.Id !== this._item.Id) {
            log.info('Play queue modified by plugins — switching current item to:', queueItem.Name);
            this._item = queueItem;

            // If OSD is already up (restarting playback), update its title/metadata
            if (this._osd) {
                this._osd.updateItem(this._item);
            }
        }

        const item = this._item;

        // 1. Check for pre-selected tracks/version from DetailsPage (stored in state)
        const preSelectedMediaSourceId = state.get('player:initialMediaSourceId');
        const preSelectedAudio = state.get('player:initialAudioIndex');
        const preSelectedSubtitle = state.get('player:initialSubtitleIndex');

        // Clear state to prevent persistence to future playbacks
        state.set('player:initialMediaSourceId', null);
        state.set('player:initialAudioIndex', null);
        state.set('player:initialSubtitleIndex', null);

        // Resolve MediaSource to use
        const mediaSource = preSelectedMediaSourceId
            ? item.MediaSources?.find((m) => m.Id === preSelectedMediaSourceId) || item.MediaSources?.[0]
            : item.MediaSources?.[0];

        // 2. Resolve Tracks
        let savedAudioIndex =
            preSelectedAudio !== null && preSelectedAudio !== undefined ? preSelectedAudio : undefined;
        let savedSubtitleIndex =
            preSelectedSubtitle !== null && preSelectedSubtitle !== undefined ? preSelectedSubtitle : undefined;

        // If no explicit selection from DetailsPage, try to restore from session memory (if enabled)
        if (PlayerSettings.get('rememberTracksForSession') !== false) {
            if (savedAudioIndex === undefined) {
                const sessionAudioLang = storage.getItem('session:lastAudioLang');
                const sessionAudioTitle = storage.getItem('session:lastAudioTitle');
                if (sessionAudioLang) {
                    const resolvedAudio = this._resolveTrackByLang(
                        mediaSource,
                        'Audio',
                        sessionAudioLang,
                        sessionAudioTitle
                    );
                    if (resolvedAudio !== undefined) {
                        savedAudioIndex = resolvedAudio;
                        log.info(
                            `[Track Memory] Restored Audio: ${sessionAudioLang} - ${sessionAudioTitle} -> Index ${resolvedAudio}`
                        );
                    }
                }
            }

            if (savedSubtitleIndex === undefined) {
                const sessionSubtitleLang = storage.getItem('session:lastSubtitleLang');
                const sessionSubtitleTitle = storage.getItem('session:lastSubtitleTitle');
                if (sessionSubtitleLang) {
                    const resolvedSubtitle = this._resolveTrackByLang(
                        mediaSource,
                        'Subtitle',
                        sessionSubtitleLang,
                        sessionSubtitleTitle
                    );
                    if (resolvedSubtitle !== undefined) {
                        savedSubtitleIndex = resolvedSubtitle;
                        log.info(
                            `[Track Memory] Restored Subtitle: ${sessionSubtitleLang} - ${sessionSubtitleTitle} -> Index ${resolvedSubtitle}`
                        );
                    }
                }
            }
        }

        // 3. Fallback to default from MediaSource for Audio if still undefined
        if (savedAudioIndex === undefined) {
            savedAudioIndex = mediaSource?.DefaultAudioStreamIndex;
        }

        // Note: We leave savedSubtitleIndex as undefined if unresolved, so JellyfinPlayer's SubtitleMode logic handles it.

        log.info('Starting playback with resolved preferences:', {
            audio: savedAudioIndex,
            subtitle: savedSubtitleIndex,
            preSelectedAudio,
            preSelectedSubtitle
        });

        // Start playback using the player's internal logic
        // This handles PlaybackInfo fetching, media source selection, and stream URL building
        try {
            const playOptions = {
                item: item, // Pass full item which might have Chapters
                itemId: item.Id,
                userId: api.userId, // Required for playback info
                startPositionTicks: this._resumePosition,
                mediaSourceId: mediaSource?.Id,
                audioStreamIndex: savedAudioIndex,
                subtitleStreamIndex: savedSubtitleIndex,
                autoPlay: syncPlayManager.wantsAutoPlay()
            };

            if (this._forceTranscode) {
                playOptions.playbackMode = 'transcode';
                this._forceTranscode = false; // Reset after applying
            }

            await this._player.play(playOptions);
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
                    subtitleStreamIndex: savedSubtitleIndex,
                    autoPlay: syncPlayManager.wantsAutoPlay()
                });
            } else {
                throw err;
            }
        }

        // ====================================================================
        // WebOS Media Session (System Controls & Metadata)
        // ====================================================================
        // Update the OS-level media session. This enables the Magic Remote
        // media controls and provides metadata to the LG system overlay.
        if (platformInfo.isWebOS) {
            webosAdapter.updateMediaSession(
                {
                    title: item.Name,
                    artist: item.ProductionYear ? item.ProductionYear.toString() : '',
                    album: item.SeriesName || 'Litefin',
                    artworkUrl: api.getImageUrl(item.Id, 'Primary', { maxWidth: 400 })
                },
                {
                    onPlay: () => this._onRemotePlay(),
                    onPause: () => this._onRemotePause(),
                    onStop: () => this._onRemoteStop(),
                    onNext: () => this._onRemoteNext(),
                    onPrevious: () => this._onRemotePrevious(),
                    onSeekForward: () => {
                        if (this._player) this._player.seekRelative(30000);
                    },
                    onSeekBackward: () => {
                        if (this._player) this._player.seekRelative(-10000);
                    }
                }
            );
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

        // Fetch lyrics for audio items
        this._currentLyrics = null;
        if (item.MediaType === 'Audio' || item.Type === 'AudioBook') {
            try {
                const lyricsData = await api.getLyrics(item.Id);
                if (lyricsData && lyricsData.Lyrics && lyricsData.Lyrics.length > 0) {
                    this._currentLyrics = lyricsData.Lyrics;
                    log.info(`Fetched ${this._currentLyrics.length} lines of lyrics.`);
                    if (this._osd && typeof this._osd.setLyricsAvailable === 'function') {
                        this._osd.setLyricsAvailable(true);
                    }
                }
            } catch (err) {
                log.info('No lyrics available or error fetching lyrics: ', err.message);
                if (this._osd && typeof this._osd.setLyricsAvailable === 'function') {
                    this._osd.setLyricsAvailable(false);
                }
            }
        }
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
            isAudio: isAudioItem,
            playerPage: this
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

        if (this._player) {
            const resolvedSource = this._player.getCurrentMediaSource?.();
            if (resolvedSource?.Id) {
                this._osd.setMediaSourceId(resolvedSource.Id);
            }
        }

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

            /*
             * Thread the resolved media source ID to the OSD so TrickplayManager
             * can look up the correct trickplay data. We do this here (not in
             * _startPlayback) because the player finalises the source ID only
             * once actual playback begins, especially during adaptive streaming.
             */
            if (this._osd) {
                const resolvedSource = this._player?.getCurrentMediaSource?.();
                if (resolvedSource?.Id) {
                    this._osd.setMediaSourceId(resolvedSource.Id);
                }
            }
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

        // Natural end of playback - delegate to centralized exit logic.
        // We pass false for clearChain so the auto-chain flag is preserved if it exists.
        log.info('Natural end of playback reached. Triggering exit.');
        eventBus.emit('player:ended', { item: this._item });
        this._stopAndExit(false, 'ended');
    }

    /**
     * Play next item in queue if available
     */
    async _playNextItem() {
        if (this._isSwitching) return;

        // No next item in the queue — check whether we are in an auto-chain
        // trailer sequence. If the 'details:autoChainRemote' flag is set in
        // state, pressing Next should exit the local trailer and hand off to
        // the remote trailer player, exactly like reaching the end naturally.
        if (!playQueue.hasNext()) {
            if (state.get('details:autoChainRemote')) {
                log.info('[AutoChain] Next pressed with no queue successor — chaining to remote trailer');
                // Pass false so _stopAndExit does NOT clear the auto-chain flag.
                // The flag must survive the router.back() so DetailsPage.onInit()
                // finds it and opens the remote trailer automatically.
                this._stopAndExit(/* clearChain= */ false);
            }
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

            // Capture track preferences for next episode
            this._captureActiveTrackSelection();

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
                // Reset Up Next and Lyrics state for the new track
                this._osd.resetUpNext();
                this._osd.resetLyrics();
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
                        // Reset persistent OSD states
                        this._osd.resetUpNext();
                        this._osd.resetLyrics();
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

                // Capture track preferences for next episode
                this._captureActiveTrackSelection();

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
                    // Reset Up Next and Lyrics state
                    this._osd.resetUpNext();
                    this._osd.resetLyrics();
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
     * Capture the currently active audio and subtitle tracks so they can be
     * carried forward to the next episode if 'rememberTracksForSession' is on.
     */
    _captureActiveTrackSelection() {
        if (PlayerSettings.get('rememberTracksForSession') === false) return;
        if (!this._player || !this._item) return;

        const mediaSource = this._player.getCurrentMediaSource?.() || this._item.MediaSources?.[0];
        if (!mediaSource || !mediaSource.MediaStreams) return;

        // 1. Audio Track Capture
        const activeAudioIndex = this._player._currentAudioStreamIndex;
        if (activeAudioIndex !== undefined && activeAudioIndex !== -1) {
            const activeAudioTrack = mediaSource.MediaStreams.find(
                (s) => s.Type === 'Audio' && s.Index === activeAudioIndex
            );
            if (activeAudioTrack) {
                storage.setItem('session:lastAudioLang', activeAudioTrack.Language || 'none');
                storage.setItem(
                    'session:lastAudioTitle',
                    activeAudioTrack.DisplayTitle || activeAudioTrack.Title || 'none'
                );
                log.info(`[Track Memory] Saved Audio: ${activeAudioTrack.Language} - ${activeAudioTrack.DisplayTitle}`);
            }
        }

        // 2. Subtitle Track Capture
        const activeSubtitleIndex = this._player._currentSubtitleStreamIndex;
        if (activeSubtitleIndex !== undefined) {
            if (activeSubtitleIndex === -1) {
                // User explicitly disabled subtitles
                storage.setItem('session:lastSubtitleLang', 'none');
                storage.setItem('session:lastSubtitleTitle', 'none');
                log.info(`[Track Memory] Saved Subtitle: none`);
            } else {
                const activeSubtitleTrack = mediaSource.MediaStreams.find(
                    (s) => s.Type === 'Subtitle' && s.Index === activeSubtitleIndex
                );
                if (activeSubtitleTrack) {
                    storage.setItem('session:lastSubtitleLang', activeSubtitleTrack.Language || 'none');
                    storage.setItem(
                        'session:lastSubtitleTitle',
                        activeSubtitleTrack.DisplayTitle || activeSubtitleTrack.Title || 'none'
                    );
                    log.info(
                        `[Track Memory] Saved Subtitle: ${activeSubtitleTrack.Language} - ${activeSubtitleTrack.DisplayTitle}`
                    );
                }
            }
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

            // Capture track preferences for next episode
            this._captureActiveTrackSelection();

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
                /* Reset OSD states so they trigger fresh for the new item. */
                this._osd.resetUpNext();
                this._osd.resetLyrics();
            }

            // Update title for Live TV items to show current program
            if (this._item.Type === 'TvChannel') {
                this._updateLiveTvTitle();
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

            // 6. Update lyrics highlighting if modal is open
            if (this._osd.lyricsModal && this._osd.lyricsModal._isVisible) {
                this._osd.lyricsModal.updatePosition(ticks, false);
            }
        }
    }

    async _reportPlaybackStart() {
        if (!this._player || !this._item) return;

        // Never report playback start for intros — we don't want them tracked or in Continue Watching
        if (this._item.isIntro) {
            log.info('Skipping PlaybackStart report for intro item');
            return;
        }

        try {
            const mediaSource = this._player.getCurrentMediaSource();
            const playerState = this._getPlayerState();

            // Cache mediaSource and play method for later use in stop reporting.
            // (player clears internal state after stop, so we grab these while they're live)
            // IMPORTANT: Only update the cache if we have a real value. The || 'DirectPlay' fallback
            // must NOT appear here — if _currentPlayMethod isn't set yet at this moment (race condition
            // between playbackstart event and play()'s async PlaybackInfo resolution), we must NOT
            // bake in 'DirectPlay'. The cache will be filled by _getPlayerState as soon as the player
            // has a real method.
            this._cachedMediaSource = mediaSource;
            if (this._player?._currentPlayMethod) {
                this._cachedPlayMethod = this._player._currentPlayMethod;
            }

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

        // Skip reporting during initial setup (first 2 seconds of play time) to avoid CPU contention.
        // Tizen hardware is under heavy load during ABR jumps at startup, and building the
        // full NowPlayingQueue for progress reporting can trigger stutters.
        const currentTicks = this._player.getCurrentPositionTicks();
        const startPositionTicks = this._player.getStartPositionTicks?.() || 0;
        const watchTimeTicks = currentTicks - startPositionTicks;

        if (watchTimeTicks < 20000000) {
            // 2 seconds
            log.info('Skipping early progress report during startup stabilization');
            return;
        }

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

        // Never report progress for intros
        if (this._item.isIntro) {
            return;
        }

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

        // Cache the play method if it exists, so we survive player instance recreation during audio track switches.
        if (this._player?._currentPlayMethod) {
            this._cachedPlayMethod = this._player._currentPlayMethod;
        }

        // 'Remux' is our internal label for a container-only remux; the Jellyfin server
        // PlayMethod enum has no 'Remux' value and returns HTTP 400 if we send it.
        // Map it to 'DirectStream' which is the closest server-side equivalent.
        const rawPlayMethod = this._player?._currentPlayMethod || this._cachedPlayMethod;
        const serverPlayMethod = rawPlayMethod === 'Remux' ? 'DirectStream' : rawPlayMethod;

        // Build base state
        const state = {
            // Core position and volume - cast strictly to integers to avoid server 400s
            PositionTicks: Math.max(0, Math.round(Number(positionTicks)) || 0),
            VolumeLevel: Math.min(100, Math.max(0, Math.round(Number(this._player?.getVolume?.())) || 100)),
            IsMuted: Boolean(this._player?.isMuted?.()),

            // Playback method (DirectPlay, DirectStream, Transcode)
            // NOTE: mediaSource.PlayMethod does NOT exist in the Jellyfin API response —
            // PlayMethod is a client-derived value stored in JellyfinPlayer._currentPlayMethod.
            PlayMethod: serverPlayMethod,

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
            const forceTranscodeBtn = this.$('#error-force-transcode-btn');
            const backBtn = this.$('#error-back-btn');

            if (retryBtn) {
                retryBtn.onclick = () => this._retryPlayback();
            }

            if (forceTranscodeBtn) {
                forceTranscodeBtn.onclick = () => this._retryPlayback(true);
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
    async _retryPlayback(forceTranscode = false) {
        // Hide error and unregister focus
        const errorEl = this.$('#player-error');
        if (errorEl) {
            errorEl.classList.add('hidden');
            focusManager.unregister('player-error');
        }

        try {
            this._showLoading(true);

            if (forceTranscode) {
                this._forceTranscode = true;
            }

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
        if (this._item?.isIntro) {
            log.info('Skipping PlaybackStopped report for intro item');
            return;
        }
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

            // 2. Build report body
            const data = {
                ItemId: this._item.Id,
                PlaySessionId: playSessionId,
                MediaSourceId: mediaSource?.Id,
                PositionTicks: positionTicks,

                VolumeLevel: this._player?.getVolume?.() ?? 100,
                IsMuted: this._player?.isMuted?.() ?? false,
                IsPaused: true,
                PlaybackRate: this._player?.getPlaybackSpeed?.() ?? 1,
                SubtitleStreamIndex: this._player?.getCurrentSubtitleStreamIndex?.() ?? -1,
                SecondarySubtitleStreamIndex: this._player?.getCurrentSecondarySubtitleStreamIndex?.() ?? -1,
                AudioStreamIndex: this._player?.getCurrentAudioStreamIndex?.() ?? -1,
                RepeatMode: 'RepeatNone',
                ShuffleMode: 'Sorted',
                CanSeek: true,
                BufferedRanges: [],
                // Use cached play method — player.stop() may clear _currentPlayMethod
                // before this report fires. Map 'Remux' to 'DirectStream' since the server
                // has no 'Remux' enum value and will return HTTP 400 otherwise.
                // Fall back to 'DirectPlay' ONLY if we truly have nothing — which shouldn't
                // happen if _reportPlaybackStart cached correctly.
                PlayMethod: (() => {
                    const raw = this._cachedPlayMethod || this._player?._currentPlayMethod;
                    if (!raw) return mediaSource?.TranscodingUrl ? 'DirectStream' : 'DirectPlay';
                    return raw === 'Remux' ? 'DirectStream' : raw;
                })()
            };

            // 2.5 Inject SyncPlay tracking fields if active
            const spm = window.__syncPlayManager;
            if (spm && spm.isEnabled) {
                if (spm._currentPlaylistItemId) {
                    data.PlaylistItemId = spm._currentPlaylistItemId;
                }
                const queue = spm.currentPlayQueue;
                if (queue && queue.Playlist && queue.Playlist.length > 0) {
                    data.NowPlayingQueue = queue.Playlist.map((item) => ({
                        Id: item.ItemId,
                        PlaylistItemId: item.PlaylistItemId
                    }));
                }
            }

            // 2.6 Close Live Stream if applicable
            if (mediaSource?.LiveStreamId) {
                log.info('Closing Live Stream:', mediaSource.LiveStreamId);
                // Call asynchronously to avoid blocking the stopped report
                api.closeLiveStream(mediaSource.LiveStreamId).catch((err) => {
                    log.warn('Failed to close live stream:', err);
                });
            }

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

    /**
     * Stop playback and navigate back to the previous page.
     *
     * @param {boolean} [clearChain=true]
     *   When true (the default, i.e. user pressed Back), the auto-chain
     *   state flag is deleted so DetailsPage.onInit() does NOT open the
     *   remote trailer — the user explicitly chose to exit.
     *
     *   Pass false when exiting as part of an intentional chain (Next button,
     *   natural end-of-file) so the flag is preserved for DetailsPage to
     *   consume and fire the remote trailer player.
     *
     * @param {string} [reason='userStop']
     *   The reason for stopping playback, passed to the 'player:stopped' event.
     */
    async _stopAndExit(clearChain = true, reason = 'userStop') {
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

        // If clearChain is true (user pressed Back), remove the auto-chain
        // flag so DetailsPage.onInit() does not launch the remote trailer.
        // If clearChain is false (Next/chain exit), leave the flag so the
        // fresh DetailsPage instance picks it up and opens the remote player.
        // ----------------------------------------------------------------
        if (clearChain) {
            state.delete('details:autoChainRemote');
        }

        // Emit for any general listeners; no longer used by the chain logic
        // but kept for potential future use (e.g., analytics, remote control).
        eventBus.emit('player:stopped', { itemId: this._item?.Id, reason });

        // ----------------------------------------------------------------
        // Navigation Override: Ensure we return to the Details page of the
        // item that was LAST playing, not the one that started the session.
        //
        // This is critical for series, collections, and playlists where the
        // user may skip multiple tracks. Returning to the metadata page of
        // the item they were just watching is more intuitive than returning
        // to the initial entry point.
        // ----------------------------------------------------------------
        if (
            this._item &&
            this._item.Id &&
            !this._item.isIntro &&
            this._item.Type !== 'TvChannel' &&
            this._item.Type !== 'Trailer'
        ) {
            const detailsPath = `/details/${this._item.Id}`;

            // The PlayerPage always replaces the page that launched it in history (to prevent bloat).
            // HOWEVER: if we came from a slideshow, we want to go BACK to the slideshow exactly
            // where we left off. In that case, App.js pushed the player instead of replacing,
            // so we just call router.back().
            if (this.params.fromSlideshow === 'true') {
                router.back();
            } else {
                router.navigate(detailsPath, { replace: true, isBack: true });
            }
        } else {
            // Standard back navigation for special types (Live TV, Intros) or if no item state exists.
            router.back();
        }
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
        if (this._onChannelUp) eventBus.off('key:channelUp', this._onChannelUp);
        if (this._onChannelDown) eventBus.off('key:channelDown', this._onChannelDown);

        // Clean up focus sections
        focusManager.unregister('player-error');

        // Clean up OSD (also handled by Component._children cleanup, but explicit is better)
        if (this._osd?.destroy) {
            log.info('Destroying OSD');
            if (this._osd.resetLyrics) this._osd.resetLyrics();
            this._osd.destroy();
        }

        // Clean up music overlay if it exists
        const musicOverlay = document.getElementById('audio-visual-overlay');
        if (musicOverlay) {
            log.info('Removing music audio-visual overlay');
            musicOverlay.remove();
        }

        // Disable Tizen AVPlayer transparency mode and clear state classes
        document.body.classList.remove('player-active', 'lyrics-active');
        document.documentElement.classList.remove('player-active');

        // Restore global clock visibility when leaving playback
        globalClock.setVisibility(true);

        log.info('destroy() complete');
        super.destroy();
    }
    // ========================================================================
    // Live TV Handlers
    // ========================================================================

    /**
     * Update the page title and OSD for Live TV to show current program info.
     * TV Channels use the channel name as base, but for UX we want to show
     * the specific show/program that is currently airing.
     * @private
     */
    async _updateLiveTvTitle() {
        if (!this._item || this._item.Type !== 'TvChannel') return;

        try {
            log.info('Fetching current program for channel:', this._item.Name);
            const programs = await api.getLiveTvPrograms({
                ChannelIds: this._item.Id,
                IsAiring: true,
                Limit: 1
            });

            if (programs && programs.Items && programs.Items.length > 0) {
                const program = programs.Items[0];
                log.info('Current program:', program.Name);

                // Set the page title to "Channel: Program"
                this.title = `${this._item.Name}: ${program.Name}`;

                // Update OSD if it exists
                if (this._osd) {
                    // Enrich program with channel info for better OSD display
                    program.ChannelName = this._item.Name;
                    program.ChannelNumber = this._item.Number || this._item.ChannelNumber;
                    this._osd.updateItem(program);
                }
            }
        } catch (err) {
            log.warn('Failed to fetch current program info:', err);
        }
    }

    /**
     * Handle physical channel up/down button presses.
     * @param {number} direction - 1 for Up, -1 for Down
     * @private
     */
    async _handleChannelChange(direction) {
        if (this._isSwitching) return;
        if (!this._item || this._item.Type !== 'TvChannel') {
            log.debug('Channel change ignored - current item is not a Live TV channel');
            return;
        }

        this._isSwitching = true;
        this._showLoading(true);

        try {
            // 1. Ensure we have the channel list
            if (!this._channels || this._channels.length === 0) {
                this._channels = playQueue.getQueue() || [];
                log.info(`Using ${this._channels.length} channels from PlayQueue for navigation.`);
            }

            if (this._channels.length <= 1) {
                log.info('Only one channel available - nothing to switch to');
                this._showLoading(false);
                this._isSwitching = false;
                return;
            }

            // 2. Find current channel index
            const currentIndex = this._channels.findIndex((c) => c.Id === this._item.Id);
            if (currentIndex === -1) {
                log.warn(`Current channel (${this._item.Name}, ${this._item.Id}) not found in navigation list. Falling back to first channel.`);
                const firstChannel = this._channels[0];
                if (firstChannel.Id === this._item.Id) {
                    log.info('Fallback channel is already playing - ignoring switch.');
                    this._showLoading(false);
                    this._isSwitching = false;
                    return;
                }
                await this._switchChannel(firstChannel);
                return;
            }

            // 3. Calculate next index (with wrapping)
            let nextIndex = currentIndex + direction;
            if (nextIndex < 0) nextIndex = this._channels.length - 1;
            if (nextIndex >= this._channels.length) nextIndex = 0;

            const nextChannel = this._channels[nextIndex];
            log.info(`Switching channel ${direction > 0 ? 'UP' : 'DOWN'} to: ${nextChannel.Name}`);

            // 4. Perform the switch
            await this._switchChannel(nextChannel);
        } catch (err) {
            log.error('Channel switch error:', err);
            this._showError('Failed to switch channel');
        } finally {
            this._isSwitching = false;
        }
    }

    /**
     * Perform an in-place channel switch.
     * This handles stopping the current stream and initializing the new one.
     * @param {Object} nextChannel - The channel iten to play
     * @private
     */
    async _switchChannel(nextChannel) {
        if (!nextChannel || nextChannel.Id === this._item.Id) {
            log.debug('Ignoring channel switch: already on this channel or invalid target');
            return;
        }

        log.info(`[ChannelSwitch] Transitioning from ${this._item.Name} (${this._item.Id}) to ${nextChannel.Name} (${nextChannel.Id})`);

        // Stop current playback cleanly
        if (this._player?.stop) {
            // Capture current info for reporting
            const mediaSource = this._player.getCurrentMediaSource();
            const positionTicks = this._player.getCurrentPositionTicks();

            await this._player.stop();
            await this._reportPlaybackStopped(mediaSource, positionTicks, false);
        }

        // Briefly settle hardware to prevent decoder state overlaps
        await new Promise((r) => setTimeout(r, 400));

        // Update state for new channel
        const oldItem = this._item;
        this._item = nextChannel;
        this.title = nextChannel.Name;
        this._resumePosition = 0;
        this._hasReportedStart = false;
        this._cachedMediaSource = null;

        // Fetch current program info asynchronously so we don't block start
        this._updateLiveTvTitle();

        // Notify OSD
        if (this._osd) {
            this._osd.updateItem(nextChannel);
            this._osd.resetUpNext();
        }

        log.info('[ChannelSwitch] State updated, initializing new playback session...');

        // Start new playback
        await this._startPlayback();

        this._showLoading(false);
    }
}

export default PlayerPage;
