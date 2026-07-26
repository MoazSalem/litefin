/**
 * TizenAVPlayer - Tizen Native Video Backend
 *
 * Uses Tizen's AVPlay API for hardware-accelerated playback on Samsung TVs.
 * Provides better codec support and performance than HTML5 video on Tizen.
 *
 * @module core/TizenAVPlayer
 */

import { MediaHelper } from './MediaHelper.js';
import { logger } from '../../utils/Logger.js';
import { detectTizenVersion, getDeviceCapabilities } from '../../api/profiles/TizenProfile.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';

const log = logger.create('TizenAVPlayer');

// Cache the Tizen firmware version once at module load.
// Used to gate hardware-specific workarounds (e.g. subtitle pause/resume cycle
// is only needed on Tizen 2.4–3.x; Tizen 4.0+ handles it natively).
const TIZEN_VERSION = detectTizenVersion();
const DEVICE_CAPS = getDeviceCapabilities();

// ============================================================================
// TizenAVPlayer Class
// ============================================================================

export class TizenAVPlayer {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - Container element
     * @param {Object} options.settings - Settings manager
     * @param {Function} options.onEvent - Event callback
     */
    constructor(options) {
        this.container = options.container;
        this.settings = options.settings;
        this.onEvent = options.onEvent || (() => {});

        // ====================================================================
        // State
        // ====================================================================

        this._currentSrc = null;
        this._currentPlayOptions = null;
        this._duration = 0;
        this._isPlaying = false;
        this._isTizenPlaying = false;
        this._bufferingComplete = false;
        this._isPrepared = false;
        this._hasEmittedPlaying = false;

        // Volume (Tizen stores 0-100)
        this._volume = MediaHelper.getSavedVolume() * 100;
        this._isMuted = false;

        // Position tracking
        this._positionTimer = null;

        // Pending track selection (applied on buffering complete)
        this._pendingAudioIndex = null;
        this._pendingSubtitleIndex = null;

        // Current track indices (Jellyfin indices)
        this._currentAudioStreamIndex = null;
        this._currentSubtitleStreamIndex = null;

        // Tracks the actively selected internal Tizen TEXT track index
        this._activeTizenSubtitleIndex = null;

        // Subtitle offset in seconds (applied via AVPlay's native API)
        this._subtitleOffset = 0;

        // Suspend/restore state for app backgrounding
        this._suspendedUrl = null;
        this._suspendedPositionMs = 0;
        this._isSuspended = false;
        this._wasPlayingBeforeSuspend = false;

        // Throttle for timeupdate events
        this._lastTimeUpdateTicks = 0;

        // When pause() is called while AVPlay is mid-seek or mid-buffer, the native
        // avplay.pause() call would throw PLAYER_ERROR_INVALID_OPERATION. Instead,
        // we set this flag and apply the native pause the next time _checkNativePlay()
        // is called (which happens when buffering completes). This prevents AVPlay from
        // secretly resuming playback after a SyncPlay-triggered seek+handshake.
        this._pendingPause = false;

        // Safety timeout ID utilized to guarantee post-seek playback state correction.
        // On various Samsung Tizen AVPlay configurations, seeking to cached chunks might
        // not fire buffering events, leaving the player asleep in a READY state.
        this._seekSafetyTimeoutId = null;

        // Guards against calling play() or other AVPlay APIs while seekTo is in progress.
        // Per Samsung docs, no other API may be called between seekTo() and its callback.
        // onbufferingcomplete can fire during seek and would otherwise trigger _checkNativePlay
        // which calls play() — violating the contract and causing native decoder freezes.
        this._seekInProgress = false;

        // Tracks whether onbufferingcomplete fired during an active seek.
        // When seek is in progress, onbufferingcomplete is suppressed (can't call
        // _checkNativePlay). This flag lets the seek success callback know that
        // the hardware buffer is already filled and play() can proceed immediately.
        this._bufferingCompleteDuringSeek = false;

        // Tracks if Tizen AVPlay has actively fired onbufferingstart and is
        // waiting on onbufferingcomplete to refill the network pipeline.
        this._isNativeBuffering = false;

        // Queue for operations that arrive during seek. Per Samsung docs, no
        // AVPlay API calls are permitted between seekTo() and its callback.
        // When play/pause is requested during seek, the operation is saved here
        // and applied after the seek completes.
        this._pendingOpAfterSeek = null;
        // If a second seek arrives while one is in flight, queue it here and
        // execute after the current seek finishes.
        this._queuedSeekPositionMs = null;

        // ── Subtitle API Cooldown ────────────────────────────────────────────
        // Samsung's hardware decoder needs a settling period after
        // setSelectTrack('TEXT') / setSilentSubtitle() calls. Issuing seekTo()
        // during this window causes a permanent native decoder crash that
        // requires a full TV restart. We track the last subtitle API call time
        // and defer seeks that arrive within the cooldown period.
        this._lastSubtitleApiTime = 0;
        this._deferredSeekTicks = null;
        this._deferredSeekTimerId = null;

        // Initial buffer gate timeout ID (3s safety fallback)
        this._initialBufferTimeoutId = null;

        // Check Tizen availability: prioritize webapis (Samsung Hardware API) over tizen (Universal API)
        // On most Samsung TVs, webapis.avplay is the direct hardware interface.
        const avplay = window.webapis?.avplay || window.tizen?.avplay || null;
        this._avplay = avplay;

        if (!this._avplay) {
            log.warn('Tizen AVPlay API not available');
        }
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Create video display area
     * @private
     */
    _createDisplay() {
        if (!this._avplay) return;

        // Get container dimensions for display rect
        const rect = this.container.getBoundingClientRect();
        log.debug('_createDisplay rect:', rect);

        try {
            this._avplay.setDisplayRect(
                Math.round(rect.left),
                Math.round(rect.top),
                Math.round(rect.width),
                Math.round(rect.height)
            );

            // Use LETTER_BOX to preserve aspect ratio
            this._avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');

            // NOTE: Do NOT call tizen.tvwindow.show() here. That API is for TV tuner/HDMI input,
            // not for AVPlay. Calling it can cause the video plane to render above HTML elements.
        } catch (e) {
            log.error('Failed to set display:', e);
        }
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        if (!this._avplay) return;

        try {
            let displayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX'; // Default/Auto

            switch (mode) {
                case 'zoom':
                    displayMethod = 'PLAYER_DISPLAY_MODE_CROPPED_FULL';
                    break;
                case 'stretch':
                    displayMethod = 'PLAYER_DISPLAY_MODE_FULL_SCREEN';
                    break;
                case 'auto':
                default:
                    displayMethod = 'PLAYER_DISPLAY_MODE_LETTER_BOX';
                    break;
            }

            log.info('Setting aspect ratio:', mode, '->', displayMethod);
            this._avplay.setDisplayMethod(displayMethod);
        } catch (e) {
            log.error('Failed to set aspect ratio:', e);
        }
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Start playback
     * @param {Object} options - Play options
     */
    async play(options) {
        if (!this._avplay) {
            throw new Error('Tizen AVPlay not available');
        }

        log.info('Starting playback');

        try {
            // Track if we were actually active to know if a cleanup sleep is needed
            const wasActive = this._isPlaying || this._isPrepared;

            // Stop any existing playback
            await this._stopInternal();

            // Reset state for new playback session:
            // This MUST happen after _stopInternal() as that reset resets these flags.
            this._isPlaying = options.autoPlay !== false; // Signal intent to play
            this._isTizenPlaying = false;
            this._bufferingComplete = false;
            this._isNativeBuffering = false;
            this._isPrepared = false;
            this._hasEmittedPlaying = false;
            this._firstFrameRendered = false;
            this._playbackStabilized = false;
            this._firstFrameTimeMs = 0;
            this._pendingSeekMs = null;
            this._subtitleOffset = 0;
            this._playStartTime = Date.now();
            this._currentPlayOptions = options;

            // Reset the pre-play await tracks timeout safety net
            this._forceTizenPlayPassed = false;
            if (this._readyTrackTimeoutId) {
                clearTimeout(this._readyTrackTimeoutId);
                this._readyTrackTimeoutId = null;
            }

            // Reset the post-seek safety net timer to clear out any stale handlers
            // leftover from previous media items or streams
            this._seekSafetyTimeoutId = null;

            // Only sleep if we just forcefully stopped an active stream
            if (wasActive) {
                // Give Tizen adequate time to tear down the previous decoder (True Reset)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            // Ensure HLS playlist exists before opening the URL (prevents "Unknown Error" on transcode).
            if (options.url && options.url.includes('.m3u8')) {
                await MediaHelper.pollHlsManifest(options.url, () => !this._isPlaying);
            }

            // Open the media
            this._avplay.open(options.url);
            this._currentSrc = options.url; // Set currentSrc after open
            try {
                // Determine if this is a video stream
                const isVideo = options.mediaSource?.MediaStreams?.some(s => s.Type === 'Video');

                if (isVideo) {
                    // 1. ABR Quality Kickstart: Prevent ABR jump stutter by starting at high quality.
                    // If no bitrate is provided, default to a high value (20Mbps) to ensure hardware
                    // requests high quality immediately.
                    const bufferPlaySec = PlayerSettings.get('tizenInitialBuffer') || 6;
                    const bufferResumeSec = PlayerSettings.get('tizenResumeBuffer') || 4;
                    const timeoutSec = 8;
                    const bitrate = options.mediaSource?.Bitrate || 20000000;
                    const isDirectPlay = options.playMethod === 'DirectPlay';

                    // 1. Advanced Property Hints: Accelerate startup & stabilize Wi-Fi
                    // We use individual try-catch and common key variants for maximum compatibility.
                    try {
                        // User's first tip used USER_AGENT (underscore)
                        this._avplay.setStreamingProperty("USER_AGENT", "JellyfinTizenClient");
                    } catch (e) {
                        try {
                            this._avplay.setStreamingProperty("USERAGENT", "JellyfinTizenClient");
                        } catch (e2) {
                            log.warn('Failed to set USER_AGENT/USERAGENT:', e2.message || e2);
                        }
                    }

                    if (!isDirectPlay) {
                        try {
                            // Some TVs prefer BUFFER_SIZE, others SET_BUFFER_SIZE
                            this._avplay.setStreamingProperty("BUFFER_SIZE", "4194304"); 
                        } catch (e) {
                             try {
                                this._avplay.setStreamingProperty("SET_BUFFER_SIZE", "4194304");
                             } catch (e2) {
                                log.warn('Failed to set BUFFER_SIZE/SET_BUFFER_SIZE:', e2.message || e2);
                             }
                        }
                    }
                    
                    // 2. Legacy 4K Mode — DEPRECATED on Tizen 5.0+
                    //    SET_MODE_4K is deprecated since Tizen 5.0. On 5.0+, FIXED_MAX_RESOLUTION
                    //    in ADAPTIVE_INFO (set below) replaces it and handles 4K/8K dynamically.
                    //    On Tizen < 5.0, set it only when the device is UHD-capable AND the
                    //    content is 4K+ (or likely 4K+ based on bitrate when resolution unknown).
                    if (!isDirectPlay && TIZEN_VERSION < 5.0 && DEVICE_CAPS.uhd &&
                        (options.mediaSource?.Height > 1080 || options.mediaSource?.Width > 1920 || options.mediaSource?.Bitrate > 20000000)) {
                        try {
                            this._avplay.setStreamingProperty("SET_MODE_4K", "TRUE");
                        } catch (e) {
                            log.warn('Failed to set SET_MODE_4K:', e.message || e);
                        }
                    }

                    // 3. ABR Quality Kickstart (HLS/Adaptive Only)
                    if (!isDirectPlay) {
                        try {
                            // Derive FIXED_MAX_RESOLUTION from device capabilities + content resolution.
                            // Per Samsung docs, only needed when the manifest doesn't describe resolutions,
                            // but we set it unconditionally as a safety cap so AVPlay never requests
                            // segments beyond what the device can decode.
                            const contentWidth = options.mediaSource?.Width || 0;
                            const contentHeight = options.mediaSource?.Height || 0;
                            let fixedMaxRes;
                            if (contentWidth > 0 && contentHeight > 0) {
                                const w = Math.min(contentWidth, DEVICE_CAPS.screenWidth);
                                const h = Math.min(contentHeight, DEVICE_CAPS.screenHeight);
                                fixedMaxRes = `${w}x${h}`;
                            } else {
                                // No content resolution info — tell AVPlay the device's max so ABR
                                // doesn't limit itself (common with 8K manifests missing resolution data).
                                fixedMaxRes = `${DEVICE_CAPS.screenWidth}x${DEVICE_CAPS.screenHeight}`;
                            }

                            const props = [
                                `FIXED_MAX_RESOLUTION=${fixedMaxRes}`,
                                'STARTBITRATE=HIGHEST', // Force hardware to skip ramp-up delay
                                'USER_AGENT=JellyfinTizenClient', // Modern way to set UA in 5.0+
                                `INITIAL_BUFFER_DURATION=${bufferPlaySec * 1000}`,
                                `RESUME_BUFFER_DURATION=${bufferResumeSec * 1000}`
                            ].join('|');
                            this._avplay.setStreamingProperty("ADAPTIVE_INFO", props);
                            log.info(`Hardware ABR Optimized: STARTBITRATE=HIGHEST, UA=Jellyfin, FIXED_MAX_RESOLUTION=${fixedMaxRes}`);
                        } catch (e) {
                             log.warn('Failed to set hls-specific properties:', e.message || e);
                        }
                    }

                    // 2. Hardware-Level Stabilization: Buffering Param Control
                    // Based on Samsung documentation: setBufferingParam is the primary control.
                    const _avplay = window.webapis?.avplay || window.tizen?.avplay || this._avplay;
                    let bufferResult = "None";

                    if (_avplay && typeof _avplay.setBufferingParam === 'function') {
                        try {
                            // Initial playback buffer
                            _avplay.setBufferingParam("PLAYER_BUFFER_FOR_PLAY", "PLAYER_BUFFER_SIZE_IN_SECOND", bufferPlaySec);
                            
                            // Rebuffer after stall/seek
                            _avplay.setBufferingParam("PLAYER_BUFFER_FOR_RESUME", "PLAYER_BUFFER_SIZE_IN_SECOND", bufferResumeSec);
                            
                            // Buffering timeout (how long to wait before triggering bufferingcomplete)
                            if (typeof _avplay.setTimeoutForBuffering === 'function') {
                                _avplay.setTimeoutForBuffering(timeoutSec);
                            }
                            
                            bufferResult = `Thresholds (${bufferPlaySec}s/${bufferResumeSec}s)`;
                        } catch (e) {
                            log.warn(`setBufferingParam failed: ${e.message || e}`);
                            
                            // Legacy Fallback Tier 2: setBufferSize (Bytes)
                            if (typeof _avplay.setBufferSize === 'function') {
                                try {
                                    const finalBufferBytes = Math.max(15 * 1024 * 1024, Math.round((bitrate / 8) * bufferPlaySec));
                                    _avplay.setBufferSize(finalBufferBytes);
                                    bufferResult = `Bytes (${Math.round(finalBufferBytes / (1024*1024))}MB)`;
                                } catch (e2) {
                                    log.warn(`setBufferSize fallback failed: ${e2.message || e2}`);
                                }
                            }
                        }
                    }

                    // Tier 3: Emergency Property Fallback (Broadest compatibility)
                    if (bufferResult === "None" && !isDirectPlay) {
                        try {
                            // Some older firmware only accepts SET_BUFFER_SIZE as a streaming property
                            this._avplay.setStreamingProperty("SET_BUFFER_SIZE", `${bufferPlaySec}`);
                            bufferResult = "Property Escape Hatch";
                        } catch (e) {
                            log.error('Hardware buffer lock failed:', e.message || e);
                        }
                    }

                    log.info(`Hardware Buffer Strategy: ${bufferResult}`);
                }
            } catch (e) {
                log.warn('Failed to apply hardware buffer optimizations:', e.message || e);
            }

            // Set up event listeners
            this._setupListeners();

            // Only queue native track selection for DirectPlay.
            // During Transcode/DirectStream, audio is baked into the HLS output,
            // so AVPlay only has one muxed audio track — calling setSelectTrack
            // would either silently fail or cause spurious errors, and it retried
            // on every onbufferingcomplete invocation (seeking, re-buffers, etc.).
            const isDirectPlay = options.playMethod === 'DirectPlay';

            // CRITICAL: Set pending indices BEFORE prepareAsync(), not after!
            // onbufferingcomplete fires DURING prepareAsync phase, which is when
            // _applyPendingTracks() runs. Setting these after would mean they're
            // always null when the handler fires, silently dropping initial track selection.
            if (isDirectPlay && options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                this._pendingAudioIndex = options.audioStreamIndex;
            } else {
                this._pendingAudioIndex = null;
            }

            if (isDirectPlay && options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null && options.subtitleStreamIndex !== -1) {
                const playability = this._getSubtitlePlayability(options.subtitleStreamIndex);
                
                if (playability === 'EXTERNAL') {
                    // HTML Subtitle manager handles this. Tell native player to disable its own subs.
                    this._pendingSubtitleIndex = -1;
                    this._delayedSubtitleIndex = -1;
                } else if (playability === 'INTERNAL_BITMAP') {
                    // Bitmap subtitle (PGS, VobSub): Tizen AVPlay CANNOT render these natively,
                    // but SubtitleManager already knows this and has chosen PGS_BITMAP delivery
                    // (via _determineDeliveryMethod). It will set up PGSRenderer and fetch the
                    // .sup file independently from the Jellyfin API.
                    //
                    // We do NOT emit subtitlefallback here — that would race against the async
                    // setSubtitleStreamIndex() call in JellyfinPlayer, calling forceExternalTextFallback()
                    // on an empty SubtitleManager state and overwriting the PGSRenderer setup with
                    // a broken EXTERNAL_TEXT/VTT fetch (Jellyfin cannot convert PGS bitmaps to text).
                    //
                    // All we need to do is silence AVPlay's own subtitle rendering so it doesn't
                    // attempt to display the raw PGS data as garbage text.
                    this._pendingSubtitleIndex = -1;   // → _applyPendingTracks will call setSilentSubtitle(true)
                    this._delayedSubtitleIndex = -1;
                } else {
                    // It's a supported internal text subtitle. Poll natively.
                    this._pendingSubtitleIndex = options.subtitleStreamIndex;
                    this._delayedSubtitleIndex = options.subtitleStreamIndex; // Used for Tizen 5.0 re-apply
                }
            } else if (isDirectPlay && options.subtitleStreamIndex === -1) {
                this._pendingSubtitleIndex = -1;
                this._delayedSubtitleIndex = -1;
            } else {
                this._pendingSubtitleIndex = null;
                this._delayedSubtitleIndex = null;
            }
            if (options.playerStartPositionTicks) {
                const startMs = options.playerStartPositionTicks / 10000;

                // ── Deferred resume seek (subtitle-first ordering) ─────────────────────────────
                //
                // We intentionally skip seekTo() here in the READY state.
                //
                // Seeking before play() initializes the VIDEO decoder from the
                // correct position, but leaves Tizen's SUBTITLE cue parser at
                // position 0. When AVPlay then renders frames at e.g. 51 minutes,
                // the subtitle parser is looking for cues near 0:00 that will never
                // arrive — so subtitles are completely silent on resume.
                //
                // The fix: store startMs in _pendingSeekMs and let the flow go:
                //   1.  play() from 0:00  →  subtitle decoder initializes at start
                //   2.  first frame renders  →  _applyPendingTracks selects subtitle
                //   3.  seekTo(startMs)  →  video jumps to resume position
                //   4.  200ms later  →  subtitle re-applied (seek can reset it)
                //   5.  4s confirm timer  →  final belt-and-suspenders re-apply
                //
                // If there is NO native subtitle pending (_pendingSubtitleIndex is
                // null or -1), the seek is applied at first-frame render instead,
                // which preserves the fast "seek once, play from target" behaviour.
                // ────────────────────────────────────────────────────────────────────────────
                log.info(`Deferring resume seek to ${startMs}ms until after subtitle track is confirmed`);
                this._pendingSeekMs = startMs;
            }

            // Some firmware resets display state during prepare — re-apply after.
            this._createDisplay();

            // Prepare asynchronously
            await this._prepareAsync();

            // Re-apply display rect after prepare (some firmware resets it).
            this._createDisplay();

            // A tiny delay avoids internal decoder race conditions
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Metadata is now loaded, display is ready, and seek position is set.
            // If awaitTracksBeforePlayback is enabled, we set up a 2-second safety timeout
            // to bypass the track selection gate in case header parsing deadlocks the player.
            const awaitTracks = PlayerSettings.get('awaitTracksBeforePlayback');
            const hasPending = this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null;

            if (awaitTracks && hasPending) {
                log.info('Await tracks before playback is enabled. Setting 2s safety timeout.');
                if (this._readyTrackTimeoutId) clearTimeout(this._readyTrackTimeoutId);
                this._readyTrackTimeoutId = setTimeout(() => {
                    this._readyTrackTimeoutId = null;
                    log.debug('READY-state safety timeout fired (checking conditions)');
                    if (this._avplay && this._isPrepared && !this._forceTizenPlayPassed) {
                        log.warn('READY-state safety timeout reached. Forcing play to prevent TV UI deadlock.');
                        this._forceTizenPlayPassed = true;
                        // Bypass _bufferingComplete gate — if onbufferingcomplete never
                        // fired (stale decoder state on resume), we must still attempt
                        // play() or the player hangs in READY forever.
                        this._bufferingComplete = true;
                        this._checkNativePlay();
                    }
                }, 2000);
            }

            // Initial buffer gate: 3s timeout fallback.
            // If onbufferingcomplete never fires (unstable network or firmware quirk),
            // force the gate open so the stream starts instead of hanging in READY.
            this._initialBufferTimeoutId = setTimeout(() => {
                this._initialBufferTimeoutId = null;
                if (this._avplay && this._isPrepared && !this._bufferingComplete) {
                    log.warn('Initial buffer timeout (3s) — forcing play');
                    this._bufferingComplete = true;
                    this._checkNativePlay();
                }
            }, 3000);

            // Check if we can start native playback yet (requires buffering complete).
            this._checkNativePlay();

            // Initialize current indices
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;

            // Start position tracking
            this._startPositionTracking();

            this.onEvent({ type: 'playbackstart' });
        } catch (e) {
            log.error('Playback failed:', e);
            this.onEvent({ type: 'error', data: { message: e.message } });
            throw e;
        }
    }

    /**
     * Prepare media asynchronously
     * @private
     */
    _prepareAsync() {
        return new Promise((resolve, reject) => {
            try {
                this._avplay.prepareAsync(
                    () => {
                        log.info('Media prepared (decoder ready)');
                        this._isPrepared = true;
                        this._duration = this._avplay.getDuration();
                        
                        // Emit loadedmetadata so OSD can update duration/chapters
                        this.onEvent({ 
                            type: 'loadedmetadata', 
                            data: { duration: this._duration / 1000 } 
                        });

                        // ================================================================
                        // IMPROVEMENT A: Eager one-shot track mapping in READY state.
                        //
                        // The recommended production flow (Plex/Emby style) is:
                        //   open → prepareAsync → getTotalTrackInfo → play
                        //
                        // On Tizen 4.x/5.5+, track info is fully populated right after
                        // prepare, before play() is ever called.  Attempting a track switch
                        // in the READY state here means subtitle/audio selection fires
                        // instantly instead of waiting for the first oncurrentplaytime tick.
                        //
                        // On older Tizen (2.4–3.x) this call returns empty arrays, so it
                        // does nothing and the existing oncurrentplaytime polling loop is
                        // still the safety net.  No harm done either way.
                        // ================================================================
                        if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null) {
                            log.debug('prepareAsync: attempting eager pre-play track selection');
                            this._applyPendingTracks();
                        }

                        // Check if we can start native playback now that preparation is complete
                        this._checkNativePlay();
                        resolve();
                    },
                    (error) => {
                        log.error('Prepare failed:', error);
                        reject(new Error('Failed to prepare media'));
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Set up Tizen AVPlay listeners
     * @private
     */
    _setupListeners() {
        if (!this._avplay) return;

        const listener = {
            onbufferingstart: () => {
                log.debug('Buffering started');
                this._hasEmittedPlaying = false; // Reset so 'playing' fires again upon resume

                // Invalidate the buffering-complete flag. The previous buffer is
                // no longer valid — the hardware is actively refilling. Without
                // this reset, _checkNativePlay() could fire play() against stale
                // _bufferingComplete=true state while the decoder is mid-rebuffer,
                // permanently freezing the pipeline on some Tizen firmware/files.
                this._bufferingComplete = false;
                this._isNativeBuffering = true;

                if (this._isPlaying && !this._suppressWaitingEvent) {
                    this.onEvent({ type: 'waiting' });
                }
            },
            onbufferingprogress: (percent) => {
                // Buffering progress (0-100)
            },
            onbufferingcomplete: () => {
                if (this._initialBufferTimeoutId) {
                    clearTimeout(this._initialBufferTimeoutId);
                    this._initialBufferTimeoutId = null;
                }
                log.info('Buffering complete (network threshold reached)');
                this._bufferingComplete = true;
                this._isNativeBuffering = false;

                // Track transition point: Buffer is full but clock hasn't started yet.
                // Apply pending tracks now. If they fail (e.g., Tizen needs more time to parse text),
                // they remain pending and get picked up by oncurrentplaytime.
                if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null) {
                    this._applyPendingTracks();
                }

                // During an active seek, skip _checkNativePlay and _emitPlaying.
                // The seekTo success callback will handle playback resume once the
                // seek completes. Calling play() while seekTo is in progress violates
                // Samsung's AVPlay API contract and can cause native decoder freezes.
                if (!this._seekInProgress) {
                    this._checkNativePlay();

                    if (this._isPlaying && this._isTizenPlaying) {
                        this._emitPlaying();
                    }
                } else {
                    // Buffering completed while seek was in progress. Record this
                    // so the seek success callback knows the hardware buffer is
                    // ready and can immediately call _checkNativePlay() without
                    // waiting for another onbufferingcomplete event that will
                    // never arrive (since it already fired here).
                    this._bufferingCompleteDuringSeek = true;
                    log.debug('onbufferingcomplete suppressed during seek — flagged for post-seek resume');
                }

                // Note: If playback hasn't started natively yet, _checkNativePlay() handles 
                // calling play() and emitting the initial 'playing' event.
            },
            oncurrentplaytime: (time) => {
                // Track when the first frame has actually rendered (time >= 0).
                // This is independent of the 'playing' event — onbufferingcomplete may
                // have already emitted 'playing', but that doesn't mean frames are drawing.
                // Pending subtitle tracks are gated on this flag to avoid silent no-ops.
                if (!this._firstFrameRendered && time >= 0) {
                    this._firstFrameRendered = true;
                    this._firstFrameTimeMs = Date.now();

                    // Apply the deferred resume seek only if there is NO native subtitle
                    // track pending. If a subtitle IS pending, the seek is deferred further
                    // to _applyPendingTracks where it fires AFTER the track is confirmed
                    // applied — this guarantees the subtitle cue parser initialises before
                    // the decoder jumps to the resume position.
                    //
                    // If there's no subtitle (or it's set to -1/disabled), seek normally.
                    if (this._pendingSeekMs !== null &&
                        (this._pendingSubtitleIndex === null || this._pendingSubtitleIndex === -1)) {
                        const seekMs = this._pendingSeekMs;
                        this._pendingSeekMs = null;
                        log.info(`Resume seek to ${seekMs}ms (post first frame, no subtitle pending)`);
                        this._safeSeekTo(seekMs, null, (e) => {
                            log.warn('Resume seek failed:', e);
                        });
                    }
                }

                // Track when playback has stabilized (e.g. 1000ms of actual playback).
                // Used to delay the re-application of subtitles on Tizen 5.0, as
                // pausing/resuming immediately on the first frame triggers buffering loops.
                // We base this on real time watched, not absolute media time (which could resume >1000ms).
                if (!this._playbackStabilized && this._firstFrameTimeMs && (Date.now() - this._firstFrameTimeMs >= 1000)) {
                    this._playbackStabilized = true;
                }

                // timeupdate fires as frames are drawn. 
                // We emit 'playing' only after the first frame has rendered (time >= 0).
                // On some Tizen versions, time might stay at 0 for a moment after buffering complete,
                // so we gate it on time >= 0 to be definitive.
                if (this._isPlaying && !this._hasEmittedPlaying && time >= 0) {
                    log.debug(`First frame rendered (time ${time}), emitting playing`);
                    this._hasEmittedPlaying = true;
                    this.onEvent({ type: 'playing' });
                }

                // AVPlay tracks are definitively fully populated once frames start rendering.
                // Apply pending tracks now. If they fail (e.g. index out of bounds or missing),
                // they remain pending. We try for up to 5 seconds of watch time on older Tizen,
                // then drop them to prevent infinite API polling performance penalties.
                if (this._seekInProgress || this._deferredSeekTimerId !== null) {
                    log.debug('oncurrentplaytime: deferring track applications — seek in progress or deferred');
                } else if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null || (this._playbackStabilized && this._delayedSubtitleIndex !== null)) {
                    
                    // Throttle track parsing check to every 500ms. Since oncurrentplaytime fires
                    // almost continuously, spamming getTotalTrackInfo() synchronously locks
                    // the TV's JavaScript thread and freezes the video frame for 5 seconds.
                    const now = Date.now();
                    if (!this._lastTrackPollTime || now - this._lastTrackPollTime > 500) {
                        this._lastTrackPollTime = now;
                        this._applyPendingTracks();
                    }
                    
                    if (this._firstFrameTimeMs && (Date.now() - this._firstFrameTimeMs > 5000)) {
                        if (this._pendingAudioIndex !== null) {
                            log.warn('Pending audio track dropped (timeout)');
                            this._pendingAudioIndex = null;
                        }
                        if (this._pendingSubtitleIndex !== null || this._delayedSubtitleIndex !== null) {
                            log.warn('Pending/delayed subtitle track dropped (timeout), requesting external fallback');
                            
                            // Capture the index before we null it out
                            const failedSubIndex = this._pendingSubtitleIndex !== null ? this._pendingSubtitleIndex : this._delayedSubtitleIndex;
                            
                            this._pendingSubtitleIndex = null;
                            this._delayedSubtitleIndex = null;
                            
                            // Since Tizen failed to map or load the hardware track after 5 seconds,
                            // immediately notify the player logic so it can fetch the subtitle via API 
                            // and render it in HTML (perfect fallback for unsupported formats or bugs)
                            if (failedSubIndex !== null && failedSubIndex !== -1) {
                                this.onEvent({
                                    type: 'subtitlefallback',
                                    data: { index: failedSubIndex }
                                });
                            }

                            // Subtitle failed — flush the deferred seek now so the user
                            // isn't stranded at 0:00. No subtitle re-apply needed since
                            // we just gave up on the native track.
                            if (this._pendingSeekMs !== null) {
                                const stuckSeekMs = this._pendingSeekMs;
                                this._pendingSeekMs = null;
                                log.warn(`[SubtitleSeek] Subtitle timed out — flushing deferred seek to ${stuckSeekMs}ms`);
                                this._safeSeekTo(stuckSeekMs, null, (e) => {
                                    log.warn('[SubtitleSeek] Deferred seek after subtitle timeout failed:', e);
                                });
                            }
                        }
                    }
                }

                // This is called periodically with current time in ms
                // Throttle to ~250ms to reduce main thread load on slow TVs
                const currentTime = this.getCurrentTime();
                const currentTimeTicks = Math.floor(currentTime * 10000000);
                
                if (Math.abs(currentTimeTicks - this._lastTimeUpdateTicks) > 2500000) {
                    this._lastTimeUpdateTicks = currentTimeTicks;
                    this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
                }
            },
            onevent: (eventType, eventData) => {
                log.debug('Event:', eventType, eventData);
            },
            onstreamcompleted: () => {
                log.info('Playback completed');
                this._isPlaying = false;
                this._isTizenPlaying = false;
                this.onEvent({ type: 'ended' });
            },
            onerror: (eventType) => {
                log.error('Error:', eventType);
                this.onEvent({ type: 'error', data: { message: eventType } });
            },
            onsubtitlechange: (duration, text, type, attributes) => {
                // Emit event with subtitle text so the UI layer can display it
                this.onEvent({
                    type: 'subtitlechange',
                    data: { text: text || '', duration: duration, subType: type, attributes }
                });
            },
            ondrmevent: (drmEvent, drmData) => {
                // DRM events
            }
        };

        this._avplay.setListener(listener);
    }

    /**
     * Set playback speed
     * @param {number} speed
     */
    setSpeed(speed) {
        if (this._avplay && this._isPrepared) {
             try {
                 this._avplay.setSpeed(speed);
             } catch (e) {
                 log.error('Failed to set speed:', speed, e);
             }
        }
    }

    /**
     * Apply any pending audio/subtitle track selections
     * @private
     */
    _applyPendingTracks() {
        if (!this._avplay || !this._isPrepared) return;

        if (this._seekInProgress || this._deferredSeekTimerId !== null) {
            log.debug('_applyPendingTracks deferred — seek in progress or deferred');
            return;
        }

        // Per Samsung docs, getTotalTrackInfo() is valid in PLAYING and PAUSED.
        // READY is only valid when using synchronous prepare() — we use prepareAsync().
        let guardState = 'UNKNOWN';
        try { guardState = this._avplay.getState(); } catch (_) {}
        if (guardState !== 'PLAYING' && guardState !== 'PAUSED') {
            log.debug(`_applyPendingTracks deferred — AVPlay state is '${guardState}', not PLAYING/PAUSED`);
            return;
        }

        const trackInfo = this._avplay.getTotalTrackInfo() || [];
        
        // If track info is completely empty, older Tizen might still be parsing headers.
        // Return early to try again on next timeupdate/buffering event.
        if (trackInfo.length === 0) {
            log.debug('_applyPendingTracks: No track info available yet, will retry...');
            return;
        }

        if (this._pendingAudioIndex !== null) {
            // For HLS/DASH, setSelectTrack('AUDIO', ...) is only valid in PLAYING state
            // per Samsung docs. Defer if not playing yet — oncurrentplaytime will retry.
            let avplayState = 'UNKNOWN';
            try { avplayState = this._avplay.getState(); } catch (_) {}
            if (avplayState !== 'PLAYING') {
                log.debug(`Audio track selection deferred — AVPlay state is '${avplayState}', not PLAYING`);
            } else {
                const tizenAudioIndex = this._findTizenAudioIndex(this._pendingAudioIndex);
                if (tizenAudioIndex !== null) {
                    try {
                        this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                        this._pendingAudioIndex = null;
                    } catch (e) {
                        if (e.name === 'InvalidStateError' || e.code === 11) {
                             log.debug(`Postponing audio track ${tizenAudioIndex} (InvalidStateError)`);
                        } else {
                            log.warn('Failed to apply audio track:', e);
                            this._pendingAudioIndex = null;
                        }
                    }
                } else {
                    const totalTracks = this._avplay.getTotalTrackInfo() || [];
                    if (totalTracks.some(t => t.type === 'AUDIO')) {
                        log.warn(`Could not map pending audio index ${this._pendingAudioIndex}`);
                        this._pendingAudioIndex = null;
                    }
                }
            }
        }

        // Apply subtitle tracks eagerly (works on Tizen 5.5+), but only CLEAR
        // _pendingSubtitleIndex once the first frame has rendered. This way, on
        // Tizen 5.0 where setSelectTrack silently no-ops during buffering, the
        // track gets re-applied from oncurrentplaytime once frames are drawing.
        if (this._pendingSubtitleIndex !== null) {
            if (this._pendingSubtitleIndex === -1) {
                try {
                    this._avplay.setSilentSubtitle(true);
                    this._lastSubtitleApiTime = Date.now();
                    this._pendingSubtitleIndex = null;
                    this._delayedSubtitleIndex = null;
                    this._activeTizenSubtitleIndex = -1;
                } catch (e) {
                    log.warn('Failed to disable subtitles:', e);
                }
            } else {
                // ================================================================
                // IMPROVEMENT C: State gate before setSelectTrack('TEXT', ...).
                //
                // Per Samsung docs, setSelectTrack('TEXT', ...) is valid in PLAYING
                // and PAUSED for HLS/DASH (READY is Smooth Streaming only). We defer
                // to oncurrentplaytime if not in a valid state.
                //
                // The _delayedSubtitleIndex post-stabilization path provides a retry
                // for firmware where early calls silently no-op.
                // ================================================================
                let avplayState = 'UNKNOWN';
                try { avplayState = this._avplay.getState(); } catch (_) {}

                const isValidForText = avplayState === 'PLAYING' || avplayState === 'PAUSED';

                if (!isValidForText) {
                    log.debug(`Subtitle track selection deferred — AVPlay state is '${avplayState}', not PLAYING/PAUSED`);
                    // Leave _pendingSubtitleIndex set for the next oncurrentplaytime retry.
                } else {
                    const tizenSubIndex = this._findTizenSubtitleIndex(this._pendingSubtitleIndex);
                    if (tizenSubIndex !== null) {
                        try {
                            log.debug(`Attempting${avplayState === 'READY' ? ' (eager READY-state)' : ''} apply of TEXT track index ${tizenSubIndex}`);
                            this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                            this._avplay.setSilentSubtitle(true);
                            this._avplay.setSilentSubtitle(false);
                            log.info(`TEXT track ${tizenSubIndex} applied in ${avplayState} state`);
                            this._lastSubtitleApiTime = Date.now();
                            this._pendingSubtitleIndex = null; // Clear so we don't spam oncurrentplaytime
                            this._activeTizenSubtitleIndex = tizenSubIndex; // Track active selection

                            // ── 4-second confirmation re-apply ──────────────────────────────────────────
                            //
                            // Some Tizen firmware silently ignores setSelectTrack() during the early
                            // READY/buffering phase — the call doesn't throw but the decoder ignores it.
                            // After 4 seconds the hardware is fully settled and a second unconditional
                            // re-apply guarantees the correct track is active.
                            //
                            // No pause/resume — just the exact same raw setSelectTrack + setSilentSubtitle
                            // toggle that ran above, repeated once more. The timer is cancelled if the
                            // user picks a different track or playback stops before it fires.
                            // ────────────────────────────────────────────────────────────────────────────
                            if (this._subtitleConfirmTimerId !== null) clearTimeout(this._subtitleConfirmTimerId);
                            const _confirmedTizenIndex = tizenSubIndex; // capture for closure
                            this._subtitleConfirmTimerId = setTimeout(() => {
                                this._subtitleConfirmTimerId = null;

                                // Bail out if the session ended or the user changed tracks since we queued
                                if (!this._avplay || !this._isPrepared || !this._isPlaying) return;
                                if (this._activeTizenSubtitleIndex !== _confirmedTizenIndex) return;

                                // CRITICAL: Do NOT call setSelectTrack or any AVPlay API while
                                // seekTo is in progress. Per Samsung docs, no other API may be
                                // called between seekTo() and its callback. Doing so causes a
                                // permanent decoder freeze. The seek's own post-seek subtitle
                                // re-apply path handles track restoration after seek completes.
                                if (this._seekInProgress) {
                                    log.debug('[SubtitleConfirm] Skipped — seek in progress, deferring to post-seek re-apply');
                                    return;
                                }

                                // Per Samsung docs, setSelectTrack('TEXT', ...) is only valid in
                                // PLAYING or PAUSED for HLS. Skip if state has changed.
                                let confirmState = 'UNKNOWN';
                                try { confirmState = this._avplay.getState(); } catch (_) {}
                                if (confirmState !== 'PLAYING' && confirmState !== 'PAUSED') {
                                    log.debug(`[SubtitleConfirm] Skipped — AVPlay state is '${confirmState}', not PLAYING/PAUSED`);
                                    return;
                                }

                                try {
                                    log.info(`[SubtitleConfirm] Re-applying TEXT track ${_confirmedTizenIndex} at +4s to ensure hardware compliance`);
                                    this._avplay.setSelectTrack('TEXT', _confirmedTizenIndex);
                                    this._avplay.setSilentSubtitle(true);
                                    this._avplay.setSilentSubtitle(false);
                                    this._lastSubtitleApiTime = Date.now();
                                } catch (e) {
                                    log.warn('[SubtitleConfirm] Re-apply failed:', e.message || e);
                                }
                            }, 4000);

                            // ── Deferred resume seek (fires once subtitle is confirmed) ───────────────
                            //
                            // The deferred seek was held here to allow Tizen's subtitle cue
                            // parser to initialize from position 0 before we jump to the
                            // resume timestamp. Now that the track is selected, do the seek.
                            // seekTo() sometimes resets Tizen's TEXT track selection, so we
                            // schedule a 200ms re-apply immediately after to restore it.
                            // ─────────────────────────────────────────────────────────────────────────
                            if (this._pendingSeekMs !== null) {
                                const seekMs = this._pendingSeekMs;
                                const seekSubIndex = tizenSubIndex; // capture for post-seek closure
                                this._pendingSeekMs = null; // consume now to prevent double-apply

                                log.info(`[SubtitleSeek] Subtitle confirmed — seeking to resume position ${seekMs}ms (deferred via setTimeout to decouple from subtitle call stack)`);

                                // Defer the seek to decouple it from the subtitle call chain.
                                // After a close+open cycle on resume, the decoder is in a
                                // transitional state. Calling _safeSeekTo immediately after
                                // setSelectTrack + setSilentSubtitle calls within the same
                                // execution tick can overwhelm the native AVPlay pipeline,
                                // causing a permanent decoder hang.
                                // Re-apply the subtitle track in the seekTo success callback.
                                // seekTo() can internally reset the active TEXT track on some
                                // Tizen firmware. Using the success callback instead of a raw
                                // timer ensures we only re-apply after seek completes.
                                setTimeout(() => {
                                    this._safeSeekTo(
                                        seekMs,
                                        () => {
                                            if (!this._avplay || !this._isPrepared || !this._isPlaying) return;
                                            if (this._activeTizenSubtitleIndex !== seekSubIndex) return;

                                            let seekState = 'UNKNOWN';
                                            try { seekState = this._avplay.getState(); } catch (_) {}
                                            if (seekState !== 'PLAYING' && seekState !== 'PAUSED') {
                                                log.debug(`[SubtitleSeek] Skipped — AVPlay state is '${seekState}', not PLAYING/PAUSED`);
                                                return;
                                            }

                                            try {
                                                log.info(`[SubtitleSeek] Post-seek re-apply of TEXT track ${seekSubIndex}`);
                                                this._avplay.setSelectTrack('TEXT', seekSubIndex);
                                                this._avplay.setSilentSubtitle(true);
                                                this._avplay.setSilentSubtitle(false);
                                                this._lastSubtitleApiTime = Date.now();
                                            } catch (e) {
                                                log.warn('[SubtitleSeek] Post-seek subtitle re-apply failed:', e.message || e);
                                            }
                                        },
                                        (e) => {
                                            log.warn('[SubtitleSeek] Deferred resume seek failed:', e);
                                        }
                                    );
                                }, 0);
                            }
                        } catch (e) {
                            // If Tizen returns InvalidStateError, keep trying in the loop.
                            if (e.name === 'InvalidStateError' || e.code === 11) {
                                 log.debug(`Postponing subtitle track ${tizenSubIndex} (InvalidStateError)`);
                            } else {
                                log.warn(`Apply of subtitle track ${tizenSubIndex} failed (will retry after stabilization):`, e);
                                // Do NOT clear _pendingSubtitleIndex. Let it stay pending so that
                                // the post-stabilization retry logic can attempt setSubtitleStreamIndex
                                // once the decoder is fully ready.
                            }
                        }
                    } else {
                        // _findTizenSubtitleIndex returned null — either the requested track
                        // doesn't exist in Tizen's TEXT list yet, or we've hit the hard limit.
                        // Check if we have definitively hit the 30-track ceiling.
                        const totalTracks = this._avplay.getTotalTrackInfo() || [];
                        const textTracks = totalTracks.filter(t => t.type === 'TEXT');
                        
                        // We only want to declare a HARD MISS (out of bounds) if the player
                        // has definitively parsed a significant number of tracks or if we've
                        // reached the 5 second timeout (handled outside this function).
                        // Tizen parse limit is 30. If we have >0 tracks but haven't found ours yet,
                        // Tizen might still be parsing tracks 2, 3, 4, etc.
                        // We will only fail early if we hit the hard 30 track limit and our
                        // requested track still isn't there. Otherwise, we let the oncurrentplaytime
                        // timeout logic handle the 5-second drop.
                        if (textTracks.length >= 30) {
                            log.warn(`Could not map pending subtitle index ${this._pendingSubtitleIndex} within Tizen 30-track limit, disabling native subtitles and requesting fallback`);
                            try {
                                this._avplay.setSilentSubtitle(true);
                                this._lastSubtitleApiTime = Date.now();
                            } catch(e){}
                            
                            const failedIndex = this._pendingSubtitleIndex;
                            this._pendingSubtitleIndex = null;
                            this._delayedSubtitleIndex = null;
                            
                            // Emit event back to JellyfinPlayer to trigger forceExternalTextFallback
                            // This handles initial tracks that exceed Tizen's 30-track limit
                            this.onEvent({
                                type: 'subtitlefallback',
                                data: { index: failedIndex }
                            });
                        }
                        // Else: AVPlay hasn't parsed text tracks up to our index yet. Remain pending.
                    }
                }
            }
        } else if (this._playbackStabilized && this._delayedSubtitleIndex !== null && this._delayedSubtitleIndex !== -1) {
            if (this._seekInProgress) {
                // Defer post-stabilization subtitle re-apply if a seek is currently in progress.
                // Doing so avoids calling setSelectTrack during seekTo, which freezes the player.
                // By not clearing _delayedSubtitleIndex, the next timeupdate tick after seek completion will pick it up.
                log.debug('oncurrentplaytime: deferring post-stabilization subtitle re-apply — seek in progress');
            } else {
                const savedIndex = this._delayedSubtitleIndex;
                this._delayedSubtitleIndex = null;
                try {
                    log.info(`Re-applying subtitle track ${savedIndex} via setSubtitleStreamIndex (post-stabilization)`);
                    this.setSubtitleStreamIndex(savedIndex);
                } catch (e) {
                    log.warn(`Post-stabilization subtitle re-apply failed for index ${savedIndex}:`, e);
                }
            }
        }

        // If all pending tracks are successfully applied, clear the safety timeout and trigger check play
        if (this._pendingAudioIndex === null && this._pendingSubtitleIndex === null) {
            if (this._readyTrackTimeoutId) {
                clearTimeout(this._readyTrackTimeoutId);
                this._readyTrackTimeoutId = null;
            }
            if (PlayerSettings.get('awaitTracksBeforePlayback') && this._isPlaying && !this._isTizenPlaying) {
                log.info('All tracks applied, triggering native check play');
                this._checkNativePlay();
            }
        }
    }

    /**
     * Start position tracking timer
     * @private
     */
    _startPositionTracking() {
        // Position tracking handled by native oncurrentplaytime event to avoid jitter
    }

    /**
     * Gated native playback start. Requires:
     * 1. Intent to play (_isPlaying)
     * 2. Decoder ready (_isPrepared)
     * 3. Hardware buffer filled (_bufferingComplete)
     * @private
     */
    _checkNativePlay() {
        // Guards against calling play() or other AVPlay APIs while seekTo is in progress.
        // Per Samsung docs, calling play() during seekTo violates the contract and causes native freezes.
        if (this._seekInProgress) {
            log.debug('_checkNativePlay() deferred — seek is in progress');
            return;
        }

        // ── Deferred Pause: apply any pending pause BEFORE we potentially start playing.
        //
        // When pause() is called while AVPlay is mid-seek or mid-buffer (returning
        // a non-PLAYING state), we couldn't call avplay.pause() immediately.
        // After the seek/buffer completes, _checkNativePlay() is called again via
        // onbufferingcomplete. At that point, if _pendingPause is set, we apply the
        // native pause now that AVPlay is back in a stable state — preventing it from
        // sneaking back into playback while SyncPlay thinks we're paused.
        if (this._pendingPause && this._avplay && this._isPrepared) {
            try {
                const state = this._avplay.getState();
                if (state === 'PLAYING') {
                    this._avplay.pause();
                    this._pendingPause = false;
                    log.info('_checkNativePlay(): applied deferred pause (post-seek/buffer)');
                }
            } catch (e) {
                log.warn('Deferred pause failed (will retry):', e.message || e);
            }
            // Don't proceed with play — we still want to be paused
            return;
        }

        if (this._isPlaying && this._isPrepared && this._bufferingComplete && !this._isTizenPlaying) {
            // If awaitTracksBeforePlayback is enabled, check if we are still waiting for audio/subtitle tracks to resolve.
            // If they are pending and the safety timeout has not yet bypassed, we hold playback.
            const awaitTracks = PlayerSettings.get('awaitTracksBeforePlayback');
            const hasPending = this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null;

            if (awaitTracks && hasPending && !this._forceTizenPlayPassed) {
                log.info('_checkNativePlay(): deferring play() because tracks are pending');
                return;
            }

            try {
                this._avplay.play();
                this._isTizenPlaying = true;
                log.info('Native play() executed (Double-Gate Strategy: Prepared & Buffered)');

                // IMPROVEMENT D: Proactively silence AVPlay's auto-track behavior.
                //
                // Many Tizen firmwares automatically enable the first internal TEXT
                // track the moment play() succeeds, regardless of any pending track
                // selection.  This causes the wrong subtitle to flash on screen for
                // 1–2 seconds while _applyPendingTracks() races to correct it.
                //
                // The fix: immediately mute all subtitles right after play() starts,
                // before any cue events fire.  _applyPendingTracks() will then:
                //   • unmute nothing  → if the user wanted subtitles OFF (-1)
                //   • select + unmute → if a specific track is pending
                //
                // This is safe even when _pendingSubtitleIndex is null (no subtitle
                // was requested) because setSilentSubtitle(true) is idempotent.
                // ================================================================
                //
                // NOTE: setSilentSubtitle() and setSelectTrack() are only valid when
                // AVPlay state is PLAYING or PAUSED. On resume after close+open,
                // play() may return before the state transitions — calling AVPlay
                // APIs in an intermediate state causes native decoder freezes.
                // ================================================================
                try {
                    let postPlayState = 'UNKNOWN';
                    try { postPlayState = this._avplay.getState(); } catch (_) {}
                    if (postPlayState === 'PLAYING' || postPlayState === 'PAUSED') {
                        this._avplay.setSilentSubtitle(true);
                        log.debug('Proactive subtitle silence applied immediately after play()');

                        // If a specific track was already successfully applied eagerly during READY state,
                        // the proactive silence just muted it. Unmute it to restore visibility.
                        if (this._activeTizenSubtitleIndex !== null && this._activeTizenSubtitleIndex !== -1) {
                            try {
                                this._avplay.setSelectTrack('TEXT', this._activeTizenSubtitleIndex);
                            } catch(e) {}
                            this._avplay.setSilentSubtitle(false);
                            log.debug('Restored silence state (unmuted) for active TEXT track');
                        }
                        this._lastSubtitleApiTime = Date.now();
                    } else {
                        log.debug('Deferred proactive subtitle silence — state is ' + postPlayState + ' after play()');
                    }
                } catch (silenceErr) {
                    // Non-fatal — older firmware may throw in early PLAYING phase.
                    log.warn('Proactive setSilentSubtitle(true/false) failed (non-fatal):', silenceErr.message || silenceErr);
                }

                // Emit 'playing' immediately after play() executes. Since Tizen's 
                // oncurrentplaytime loop only ticks every 500ms, waiting for the first 
                // tick causes audio to leak for half a second behind the loading screen.
                this._emitPlaying();

                // IMPROVEMENT E: Eager seek on forced path.
                //
                // When _forceTizenPlayPassed is true, the safety timeout bypassed
                // the awaitTracksBeforePlayback gate. If _pendingSeekMs is set,
                // apply the seek directly here (after play() + _emitPlaying())
                // instead of deferring to _applyPendingTracks(). This separates
                // seekTo from subtitle operations (setSelectTrack + setSilentSubtitle
                // toggles) that happen in oncurrentplaytime, preventing the rapid
                // succession of AVPlay API calls that causes native hangs on resume.
                // ================================================================
                if (this._forceTizenPlayPassed && this._pendingSeekMs !== null) {
                    const seekMs = this._pendingSeekMs;
                    this._pendingSeekMs = null;
                    this._bufferingComplete = false;
                    this._seekInProgress = true;
                    log.info('Eager seek on forced path to ' + seekMs + 'ms');
                    this._safeSeekTo(
                        seekMs,
                        () => {
                            this._seekInProgress = false;
                            if (!this._isNativeBuffering) {
                                this._bufferingComplete = true;
                            }
                            if (this._bufferingCompleteDuringSeek) {
                                this._bufferingComplete = true;
                                this._bufferingCompleteDuringSeek = false;
                            }
                            log.info('Eager seek on forced path completed to ' + seekMs + 'ms');
                        },
                        () => {
                            this._seekInProgress = false;
                            log.warn('Eager seek on forced path failed for ' + seekMs + 'ms');
                        }
                    );
                }

            } catch (e) {
                log.error('Double-Gate play() failed:', e.message || e);
            }
        } else if (!this._isTizenPlaying) {
            log.debug(`Double-Gate pending: Playing=${this._isPlaying}, Prep=${this._isPrepared}, Buff=${this._bufferingComplete}`);
        }
    }

    /**
     * Stop position tracking timer
     * @private
     */
    _stopPositionTracking() {
        // No-op (handled by native events)
    }

    /**
     * Wrapper around avplay.seekTo that uses success/error callbacks.
     * Per Samsung docs, no other AVPlay API may be called while seekTo
     * is in progress — the callbacks signal when it's safe.
     * @private
     * @param {number} ms - Target position in milliseconds
     * @param {Function} [onSuccess] - Called when seek completes
     * @param {Function} [onError] - Called if seek fails
     */
    _safeSeekTo(ms, onSuccess, onError) {
        if (!this._avplay) {
            if (onError) onError(new Error('No avplay instance'));
            return;
        }

        // Per Samsung docs, seekTo() is only valid in PLAYING or PAUSED states.
        // Calling it in READY/NONE/IDLE causes an unrecoverable native decoder
        // crash that requires a full TV restart.
        let state = 'UNKNOWN';
        try { state = this._avplay.getState(); } catch (_) {}
        if (state !== 'PLAYING' && state !== 'PAUSED') {
            log.warn(`_safeSeekTo(): AVPlay state is '${state}' — seekTo() not valid, aborting`);
            if (onError) onError(new Error(`Invalid state for seek: ${state}`));
            return;
        }

        try {
            this._avplay.seekTo(
                ms,
                () => {
                    if (onSuccess) onSuccess();
                    this._assertActiveSubtitleTrack();
                },
                () => { if (onError) onError(new Error('seekTo failed')); }
            );
        } catch (e) {
            log.warn('_safeSeekTo threw synchronously:', e);
            if (onError) onError(e);
        }
    }

    /**
     * Re-assert the active native subtitle track after a seek completes.
     * Some firmware drops the TEXT track selection during buffer flush, causing
     * subtitles to go silent even though setSilentSubtitle(false) was called.
     */
    _assertActiveSubtitleTrack() {
        if (!this._avplay || !this._isPrepared) return;
        if (this._activeTizenSubtitleIndex === null || this._activeTizenSubtitleIndex === -1) return;

        try {
            this._avplay.setSelectTrack('TEXT', this._activeTizenSubtitleIndex);
            this._avplay.setSilentSubtitle(false);
            this._lastSubtitleApiTime = Date.now();
            log.debug('Post-seek subtitle track re-asserted:', this._activeTizenSubtitleIndex);
        } catch (e) {
            log.warn('Post-seek subtitle re-assertion failed:', e);
        }
    }

    /**
     * Find Tizen internal audio track index for a given Jellyfin StreamIndex
     * @private
     * @param {number} streamIndex - Jellyfin Audio StreamIndex
     * @returns {number|null} Tizen track index or null if not found
     */
    _findTizenAudioIndex(streamIndex) {
        try {
            const trackInfo = this._avplay.getTotalTrackInfo();

            // Tizen returns objects like { type: 'AUDIO', index: 0, extra_info: ... }
            const audioTracks = trackInfo.filter((t) => t.type === 'AUDIO');

            // We need to map Jellyfin StreamIndex to Tizen's index
            // Strategy: Assume Tizen and Jellyfin see audio tracks in the same order
            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                log.warn('No MediaStreams info to map audio index');
                return null;
            }

            // Find which N-th audio track this is in Jellyfin MediaSource
            let jellyfinAudioStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Audio'
            );

            // If Tizen has fewer audio tracks, it usually silently dropped unsupported ones (DTS/TrueHD)
            if (audioTracks.length > 0 && jellyfinAudioStreams.length > audioTracks.length) {
                log.debug('Tizen audio track count mismatch, filtering unsupported codecs');
                jellyfinAudioStreams = jellyfinAudioStreams.filter(s => {
                    const c = (s.Codec || '').toLowerCase();
                    return !c.includes('truehd') && !c.includes('dts');
                });
            }

            const targetStreamIndexInAudioList = jellyfinAudioStreams.findIndex((s) => s.Index === streamIndex);

            if (targetStreamIndexInAudioList === -1) {
                log.warn('Requested audio stream index not found in MediaSource:', streamIndex);
                return null;
            }

            // Select the N-th available audio track in Tizen
            if (audioTracks[targetStreamIndexInAudioList]) {
                const tizenIndex = audioTracks[targetStreamIndexInAudioList].index;
                log.debug(`Mapped Jellyfin Audio ${streamIndex} to Tizen index ${tizenIndex}`);
                return parseInt(tizenIndex, 10);
            }

            log.warn('Could not map audio stream index (out of bounds)');
            return null;
        } catch (e) {
            log.error('Error mapping audio index:', e);
            return null;
        }
    }

    /**
     * Determines the native playability class of a subtitle stream.
     * @private
     * @param {number} streamIndex - Jellyfin Subtitle StreamIndex
     * @returns {string} 'EXTERNAL', 'INTERNAL_BITMAP', 'INTERNAL_TEXT', or 'UNKNOWN'
     */
    _getSubtitlePlayability(streamIndex) {
        if (!this._currentPlayOptions?.mediaSource?.MediaStreams) return 'UNKNOWN';
        const stream = this._currentPlayOptions.mediaSource.MediaStreams.find(s => s.Index === streamIndex);
        if (!stream) return 'UNKNOWN';

        if (stream.IsExternal) return 'EXTERNAL';

        const codec = (stream.Codec || '').toLowerCase();
        
        // Codecs that can be rendered natively by Tizen AVPlay
        const nativeTextCodecs = [
            'srt', 'subrip',
            'vtt', 'webvtt',
            'ttml', 'dfxp',
            'smi', 'sami',
            'scc',
            'sbv',
            'ttxt'
        ];
        if (nativeTextCodecs.includes(codec)) {
            return 'INTERNAL_TEXT';
        }

        const isBitmap = codec === 'pgs' || codec === 'pgssub' || codec === 'vobsub' || codec === 'dvdsub' || codec === 'dvd_subtitle';
        if (isBitmap) {
            return 'INTERNAL_BITMAP';
        }

        // All other formats (e.g. ass, ssa, mov_text, tx3g, etc.) are handled externally by SubtitleManager
        return 'EXTERNAL';
    }

    /**
     * Find Tizen internal subtitle track index for a given Jellyfin StreamIndex
     * @private
     * @param {number} streamIndex - Jellyfin Subtitle StreamIndex
     * @returns {number|null} Tizen track index or null if not found
     */
    _findTizenSubtitleIndex(streamIndex) {
        try {
            const trackInfo = this._avplay.getTotalTrackInfo() || [];
            const textTracks = trackInfo.filter((t) => t.type === 'TEXT');

            if (!this._currentPlayOptions?.mediaSource?.MediaStreams) {
                return null;
            }

            // Get ALL embedded subtitles from Jellyfin
            const jellyfinSubStreams = this._currentPlayOptions.mediaSource.MediaStreams.filter(
                (s) => s.Type === 'Subtitle' && !s.IsExternal
            );

            // Is the requested track actually an embedded subtitle?
            const targetStreamIndexInSubList = jellyfinSubStreams.findIndex((s) => s.Index === streamIndex);
            if (targetStreamIndexInSubList === -1) {
                log.warn('Requested subtitle stream not found in internal list:', streamIndex);
                return null;
            }

            // Tizen AVPlay silently skips loading bitmap/image-based embedded subtitles (PGS, VobSub).
            // This means Tizen's TEXT track length will be SHORTER than Jellyfin's Subtitle track length.
            // We must filter out those invisible tracks from Jellyfin's list *before* sequential mapping,
            // so that Jellyfin's text track N exactly aligns with Tizen's text track N.
            const jellyfinTextOnlyStreams = jellyfinSubStreams.filter(s => {
                const codec = (s.Codec || '').toLowerCase();
                return codec !== 'pgs' && codec !== 'pgssub' && 
                       codec !== 'vobsub' && codec !== 'dvdsub' && 
                       codec !== 'dvd_subtitle';
            });

            // Find the sequential position (Nth track) among the visible text tracks
            const occurrenceIndex = jellyfinTextOnlyStreams.findIndex(s => s.Index === streamIndex);

            if (occurrenceIndex === -1) {
                log.warn(`Requested subtitle track ${streamIndex} is a bitmap format not supported by Tizen AVPlay.`);
                return null;
            }

            // Map the Jellyfin Nth text track to Tizen's Nth text track
            if (textTracks[occurrenceIndex]) {
                const tizenIndex = textTracks[occurrenceIndex].index;
                log.debug(`Mapped Jellyfin Subtitle ${streamIndex} (Text sequence #${occurrenceIndex}) to Tizen index ${tizenIndex}`);
                return parseInt(tizenIndex, 10);
            }

            // Should never reach here unless Tizen failed to parse a text track entirely
            log.warn(`Tizen AVPlay out-of-bounds error: Track occurrence ${occurrenceIndex} exceeds Tizen's available TEXT tracks (${textTracks.length}).`);
            return null;

        } catch (e) {
            log.error('Error mapping subtitle index:', e);
            return null; // Safest fallback to let SubtitleManager catch it
        }
    }

    /**
     * Pause playback
     */
    pause() {
        if (!this._avplay) return;

        // Always update the logical play intent so higher layers (JellyfinPlayer,
        // SyncPlayManager) see the player as paused, regardless of AVPlay's current
        // internal state.
        const wasPlaying = this._isPlaying;
        this._isPlaying = false;
        this._isTizenPlaying = false;
        this._hasEmittedPlaying = false;

        if (!wasPlaying) return; // Already considered paused — nothing to do

        // Queue 'pause' as the post-seek operation if a seek is in flight,
        // so the intended state is preserved after the seek completes.
        if (this._seekInProgress) {
            this._pendingOpAfterSeek = 'pause';
        }

        // Only call native pausing if AVPlay is actually in a PLAYING state.
        // During a seek or buffering phase, AVPlay is NOT in PLAYING state and
        // calling avplay.pause() throws PLAYER_ERROR_INVALID_OPERATION (code 15).
        // If we can't pause now, set _pendingPause so _checkNativePlay() will
        // apply the pause once AVPlay re-enters a stable PLAYING state post-seek.
        // Without this, AVPlay would secretly resume playing after the seek,
        // even though SyncPlay's state machine says we should be paused.
        try {
            const state = this._avplay.getState();
            if (state === 'PLAYING') {
                this._avplay.pause();
                this._pendingPause = false; // Applied successfully — no deferral needed
            } else {
                // Non-playing state: defer the native pause
                this._pendingPause = true;
                log.debug(`pause(): AVPlay state is '${state}' — deferring native pause until post-seek/buffer`);
            }
        } catch (e) {
            // If getState() itself throws, set pending as a fallback.
            this._pendingPause = true;
            log.warn('pause(): getState() failed — deferring native pause:', e.message || e);
        }

        this.onEvent({ type: 'pause' });
    }

    /**
     * Resume playback.
     *
     * Two cases we handle here:
     *   1. Normal start: _isPlaying was false (normal pause → resume).
     *      We flip _isPlaying and let _checkNativePlay() do the gate-check.
     *   2. Post-seek resume: _isPlaying was already true (we were playing when
     *      a SyncPlay seek came in, which paused us mid-play). In this case
     *      _checkNativePlay() would bail because _isTizenPlaying is still true.
     *      We handle this by directly calling avplay.play() if the state demands it.
     */
    unpause() {
        if (!this._avplay) return;

        // Cancel any deferred pause — we want to play now.
        this._pendingPause = false;

        if (this._seekInProgress) {
            this._pendingOpAfterSeek = 'play';
            this._isPlaying = true;
            log.debug('unpause(): seek in progress — queued play for post-seek');
            return;
        }

        if (!this._isPlaying) {
            // Standard unpause path: was fully paused, go through the double-gate.
            this._isPlaying = true;
            this.onEvent({ type: 'play' });
            this._checkNativePlay();
        } else if (this._isPrepared) {
            // Directly resume native playback now that we know it's safe.
            try {
                this._avplay.play();
                this._isTizenPlaying = true;
                log.info('unpause(): direct avplay.play() after mid-play seek resume');
                this._emitPlaying();
            } catch (e) {
                log.error('unpause(): failed to resume after seek:', e);
            }
        }
    }

    /**
     * Stop playback (internal)
     * @private
     */
    async _stopInternal() {
        this._activeTizenSubtitleIndex = null;

        // ── Cancel all pending timeouts BEFORE touching AVPlay. ──────────────
        //
        // These timers hold closures that reference the AVPlay instance. If they
        // fire after close(), they attempt to call setSelectTrack / setListener
        // on a dead decoder, which on Tizen can corrupt the hardware pipeline
        // and prevent VRAM from being fully reclaimed (causing GPU glitches on
        // the UI after exiting 4K playback).
        //
        if (this._subtitleConfirmTimerId !== null) {
            clearTimeout(this._subtitleConfirmTimerId);
            this._subtitleConfirmTimerId = null;
        }
        if (this._suppressWaitingTimeout) {
            clearTimeout(this._suppressWaitingTimeout);
            this._suppressWaitingTimeout = null;
        }
        if (this._readyTrackTimeoutId) {
            clearTimeout(this._readyTrackTimeoutId);
            this._readyTrackTimeoutId = null;
        }
        if (this._initialBufferTimeoutId) {
            clearTimeout(this._initialBufferTimeoutId);
            this._initialBufferTimeoutId = null;
        }

        // Unconditionally cancel the seek safety timer on stop to avoid fires
        // referencing a dead, stopped, or closed player instance
        if (this._seekSafetyTimeoutId !== null) {
            clearTimeout(this._seekSafetyTimeoutId);
            this._seekSafetyTimeoutId = null;
        }

        // Clear suspend state on stop
        this._isSuspended = false;
        this._suspendedUrl = null;
        this._suspendedPositionMs = 0;
        this._wasPlayingBeforeSuspend = false;

        // Clear seek-in-progress flag so stale state doesn't block _checkNativePlay
        // on a future playback session
        this._seekInProgress = false;
        this._bufferingCompleteDuringSeek = false;
        this._isNativeBuffering = false;
        this._lastSubtitleApiTime = 0;
        this._deferredSeekTicks = null;
        this._pendingOpAfterSeek = null;
        this._queuedSeekPositionMs = null;
        if (this._deferredSeekTimerId !== null) {
            clearTimeout(this._deferredSeekTimerId);
            this._deferredSeekTimerId = null;
        }

        if (this._avplay) {
            // ── Remove the event listener FIRST before stop/close. ────────────
            //
            // Per Samsung's AVPlay documentation, the listener object holds
            // internal references to the C++ hardware decoder pipeline.
            // Calling setListener(null) explicitly instructs the native layer
            // to release those references BEFORE the decoder is torn down by
            // stop() and close(). Without this, the decoder's texture surfaces
            // (which can be 20–50MB+ for 4K content) may remain pinned in VRAM
            // even after close() returns — causing GPU memory fragmentation that
            // manifests as UI glitches (white flashes, icon disappearance) on
            // the next page after playback.
            //
            try {
                this._avplay.setListener(null);
                log.debug('AVPlay listener cleared (VRAM reference released)');
            } catch (e) {
                // Non-fatal on older firmware — log and continue with stop/close.
                log.debug('setListener(null) failed (non-fatal):', e.message || e);
            }

            // 1. Attempt stop
            try {
                const state = this._avplay.getState();
                if (state !== 'NONE' && state !== 'IDLE') {
                    this._avplay.stop();
                }
            } catch (e) {
                log.debug('AVPlay stop failed (possibly already idle):', e.message || e);
            }

            // 2. Force close (True Reset to NONE state).
            // This is critical for episode-to-episode transitions to clear
            // stale buffers and decoder state.
            try {
                this._avplay.close();
            } catch (e) {
                log.debug('AVPlay close failed:', e.message || e);
            }
        }
        this._isPrepared = false;
        this._isPlaying = false;
        this._isTizenPlaying = false;
        this._bufferingComplete = false;
        this._lastTrackPollTime = 0;
    }

    /**
     * Stop playback
     */
    async stop() {
        this._stopPositionTracking();
        await this._stopInternal();

        this._currentSrc = null;
        this._currentPlayOptions = null;

        this.onEvent({ type: 'stopped' });
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks
     * @param {Object} [options] - Additional options
     * @param {boolean} [options.suppressWaitingEvent] - Don't emit 'waiting' while buffering this seek
     */
    seek(positionTicks, options = {}) {
        if (!this._avplay || !this._isPrepared) return;

        // If a seek is already in flight, queue this one to run after it completes
        // instead of attempting concurrent seeks which violate Samsung's AVPlay API
        // contract (no API calls between seekTo and its callback).
        if (this._seekInProgress) {
            const targetTicks = positionTicks;
            const targetMs = Math.floor(
                Math.max(0, targetTicks - (this._currentPlayOptions?.transcodingOffsetTicks || 0)) / 10000
            );
            this._queuedSeekPositionMs = targetMs;
            log.debug(`seek(): seek in progress — queued subsequent seek to ${targetMs}ms`);
            return;
        }

        try {
            if (options.suppressWaitingEvent) {
                this._suppressWaitingEvent = true;
                
                if (this._suppressWaitingTimeout) clearTimeout(this._suppressWaitingTimeout);
                this._suppressWaitingTimeout = setTimeout(() => {
                    this._suppressWaitingEvent = false;
                }, 3000);
            }

            let targetTicks = positionTicks;
            if (this._currentPlayOptions?.transcodingOffsetTicks) {
                targetTicks = Math.max(0, positionTicks - this._currentPlayOptions.transcodingOffsetTicks);
            }
            let positionMs = Math.floor(targetTicks / 10000);

            // ── LIVE DVR Range Validation ────────────────────────────────────────
            // For live streams, clamp the seek position to the available DVR range.
            if (this._currentPlayOptions?.mediaSource?.IsLive) {
                try {
                    const liveDuration = this._avplay.getStreamingProperty('GET_LIVE_DURATION');
                    if (liveDuration) {
                        const parts = liveDuration.split('|');
                        const dvrStart = parseInt(parts[0], 10);
                        const dvrEnd = parseInt(parts[1], 10);
                        if (!isNaN(dvrStart) && !isNaN(dvrEnd)) {
                            const clamped = Math.max(dvrStart, Math.min(positionMs, dvrEnd));
                            if (clamped !== positionMs) {
                                log.warn(`seek(): Live DVR clamp ${positionMs}ms → ${clamped}ms (range: ${dvrStart}-${dvrEnd})`);
                                positionMs = clamped;
                            }
                        }
                    }
                } catch (e) {
                    log.debug('seek(): GET_LIVE_DURATION not available, skipping DVR clamp');
                }
            }

            // ── Subtitle API Cooldown Gate ────────────────────────────────────────
            // Samsung's hardware decoder needs a settling period after
            // setSelectTrack('TEXT') / setSilentSubtitle() calls complete.
            // If seekTo() is issued during this window the native decoder
            // enters an unrecoverable state that requires a full TV restart.
            // We defer the seek and retry automatically once the cooldown expires.
            const SUBTITLE_API_COOLDOWN_MS = 2000;
            const timeSinceSubtitleApi = Date.now() - (this._lastSubtitleApiTime || 0);
            if (timeSinceSubtitleApi < SUBTITLE_API_COOLDOWN_MS) {
                const remainingMs = SUBTITLE_API_COOLDOWN_MS - timeSinceSubtitleApi;
                log.debug(`seek(): subtitle API cooldown active (${remainingMs}ms remaining) — deferring seek`);

                // Cancel any previously deferred seek (user may have pressed seek multiple times)
                if (this._deferredSeekTimerId !== null) {
                    clearTimeout(this._deferredSeekTimerId);
                }

                // Store the target and schedule execution after the cooldown expires
                this._deferredSeekTicks = positionTicks;
                this._deferredSeekTimerId = setTimeout(() => {
                    this._deferredSeekTimerId = null;
                    const pendingTicks = this._deferredSeekTicks;
                    this._deferredSeekTicks = null;
                    if (pendingTicks !== null && this._avplay && this._isPrepared) {
                        log.info(`seek(): executing deferred seek to ${pendingTicks / 10000}ms after subtitle API cooldown`);
                        this.seek(pendingTicks, options);
                    }
                }, remainingMs + 50); // +50ms safety margin
                return;
            }

            // ========================================================================
            // Post-Seek State Management and Automatic Playback Resume
            // ========================================================================
            const wasPlayingBeforeSeek = this._isTizenPlaying || this._isPlaying;

            this.onEvent({ type: 'seek' });

            const currentTime = targetTicks / 10000000;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });

            // ── Invalidate buffer state for the upcoming seek ────────────────────
            // The seek will reposition the decoder, invalidating whatever data was
            // in the hardware buffer. We must reset _bufferingComplete so that the
            // seek success callback doesn't call play() based on stale state from
            // before the seek. On files that need network refetch after seeking
            // (long jumps, remote HLS), calling play() before the new buffer is
            // filled causes a permanent decoder freeze on some Tizen firmware.
            this._bufferingComplete = false;
            this._hasEmittedPlaying = false;
            this._bufferingCompleteDuringSeek = false;
            this._isNativeBuffering = false;

            // ── Cancel the subtitle confirmation timer ───────────────────────────
            // The 4-second re-apply timer calls setSelectTrack() + setSilentSubtitle(),
            // which are illegal during seekTo(). Cancel it proactively so there's
            // zero chance of it firing in a gap between seek callbacks.
            if (this._subtitleConfirmTimerId !== null) {
                clearTimeout(this._subtitleConfirmTimerId);
                this._subtitleConfirmTimerId = null;
                log.debug('seek(): cancelled pending subtitle confirmation timer');
            }

            // ── Mute native subtitles during seek to flush ghost cues ────────────
            // For native subtitles, temporarily mute them during the seek.
            // This forces AVPlay to flush the current cue buffer, preventing 
            // the subtitle that was active before the seek from lingering on-screen.
            const hasActiveNativeSubtitle = this._activeTizenSubtitleIndex !== null && this._activeTizenSubtitleIndex !== -1;
            if (hasActiveNativeSubtitle) {
                try {
                    log.debug('seek(): muting native subtitles to prevent ghost cues');
                    this._avplay.setSilentSubtitle(true);
                    this._lastSubtitleApiTime = Date.now();
                } catch (e) {
                    log.warn('seek(): failed to mute native subtitles:', e);
                }
            }

            // ── Mark seek in progress ────────────────────────────────────────────
            // Set before _safeSeekTo so that onbufferingcomplete (which fires during
            // seek) does not trigger _checkNativePlay → play() while seekTo is still
            // active. Per Samsung docs, no other API may be called between seekTo()
            // and its callback — play() included.
            this._seekInProgress = true;

            // ── Execute seek with callbacks ──────────────────────────────────────
            this._safeSeekTo(
                positionMs,
                () => {
                    this._seekInProgress = false;

                    // If the seek did not trigger native buffering (e.g. seeking within
                    // cached/buffered range), onbufferingstart was never called.
                    // In this case, we can safely mark buffering as complete immediately.
                    if (!this._isNativeBuffering) {
                        log.debug('seek(): target position is within cached range (no buffering triggered)');
                        this._bufferingComplete = true;
                    }

                    // If onbufferingcomplete fired while the seek was in progress,
                    // it was suppressed (couldn't call _checkNativePlay). Restore
                    // _bufferingComplete now so the gate in _checkNativePlay passes.
                    if (this._bufferingCompleteDuringSeek) {
                        this._bufferingComplete = true;
                        this._bufferingCompleteDuringSeek = false;
                    }

                    // ── Unmute native subtitles post-seek ─────────────────────────
                    if (hasActiveNativeSubtitle && this._avplay) {
                        try {
                            log.debug('seek(): unmuting native subtitles post-seek');
                            this._avplay.setSilentSubtitle(false);
                            this._lastSubtitleApiTime = Date.now();
                        } catch (e) {
                            log.warn('seek(): failed to unmute native subtitles:', e);
                        }
                    }

                    // ── Apply pending operation queued during seek ───────────────
                    // If pause() or unpause() was called while the seek was in flight,
                    // apply it now that the seek has completed.
                    const pendingOp = this._pendingOpAfterSeek;
                    this._pendingOpAfterSeek = null;
                    if (pendingOp === 'pause') {
                        this._isPlaying = false;
                        this._isTizenPlaying = false;
                        this._hasEmittedPlaying = false;
                        log.debug('seek(): applied queued pause after seek');
                    } else if (pendingOp === 'play') {
                        this._isPlaying = true;
                        this._isTizenPlaying = false;
                        if (this._isPrepared && this._bufferingComplete) {
                            this._checkNativePlay();
                        }
                        log.debug('seek(): applied queued play after seek');
                    }

                    // Resume playback now that seek completed successfully.
                    // Only resume normally if no pending op overrode the state.
                    if (!pendingOp && wasPlayingBeforeSeek) {
                        this._isTizenPlaying = false;
                        this._checkNativePlay();
                    }

                    // ── Execute queued seek if another seek arrived in flight ────
                    const queuedMs = this._queuedSeekPositionMs;
                    if (queuedMs !== null) {
                        this._queuedSeekPositionMs = null;
                        if (this._avplay && this._isPrepared) {
                            const queuedTicks = queuedMs * 10000;
                            log.debug('seek(): executing queued seek after previous seek completed');
                            this.seek(queuedTicks, { suppressWaitingEvent: true });
                        }
                    }

                    // ── Post-Seek Safety Resume Net ──────────────────────────────
                    // On certain Tizen firmware, seekTo can leave the pipeline stuck
                    // in READY without firing buffering events. This safety timer
                    // re-asserts play() if the native layer hasn't resumed after 250ms.
                    if (wasPlayingBeforeSeek && !pendingOp) {
                        if (this._seekSafetyTimeoutId !== null) {
                            clearTimeout(this._seekSafetyTimeoutId);
                        }
                        this._seekSafetyTimeoutId = setTimeout(() => {
                            this._seekSafetyTimeoutId = null;
                            if (this._avplay && this._isPrepared && this._isPlaying && !this._isTizenPlaying) {
                                log.info('seek(): safety timeout fired, re-asserting native playback after skip/seek');
                                this._bufferingComplete = true;
                                this._checkNativePlay();
                            }
                        }, 250);
                    }
                },
                (e) => {
                    this._seekInProgress = false;
                    this._isNativeBuffering = false;

                    // Restore buffering state if it completed during the failed seek
                    if (this._bufferingCompleteDuringSeek) {
                        this._bufferingComplete = true;
                        this._bufferingCompleteDuringSeek = false;
                    }

                    // Apply pending operation on error too
                    const pendingOp = this._pendingOpAfterSeek;
                    this._pendingOpAfterSeek = null;
                    if (pendingOp === 'pause') {
                        this._isPlaying = false;
                        this._isTizenPlaying = false;
                        this._hasEmittedPlaying = false;
                    } else if (pendingOp === 'play') {
                        this._isPlaying = true;
                        this._isTizenPlaying = false;
                        if (this._isPrepared && this._bufferingComplete) {
                            this._checkNativePlay();
                        }
                    }

                    // Even on error, try to resume playback so the UI isn't stuck.
                    if (!pendingOp && wasPlayingBeforeSeek) {
                        log.warn('seek(): seekTo failed, trying to resume playback:', e);
                        this._isTizenPlaying = false;
                        this._checkNativePlay();
                    }

                    // Execute queued seek on error too
                    const queuedMs = this._queuedSeekPositionMs;
                    if (queuedMs !== null) {
                        this._queuedSeekPositionMs = null;
                        if (this._avplay && this._isPrepared) {
                            const queuedTicks = queuedMs * 10000;
                            log.debug('seek(): executing queued seek after failed seek');
                            this.seek(queuedTicks, { suppressWaitingEvent: true });
                        }
                    }

                    // Arm the safety net as a fallback.
                    if (wasPlayingBeforeSeek && !pendingOp) {
                        if (this._seekSafetyTimeoutId !== null) {
                            clearTimeout(this._seekSafetyTimeoutId);
                        }
                        this._seekSafetyTimeoutId = setTimeout(() => {
                            this._seekSafetyTimeoutId = null;
                            if (this._avplay && this._isPrepared && this._isPlaying && !this._isTizenPlaying) {
                                log.info('seek(): error fallback safety timer fired');
                                this._bufferingComplete = true;
                                this._checkNativePlay();
                            }
                        }, 250);
                    }
                }
            );
        } catch (e) {
            log.error('Seek failed:', e);
        }
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume (0-100)
     */
    setVolume(volume) {
        this._volume = Math.max(0, Math.min(100, volume));

        if (this._avplay && !this._isMuted) {
            try {
                this._avplay.setVolume(this._volume);
            } catch (e) {
                // Some versions don't support setVolume
            }
        }

        MediaHelper.saveVolume(this._volume / 100);
    }

    /**
     * Get current volume
     * @returns {number} Volume (0-100)
     */
    getVolume() {
        return this._volume;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this._isMuted = !this._isMuted;

        if (this._avplay) {
            try {
                this._avplay.setVolume(this._isMuted ? 0 : this._volume);
            } catch (e) {
                // Ignore
            }
        }
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._isMuted;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio stream index
     * @param {number} index - Audio stream index
     */
    setAudioStreamIndex(index) {
        if (!this._avplay) {
            log.error('No avplay instance');
            return;
        }
        if (!this._isPrepared) {
            log.error('Player not prepared');
            return;
        }

        try {
            const tracks = this._avplay.getTotalTrackInfo();
            const audioTracks = tracks.filter((t) => t.type === 'AUDIO');

            if (index >= 0 && index < audioTracks.length) {
                const track = audioTracks[index];

                // Per Samsung docs, setSelectTrack('AUDIO', ...) is only valid in
                // PLAYING state for HLS/DASH. Defer via _pendingAudioIndex if not.
                let avplayState = 'UNKNOWN';
                try { avplayState = this._avplay.getState(); } catch (_) {}
                if (this._seekInProgress || avplayState !== 'PLAYING') {
                    log.debug(`Audio track ${track.index} deferred — seekInProgress=${this._seekInProgress}, state='${avplayState}'`);
                    const jellyfinStreamIndex = this._currentPlayOptions?.mediaSource?.MediaStreams
                        ?.filter(s => s.Type === 'Audio')?.[index]?.Index;
                    if (jellyfinStreamIndex !== undefined) {
                        this._pendingAudioIndex = jellyfinStreamIndex;
                    }
                    this._currentAudioStreamIndex = index;
                    return;
                }

                this._avplay.setSelectTrack('AUDIO', track.index);
                this._currentAudioStreamIndex = index;
            } else {
                log.error('Invalid audio index:', index, 'max:', audioTracks.length - 1);
            }
        } catch (e) {
            log.error('Set audio track failed:', e);
        }
    }

    /**
     * Set subtitle stream index
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    setSubtitleStreamIndex(index) {
        if (!this._avplay) return;

        // If not DirectPlay, AVPlay Native player has no embedded subtitles to switch to.
        // The SubtitleManager handles external/burn-in logic.
        if (this._currentPlayOptions && this._currentPlayOptions.playMethod !== 'DirectPlay') {
            this._currentSubtitleStreamIndex = index;
            return Promise.resolve();
        }

        // Per Samsung docs, setSilentSubtitle and setSelectTrack('TEXT', ...) are only
        // valid in PLAYING or PAUSED state for HLS. If the AVPlay session hasn't started
        // yet (state = NONE/IDLE/READY) or a seek is currently in progress, defer via _pendingSubtitleIndex.
        let initState = 'UNKNOWN';
        try { initState = this._avplay.getState(); } catch (_) {}
        if (this._seekInProgress || (initState !== 'PLAYING' && initState !== 'PAUSED')) {
            log.debug(`setSubtitleStreamIndex deferred — seekInProgress=${this._seekInProgress}, state='${initState}'`);
            this._pendingSubtitleIndex = index;
            this._currentSubtitleStreamIndex = index;
            this._delayedSubtitleIndex = index;
            return;
        }

        // ================================================================
        // Conditional pause/resume for old Tizen firmware.
        //
        // Samsung docs confirm setSelectTrack('TEXT') can be called directly
        // in the PLAYING state on Tizen 4.0+ (2018+).  However, on Tizen 2.4
        // and 3.0 (2015–2017 TVs), the decoder sometimes doesn't refresh the
        // active cue without a brief pause/resume cycle.
        //
        // On Tizen 4.0+ we skip the pause entirely to avoid an audible audio
        // hitch that the cycle causes.  The setSilentSubtitle toggle already
        // handles cue refresh on modern firmware.
        //
        // Note: Our config.xml requires Tizen 4.0+, so the < 4.0 path only
        // activates if someone sideloads onto an older TV.
        // ================================================================
        const needsPauseForSubSwitch = TIZEN_VERSION < 4;
        let wasPlaying = false;

        if (needsPauseForSubSwitch) {
            try {
                wasPlaying = this._isPlaying && this._avplay.getState() === 'PLAYING';
                if (wasPlaying) {
                    try {
                        this._avplay.pause();
                    } catch (e) {
                        log.warn('Pause for subtitle switch failed:', e);
                    }
                }
            } catch (stateErr) {
                log.warn('Could not verify playing state for subtitle switch:', stateErr);
            }
        }

        try {
            if (index < 0) {
                // -1 = disable subtitles
                this._avplay.setSilentSubtitle(true);
                this._lastSubtitleApiTime = Date.now();
                this._currentSubtitleStreamIndex = index;
                this._activeTizenSubtitleIndex = -1;
            } else {
                const playability = this._getSubtitlePlayability(index);
                
                if (playability === 'EXTERNAL') {
                    // External subtitles handled via HTML, disable native.
                    this._avplay.setSilentSubtitle(true);
                    this._lastSubtitleApiTime = Date.now();
                    this._currentSubtitleStreamIndex = index;
                    this._activeTizenSubtitleIndex = -1;
                    return;
                } else if (playability === 'INTERNAL_BITMAP') {
                    // Unsupported natively. Fast-fail to trigger fallback.
                    this._avplay.setSilentSubtitle(true);
                    this._lastSubtitleApiTime = Date.now();
                    this._currentSubtitleStreamIndex = index;
                    this._activeTizenSubtitleIndex = -1;
                    this.onEvent({
                        type: 'subtitlefallback',
                        data: { index: index }
                    });
                    return;
                }

                /*
                 * IMPORTANT: `index` here is a Jellyfin stream index (e.g. 3, 5, 7),
                 * NOT a 0-based Tizen array position. Using it directly as textTracks[index]
                 * would select the completely wrong track.
                 *
                 * We must map it via _findTizenSubtitleIndex(), which finds the N-th
                 * embedded subtitle in the Jellyfin MediaStreams list and maps that
                 * to the corresponding Tizen TEXT track by position.
                 */
                const tizenSubIndex = this._findTizenSubtitleIndex(index);
                if (tizenSubIndex !== null) {
                    let avplayState = 'UNKNOWN';
                    try { avplayState = this._avplay.getState(); } catch (e) {}

                    // Per Samsung docs, setSelectTrack('TEXT', ...) is valid in PLAYING
                    // and PAUSED for HLS. Defer if in READY/IDLE/NONE.
                    if (!needsPauseForSubSwitch && avplayState !== 'PLAYING' && avplayState !== 'PAUSED') {
                        this._pendingSubtitleIndex = index;
                        this._currentSubtitleStreamIndex = index;
                        log.debug(`setSubtitleStreamIndex: Player state is ${avplayState}. Deferring TEXT track ${tizenSubIndex}.`);
                        return;
                    }

                    this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                    this._avplay.setSilentSubtitle(true);
                    this._avplay.setSilentSubtitle(false);
                    this._lastSubtitleApiTime = Date.now();
                    this._currentSubtitleStreamIndex = index;
                    this._activeTizenSubtitleIndex = tizenSubIndex;
                    this._pendingSubtitleIndex = null;
                    log.debug(`setSubtitleStreamIndex: Jellyfin ${index} → Tizen TEXT ${tizenSubIndex}`);
                } else {
                    log.warn(`setSubtitleStreamIndex: Could not map Jellyfin index ${index} to Tizen TEXT track`);
                    throw new Error('OUT_OF_BOUNDS_TIZEN_LIMIT');
                }
            }
        } catch (e) {
            // OUT_OF_BOUNDS_TIZEN_LIMIT is a handled fallback, not a crash — use WARN, not ERROR
            if (e && e.message === 'OUT_OF_BOUNDS_TIZEN_LIMIT') {
                log.warn('Subtitle track exceeds Tizen 30-track limit, requesting external text fallback');
            } else {
                log.error('Failed to set subtitle track:', e);
            }
            throw e; // Re-throw so JellyfinPlayer can catch limits and fallback!
        }

        // Resume playback if we paused for the old-Tizen workaround
        if (needsPauseForSubSwitch && wasPlaying) {
            try {
                this._avplay.play();
            } catch (e) {
                log.warn('Resume after subtitle switch failed:', e);
            }
        }
    }

    /**
     * Signal to the UI that subtitle styles should be refreshed.
     * Called by settings menu when style preferences change.
     */
    refreshSubtitles() {
        this.onEvent({ type: 'refreshsubtitles' });
    }

    /**
     * Set subtitle offset using Tizen's native AVPlay API.
     * Positive values delay subtitles, negative values advance them.
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        this._subtitleOffset = seconds;
        this._applySubtitlePosition();
    }

    /**
     * Apply the current subtitle offset to AVPlay.
     * Uses webapis.avplay.setSubtitlePosition(ms) which accepts
     * positive (delay) and negative (advance) millisecond values.
     * Only callable in PLAYING or PAUSED states.
     * @private
     */
    _applySubtitlePosition() {
        if (!this._avplay || !this._isPrepared) return;

        // Per Samsung docs, setSubtitlePosition() is only valid in PLAYING or PAUSED.
        let guardState = 'UNKNOWN';
        try { guardState = this._avplay.getState(); } catch (_) {}
        if (guardState !== 'PLAYING' && guardState !== 'PAUSED') {
            log.debug(`Subtitle offset deferred — AVPlay state is '${guardState}', not PLAYING/PAUSED`);
            return;
        }

        try {
            const offsetMs = Math.round(this._subtitleOffset * 1000);
            this._avplay.setSubtitlePosition(offsetMs);
            log.debug(`Subtitle offset applied: ${this._subtitleOffset}s (${offsetMs}ms)`);
        } catch (e) {
            log.warn('Failed to apply subtitle offset:', e);
        }
    }

    /**
     * Get current time in seconds
     * @returns {number}
     */
    async _pollHlsPlaylist(url) {
        if (!url || !url.includes('.m3u8')) return;

        const maxRetries = 30; // 15 seconds total (500ms * 30)
        const delayMs = 500;
        
        log.info(`[HLS Polling] Waiting for playlist generation: ${url}`);

        for (let i = 0; i < maxRetries; i++) {
            // Stop polling if the player was destroyed or playback was cancelled
            if (!this._isPlaying) {
                log.info('[HLS Polling] Playback cancelled during polling.');
                return;
            }

            try {
                const response = await fetch(url, { method: 'GET' });
                if (response.ok) {
                    const text = await response.text();
                    if (text && text.includes('#EXTM3U')) {
                        log.info(`[HLS Polling] Playlist ready after ${i * delayMs}ms.`);
                        return; // Playlist is ready!
                    }
                }
            } catch (e) {
                // Ignore fetch errors (server might still be refusing connections or 404ing)
            }

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        log.warn(`[HLS Polling] Timed out waiting for playlist after ${maxRetries * delayMs}ms. Proceeding anyway.`);
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current time in seconds
     * @returns {number}
     */
    /**
     * Emit 'playing' event and update internal state
     * @private
     */
    _emitPlaying() {
        if (!this._hasEmittedPlaying) {
            this._hasEmittedPlaying = true;
            this.onEvent({ type: 'playing' });
        }
    }

    /**
     * Get the current playing URL
     * @returns {string|null}
     */
    getCurrentUrl() {
        return this._currentSrc;
    }

    /**
     * Suspend AVPlay playback and save decoder state.
     * Called when the app goes to background. The decoder is preserved in
     * hardware state and can be restored via restore().
     * @returns {boolean} True if suspend was successful
     */
    suspend() {
        if (!this._avplay || !this._isPrepared) return false;

        try {
            const state = this._avplay.getState();
            if (state === 'NONE' || state === 'IDLE') return false;

            this._suspendedUrl = this._currentSrc;
            this._suspendedPositionMs = Math.floor(this.getCurrentTime() * 1000);
            this._wasPlayingBeforeSuspend = state === 'PLAYING';

            this._avplay.suspend();
            this._isSuspended = true;
            this._isTizenPlaying = false;
            log.info('AVPlay suspended at position:', this._suspendedPositionMs);
            return true;
        } catch (e) {
            log.warn('AVPlay suspend failed:', e.message || e);
            this._isSuspended = false;
            return false;
        }
    }

    /**
     * Restore AVPlay playback from a suspended state.
     * Called when the app returns to foreground. Reopens the stream at the
     * saved position using the hardware decoder state.
     * @param {string} url - The URL to restore (same as was playing)
     * @param {number} positionMs - Position in milliseconds to restore to
     * @returns {Promise<{success: boolean, wasPlaying: boolean}>}
     */
    async restore(url, positionMs) {
        if (!this._avplay) return { success: false, wasPlaying: false };

        const wasPlaying = this._wasPlayingBeforeSuspend;

        try {
            if (typeof this._avplay.restoreAsync === 'function') {
                return await new Promise((resolve) => {
                    try {
                        this._avplay.restoreAsync(
                            url,
                            Math.max(0, Math.floor(positionMs || 0)),
                            true,
                            () => {
                                this._isSuspended = false;
                                this._wasPlayingBeforeSuspend = false;
                                this._isPrepared = true;
                                this._bufferingComplete = true;
                                this._isTizenPlaying = false;
                                this._currentSrc = url;
                                log.info('AVPlay restored successfully via restoreAsync');
                                resolve({ success: true, wasPlaying });
                            },
                            () => {
                                this._isSuspended = false;
                                this._wasPlayingBeforeSuspend = false;
                                log.warn('AVPlay restoreAsync failed');
                                resolve({ success: false, wasPlaying: false });
                            }
                        );
                    } catch (e) {
                        this._isSuspended = false;
                        this._wasPlayingBeforeSuspend = false;
                        log.warn('AVPlay restoreAsync threw:', e.message || e);
                        resolve({ success: false, wasPlaying: false });
                    }
                });
            }

            this._avplay.restore(url, Math.max(0, Math.floor(positionMs || 0)), true);
            this._isSuspended = false;
            this._wasPlayingBeforeSuspend = false;
            this._isPrepared = true;
            this._bufferingComplete = true;
            this._isTizenPlaying = false;
            this._currentSrc = url;
            log.info('AVPlay restored successfully');
            return { success: true, wasPlaying };
        } catch (e) {
            this._isSuspended = false;
            this._wasPlayingBeforeSuspend = false;
            log.warn('AVPlay restore failed:', e.message || e);
            return { success: false, wasPlaying: false };
        }
    }

    /**
     * Check if the player is currently in a suspended state
     * @returns {boolean}
     */
    isSuspended() {
        return this._isSuspended;
    }

    getCurrentTime() {
        if (!this._avplay || !this._isPrepared) return 0;

        try {
            const timeMs = Number(this._avplay.getCurrentTime());
            if (isNaN(timeMs)) return 0;

            return timeMs / 1000;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Get start position in ticks
     * @returns {number}
     */
    getStartPositionTicks() {
        return this._currentPlayOptions?.playerStartPositionTicks || 0;
    }

    /**
     * Get duration in seconds
     * @returns {number}
     */
    getDuration() {
        return this._duration / 1000;
    }

    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        if (!this._avplay) return true;

        try {
            const state = this._avplay.getState();
            // In Tizen AVPlay, state can be NONE, IDLE, READY, PLAYING, PAUSED
            // If it's not PLAYING, we consider it logically paused for UI tracking
            return state !== 'PLAYING';
        } catch (e) {
            return !this._isPlaying;
        }
    }

    // ========================================================================
    // Fullscreen (Tizen TVs are always fullscreen)
    // ========================================================================

    /**
     * Toggle fullscreen (no-op on Tizen TV)
     */
    toggleFullscreen() {
        // Tizen TV apps are always fullscreen
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        return true; // Always fullscreen on TV
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Destroy the player
     */
    destroy() {
        this._stopPositionTracking();
        this._isSuspended = false;
        this._suspendedUrl = null;
        this._suspendedPositionMs = 0;
        this._wasPlayingBeforeSuspend = false;

        if (this._avplay) {
            try {
                this._avplay.stop();
                this._avplay.close();
            } catch (e) {
                // Ignore cleanup errors
            }
        }

        this._avplay = null;
        this._currentSrc = null;
        this._currentPlayOptions = null;
    }

    /**
     * Get current audio stream index
     * @returns {number|null}
     */
    getCurrentAudioStreamIndex() {
        return this._currentAudioStreamIndex;
    }

    /**
     * Get current subtitle stream index
     * @returns {number|null}
     */
    getCurrentSubtitleStreamIndex() {
        return this._currentSubtitleStreamIndex;
    }
}
