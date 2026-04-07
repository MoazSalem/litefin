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
import { detectTizenVersion } from '../../api/profiles/TizenProfile.js';

const log = logger.create('TizenAVPlayer');

// Cache the Tizen firmware version once at module load.
// Used to gate hardware-specific workarounds (e.g. subtitle pause/resume cycle
// is only needed on Tizen 2.4–3.x; Tizen 4.0+ handles it natively).
const TIZEN_VERSION = detectTizenVersion();

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

        // Throttle for timeupdate events
        this._lastTimeUpdateTicks = 0;

        // When pause() is called while AVPlay is mid-seek or mid-buffer, the native
        // avplay.pause() call would throw PLAYER_ERROR_INVALID_OPERATION. Instead,
        // we set this flag and apply the native pause the next time _checkNativePlay()
        // is called (which happens when buffering completes). This prevents AVPlay from
        // secretly resuming playback after a SyncPlay-triggered seek+handshake.
        this._pendingPause = false;

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
            this._isPrepared = false;
            this._hasEmittedPlaying = false;
            this._firstFrameRendered = false;
            this._playbackStabilized = false;
            this._firstFrameTimeMs = 0;
            this._pendingSeekMs = null;
            this._subtitleOffset = 0;
            this._playStartTime = Date.now();
            this._currentPlayOptions = options;

            // Only sleep if we just forcefully stopped an active stream
            if (wasActive) {
                // Give Tizen adequate time to tear down the previous decoder (True Reset)
                await new Promise((resolve) => setTimeout(resolve, 100));
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
                    const bufferPlaySec = 6;
                    const bufferResumeSec = 4;
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
                    
                    // 2. Legacy 4K Mode (Required for some older Tizen TVs to accept 4K HLS)
                    if (!isDirectPlay && (options.mediaSource?.Bitrate > 20000000 || options.mediaSource?.Width > 1920)) {
                        try {
                            this._avplay.setStreamingProperty("SET_MODE_4K", "TRUE");
                        } catch (e) {
                            log.warn('Failed to set SET_MODE_4K:', e.message || e);
                        }
                    }

                    // 3. ABR Quality Kickstart (HLS/Adaptive Only)
                    if (!isDirectPlay) {
                        try {
                            const props = [
                                'FIXED_MAX_RESOLUTION=3840x2160', // Correctly cased 'x' per modern Tizen docs, though 'X' works on some.
                                'STARTBITRATE=HIGHEST', // Force hardware to skip ramp-up delay
                                'USER_AGENT=JellyfinTizenClient', // Modern way to set UA in 5.0+
                                `INITIAL_BUFFER_DURATION=${bufferPlaySec * 1000}`,
                                `RESUME_BUFFER_DURATION=${bufferResumeSec * 1000}`
                            ].join('|');
                            this._avplay.setStreamingProperty("ADAPTIVE_INFO", props);
                            log.info('Hardware ABR Optimized: STARTBITRATE=HIGHEST, UA=Jellyfin, FIXED_MAX_RESOLUTION=3840x2160');
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
            // Ensure HLS playlist exists before preparing AVPlay (prevents "Unknown Error" crash on 404)
            if (options.url && options.url.includes('.m3u8')) {
                await this._pollHlsPlaylist(options.url);
            }

            // Prepare asynchronously
            await this._prepareAsync();

            // Set up display rect only after preparation success
            this._createDisplay();

            // A tiny delay avoids internal decoder race conditions
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Seek to start position BEFORE native play starts.
            // AVPlay supports seekTo in the READY state (after prepareAsync).
            // Seeking here ensures the decoder starts buffering from the correct
            // position, rather than buffering from 0 and then doing a disruptive
            // post-play seek that snaps to an unpredictable keyframe.
            if (options.playerStartPositionTicks) {
                const startMs = options.playerStartPositionTicks / 10000;

                // Seek to the exact requested position. AVPlay will snap to the
                // nearest keyframe before the target, which is a small natural offset
                // that SyncPlay's drift correction handles automatically.
                // The old -10s KEYFRAME_REWIND_MS hack made things worse — we were
                // seeking 10s early and then reporting that fake position to SyncPlay,
                // causing the group to wait 10s for Tizen to catch up.
                try {
                    log.info(`Initial seek to ${startMs}ms (before native play)`);
                    this._avplay.seekTo(startMs);
                } catch (e) {
                    log.warn('Pre-play seek failed, will retry after play:', e);
                    this._pendingSeekMs = startMs;
                }
            }

            // Metadata is now loaded, display is ready, and seek position is set.
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
                if (this._isPlaying && !this._suppressWaitingEvent) {
                    this.onEvent({ type: 'waiting' });
                }
            },
            onbufferingprogress: (percent) => {
                // Buffering progress (0-100)
            },
            onbufferingcomplete: () => {
                log.info('Buffering complete (network threshold reached)');
                this._bufferingComplete = true;

                // Hardware is settled (due to 6s buffer threshold), 
                // but we only fire if the decoder is also prepared and intent is to play.
                this._checkNativePlay();
                
                // Track transition point: Buffer is full but clock hasn't started yet.
                // Apply pending tracks now. If they fail (e.g., Tizen needs more time to parse text),
                // they remain pending and get picked up by oncurrentplaytime.
                if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null) {
                    this._applyPendingTracks();
                }

                // If the player was already natively playing (e.g. stalled for network buffer),
                // it natively auto-resumes once buffering is complete. We must emit 'playing' 
                // immediately here to prevent the UI loader from lingering while audio resumes.
                if (this._isPlaying && this._isTizenPlaying) {
                    this._emitPlaying();
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

                    // Fallback: if the pre-play seekTo failed, retry now that playback has started
                    if (this._pendingSeekMs !== null) {
                        const seekMs = this._pendingSeekMs;
                        this._pendingSeekMs = null;
                        try {
                            log.info(`Fallback seek to ${seekMs}ms (post first frame)`);
                            this._avplay.seekTo(seekMs);
                        } catch (e) {
                            log.warn('Fallback seek also failed:', e);
                        }
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
                if (this._pendingAudioIndex !== null || this._pendingSubtitleIndex !== null || (this._playbackStabilized && this._delayedSubtitleIndex !== null)) {
                    
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

        const trackInfo = this._avplay.getTotalTrackInfo() || [];
        
        // If track info is completely empty, older Tizen might still be parsing headers.
        // Return early to try again on next timeupdate/buffering event.
        if (trackInfo.length === 0) {
            log.debug('_applyPendingTracks: No track info available yet, will retry...');
            return;
        }

        if (this._pendingAudioIndex !== null) {
            const tizenAudioIndex = this._findTizenAudioIndex(this._pendingAudioIndex);
            if (tizenAudioIndex !== null) {
                try {
                    this._avplay.setSelectTrack('AUDIO', tizenAudioIndex);
                    this._pendingAudioIndex = null;
                } catch (e) {
                    // If Tizen returns InvalidStateError, the engine isn't ready for track switching.
                    // Keep the index pending so the oncurrentplaytime loop can retry once stable.
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
                // Else: AVPlay hasn't parsed audio tracks yet. Remain pending.
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
                    this._pendingSubtitleIndex = null;
                    this._delayedSubtitleIndex = null;
                    this._activeTizenSubtitleIndex = -1;
                } catch (e) {
                    log.warn('Failed to disable subtitles:', e);
                }
            } else {
                // ================================================================
                // IMPROVEMENT C: PLAYING state gate before setSelectTrack.
                //
                // Some Tizen firmwares (especially 2.4–3.0, and some 4.x units)
                // silently ignore setSelectTrack('TEXT', ...) if the player is in
                // anything other than the PLAYING state at the moment of the call.
                //
                // This function is called from both onbufferingcomplete (state=READY)
                // and oncurrentplaytime (state=PLAYING).  We attempt the switch only
                // when we're verified PLAYING; otherwise we leave _pendingSubtitleIndex
                // set so the oncurrentplaytime loop retries on the next tick.
                //
                // Exception: if we are in READY state and the eager pre-play path
                // (Improvement A) is running, we still try — on modern Tizen that works.
                // We detect READY by checking !this._isTizenPlaying.
                // ================================================================
                let avplayState = 'UNKNOWN';
                try { avplayState = this._avplay.getState(); } catch (_) {}

                // Allow attempt from READY state (pre-play Improvement A path)
                // or from PLAYING state (normal oncurrentplaytime path).
                // Bail out from PAUSED — the pause/resume cycle in setSubtitleStreamIndex
                // already handles that scenario via _delayedSubtitleIndex.
                const isReadyOrPlaying = avplayState === 'PLAYING' || avplayState === 'READY';

                if (!isReadyOrPlaying) {
                    log.debug(`Subtitle track selection deferred — AVPlay state is '${avplayState}', not READY/PLAYING`);
                    // Leave _pendingSubtitleIndex set for the next oncurrentplaytime retry.
                } else {
                    // Pre-first-frame: try the raw setSelectTrack. This works on
                    // Tizen 5.5+ where tracks activate during READY/buffering. On Tizen 5.0
                    // it silently no-ops, but _delayedSubtitleIndex stays set so the
                    // post-stabilization path will catch it later.
                    const tizenSubIndex = this._findTizenSubtitleIndex(this._pendingSubtitleIndex);
                    if (tizenSubIndex !== null) {
                        try {
                            log.debug(`Attempting${avplayState === 'READY' ? ' (eager READY-state)' : ''} apply of TEXT track index ${tizenSubIndex}`);
                            this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                            this._avplay.setSilentSubtitle(true);
                            this._avplay.setSilentSubtitle(false);
                            log.info(`TEXT track ${tizenSubIndex} applied in ${avplayState} state`);
                            this._pendingSubtitleIndex = null; // Clear so we don't spam oncurrentplaytime
                            this._activeTizenSubtitleIndex = tizenSubIndex; // Track active selection
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
                            try { this._avplay.setSilentSubtitle(true); } catch(e){}
                            
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
            // Post-stabilization: use setSubtitleStreamIndex which includes a
            // pause/resume cycle. On Tizen 5.0, early setSelectTrack silently failed.
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
                try {
                    this._avplay.setSilentSubtitle(true);
                    log.debug('Proactive subtitle silence applied immediately after play()');
                    
                    // If a specific track was already successfully applied eagerly during READY state,
                    // the proactive silence just muted it. Unmute it to restore visibility.
                    if (this._activeTizenSubtitleIndex !== null && this._activeTizenSubtitleIndex !== -1) {
                        try {
                            // Re-assert the track selection. This acts as a pipeline flush
                            // for backwards seeks where AVPlay's internal text buffer gets corrupted.
                            this._avplay.setSelectTrack('TEXT', this._activeTizenSubtitleIndex);
                        } catch(e) {}
                        this._avplay.setSilentSubtitle(false);
                        log.debug('Restored silence state (unmuted) for active TEXT track');
                    }
                } catch (silenceErr) {
                    // Non-fatal — older firmware may throw in early PLAYING phase.
                    log.warn('Proactive setSilentSubtitle(true/false) failed (non-fatal):', silenceErr.message || silenceErr);
                }

                // Emit 'playing' immediately after play() executes. Since Tizen's 
                // oncurrentplaytime loop only ticks every 500ms, waiting for the first 
                // tick causes audio to leak for half a second behind the loading screen.
                this._emitPlaying();

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
        const isBitmap = codec === 'pgs' || codec === 'pgssub' || codec === 'vobsub' || codec === 'dvdsub' || codec === 'dvd_subtitle';
        
        if (isBitmap) return 'INTERNAL_BITMAP';
        return 'INTERNAL_TEXT';
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

        if (!this._isPlaying) {
            // Standard unpause path: was fully paused, go through the double-gate.
            this._isPlaying = true;
            this.onEvent({ type: 'play' });
            this._checkNativePlay();
        } else if (this._isPrepared) {
            // Post-seek path: _isPlaying is already true (intent was never cleared)
            // but Tizen may have stalled. Directly resume native playback.
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
        if (this._avplay) {
            // 1. Attempt stop
            try {
                const state = this._avplay.getState();
                if (state !== 'NONE' && state !== 'IDLE') {
                    this._avplay.stop();
                }
            } catch (e) {
                log.debug('AVPlay stop failed (possibly already idle):', e.message || e);
            }

            // 2. Force close (True Reset to NONE state)
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

        try {
            if (options.suppressWaitingEvent) {
                this._suppressWaitingEvent = true;
                
                // Clear the suppression flag after a safe timeout, or it will be
                // cleared naturally by onbufferingcomplete / oncurrentplaytime
                if (this._suppressWaitingTimeout) clearTimeout(this._suppressWaitingTimeout);
                this._suppressWaitingTimeout = setTimeout(() => {
                    this._suppressWaitingEvent = false;
                }, 3000);
            }

            let targetTicks = positionTicks;
            if (this._currentPlayOptions?.transcodingOffsetTicks) {
                targetTicks = Math.max(0, positionTicks - this._currentPlayOptions.transcodingOffsetTicks);
            }
            const positionMs = Math.floor(targetTicks / 10000);
            this._avplay.seekTo(positionMs);

            // After seekTo(), AVPlay resumes buffering from the new position.
            // If we were in PLAYING state when the seek was requested (e.g. during
            // SyncPlay drift correction or a mid-play seek), AVPlay internally
            // re-enters a READY/buffering phase, which means a subsequent avplay.play()
            // IS needed. Reset _isTizenPlaying so unpause() -> _checkNativePlay()
            // (or the direct path) works correctly after the seek.
            if (this._isTizenPlaying) {
                this._isTizenPlaying = false;
                log.debug('seek(): reset _isTizenPlaying for post-seek resume');
            }

            // Emit a seek event so SyncPlayManager can react (e.g. broadcast to group, suppress echo).
            this.onEvent({ type: 'seek' });

            // Manual timeupdate for paused state (native oncurrentplaytime is only fired when playing)
            const currentTime = targetTicks / 10000000;
            this.onEvent({ type: 'timeupdate', data: { time: currentTime } });
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
                this._avplay.setSelectTrack('AUDIO', track.index);
                this._currentAudioStreamIndex = index; // Update state
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
                this._currentSubtitleStreamIndex = index;
                this._activeTizenSubtitleIndex = -1;
            } else {
                const playability = this._getSubtitlePlayability(index);
                
                if (playability === 'EXTERNAL') {
                    // External subtitles handled via HTML, disable native.
                    this._avplay.setSilentSubtitle(true);
                    this._currentSubtitleStreamIndex = index;
                    this._activeTizenSubtitleIndex = -1;
                    return;
                } else if (playability === 'INTERNAL_BITMAP') {
                    // Unsupported natively. Fast-fail to trigger fallback.
                    this._avplay.setSilentSubtitle(true);
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
                    this._avplay.setSelectTrack('TEXT', tizenSubIndex);
                    this._avplay.setSilentSubtitle(true);
                    this._avplay.setSilentSubtitle(false);
                    this._currentSubtitleStreamIndex = index;
                    this._activeTizenSubtitleIndex = tizenSubIndex;
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

        try {
            // Convert seconds to milliseconds for AVPlay API
            const offsetMs = Math.round(this._subtitleOffset * 1000);
            this._avplay.setSubtitlePosition(offsetMs);
            log.debug(`Subtitle offset applied: ${this._subtitleOffset}s (${offsetMs}ms)`);
        } catch (e) {
            // setSubtitlePosition may fail if not in PLAYING/PAUSED state
            log.warn('Failed to apply subtitle offset:', e);
        }
    }

    /**
     * Polls the HLS playlist URL until it returns HTTP 200 with content.
     * Prevents Tizen AVPlay from crashing with 'Unknown error' if
     * prepareAsync() is called before the server builds the manifest.
     * @param {string} url - The HLS playlist URL
     * @returns {Promise<void>}
     * @private
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
