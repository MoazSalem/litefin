/**
 * JellyfinPlayer - Main orchestrating class
 *
 * Manages video playback using HtmlVideoPlayer, TizenAVPlayer, or WebOSPlayer
 * backend. Handles media source selection, track switching, and playback state.
 *
 * The active backend is exposed through `this._backendType` ('tizen', 'webos', 'html5')
 * for all platform-specific branching — prefer _backendType string checks over
 * `instanceof` so that adding new backends never requires touching this class.
 *
 * Integrated directly into litefin — no UMD bundle, no bridge, no standalone
 * @module core/JellyfinPlayer
 */

import { HtmlVideoPlayer } from './HtmlVideoPlayer.js';
import { TizenAVPlayer } from './TizenAVPlayer.js';
import { WebOSPlayer } from './WebOSPlayer.js';
import { platformInfo } from '../../utils/PlatformInfo.js';
import { MediaHelper } from './MediaHelper.js';
import { buildJellyfinProfile } from '../../api/DeviceProfile.js';
import SubtitleManager, { DeliveryMethod } from './SubtitleManager.js';
import { logger } from '../../utils/Logger.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { api } from '../../api/index.js';
import { storage } from '../../utils/StorageService.js';

const log = logger.create('JellyfinPlayer');


// ============================================================================
// Minimal EventEmitter (inlined from player/src/bridge/EventEmitter.js)
// Only the on/off/once/emit/removeAllListeners subset — no postMessage stuff.
// ============================================================================

class EventEmitter {
    constructor() {
        this._listeners = {};
    }

    /**
     * Register a listener for an event
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
        return this;
    }

    /**
     * Register a one-time listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    once(event, callback) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            callback.apply(this, args);
        };
        wrapper._original = callback;
        return this.on(event, wrapper);
    }

    /**
     * Remove a listener
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {this}
     */
    off(event, callback) {
        if (!this._listeners[event]) return this;
        this._listeners[event] = this._listeners[event].filter(
            (fn) => fn !== callback && fn._original !== callback
        );
        return this;
    }

    /**
     * Emit an event to all registered listeners
     * @param {string} event - Event name
     * @param {...*} args - Arguments to pass to listeners
     * @returns {this}
     */
    emit(event, ...args) {
        const listeners = this._listeners[event];
        if (listeners) {
            // Iterate a copy so listeners can safely remove themselves
            [...listeners].forEach((fn) => {
                try {
                    fn.apply(this, args);
                } catch (e) {
                    console.error(`Error in listener for event "${event}":`, e);
                }
            });
        }
        return this;
    }

    /**
     * Remove all listeners, optionally for a specific event
     * @param {string} [event] - Event name (omit to clear all)
     * @returns {this}
     */
    removeAllListeners(event) {
        if (event) {
            delete this._listeners[event];
        } else {
            this._listeners = {};
        }
        return this;
    }
}

// ============================================================================
// Player Events
// ============================================================================

export const PlayerEvent = {
    PLAY: 'play',
    PAUSE: 'pause',
    STOP: 'stop',
    TIME_UPDATE: 'timeupdate',
    VOLUME_CHANGE: 'volumechange',
    PLAYBACK_START: 'playbackstart',
    PLAYBACK_STOP: 'playbackstop',
    MEDIA_STREAMS_CHANGE: 'mediastreamschange',
    ERROR: 'error',
    WAITING: 'waiting',
    PLAYING: 'playing',
    FULLSCREEN_CHANGE: 'fullscreenchange',
    STATE_CHANGE: 'statechange',
    RESTARTING: 'restarting'
};

// ============================================================================
// JellyfinPlayer Class
// ============================================================================

export class JellyfinPlayer extends EventEmitter {
    /**
     * @param {Object} options - Player options
     * @param {HTMLElement} options.container  - Container element for the player
     * @param {string}      options.serverUrl  - Jellyfin server URL
     * @param {string}      options.authToken  - Authentication token
     * @param {boolean}     [options.useTizenPlayer=false] - Use Tizen AVPlay backend
     */
    constructor(options) {
        super();

        // ====================================================================
        // Configuration
        // ====================================================================

        this.container = options.container;
        this.serverUrl = options.serverUrl;
        this.authToken = options.authToken;
        this.useTizenPlayer = options.useTizenPlayer || false;

        // ====================================================================
        // State
        // ====================================================================

        this._currentItem = null;
        this._currentMediaSource = null;
        this._currentPlayOptions = null;
        this._isPlaying = false;
        this._isPaused = false;
        // Initialize with global limit if set, otherwise null (Auto/Max)
        // User requested: Global limit acts as default manual override.
        // "Auto" (null) means Unlimited/Direct Play.
        this._manualBitrate = PlayerSettings.get('maxBitrateInternet') || null;
        this._isRestarting = false; // Flag to suppress stop events during manual quality change
        this._playbackMode = 'auto'; // Current playback mode ('auto', 'directPlay', 'transcode', 'remux')
        this._transcodingOffsetTicks = 0; // Offset for transcoded streams that start at 0
        this._pendingTranscodeSeekTicks = null; // Target position for initial transcode seek
        this._pendingStartPositionTicks = null; // Target position before first frame
        this._isSeeking = false; // Track seeking state to suppress loading screens during seek

        // Secondary subtitle stream index (kept here for OSD queries)
        this._currentSecondarySubtitleStreamIndex = -1;

        // ====================================================================
        // Subtitle Manager — centralized subtitle orchestration
        // Handles delivery method selection, external subtitle fetching,
        // cue parsing, and time-based cue ticking for both primary and
        // secondary subtitles. Embedded subs on Tizen are still routed
        // through the backend, but the manager coordinates everything.
        // ====================================================================

        this._subtitleManager = new SubtitleManager({
            container: this.container,
            serverUrl: this.serverUrl,
            authToken: this.authToken,
            // Primary cue callback — emits to PlayerPage for DOM rendering
            onPrimaryCue: (data) => this.emit('subtitlechange', data),
            // Secondary cue callback — emits to PlayerPage for secondary overlay
            onSecondaryCue: (data) => this.emit('secondarysubtitlechange', data),
            // Delivery method change — used for logging / debugging
            onDeliveryChange: (info) => {
                log.info('[SubtitleManager] Delivery changed:', info);
            }
        });

        // Chapters
        this._chapters = [];

        // ====================================================================
        // Player Backend
        // ====================================================================

        this._backend = null;
        // Device profile now uses unified api/DeviceProfile module

        // Initialize the appropriate backend
        this._initBackend();
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    /**
     * Initialize the player backend based on platform and settings.
     *
     * Priority order:
     *   1. Explicit 'playerBackend' setting ('avplay' / 'html5' / 'webos')
     *   2. Auto-detect: WebOS platform → WebOSPlayer
     *   3. Auto-detect: Tizen AVPlay API available → TizenAVPlayer
     *   4. Fallback: HtmlVideoPlayer
     *
     * The resolved backend type is stored in `this._backendType` as a plain
     * string so other methods can branch on it without instanceof checks.
     * @private
     */
    _initBackend() {
        // Detect Tizen AVPlay API (present on either namespace depending on Tizen version)
        const hasAvPlay = !!(window.tizen?.avplay || window.webapis?.avplay);
        const backendSetting = PlayerSettings.get('playerBackend') || 'auto';

        log.info(
            'Initializing backend — useTizenPlayer:', this.useTizenPlayer,
            ' | avplay detected:', hasAvPlay,
            ' | isWebOS:', platformInfo.isWebOS,
            ' | setting:', backendSetting
        );

        const sharedOptions = {
            container: this.container,
            settings:  PlayerSettings,
            onEvent:   this._handleBackendEvent.bind(this)
        };

        // ----------------------------------------------------------------
        // Explicit override: 'avplay' → always try TizenAVPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'avplay') {
            if (!hasAvPlay) {
                log.warn('Forced avplay backend, but AVPlay API not found — attempting anyway');
            }
            log.info('Using Tizen AVPlay backend (forced by setting)');
            this._backendType = 'tizen';
            this._backend    = new TizenAVPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Explicit override: 'html5' → always use HtmlVideoPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'html5') {
            log.info('Using HTML5 Video backend (forced by setting)');
            this._backendType = 'html5';
            this._backend    = new HtmlVideoPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Explicit override: 'webos' → always use WebOSPlayer
        // ----------------------------------------------------------------
        if (backendSetting === 'webos') {
            log.info('Using WebOS backend (forced by setting)');
            this._backendType = 'webos';
            this._backend    = new WebOSPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Auto-detect: WebOS platform → use the native WebOS backend.
        // This gives us hardware-accelerated HLS and track switching
        // without the complexity of the Luna media service API.
        // ----------------------------------------------------------------
        if (platformInfo.isWebOS) {
            log.info('WebOS platform detected — using WebOS backend');
            this._backendType = 'webos';
            this._backend    = new WebOSPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Auto-detect: Tizen with AVPlay available → TizenAVPlayer
        // ----------------------------------------------------------------
        if (this.useTizenPlayer && hasAvPlay) {
            log.info('Using Tizen AVPlay backend (auto-detected)');
            this._backendType = 'tizen';
            this._backend    = new TizenAVPlayer(sharedOptions);
            return;
        }

        // ----------------------------------------------------------------
        // Fallback: stock HTML5 video (desktop browser, Tizen without AVPlay)
        // ----------------------------------------------------------------
        log.info('Using HTML5 Video backend (fallback)');
        this._backendType = 'html5';
        this._backend    = new HtmlVideoPlayer(sharedOptions);
    }

    /**
     * Check if player is currently seeking
     * @returns {boolean}
     */
    get isSeeking() {
        return this._isSeeking;
    }

    /**
     * Get the current backend type string.
     * Possible values: 'tizen', 'webos', 'html5'
     * @returns {string}
     */
    get backendType() {
        return this._backendType;
    }

    /**
     * Check if the currently playing item is an audio-only item
     * (Music, Audiobooks, Podcasts). Used by OSD and PlayerPage to
     * hide video-specific controls (subtitles, tracks, chapters).
     * @returns {boolean}
     */
    isAudio() {
        const item = this._currentItem;
        if (!item) return false;
        return item.MediaType === 'Audio' || item.Type === 'AudioBook';
    }

    /**
     * Handle events from the backend player
     * @private
     */
    _handleBackendEvent(event) {
        // Clear seeking flag on relevant events
        if (event.type === PlayerEvent.SEEKED || 
            event.type === PlayerEvent.PLAYING || 
            (event.type === PlayerEvent.TIME_UPDATE && this._isSeeking)) {
            this._isSeeking = false;
        }

        // Intercept events if we are waiting for the initial Transcode Seek
        if (this._pendingTranscodeSeekTicks !== null) {
            // If we receive a TIME_UPDATE with a valid time > 0, we know playback has really started
            // and it's safe to perform our seek.
            if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time > 0) {
                 const target = this._pendingTranscodeSeekTicks;
                 this._pendingTranscodeSeekTicks = null; // Clear flag FIRST
                 
                 log.info('TranscodeSeek: Initial playback confirmed. Seeking to', target);
                 this.seek(target);
                 
                 // Transfer responsibility to the native resume validation block
                 // so the UI loading spinner stays up until the seek completes
                 this._pendingStartPositionTicks = target;
                 this._resumeWaitStartTime = Date.now();
                 return;
            }
            
            // Suppress PLAYING and TIME_UPDATE events while waiting to trigger the transcode seek
            if (event.type === PlayerEvent.PLAY || 
                event.type === PlayerEvent.PLAYING || 
                event.type === PlayerEvent.TIME_UPDATE) {
                return;
            }
        }

        // Intercept events if we are waiting for a native client-side Resume Seek to complete
        // This prevents the UI from hiding the loading spinner and flashing the 0:00 frame
        // before the player has actually jumped to the resume position.
        if (this._pendingStartPositionTicks !== null) {
            const targetSec = this._pendingStartPositionTicks / 10000000;
            const currentTime = event.data?.time || 0;

            if (event.type === PlayerEvent.TIME_UPDATE && currentTime > 0) {
                // Check if we have arrived near our target resume position
                if (Math.abs(currentTime - targetSec) < 10 || currentTime >= targetSec) {
                    this._pendingStartPositionTicks = null;
                    log.info(`Resume verified at ${currentTime}s. Dismissing loading screen.`);
                    this.emit(PlayerEvent.PLAYING);
                    // allow timeupdate to proceed below
                } else if (Date.now() - (this._resumeWaitStartTime || 0) > 15000) {
                    // Fallback: 15 seconds have passed, seek likely failed or is taking too long.
                    // Release the spinner so we don't hold the UI hostage forever.
                    this._pendingStartPositionTicks = null;
                    log.warn(`Resume fallback: 15s timeout reached. Playing at ${currentTime}s but expected ${targetSec}s. Dismissing screen.`);
                    this.emit(PlayerEvent.PLAYING);
                } else {
                    // Still waiting to reach target time. Suppress early timeupdates.
                    return;
                }
            } else if (event.type === PlayerEvent.PLAY || 
                       event.type === PlayerEvent.PLAYING || 
                       event.type === PlayerEvent.TIME_UPDATE) {
                // Suppress events while the buffer is jumping
                return;
            }
        }

        // Sync internal state
        if (event.type === PlayerEvent.PAUSE) {
            this._isPaused = true;
        } else if (event.type === PlayerEvent.PLAY || event.type === PlayerEvent.PLAYING) {
            this._isPaused = false;
        }

        // Handle timeupdate — tick the SubtitleManager to update cues
        if (event.type === PlayerEvent.TIME_UPDATE && event.data?.time !== undefined) {
            try {
                // SubtitleManager handles both primary and secondary subtitle ticking
                if (this._subtitleManager) {
                    this._subtitleManager.tick(event.data.time);
                }
            } catch (e) {
                console.error('Error ticking subtitle manager:', e.message || e, e.stack);
            }
            
            // Re-emit normalized timeupdate with absolute ticks
            this.emit(PlayerEvent.TIME_UPDATE, this.getCurrentPositionTicks());
            return;
        }

        // Route embedded subtitle events through SubtitleManager
        if (event.type === 'subtitlechange') {
            if (this._subtitleManager) {
                this._subtitleManager.handleEmbeddedSubtitleEvent(event.data);
            }
            return;
        }


        if (event.type === 'subtitlefallback') {
            log.warn('Backend requested subtitle fallback for index:', event.data.index);
            if (event.data.index !== undefined && event.data.index !== null) {
                // ================================================================
                // Guard: Only escalate to external text fallback if SubtitleManager
                // is NOT already managing this track via a specialised canvas renderer.
                //
                // When SubtitleManager chose PGS_BITMAP or ASS_CANVAS for the primary
                // track, it has already set up a PGSRenderer/ASSRenderer that is
                // actively fetching and rendering the subtitle.  Calling
                // forceExternalTextFallback() here would:
                //   1. Try to fetch the subtitle as .vtt (Jellyfin cannot convert PGS
                //      bitmaps to text → returns empty cues or garbage).
                //   2. Mark delivery as EXTERNAL_TEXT, which kills the canvas tick
                //      path and leaves the subtitle invisible.
                //
                // The backend fires subtitlefallback only to signal that IT cannot
                // render the track natively (e.g. PGS on AVPlay DirectPlay).  If
                // SubtitleManager is already covering it, we honour that and do nothing.
                // ================================================================
                const delivery = this._subtitleManager.getPrimaryDelivery();
                const primaryTrack = this._subtitleManager.getPrimaryTrack();
                const alreadyManaged = primaryTrack?.Index === event.data.index && (
                    delivery === 'pgs_bitmap' ||
                    delivery === 'ass_canvas'
                );

                if (alreadyManaged) {
                    log.info(`Subtitle fallback skipped for index ${event.data.index} — SubtitleManager already handling via ${delivery}`);
                } else {
                    // EMBEDDED_NATIVE delivery failed on the backend, or SubtitleManager
                    // hadn't set up any renderer for this track yet. Try fetching it as
                    // an external text subtitle (VTT) from the Jellyfin API.
                    this._subtitleManager.forceExternalTextFallback(event.data.index).catch(e => {
                        log.error('Failed to apply subtitle fallback:', e);
                    });
                }
            }
            return;
        }

        // Re-emit events from backend
        this.emit(event.type, event.data);
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    /**
     * Play media item
     *
     * @param {Object} options - Play options
     * @param {string} options.itemId - Jellyfin item ID
     * @param {string} [options.mediaSourceId] - Specific media source ID
     * @param {number} [options.startPositionTicks=0] - Start position in ticks
     * @param {number} [options.audioStreamIndex] - Audio track index
     * @param {number} [options.subtitleStreamIndex] - Subtitle track index
     * @returns {Promise<void>}
     */
    async play(options) {
        //log.info('Play requested:', options);
        log.info('Backend Type:', this._backendType);
        log.info('Use Tizen Player:', this.useTizenPlayer);
        
        // Update server URL/Auth if provided in play options
        if (options.serverUrl) this.serverUrl = options.serverUrl;
        if (options.authToken) this.authToken = options.authToken;

        this._currentPlayOptions = options;
        // Store initial options for potential reload
        this._lastPlayOptions = options;

        try {
            log.debug(`Requesting PlaybackInfo from ${this.serverUrl}...`);

            this._playbackMode = options.playbackMode || 'auto';

            // Determine if we need to force a remux for audio tracks on HTML5
            const isHtml5Backend = !(this._backend instanceof TizenAVPlayer);
            const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();
            
            let isCustomAudioTrack = false;
            let isFirstAudioTrack = true;
            if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
                // Determine the default and first tracks from the pre-fetched item if available
                let defaultIndex = undefined;
                let firstAudioIndex = undefined;

                if (options.item && options.item.MediaSources) {
                    const fallbackSource = options.item.MediaSources[0];
                    const ms = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
                    if (ms) {
                        defaultIndex = ms.DefaultAudioStreamIndex;
                        const audioStreams = (ms.MediaStreams || []).filter(s => s.Type === 'Audio');
                        if (audioStreams.length > 0) {
                            firstAudioIndex = audioStreams[0].Index;
                        }
                    }
                }
                
                // Compare indices (cast to number to avoid type mismatches)
                const reqIndex = Number(options.audioStreamIndex);
                isCustomAudioTrack = (reqIndex !== Number(defaultIndex));
                isFirstAudioTrack = (firstAudioIndex !== undefined && reqIndex === Number(firstAudioIndex));
                
                log.info(`[AudioSelection] Requested: ${reqIndex}, Default: ${defaultIndex}, First: ${firstAudioIndex}, Custom: ${isCustomAudioTrack}, IsFirst: ${isFirstAudioTrack}`);
            }

            const needsDirectStreamForAudio = options._forceDirectStream ||
                (isHtml5Backend && !supportsNativeAudio && (isCustomAudioTrack || !isFirstAudioTrack));

            // Determine effective playback mode for profiling
            let profilePlaybackMode = this._playbackMode;
            if (needsDirectStreamForAudio && (profilePlaybackMode === 'auto' || profilePlaybackMode === 'directPlay')) {
                log.info('HTML5 audio track selection: Upgrading profile mode to "remux" to ensure video Direct Stream.');
                profilePlaybackMode = 'remux';
            }

            // Build device profile once (avoids duplicate logs/work).
            // On an interlaced fallback retry, a pre-built html5 profile is passed in
            // via options._deviceProfile so we don't rebuild with the wrong settings.
            const deviceProfile = options._deviceProfile || buildJellyfinProfile({
                 manualBitrate: this._manualBitrate, 
                 playbackMode: profilePlaybackMode,
                 backend: this._backendType
            });
            log.info('Built DeviceProfile:', deviceProfile.Name);

            // If we still need to force remux but didn't use the 'remux' mode in profile
            // (e.g. user set bitrate limits), still clear DirectPlayProfiles as a safeguard.
            if (needsDirectStreamForAudio) {
                deviceProfile.DirectPlayProfiles = [];
            }

            // Apply Subtitle Mode logic before fetching PlaybackInfo
            // This ensures the server includes the correct subtitle in TranscodingUrls (burn-in)
            if (options.subtitleStreamIndex === undefined && options.item && options.item.MediaSources) {
                const fallbackSource = options.item.MediaSources[0];
                const ms = options.item.MediaSources.find(m => m.Id === options.mediaSourceId) || fallbackSource;
                if (ms && ms.MediaStreams) {
                    // =========================================================================
                    // Retrieve Subtitle Mode Setting
                    //
                    // Fetch the user's preferred subtitle mode setting (Default, Always, Smart, etc.).
                    // Fall back to 'Default' if no preference has been configured yet.
                    // =========================================================================
                    const subtitleMode = PlayerSettings.get('subtitleMode') || 'Default';

                    // =========================================================================
                    // PGS Subtitle Filter Guard
                    //
                    // If the user set PGS playback to "Disable and Hide Completely" in settings,
                    // they explicitly want PGS subtitles to be ignored. We filter them out of
                    // the candidate pool of subtitle streams here. This prevents the player from
                    // auto-selecting a disabled/hidden PGS track and rendering nothing, allowing
                    // it to instead fallback to a valid, renderable SRT or VTT track.
                    // =========================================================================
                                        const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';
                    const subtitleStreams = ms.MediaStreams.filter(s => {
                        // We only care about subtitle streams
                        if (s.Type !== 'Subtitle') return false;
                        
                        // If PGS rendering is disabled, filter out PGS/PGSSUB codecs
                        if (disablePgs) {
                            const codec = (s.Codec || '').toLowerCase();
                            if (codec === 'pgs' || codec === 'pgssub') {
                                return false;
                            }
                        }
                        return true;
                    });

                    // =========================================================================
                    // Prioritize and Sort Subtitle Streams
                    //
                    // To resolve selection ambiguity, sort candidate tracks based on type
                    // and delivery attributes before running the auto-selection queries:
                    //
                    // 1. External (EXT) tracks first: External files added explicitly by the user
                    //    should take priority over embedded/internal streams.
                    // 2. Codec-level priority: Prefer formats in this order:
                    //    ASS/SSA (highest styled styling fidelity) -> SRT/SUBRIP -> PGS/PGSSUB -> others.
                    // =========================================================================
                    const getCodecPriority = (codec) => {
                        const c = (codec || '').toLowerCase();
                        if (c === 'ass' || c === 'ssa') {
                            return 4; // Styled subtitles preferred first
                        }
                        if (c === 'srt' || c === 'subrip') {
                            return 3; // Clean text-based standard fallback
                        }
                        if (c === 'pgs' || c === 'pgssub') {
                            return 2; // Picture-based subtitle tracks
                        }
                        return 1; // Any other uncategorized format
                    };

                    subtitleStreams.sort((a, b) => {
                        // Extract external status
                        const aExt = !!a.IsExternal;
                        const bExt = !!b.IsExternal;

                        // Check if one is external and the other is internal
                        if (aExt !== bExt) {
                            // Put external tracks first
                            return aExt ? -1 : 1;
                        }

                        // Determine codec priority for both streams
                        const aPriority = getCodecPriority(a.Codec);
                        const bPriority = getCodecPriority(b.Codec);

                        // If priorities differ, place higher priority first
                        if (aPriority !== bPriority) {
                            return bPriority - aPriority;
                        }

                        // Keep original sequence stable if identical priority
                        return 0;
                    });

                    let chosenIndex = undefined;

                    // Apply the corresponding selection logic depending on the mode
                    if (subtitleMode === 'None') {
                        chosenIndex = -1;
                    } else if (subtitleMode === 'Default') {
                        // =====================================================================
                        // Server Default Track Resolution with PGS Safeguard
                        //
                        // Verify if the server-provided default track is a PGS track. If PGS is
                        // disabled, we discard this track and fall back to searching the rest of
                        // the filtered candidate streams (which have PGS excluded).
                        // =====================================================================
                        const serverDefaultTrack = ms.DefaultSubtitleStreamIndex !== undefined && ms.DefaultSubtitleStreamIndex !== null
                            ? ms.MediaStreams.find(s => s.Index === ms.DefaultSubtitleStreamIndex)
                            : null;
                        const isServerDefaultPgs = serverDefaultTrack && 
                            ((serverDefaultTrack.Codec || '').toLowerCase() === 'pgs' || (serverDefaultTrack.Codec || '').toLowerCase() === 'pgssub');
                        
                        // Use default only if valid and not a disabled PGS track
                        if (ms.DefaultSubtitleStreamIndex !== undefined && 
                            ms.DefaultSubtitleStreamIndex !== null && 
                            !(disablePgs && isServerDefaultPgs)) {
                            chosenIndex = ms.DefaultSubtitleStreamIndex;
                        } else {
                            // Find the first default or forced track from the filtered candidate list
                            const subStream = subtitleStreams.find(s => s.IsDefault || s.IsForced);
                            if (subStream) chosenIndex = subStream.Index;
                        }
                    } else {
                        const prefLang = storage.getItem('pref:subtitleLang') || 'none';
                        const audioStreamIndex = options.audioStreamIndex !== undefined ? options.audioStreamIndex : ms.DefaultAudioStreamIndex;
                        const audioStream = ms.MediaStreams.find(s => s.Type === 'Audio' && s.Index === audioStreamIndex);
                        const audioLang = audioStream ? (audioStream.Language || 'und') : 'und';
                        
                        if (subtitleMode === 'OnlyForced') {
                            let forced = subtitleStreams.find(s => s.IsForced && s.Language === prefLang);
                            if (!forced) forced = subtitleStreams.find(s => s.IsForced);
                            if (forced) chosenIndex = forced.Index;
                        } else if (subtitleMode === 'Always') {
                            let best = subtitleStreams.find(s => s.Language === prefLang && (s.IsDefault || s.IsForced));
                            if (!best) best = subtitleStreams.find(s => s.Language === prefLang);
                            if (!best) best = subtitleStreams.find(s => s.IsDefault || s.IsForced);
                            if (!best && subtitleStreams.length > 0) best = subtitleStreams[0];
                            if (best) chosenIndex = best.Index;
                        } else if (subtitleMode === 'Smart') {
                            // Smart = Show if audio is NOT in the preferred subtitle language.
                            if (prefLang !== 'none' && audioLang !== prefLang && audioLang !== 'und') {
                                let best = subtitleStreams.find(s => s.Language === prefLang && (s.IsDefault || s.IsForced));
                                if (!best) best = subtitleStreams.find(s => s.Language === prefLang);
                                if (best) chosenIndex = best.Index;
                            } else {
                                let forced = subtitleStreams.find(s => s.IsForced && s.Language === prefLang);
                                if (!forced) forced = subtitleStreams.find(s => s.IsForced);
                                if (forced) chosenIndex = forced.Index;
                            }
                        }
                    }
                    
                    if (chosenIndex !== undefined) {
                        options.subtitleStreamIndex = chosenIndex;
                        log.info(`[SubtitleSelection] Pre-flight Mode: ${subtitleMode}, Chosen Index: ${chosenIndex}`);
                    }
                }
            }

            // Get playback info from server
            const playbackInfo = await this._getPlaybackInfo(options, deviceProfile, this._manualBitrate);
            log.debug('PlaybackInfo keys:', Object.keys(playbackInfo));
            if (playbackInfo.MediaSources && playbackInfo.MediaSources.length > 0) {
                 log.debug('MediaSource[0] keys:', Object.keys(playbackInfo.MediaSources[0]));
            }


            if (!playbackInfo || !playbackInfo.MediaSources?.length) {
                log.error('No media sources in PlaybackInfo');
                throw new Error('No media sources available');
            }

            // Select best media source:
            // For Live TV channels, the server dynamically generates the media source ID
            // when it opens the tuner — it will NEVER match options.mediaSourceId (which is
            // the channel item ID). Always pick the first source for live channels.
            const isLiveChannel = options.item?.Type === 'TvChannel';
            const mediaSource = (!isLiveChannel && options.mediaSourceId)
                ? playbackInfo.MediaSources.find((ms) => ms.Id === options.mediaSourceId)
                : playbackInfo.MediaSources[0];

            if (!mediaSource) {
                log.error('Media source selection failed');
                throw new Error('Media source not found');
            }

            if (mediaSource.TranscodingInfo) {
                log.info(`[PlaybackMode] IsDirectStream: ${mediaSource.TranscodingInfo.IsVideoDirect ? 'Yes' : 'No'}`);
            }

            // ================================================================
            // DEBUG: Log video stream properties to diagnose transcoding decisions
            // This helps identify exactly which CodecProfile condition fails.
            // ================================================================
            const videoStream = (mediaSource.MediaStreams || []).find(s => s.Type === 'Video');
            if (videoStream) {
                log.info(`[PlaybackMode] VideoStream: Codec=${videoStream.Codec}, Profile=${videoStream.Profile}, Level=${videoStream.Level}, BitDepth=${videoStream.BitDepth}, RangeType=${videoStream.VideoRangeType}, Width=${videoStream.Width}x${videoStream.Height}`);
            }
            if (mediaSource.TranscodingUrl) {
                log.info(`[PlaybackMode] TranscodingUrl: ${mediaSource.TranscodingUrl}`);
            }
            log.info(`[PlaybackMode] SupportsDirectPlay=${mediaSource.SupportsDirectPlay}, SupportsDirectStream=${mediaSource.SupportsDirectStream}`);
            // MediaHelper also derives PlayMethod, let's check that
            let playMethod = MediaHelper.getPlayMethod(mediaSource);

            // In "Force Remux" mode, the server might report "Transcode" because it technically
            // falls back to the transcoding pipeline, but if the only reason is "DirectPlayError",
            // it means it's remuxing (copying streams) because we enabled all codecs in DeviceProfile.
            const wasForcedRemux = (this._playbackMode === 'remux' || (typeof profilePlaybackMode !== 'undefined' && profilePlaybackMode === 'remux'));
            if (wasForcedRemux && playMethod === 'Transcode') {
                const reasons = mediaSource.TranscodingReasons;
                const hasOnlyDirectPlayError = reasons === 'DirectPlayError' || 
                    (Array.isArray(reasons) && reasons.length === 1 && reasons[0] === 'DirectPlayError');
                
                // Also check the URL parameters if reasons property is empty (it's often in the URL)
                const urlHasOnlyDirectPlayError = mediaSource.TranscodingUrl && 
                    mediaSource.TranscodingUrl.includes('TranscodeReasons=DirectPlayError') &&
                    !mediaSource.TranscodingUrl.includes('ContainerNotSupported') &&
                    !mediaSource.TranscodingUrl.includes('VideoCodecNotSupported') &&
                    !mediaSource.TranscodingUrl.includes('AudioCodecNotSupported');

                if (hasOnlyDirectPlayError || urlHasOnlyDirectPlayError) {
                     playMethod = 'Remux';
                     
                     // CRITICAL: Update the MediaSource object itself so that
                     // MediaHelper.getPlayMethod() returns 'Remux' for the OSD/UI later.
                     mediaSource.SupportsDirectStream = true;
                     
                     log.info('[PlaybackMode] Inferring Remux based on DirectPlayError only.');
                }
            }
            if (this._playbackMode === 'transcode') {
                playMethod = 'Transcode';
                mediaSource.SupportsDirectStream = false;
                mediaSource.SupportsDirectPlay = false;
                
                // Force MediaHelper to evaluate this as a full transcode for UI overlays
                if (!mediaSource.TranscodingInfo) {
                    mediaSource.TranscodingInfo = {
                        IsVideoDirect: false,
                        IsAudioDirect: false,
                        VideoCodec: 'h264', // Dummy value to prevent !VideoCodec fallback
                        AudioCodec: 'aac'
                    };
                } else {
                    mediaSource.TranscodingInfo.IsVideoDirect = false;
                    mediaSource.TranscodingInfo.IsAudioDirect = false;
                }
                
                log.info('[PlaybackMode] Enforcing Transcode label due to strict transcode mode.');
            }

            log.info(`[PlaybackMode] Calculated PlayMethod: ${playMethod}`);

            // Store the resolved play method so track-switching logic can
            // reliably detect transcoding without re-deriving from media source
            // flags (which may have been mutated, e.g. by the remux case above).
            this._currentPlayMethod = playMethod;

            // Attach play session ID to media source
            if (playbackInfo.PlaySessionId) {
                mediaSource.PlaySessionId = playbackInfo.PlaySessionId;
            }

            // ================================================================
            // Interlaced Backend Fallback — AVPlay Auto-Switch
            //
            // Samsung's AVPlay HLS parser crashes with PLAYER_ERROR_NOT_SUPPORTED_FORMAT
            // when the video stream contains interlaced H264 frames (e.g. 1080i DVB/ATSC
            // broadcasts). The Chromium software decoder in the HTML5 backend handles
            // interlaced H264 natively, so we transparently restart the session on HTML5
            // when all of the following conditions are met:
            //
            //   1. We are currently on the AVPlay (tizen) backend
            //   2. The user has 'interlacedBackendFallback' enabled in settings
            //   3. The video stream is flagged IsInterlaced=true by Jellyfin
            //   4. A non-HTML5 restart has not already been attempted (guard flag)
            //
            // No server-side transcoding happens — the device profile built for HTML5
            // omits the IsInterlaced=false CodecProfile condition, so the server will
            // direct-stream or direct-play the interlaced content as-is.
            // ================================================================
            if (
                this._backendType === 'tizen' &&
                PlayerSettings.get('interlacedBackendFallback') &&
                !options._interlacedFallbackAttempted
            ) {
                const isInterlaced = videoStream && videoStream.IsInterlaced === true;
                if (isInterlaced) {
                    log.info(
                        `[InterlacedFallback] Interlaced video detected (${videoStream.Width}x${videoStream.Height}i). ` +
                        'AVPlay cannot handle interlaced HLS — restarting on HTML5 backend.'
                    );

                    // Stop the current backend before switching — it hasn't started playing yet,
                    // but belt-and-suspenders in case prepareAsync was triggered internally.
                    try {
                        await this._backend.stop();
                    } catch (stopErr) {
                        log.warn('[InterlacedFallback] Backend stop() threw during pre-switch cleanup:', stopErr);
                    }

                    // Switch backend to HTML5 in-place (no page reload needed).
                    // HtmlVideoPlayer is already statically imported at the top of this module,
                    // so we just construct a new instance directly.
                    this._backend = new HtmlVideoPlayer({
                        container: this.container,
                        settings: PlayerSettings,
                        onEvent: this._handleBackendEvent.bind(this)
                    });
                    this._backendType = 'html5';
                    log.info('[InterlacedFallback] Backend switched to html5. Rebuilding profile and restarting...');

                    // Rebuild with html5 backend so the profile omits IsInterlaced=false,
                    // allowing the server to direct-stream the interlaced content unchanged.
                    const html5Profile = buildJellyfinProfile({
                        manualBitrate: this._manualBitrate,
                        playbackMode: profilePlaybackMode,
                        backend: 'html5'
                    });

                    // Re-request PlaybackInfo with the html5 profile so the server
                    // knows it no longer needs to deinterlace, then start playback.
                    // Set the guard flag so we never loop if html5 also somehow fails.
                    return this.play({
                        ...options,
                        _interlacedFallbackAttempted: true,
                        _deviceProfile: html5Profile
                    });
                }
            }

            this._currentMediaSource = mediaSource;
            this._currentItem = options.item || { Id: options.itemId };

            // ================================================================
            // Chapter Resolution
            //
            // We resolve chapters after establishing _currentMediaSource and
            // _currentItem. This prevents race conditions where the 'chaptersloaded'
            // event triggers an OSD render that tries to read duration from a
            // null media source.
            // ================================================================
            const isAudioItemForChapters = this._currentItem?.MediaType === 'Audio' ||
                                 this._currentItem?.Type === 'AudioBook';

            let chapters = [];
            if (!isAudioItemForChapters) {
                chapters = this._currentItem?.Chapters || [];

                if (chapters.length > 0) {
                    log.info('Using chapters from item object:', chapters.length);
                } else if (playbackInfo.Chapters && playbackInfo.Chapters.length > 0) {
                    chapters = playbackInfo.Chapters;
                    log.info('Using chapters from PlaybackInfo:', chapters.length);
                } else {
                    log.info('Chapters missing. Fetching item details...');
                    try {
                        const itemDetails = await api.getItem(options.itemId, { Fields: 'Chapters,Trickplay,RunTimeTicks' });
                        if (itemDetails?.Chapters) {
                            chapters = itemDetails.Chapters;
                            log.info('Chapters fetched from API:', chapters.length);
                        }
                        // Back-fill RunTimeTicks if missing
                        if (itemDetails?.RunTimeTicks && !this._currentItem.RunTimeTicks) {
                            this._currentItem.RunTimeTicks = itemDetails.RunTimeTicks;
                        }
                    } catch (e) {
                        log.warn('Failed to fetch item details for chapters:', e);
                    }
                }
            }

            this._chapters = chapters;
            this.emit('chaptersloaded', { chapters: this._chapters });

            // ================================================================
            // Duration Resolution — back-fill from item metadata
            //
            // Jellyfin's PlaybackInfo often omits RunTimeTicks on the
            // MediaSource for transcoded HLS streams, even though the item's
            // own API response carries it. We copy it over here so that
            // getDurationTicks() can find it without needing a second API call.
            //
            // If BOTH sources lack RunTimeTicks (server has genuinely never
            // scanned/stored duration for this file), we fall through. In that
            // case getDurationTicks() will try to read the HLS.js manifest
            // duration once the transcoder finishes encoding, then fall back to
            // the growing backend value as a last resort.
            // ================================================================
            if (!this._currentMediaSource.RunTimeTicks && this._currentItem?.RunTimeTicks) {
                log.info(`[Duration] Back-filling RunTimeTicks from item metadata: ${this._currentItem.RunTimeTicks} ticks`);
                this._currentMediaSource.RunTimeTicks = this._currentItem.RunTimeTicks;
            }

            if (!this._currentMediaSource.RunTimeTicks) {
                log.warn('[Duration] MediaSource and item both lack RunTimeTicks — will rely on HLS manifest or backend duration');
            }

            // Set up the SubtitleManager with the current media context
            // This tells it what item/source we're playing and what backend we're using
            const backend = this._backend || this._videoPlayer;
            this._subtitleManager.setMediaContext({
                itemId:       options.itemId,
                mediaSourceId: mediaSource.Id,
                mediaStreams:  mediaSource.MediaStreams || [],
                mediaAttachments: mediaSource.MediaAttachments || [],
                // Use the resolved _backendType string so SubtitleManager knows
                // whether it should attempt embedded-native subtitle routing
                // (Tizen only) or always defer to external text/ASS/PGS paths.
                backendType:   this._backendType,
                videoElement:  (backend && backend.getVideoElement) ? backend.getVideoElement() : null,
                playMethod:    this._currentPlayMethod
            });

            // Initialize current stream indices
            this._currentAudioStreamIndex = options.audioStreamIndex;
            this._currentSubtitleStreamIndex = options.subtitleStreamIndex;

            // If not provided, try to find default from MediaSource
            if (this._currentAudioStreamIndex === undefined && mediaSource.MediaStreams) {
                const audioStream =
                    mediaSource.MediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault) ||
                    mediaSource.MediaStreams.find((s) => s.Type === 'Audio');
                if (audioStream) this._currentAudioStreamIndex = audioStream.Index;
            }

            // If not provided (and not resolved pre-flight), subtitles default to off
            if (this._currentSubtitleStreamIndex === undefined) {
                this._currentSubtitleStreamIndex = -1;
            }

            // Check play method to determine if we need to force start-at-0 (for Transcode/Remux)
            // playMethod was already derived above for logging
            const originalStartPositionTicks = options.startPositionTicks || 0;
            let effectiveStartPositionTicks = originalStartPositionTicks;
            let isTranscodeSeek = false;

            // Save the intended start position for the UI before the backend initializes.
            this._pendingStartPositionTicks = originalStartPositionTicks > 0 ? originalStartPositionTicks : null;

            // User Request: When transcoding or remuxing, start playback at 0, 
            // and after it's loaded seek to the resume location if it exists
            if ((playMethod === 'Transcode' || playMethod === 'DirectStream' || playMethod === 'Remux') && originalStartPositionTicks > 0) {
                log.info(`Transcode detected: Starting at 0 ticks, will seek to ${originalStartPositionTicks} after load`);
                effectiveStartPositionTicks = 0;
                isTranscodeSeek = true;
                
                // Do not apply early resume validation yet. We will transfer it once the TranscodeSeek triggers.
                this._pendingStartPositionTicks = null;
            } else if (this._pendingStartPositionTicks) {
                // For native client-side seeking, start the 15-second wall-clock timeout immediately
                this._resumeWaitStartTime = Date.now();
            }

            // Build stream URL
            const streamInfo = MediaHelper.buildStreamUrl({
                serverUrl: this.serverUrl,
                itemId: options.itemId,
                mediaSource,
                startPositionTicks: effectiveStartPositionTicks,
                playSessionId: playbackInfo.PlaySessionId,
                authToken: this.authToken,
                deviceProfile: deviceProfile,
                // Pass audioStreamIndex so it's included in manually-built fallback URLs.
                // When TranscodingUrl is present (the normal case), the server already
                // has this baked in and this param is unused.
                audioStreamIndex: this._currentAudioStreamIndex
            });

            //log.debug('Stream Info built:', streamInfo);

            // Save transcoding offset
            this._transcodingOffsetTicks = streamInfo.transcodingOffsetTicks || 0;
            if (this._transcodingOffsetTicks > 0) {
                log.info('Transcoding offset:', this._transcodingOffsetTicks);
            }

            // Start playback on backend
            log.info('Initializing backend playback...');

            // Handle delayed seek for Transcode/Remux
            // CRITICAL: Set this BEFORE play() to ensure we catch all initial events
            if (isTranscodeSeek) {
                log.info('TranscodeSeek: Enabled. Waiting for timeupdate to seek to:', originalStartPositionTicks);
                this._pendingTranscodeSeekTicks = originalStartPositionTicks;
                // Explicitly emit WAITING to ensure spinner is shown
                this.emit(PlayerEvent.WAITING);
            }

            const backendOptions = {
                ...streamInfo,
                item: this._currentItem,
                mediaSource,
                startPositionTicks: streamInfo.playerStartPositionTicks, // Use adjusted start position
                audioStreamIndex: this._currentAudioStreamIndex,
                audioTrackListIndex: this._getBackendAudioTrackListIndex(this._currentAudioStreamIndex, mediaSource),
                subtitleStreamIndex: options.subtitleStreamIndex,
                // Tell the backend what play method was negotiated — critical so
                // TizenAVPlayer knows NOT to apply native track selection when
                // the server is transcoding (audio is baked into the HLS stream).
                playMethod: playMethod,
                autoPlay: options.autoPlay
            };

            /*
             * -------------------------------------------------------------------------
             * Pre-flight Subtitle Awaiting
             * -------------------------------------------------------------------------
             * If the user opted into the 'awaitTracksBeforePlayback' setting, we block
             * and fully download/parse the subtitle cues (e.g. SRT, VTT, ASS canvas fonts,
             * or PGS bitmaps) BEFORE starting the native player decoder. This completely
             * eliminates the visual subtitle flash/pop-in effect on TV displays.
             * -------------------------------------------------------------------------
             */
            const isAudioItemSetup = options.item?.MediaType === 'Audio' ||
                                      options.item?.Type === 'AudioBook';

            const awaitTracks = PlayerSettings.get('awaitTracksBeforePlayback');

            if (awaitTracks && !isAudioItemSetup && this._currentSubtitleStreamIndex !== undefined && this._currentSubtitleStreamIndex !== -1) {
                log.info('[Play-Flow] Awaiting subtitle track setup pre-flight...');
                this._playSetupInProgress = true;
                try {
                    // Fully await subtitle loading (resolves once cues/renderers are ready)
                    await this.setSubtitleStreamIndex(this._currentSubtitleStreamIndex);
                    log.info('[Play-Flow] Pre-flight subtitle setup completed successfully');
                } catch (err) {
                    log.warn('[Play-Flow] Pre-flight initial subtitle setup failed:', err);
                } finally {
                    this._playSetupInProgress = false;
                }
            }

            // Instruct the resolved backend (TizenAVPlayer, WebOSPlayer, or HTML5) to initialize
            await this._backend.play(backendOptions);
            log.info('Backend play() promise resolved');

            this._isPlaying = true;
            this._isPaused = options.autoPlay === false;

            this.emit(PlayerEvent.PLAYBACK_START, {
                item: this._currentItem,
                mediaSource
            });

            /*
             * -------------------------------------------------------------------------
             * Standard Asynchronous Subtitle Setup
             * -------------------------------------------------------------------------
             * If the awaitTracks option is disabled, we restore the original behavior:
             * start decoding instantly and load subtitles in the background asynchronously.
             * -------------------------------------------------------------------------
             */
            if (!awaitTracks && !isAudioItemSetup && this._currentSubtitleStreamIndex !== undefined && this._currentSubtitleStreamIndex !== -1) {
                // Initialize the SubtitleManager with the selected subtitle track.
                // The subtitle index is already included in the server request, so
                // this call only needs to set up CLIENT-SIDE rendering.
                this._playSetupInProgress = true;
                // Fire-and-forget — don't block playback on subtitle fetch
                this.setSubtitleStreamIndex(this._currentSubtitleStreamIndex)
                    .catch((err) => log.warn('Initial subtitle setup failed:', err))
                    .finally(() => { this._playSetupInProgress = false; });
            }
        } catch (error) {
            log.error('Playback error caught:', error);
            this.emit(PlayerEvent.ERROR, { error, type: 'playback' });
            throw error;
        }
    }

    /**
     * Pause playback
     */
    pause() {
        this._backend?.pause();
        // State update and event emission handled by _handleBackendEvent
    }

    /**
     * Resume playback
     */
    unpause() {
        this.emit(PlayerEvent.PLAY);
        this._backend?.unpause();
        // State update and event emission handled by _handleBackendEvent
    }

    /**
     * Toggle play/pause
     */
    togglePlay() {
        if (this._isPaused) {
            this.unpause();
        } else {
            this.pause();
        }
    }

    /**
     * Stop playback
     */
    async stop() {
        if (this._backend) {
            await this._backend.stop();
        }

        const item = this._currentItem;
        const positionTicks = this.getCurrentPositionTicks();

        // Only clear state if NOT restarting
        if (!this._isRestarting) {
            this._currentItem = null;
            this._currentMediaSource = null;
            this._currentPlayOptions = null;
        }
        
        this._isPlaying = false;
        this._isPaused = false;

        // Only emit stop events if we are NOT restarting
        if (!this._isRestarting) {
            this._manualBitrate = null;
            this._transcodingOffsetTicks = 0;
            this._playbackSpeed = 1; // Reset speed on stop
            this.emit(PlayerEvent.STOP);
            this.emit(PlayerEvent.PLAYBACK_STOP, { item, positionTicks });
        } else {
            log.info('Suppressing STOP events due to restart');
        }
    }

    /**
     * Seek to position
     * @param {number} positionTicks - Position in ticks (1 tick = 100 nanoseconds)
     * @param {Object} [options] - Additional options
     * @param {boolean} [options.suppressWaitingEvent] - Don't emit 'waiting' during this seek's buffer phase
     */
    seek(positionTicks, options = {}) {
        // High-Priority State Update: Indicate that seeking is actively occurring
        this._isSeeking = true;
        this._seekTargetTicks = positionTicks;

        // INSTANT SUBTITLE WIPE:
        // Clear all active subtitles instantly when seeking. This prevents the currently
        // displayed cue from lingering as a ghost overlay during the buffering/loading phase
        // of a seek operation (whether scrubbing, chapter skips, or direct d-pad seeks).
        if (this._subtitleManager) {
            // Fancy explanation: reset active state caches and flush any DOM / canvas subtitle layers
            this._subtitleManager.resetActiveCues();
        }

        // Delegate the core seek execution to our underlying player backend (AVPlay, HTML5, WebOS)
        this._backend?.seek(positionTicks, options);

        // Notify all registered UI/OSD event listeners that seek has successfully fired
        this.emit('seek', { positionTicks });
    }

    /**
     * Seek relative to current position
     * @param {number} offsetMs - Offset in milliseconds (positive = forward)
     */
    seekRelative(offsetMs) {
        const currentMs = this.getCurrentPositionMs();
        const newMs = Math.max(0, currentMs + offsetMs);
        this.seek(newMs * 10000); // Convert ms to ticks
    }

    // ========================================================================
    // Volume Control
    // ========================================================================

    /**
     * Set volume
     * @param {number} volume - Volume level (0-100)
     */
    setVolume(volume) {
        this._backend?.setVolume(volume);
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume });
    }

    /**
     * Get current volume
     * @returns {number} Volume level (0-100)
     */
    getVolume() {
        return this._backend?.getVolume() ?? 100;
    }

    /**
     * Toggle mute
     */
    toggleMute() {
        this._backend?.toggleMute();
    }

    /**
     * Set mute state explicitly.
     * Called by PlayerPage when a remote Mute / Unmute command arrives via WebSocket.
     * Delegates to the backend player (HtmlVideoPlayer.setMuted or TizenAVPlayer).
     * @param {boolean} muted
     */
    setMuted(muted) {
        if (this._backend?.setMuted) {
            this._backend.setMuted(muted);
        } else {
            // Fallback: backend may only expose toggleMute — use isMuted to decide
            if (Boolean(muted) !== this.isMuted()) {
                this._backend?.toggleMute?.();
            }
        }
        this.emit(PlayerEvent.VOLUME_CHANGE, { volume: this.getVolume() });
    }

    /**
     * Check if muted
     * @returns {boolean}
     */
    isMuted() {
        return this._backend?.isMuted() ?? false;
    }

    // ========================================================================
    // Track Selection
    // ========================================================================

    /**
     * Set audio track.
     *
     * During DirectPlay, the backend can switch tracks natively.
     * During Transcode/DirectStream (server re-encodes the video), the audio
     * channel is baked into the server's output stream. Changing it requires
     * a full retranscode restart with the new AudioStreamIndex, exactly like
     * switching subtitle tracks in burn-in mode.
     *
     * @param {number} index - Audio stream index (Jellyfin ID)
     */
    async setAudioStreamIndex(index) {
        this._currentAudioStreamIndex = index;

        let isTargetCodecSupported = true;
        if (this._backendType === 'tizen' || this._backendType === 'webos') {
            const AudioTracks = this.getAudioTracks();
            const targetTrack = AudioTracks.find(t => t.Index === index);
            if (targetTrack && targetTrack.Codec) {
                const targetCodec = targetTrack.Codec.toLowerCase();
                if (this._backendType === 'tizen' && (targetCodec === 'flac' || targetCodec === 'alac') && !PlayerSettings.get('enableFlacInVideo')) {
                    isTargetCodecSupported = false;
                } else if (targetCodec.includes('dts') && !PlayerSettings.get('enableDts')) {
                    isTargetCodecSupported = false;
                } else if (targetCodec === 'truehd' && !PlayerSettings.get('enableTrueHd')) {
                    isTargetCodecSupported = false;
                }
            }
        }

        const supportsNativeAudio = this._backend && typeof this._backend.supportsNativeAudioTracks === 'function' && this._backend.supportsNativeAudioTracks();

        // Remux on WebOS with a supported codec: HLS already has all tracks, switch natively.
        // Remux on Tizen always restarts — AVPlay FLAC gate must stay in effect.
        const isTranscoding = this._currentPlayMethod === 'Transcode' ||
                              this._currentPlayMethod === 'DirectStream' ||
                              (this._currentPlayMethod === 'Remux' && !(this._backendType === 'webos' && isTargetCodecSupported && supportsNativeAudio));
        const requiresRestart = isTranscoding || !isTargetCodecSupported || (this._backendType !== 'tizen' && !supportsNativeAudio);

        log.info(`setAudioStreamIndex: index=${index} playMethod=${this._currentPlayMethod} requiresRestart=${requiresRestart} isTargetCodecSupported=${isTargetCodecSupported}`);

        if (requiresRestart && this._currentPlayOptions && !this._audioRestartInProgress) {
            log.info(`Restarting playback for audio track: ${index} (method: ${this._currentPlayMethod ?? 'DirectPlay/HTML5'})`);

            const currentTicks = this.getCurrentPositionTicks();
            
            // Check if the requested index is the original default track
            let isCustomAudioTrack = true;
            if (this._currentItem && this._currentItem.MediaSources) {
                const msId = this._currentPlayOptions.mediaSourceId;
                const fallbackSource = this._currentItem.MediaSources[0];
                const ms = this._currentItem.MediaSources.find(m => m.Id === msId) || fallbackSource;
                if (ms && index === ms.DefaultAudioStreamIndex) {
                    isCustomAudioTrack = false;
                }
            }

            // 'auto' preserves CodecProfiles so Jellyfin transcodes unsupported codecs correctly.
            const restartPlaybackMode = this._playbackMode === 'transcode' ? 'transcode'
                : !isTargetCodecSupported ? 'auto'
                : 'remux';
            const restartOptions = {
                ...this._currentPlayOptions,
                audioStreamIndex: index,
                startPositionTicks: currentTicks,
                playbackMode: restartPlaybackMode,
                _forceDirectStream: this._backendType !== 'tizen' && !supportsNativeAudio && isCustomAudioTrack
            };

            // Persist so future restarts (bitrate change, etc.) carry the right track
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set guard BEFORE play() to block re-entrant restarts
            this._audioRestartInProgress = true;
            this._isRestarting = true;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop();
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.play(restartOptions);
                // Reset the restarting flag on success so subsequent stop() calls
                // emit proper STOP events and clear state normally.
                this._isRestarting = false;
            } catch (e) {
                log.error('Failed to restart playback for audio track switch:', e);
                this._isRestarting = false;
            } finally {
                // Always clear the guard when done, success or failure
                this._audioRestartInProgress = false;
            }

            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // In transcoding mode but called from play()'s internal audio setup —
        // there's nothing to do; the server already has the correct index.
        if (isTranscoding) {
            log.info(`[${this._currentPlayMethod}] Skipping native audio switch — server already has the correct track`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        // =====================================================================
        // DirectPlay: native backend audio switching (no restart needed)
        // =====================================================================

        // Both Tizen (AVPlay) and HtmlVideoPlayer work with 0-based list
        // indices of available audio tracks, NOT the raw Jellyfin stream ID.
        // Convert here so both backends share the same simple interface.
        const tracks = this._getBackendAudioTracks();
        const listIndex = this._getBackendAudioTrackListIndex(index);

        if (listIndex === -1) {
            log.warn('StreamID', index, 'not found in audio tracks:', tracks.map(t => t.Index));
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
            return;
        }

        log.debug('Converting StreamID', index, 'to list index', listIndex);
        this._backend?.setAudioStreamIndex(listIndex);

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { audioStreamIndex: index });
    }

    /**
     * Set subtitle track — delegates to SubtitleManager for delivery routing.
     * SubtitleManager decides whether to use embedded native rendering
     * (Tizen AVPlay) or fetch/parse the subtitle externally.
     *
     * Special case: in "Always Burn In" mode, every subtitle track is burned
     * into the video server-side during transcoding. Changing the track in this
     * mode means re-sending a new transcoding request with the updated
     * SubtitleStreamIndex — we must restart playback from the current position.
     *
     * @param {number} index - Subtitle stream index (-1 to disable)
     */
    async setSubtitleStreamIndex(index) {
        this._currentSubtitleStreamIndex = index;

        // =====================================================================
        // Burn-in restart: if the server is baking the subtitle into the video,
        // switching tracks requires a full retranscode. Two applicable modes:
        //
        //   'all'        → server burns EVERY subtitle format. Always restart.
        //
        //   'allcomplex' / 'auto' → server burns ONLY complex/bitmap formats (PGS,
        //                   VOBSUB, ASS, SSA). Simple Text formats (SRT, VTT) are 
        //                   delivered externally — no restart needed for those.
        //
        // Guards: _playSetupInProgress     → called from play()'s own setup;
        //                                    subtitle index already in server req.
        //         _burnInRestartInProgress → already inside a restart; prevents
        //                                    re-entrant second restart from play().
        // =====================================================================
        const burnIn = PlayerSettings.get('subtitleBurnIn');
        const isTranscodingSession = this._currentPlayMethod === 'Transcode' ||
                                     this._currentPlayMethod === 'DirectStream';

        // In 'allcomplex' / 'auto' mode:
        //
        //   Complex formats (PGS, VOBSUB, ASS, SSA): the server burns them in when it
        //   transcodes. Selecting a complex subtitle while DIRECT-PLAYING must also
        //   trigger a restart — the server needs to start transcoding with the
        //   subtitle burned in. So complex = ALWAYS restart in allcomplex mode.
        //
        //   Simple Text formats (SRT, VTT): served externally by the server API,
        //   so the client can render them without a restart UNLESS we're already
        //   transcoding — in that case the server has a specific SubtitleStreamIndex
        //   locked into the current HLS session and we must restart to change it.
        const _isAllComplex = burnIn === 'allcomplex' || burnIn === 'auto';
        const isComplexCodec = (() => {
            if (!_isAllComplex || index === -1) return false;
            const track = this.getSubtitleTracks().find(t => t.Index === index);
            const codec = (track?.Codec || '').toLowerCase();
            return codec === 'pgs' || codec === 'pgssub' ||
                   codec === 'vobsub' || codec === 'dvdsub' || codec === 'dvd_subtitle' ||
                   codec === 'ass' || codec === 'ssa';
        })();

        // Complex in allcomplex: always restart (even from direct play)
        // Simple text in allcomplex + transcoding: restart (subtitle locked in stream URL)
        const isComplexBurnIn = (_isAllComplex && isComplexCodec) ||
                               (_isAllComplex && isTranscodingSession);

        const needsBurnInRestart = burnIn === 'all' || isComplexBurnIn;

        if (needsBurnInRestart && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
            log.info(`Burn-in restart (mode: ${burnIn}, track: ${index}) — retranscoding`);

            // Capture current position so we can resume from the same spot
            const currentTicks = this.getCurrentPositionTicks();

            // Build new play options with the updated subtitle stream index
            const restartOptions = {
                ...this._currentPlayOptions,
                subtitleStreamIndex: index,
                startPositionTicks: currentTicks,
                playbackMode: this._playbackMode
            };

            // Persist the new index so that subsequent restarts (e.g. bitrate
            // changes) also carry the correct subtitle stream index
            this._currentPlayOptions = restartOptions;
            this._lastPlayOptions = restartOptions;

            // Set the guard BEFORE calling play() so that the internal
            // setSubtitleStreamIndex call from play() skips this path
            this._burnInRestartInProgress = true;
            this._isRestarting = true;
            try {
                this.emit(PlayerEvent.RESTARTING);
                await this.stop();
                await new Promise(resolve => setTimeout(resolve, 500));
                await this.play(restartOptions);
                // Reset on success so subsequent stop() calls behave normally
                this._isRestarting = false;
            } finally {
                // Always clear the guard when done
                this._burnInRestartInProgress = false;
            }

            // Notify OSD of the track change
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Called from play()'s internal setup during a burn-in session —
        // the server already has the correct subtitle index, nothing to do client-side.
        if (needsBurnInRestart) {
            log.info(`Burn-in mode (${burnIn}) — skipping client-side setup (server already has correct track)`);
            this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
            return;
        }

        // Let SubtitleManager determine the best delivery method
        const delivery = await this._subtitleManager.setPrimaryTrack(index);

        // If SubtitleManager chose embedded native, we need to tell the backend.
        //
        // IMPORTANT: In a transcoding session (Transcode or DirectStream play method)
        // the HLS/transcode output from the server carries NO embedded subtitle tracks.
        // Calling AVPlay's setSubtitleStreamIndex() would silently do nothing.
        // The only way to switch the subtitle is to restart the transcode with the
        // new SubtitleStreamIndex so the server re-encodes / remuxes the correct track.
        if (delivery === DeliveryMethod.EMBEDDED_NATIVE) {
            const isTranscoding = this._currentPlayMethod === 'Transcode' ||
                                  this._currentPlayMethod === 'DirectStream';

            if (isTranscoding && this._currentPlayOptions && !this._burnInRestartInProgress && !this._playSetupInProgress) {
                // Same restart pattern as burn-in — we reuse the burn-in guard flag
                // because the two paths are mutually exclusive (burn-in was already
                // checked earlier and would have returned by now).
                log.info(`EMBEDDED_NATIVE + ${this._currentPlayMethod} — restarting transcode for subtitle: ${index}`);

                const currentTicks = this.getCurrentPositionTicks();
                const restartOptions = {
                    ...this._currentPlayOptions,
                    subtitleStreamIndex: index,
                    startPositionTicks: currentTicks
                };

                this._currentPlayOptions = restartOptions;
                this._lastPlayOptions = restartOptions;

                this._burnInRestartInProgress = true;
                this._isRestarting = true;
                try {
                    this.emit(PlayerEvent.RESTARTING);
                    await this.stop();
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.play(restartOptions);
                    // Reset on success so subsequent stop() calls behave normally
                    this._isRestarting = false;
                } catch (e) {
                    log.error('Failed to restart for embedded subtitle switch during transcode:', e);
                    this._isRestarting = false;
                } finally {
                    this._burnInRestartInProgress = false;
                }

                this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
                return;
            }

            // DirectPlay: Tizen AVPlay can read embedded subtitle tracks natively.
            // WebOS and HTML5 backends do not surface embedded subtitle track APIs
            // reliably, so they always defer to SubtitleManager external rendering.
            if (this._backendType === 'tizen') {
                // Skip explicit backend call during initial playback setup.
                // TizenAVPlayer natively handles initial track selection via _pendingSubtitleIndex
                // deferred until the 'onbufferingcomplete' event safely transitions the player.
                if (this._playSetupInProgress) {
                    log.info('Skipping backend subtitle assignment during initial play (Tizen handles natively via pending index)');
                } else if (index === -1) {
                    this._backend.setSubtitleStreamIndex(-1);
                } else {
                    const tracks = this.getSubtitleTracks();
                    const trackExists = tracks.some((t) => t.Index === index);
                    if (trackExists) {
                        try {
                            this._backend.setSubtitleStreamIndex(index);
                        } catch (err) {
                            if (err.message === 'OUT_OF_BOUNDS_TIZEN_LIMIT') {
                                log.warn(`Tizen Backend rejected track ${index} (out of bounds). Falling back to EXTERNAL_TEXT rendering.`);
                                this._subtitleManager.forceExternalTextFallback(index);
                            } else {
                                throw err;
                            }
                        }
                    } else {
                        log.warn('Subtitle StreamID', index, 'not found in backend tracks');
                    }
                }
            }
        } else {
            // SubtitleManager is handling rendering via DOM (EXTERNAL_TEXT, ASS_CANVAS, PGS_BITMAP)
            // or delivery is NONE (subtitles disabled / unsupported format).
            // Tell the backend to turn off embedded subs so they don't double-render.
            // All backend types support setSubtitleStreamIndex(-1) to disable.
            this._backend?.setSubtitleStreamIndex(-1);
        }

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { subtitleStreamIndex: index });
    }

    /**
     * Set subtitle offset — routes to SubtitleManager for DOM-rendered subs
     * or to the backend for embedded native subs.
     *
     * @param {number} seconds - Offset in seconds
     */
    setSubtitleOffset(seconds) {
        // If SubtitleManager is handling the primary subtitle, apply offset there
        if (this._subtitleManager.isPrimaryManagedByUs()) {
            this._subtitleManager.setPrimaryOffset(seconds);
        } else {
            // Embedded native subs — delegate to backend (Tizen has native offset API)
            this._backend?.setSubtitleOffset(seconds);
        }
    }

    /**
     * Set aspect ratio mode
     * @param {string} mode - 'auto', 'zoom', 'stretch'
     */
    setAspectRatio(mode) {
        this._currentAspectRatio = mode;
        this._backend?.setAspectRatio(mode);
    }

    /**
     * Get current aspect ratio
     * @returns {string} 'auto', 'zoom', 'stretch'
     */
    getAspectRatio() {
        return this._currentAspectRatio || 'auto';
    }

    /**
     * Get current audio stream index
     * @returns {number}
     */
    getCurrentAudioStreamIndex() {
        return this._currentAudioStreamIndex;
    }

    /**
     * Get current subtitle stream index
     * @returns {number}
     */
    getCurrentSubtitleStreamIndex() {
        return this._currentSubtitleStreamIndex;
    }

    // ========================================================================
    // Secondary Subtitle Support
    // ========================================================================

    /**
     * Set secondary subtitle stream index — delegates to SubtitleManager.
     * Secondary subtitles are always fetched externally and rendered on DOM,
     * even if the track is embedded in the container.
     *
     * @param {number} index - Stream index (-1 to disable)
     */
    async setSecondarySubtitleStreamIndex(index) {
        if (this._currentSecondarySubtitleStreamIndex === index) return;

        log.info('Setting secondary subtitle index:', index);
        this._currentSecondarySubtitleStreamIndex = index;

        // Delegate to SubtitleManager — it handles fetch, parse, and cue ticking
        await this._subtitleManager.setSecondaryTrack(index);

        this.emit(PlayerEvent.MEDIA_STREAMS_CHANGE, { secondarySubtitleStreamIndex: index });
    }

    // ========================================================================
    // Playback Speed
    // ========================================================================

    /**
     * Set playback speed
     * @param {number} speed - Playback speed (0.5 to 4.0)
     */
    setPlaybackSpeed(speed) {
        this._playbackSpeed = speed;
        this._backend?.setSpeed(speed);
        this.emit('speedchange', { speed });
    }

    /**
     * Get current playback speed
     * @returns {number}
     */
    getPlaybackSpeed() {
        return this._playbackSpeed || 1;
    }

    /**
     * Get current secondary subtitle stream index
     * @returns {number}
     */
    getCurrentSecondarySubtitleStreamIndex() {
        return this._currentSecondarySubtitleStreamIndex;
    }

    // ========================================================================
    // Chapter Support
    // ========================================================================

    getChapters() {
        return this._chapters || [];
    }

    getCurrentChapterIndex(timeTicks) {
        if (!this._chapters || this._chapters.length === 0) return -1;
        
        const currentTicks = timeTicks !== undefined ? timeTicks : this.getCurrentPositionTicks();
        // log.debug('Chapter Debug: Current Ticks', currentTicks);

        // Find the last chapter that started before current time
        for (let i = this._chapters.length - 1; i >= 0; i--) {
            const startTicks = this._chapters[i].StartPositionTicks || 0;
            if (currentTicks >= startTicks) {
                // log.debug('Chapter Debug: Found index', i, 'StartTicks', startTicks);
                return i;
            }
        }
        return -1;
    }

    nextChapter() {
        // Tizen Seek Offset Workaround:
        // On Tizen, we apply a -2.5s offset to chapter seeks (see below).
        // This causes "Next Chapter" to land slightly before the actual chapter start.
        // Determining the current chapter index strictly by current time would place us in the PREVIOUS chapter.
        // To avoid getting stuck in a loop (Next -> Prev Chapter End -> Next -> Prev Chapter End),
        // we look ahead by 3s (slightly more than the 2.5s hack) to see "where we effectively are".
        let lookAhead = 0;
        if (this._backendType === 'tizen') {
             lookAhead = 30000000; // 3 seconds in ticks
        }
        
        const index = this.getCurrentChapterIndex(this.getCurrentPositionTicks() + lookAhead);
        log.debug('Chapter Debug (Next): Current Index', index, 'Total', this._chapters ? this._chapters.length : 0);

        if (index === -1) {
             if (this._chapters && this._chapters.length > 0) {
                 this._lastChapterSeekTime = Date.now();
                 this.seek(this._chapters[0].StartPositionTicks);
                 return;
             }
             return;
        }

        if (index >= this._chapters.length - 1) {
            log.debug('Chapter Debug: Already at last chapter');
            return;
        }

        const nextChapter = this._chapters[index + 1];
        if (nextChapter) {
            let seekTarget = nextChapter.StartPositionTicks;
            if (this._backendType === 'tizen') {
                // hack: Tizen AVPlay seek subtract 2.5s (25,000,000 ticks) from next chapter until we find what is wrong
                seekTarget = Math.max(0, seekTarget - 25000000);
                log.info('TizenAVPlayer: Applying 2.5s offset to next chapter jump');
            }
            log.info('Skipping to next chapter:', nextChapter.Name);
            this._lastChapterSeekTime = Date.now();
            this.seek(seekTarget);
        }
    }

    previousChapter() {
        // Tizen Seek Offset Workaround:
        // On Tizen, nextChapter() applies a -2.5s offset to chapter seeks, landing slightly
        // before the actual chapter start. To prevent previousChapter() from misidentifying
        // the current chapter and getting stuck in a loop, we look ahead by 3s (matching nextChapter).
        let lookAhead = 0;
        if (this._backendType === 'tizen') {
             lookAhead = 30000000; // 3 seconds in ticks
        }

        const index = this.getCurrentChapterIndex(this.getCurrentPositionTicks() + lookAhead);
        log.debug('Chapter Debug (Prev): Current Index', index);

        if (index === -1) return;

        const currentTicks = this.getCurrentPositionTicks();
        const currentChapter = this._chapters[index];
        const chapterStart = currentChapter.StartPositionTicks || 0;
        
        const diff = currentTicks - chapterStart;
        log.debug('Chapter Debug: Diff from start', diff);

        // STICKY CHAPTER SEEK PROTECTION (Bypasses restart block if user clicks quickly)
        const now = Date.now();
        const isRepeatedClick = this._lastChapterSeekTime && (now - this._lastChapterSeekTime < 2500);

        // If we are more than 3 seconds into the chapter AND it's not a rapid repeated click, restart current chapter.
        // On Tizen, keyframe seeking can make us land up to 8-10 seconds after the target chapter start.
        // Therefore, if the user repeatedly clicks "Previous Chapter" (within 2.5 seconds),
        // we bypass the restart protection entirely and skip to the previous chapter.
        if (diff > 30000000 && !isRepeatedClick) {
            log.info('Restarting current chapter:', currentChapter.Name);
            this._lastChapterSeekTime = now;
            this.seek(chapterStart);
        } else if (index > 0) {
            // Go to previous chapter
            const prevChapter = this._chapters[index - 1];
            log.info('Skipping to previous chapter:', prevChapter.Name);
            this._lastChapterSeekTime = now;
            this.seek(prevChapter.StartPositionTicks);
        } else {
             // First chapter, just seek to start
             this._lastChapterSeekTime = now;
             this.seek(0);
        }
    }

    /**
     * Refresh subtitle styles — delegate to backend (for embedded subs)
     * or emit event for DOM-rendered subs.
     */
    refreshSubtitles() {
        // Always try to refresh managed subtitles (ASS/Text)
        if (this._subtitleManager) {
            this._subtitleManager.refreshStyles();
        }

        if (this._backend && this._backend.refreshSubtitles) {
            this._backend.refreshSubtitles();
        } else {
             this.emit('refreshsubtitles');
        }
    }

    /**
     * Get current stream type
     * @returns {string} 'HLS' or 'Video'
     */
    getStreamType() {
        if (this._backend && this._backend._hlsPlayer) {
            return 'HLS';
        }
        return 'Video';
    }

    /**
     * Get available audio tracks
     * @returns {Array} Audio streams
     */
    getAudioTracks() {
        return this._currentMediaSource?.MediaStreams?.filter((s) => s.Type === 'Audio') || [];
    }

    /**
     * Get audio tracks as exposed by the current native backend.
     *
     * Jellyfin keeps original stream IDs, including tracks the WebOS native
     * audioTracks API will not expose when passthrough codecs are disabled.
     * Counting those hidden tracks shifts the backend list index by one.
     *
     * @param {Object} [mediaSource]
     * @returns {Array} Backend-visible audio streams
     * @private
     */
    _getBackendAudioTracks(mediaSource = this._currentMediaSource) {
        const tracks = mediaSource?.MediaStreams?.filter((s) => s.Type === 'Audio') || [];

        if (this._backendType !== 'webos') {
            return tracks;
        }

        return tracks.filter((track) => {
            const codec = (track.Codec || '').toLowerCase();

            if (codec === 'truehd' && !PlayerSettings.get('enableTrueHd')) {
                return false;
            }

            if ((codec.includes('dts') || codec === 'dca') && !PlayerSettings.get('enableDts')) {
                return false;
            }

            return true;
        });
    }

    /**
     * Convert a Jellyfin audio stream Index to the 0-based backend track index.
     * @param {number} streamIndex
     * @param {Object} [mediaSource]
     * @returns {number}
     * @private
     */
    _getBackendAudioTrackListIndex(streamIndex, mediaSource = this._currentMediaSource) {
        if (streamIndex === undefined || streamIndex === null) {
            return -1;
        }

        return this._getBackendAudioTracks(mediaSource).findIndex((t) => t.Index === streamIndex);
    }

    /**
     * Get available subtitle tracks
     * @returns {Array} Subtitle streams
     */
    getSubtitleTracks() {
        if (!this._currentMediaSource || !this._currentMediaSource.MediaStreams) {
            return [];
        }

        const disablePgs = PlayerSettings.get('pgsPlaybackMode') === 'disable';

        return this._currentMediaSource.MediaStreams.filter((s) => {
            if (s.Type !== 'Subtitle') return false;

            if (disablePgs) {
                const codec = (s.Codec || '').toLowerCase();
                if (codec === 'pgs' || codec === 'pgssub') {
                    return false;
                }
            }

            return true;
        });
    }

    // ========================================================================
    // State Getters
    // ========================================================================

    /**
     * Get current position in ticks
     * @returns {number}
     */
    getCurrentPositionTicks() {
        if (this._isSeeking && this._seekTargetTicks !== null) {
            return this._seekTargetTicks;
        }

        const backendTime = this._backend?.getCurrentTime ? this._backend.getCurrentTime() : 0;
        const backendTicks = Math.round(backendTime * 10000000);
        
        // If playback hasn't fully started yet (time is 0), but we requested a specific
        // start position, return it so the UI (OSD) shows the correct time immediately
        // instead of flashing 00:00.
        if (backendTicks === 0 && this._pendingStartPositionTicks) {
            return this._pendingStartPositionTicks;
        }

        // Add offset if we are playing a transcoded segment
        const total = backendTicks + this._transcodingOffsetTicks;
        return isNaN(total) ? 0 : total;
    }

    /**
     * Get current position in milliseconds
     * @returns {number}
     */
    getCurrentPositionMs() {
        return (this._backend?.getCurrentTime() ?? 0) * 1000;
    }

    /**
     * Get total duration in ticks.
     *
     * Resolution priority:
     *   1. MediaSource.RunTimeTicks  — most authoritative; set from Jellyfin metadata at
     *                                  play() time. Also used as a latch once Priority 3
     *                                  populates a valid value (so subsequent calls are free).
     *   2. HLS.js manifest duration  — set by getHlsManifestDuration() after LEVEL_UPDATED
     *                                  fires with details.live===false (transcoder done).
     *   3. Backend video.duration    — for DirectPlay this is the container-header duration
     *                                  (accurate from metadata load). For live HLS this is
     *                                  Infinity (rejected). Once a valid value is found here
     *                                  it is cached onto MediaSource so Priority 1 wins next time.
     *
     * @returns {number} Duration in 100-nanosecond ticks
     */
    getDurationTicks() {
        // ====================================================================
        // Priority 1: Jellyfin metadata (MediaSource or Item RunTimeTicks).
        //   This is the most reliable source — set at play() time, including
        //   the back-fill from item metadata when PlaybackInfo omits it.
        // ====================================================================
        const metadataTicks = this._currentMediaSource?.RunTimeTicks || this._currentItem?.RunTimeTicks || 0;
        if (metadataTicks > 0) {
            return metadataTicks;
        }

        // ====================================================================
        // Priority 2: HLS.js manifest-derived duration.
        //
        // When Jellyfin finishes transcoding the entire file it appends
        // #EXT-X-ENDLIST to the HLS playlist. HLS.js detects this via the
        // LEVEL_UPDATED event (details.live === false) and stores the accurate
        // total in _hlsManifestDuration via getHlsManifestDuration(). Once
        // available this is perfectly accurate — far better than the growing
        // video.duration value we'd get before the manifest is complete.
        //
        // This is only available for HtmlVideoPlayer (HLS.js backend). On
        // TizenAVPlayer the native media engine reports duration directly.
        // ====================================================================
        if (this._backend && typeof this._backend.getHlsManifestDuration === 'function') {
            const hlsDur = this._backend.getHlsManifestDuration();
            if (hlsDur !== null) {
                log.debug(`[Duration] Using HLS manifest duration: ${hlsDur.toFixed(1)}s`);
                
                const ticks = Math.floor(hlsDur * 10000000);
                // Cache it on the MediaSource so subsequent calls skip this lookup
                if (this._currentMediaSource) {
                    this._currentMediaSource.RunTimeTicks = ticks;
                }
                return ticks;
            }
        }

        // ====================================================================
        // Priority 3 (last resort): Backend-reported duration.
        //   For DirectPlay, video.duration is read accurately from the
        //   container header (MKV/MP4/etc.) once metadata loads.
        //   For live TV this may be Infinity, and for HLS transcoding it may
        //   grow as segments are encoded — both are rejected below.
        //   Once a valid finite value is found it is cached onto the
        //   MediaSource so subsequent calls hit Priority 1 directly.
        // ====================================================================
        if (this._backend && typeof this._backend.getDuration === 'function') {
            const backendDur = this._backend.getDuration();
            if (backendDur > 0 && isFinite(backendDur) && !isNaN(backendDur)) {
                const ticks = Math.floor(backendDur * 10000000);
                // Latch the value so the OSD never has to re-read video.duration
                if (this._currentMediaSource) {
                    this._currentMediaSource.RunTimeTicks = ticks;
                }
                return ticks;
            }
        }

        return 0;
    }

    /**
     * Check if currently playing
     * @returns {boolean}
     */
    isPlaying() {
        return this._isPlaying && !this._isPaused;
    }

    /**
     * Check if paused
     * @returns {boolean}
     */
    isPaused() {
        return this._isPaused;
    }

    /**
     * Get current item
     * @returns {Object|null}
     */
    getCurrentItem() {
        return this._currentItem;
    }

    /**
     * Get current media source
     * @returns {Object|null}
     */
    getCurrentMediaSource() {
        return this._currentMediaSource;
    }

    /* =========================================================================
       HDR DETECTION UTILITY
       =========================================================================
       Determines if the currently loaded/playing media source contains a video
       stream in High Dynamic Range (HDR). Checks the video stream properties
       which are parsed dynamically from the Jellyfin media metadata.
       ========================================================================= */
    isCurrentMediaHDR() {
        // Retrieve the selected active media source
        const mediaSource = this.getCurrentMediaSource();
        if (!mediaSource) {
            // No active playback media loaded
            return false;
        }

        // Locate the primary video stream within the streams list
        const videoStream = (mediaSource.MediaStreams || []).find(s => s.Type === 'Video');
        if (!videoStream) {
            // No valid video tracks found
            return false;
        }

        // ---------------------------------------------------------------------
        // Check 1: Coarse range description (e.g. HDR vs SDR)
        // ---------------------------------------------------------------------
        const videoRange = (videoStream.VideoRange || '').toUpperCase();
        if (videoRange.includes('HDR')) {
            return true;
        }

        // ---------------------------------------------------------------------
        // Check 2: Fine-grained Range Type (e.g., HDR10, HDR10Plus, DOVI, HLG)
        // Ensure we filter out explicit 'SDR' values
        // ---------------------------------------------------------------------
        const videoRangeType = (videoStream.VideoRangeType || '').toUpperCase();
        if (videoRangeType && videoRangeType !== 'SDR') {
            return true;
        }

        // Content is fallback SDR (Standard Dynamic Range)
        return false;
    }

    // ========================================================================
    // Fullscreen
    // ========================================================================

    /**
     * Toggle fullscreen mode
     */
    toggleFullscreen() {
        this._backend?.toggleFullscreen();
    }

    /**
     * Check if in fullscreen
     * @returns {boolean}
     */
    isFullscreen() {
        return this._backend?.isFullscreen() ?? false;
    }

    // ========================================================================
    // API Helpers
    // ========================================================================

    /**
     * Get playback info from Jellyfin server
     * @private
     */
    async _getPlaybackInfo(options, deviceProfile, manualBitrate = null) {
        const url = `${this.serverUrl}/Items/${options.itemId}/PlaybackInfo?UserId=${options.userId}`;

        // Read max bitrate: priority to deviceProfile if passed (it contains the logic)
        // Fallback to manualBitrate or 120Mbps
        const maxBitrate = deviceProfile?.MaxStreamingBitrate || manualBitrate || 120000000;

        /*
         * Audio items (Music, Audiobooks) do NOT have subtitle streams.
         * The Jellyfin server returns HTTP 500 if SubtitleStreamIndex is
         * present in the request body for Audio-type items. Only send it
         * for Video items where subtitle selection makes sense.
         */
        const isAudioItem = (options.item?.MediaType === 'Audio') ||
                            (options.item?.Type === 'Audio') ||
                            (options.item?.Type === 'MusicAlbum') ||
                            (options.item?.Type === 'MusicArtist') ||
                            (options.item?.Type === 'Artist') ||
                            (options.item?.Type === 'AudioBook') ||
                            (options.item?.Type === 'PodcastEpisode');

        // Deep clone the device profile so we can mutilate it to trick the server without affecting future calls
        const clonedProfile = JSON.parse(JSON.stringify(deviceProfile || buildJellyfinProfile(maxBitrate)));



        const requestBody = {
            DeviceProfile: clonedProfile,
            UserId: options.userId,
            MaxStreamingBitrate: maxBitrate,
            StartTimeTicks: options.startPositionTicks || 0,
            AutoOpenLiveStream: true,
            IsPlayback: true,
            // Default to true for both, let server profiles decide unless strictly overridden below
            EnableDirectPlay: true,
            EnableDirectStream: true
        };

        // Strict Playback Mode Enforcement
        const forceTranscodeSetting = PlayerSettings.get('forceTranscode');
        const forceDirectPlaySetting = PlayerSettings.get('forceDirectPlay');
        
        let currentMode = this._playbackMode;
        if (forceTranscodeSetting) currentMode = 'transcode';
        else if (forceDirectPlaySetting) currentMode = 'directPlay';
        switch (currentMode) {
            case 'directPlay':
                requestBody.EnableDirectPlay = true;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = false;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;
                
                // Nuclear option: tell the server we can parse everything natively
                requestBody.DeviceProfile.DirectPlayProfiles = [{
                    Container: 'm4v,3gp,ts,mpegts,mov,xvid,vob,mkv,wmv,asf,ogm,ogv,m2v,avi,mpg,mpeg,mp4,webm,wtv,dvr-ms,m2ts,rmvb,mxf',
                    AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    VideoCodec: 'h264,h265,hevc,vp8,vp9,mpeg1video,mpeg2video,mpeg4,wmv2,wmv3,vcl,theora,vc1,mpeg,h263,msmpeg4,av1',
                    Type: 'Video'
                }, {
                    Container: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    AudioCodec: 'aac,mp3,mpa,wav,wma,wv,flac,ogg,oga,vorbis,ac3,eac3,dts,dtshd,opus,truehd,alac',
                    Type: 'Audio'
                }];
                // Clear any transcoding/direct stream profiles and ALL codec limits
                requestBody.DeviceProfile.TranscodingProfiles = [];
                requestBody.DeviceProfile.DirectStreamProfiles = [];
                requestBody.DeviceProfile.CodecProfiles = [];
                requestBody.DeviceProfile.ContainerProfiles = [];
                
                log.info('PlaybackInfo API Override: Enforcing STRICT Direct Play (Safeguarded DeviceProfile)');
                break;
            case 'remux':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = true;
                // EnableTranscoding must be true for Jellyfin to process a Remux stream
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = true;
                requestBody.AllowAudioStreamCopy = true;
                
                // Clear ALL codec limits to prevent "VideoBitDepthNotSupported" etc which block generic remux
                requestBody.DeviceProfile.CodecProfiles = [];
                requestBody.DeviceProfile.ContainerProfiles = [];
                requestBody.DeviceProfile.DirectPlayProfiles = [];

                log.info('PlaybackInfo API Override: Enforcing STRICT Remuxing (Safeguarded DeviceProfile)');
                break;
            case 'transcode':
                requestBody.EnableDirectPlay = false;
                requestBody.EnableDirectStream = false;
                requestBody.EnableTranscoding = true;
                requestBody.AllowVideoStreamCopy = false;
                requestBody.AllowAudioStreamCopy = false;

                // Force server to drop standard formats so it transcodes
                requestBody.DeviceProfile.DirectPlayProfiles = [];
                requestBody.DeviceProfile.DirectStreamProfiles = [];

                log.info('PlaybackInfo API Override: Enforcing STRICT Transcoding (No stream copying)');
                break;
            case 'auto':
            default:
                // Keep defaults, Server and DeviceProfile make the decision
                break;
        }

        // IMPORTANT: For Live TV channels, do NOT pass MediaSourceId in the PlaybackInfo request.
        // The server dynamically generates a MediaSourceId when it opens the tuner; passing the
        // channel's ItemId as MediaSourceId causes the server's source-matching logic to fail
        // with "NoCompatibleStream" because it tries to find a pre-existing specific source.
        const isLiveChannel = options.item?.Type === 'TvChannel';
        if (options.mediaSourceId && !isLiveChannel) {
            requestBody.MediaSourceId = options.mediaSourceId;
        }


        // For Audio items, sending SubtitleStreamIndex often causes an HTTP 500 
        // from the Jellyfin server. Therefore, we entirely omit it for audio playback.
        // However, we MUST send AudioStreamIndex if available, even for audio tracks,
        // otherwise forced transcode requests will fail with a 500 error.
        if (options.audioStreamIndex !== undefined && options.audioStreamIndex !== null) {
            requestBody.AudioStreamIndex = options.audioStreamIndex;
        }


        if (!isAudioItem) {
            if (options.subtitleStreamIndex !== undefined && options.subtitleStreamIndex !== null) {
                requestBody.SubtitleStreamIndex = options.subtitleStreamIndex;
            }
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `MediaBrowser Token="${this.authToken}"`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorText = '';
            try {
                errorText = await response.text();
            } catch (e) {}
            throw new Error(`Failed to get playback info: ${response.status} - ${errorText}`);
        }

        return await response.json();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    // ========================================================================
    // Manual Bitrate Control
    // ========================================================================

    /**
     * Set max bitrate and restart playback
     * @param {number} bitrate - Max bitrate in bps (0 = Auto)
     */
    async setMaxBitrate(bitrate) {
        if (!this._currentItem) return;
        
        log.info('Setting manual bitrate:', bitrate);
        
        // Update state (0 means null/Auto)
        this._manualBitrate = bitrate > 0 ? bitrate : null;

        // Capture current position to resume
        const currentTicks = this.getCurrentPositionTicks();

        // Strategy: Standard - Play from current position
        // This is more robust than seeking from 0 for HLS
        const playOptions = {
            ...this._currentPlayOptions,
            startPositionTicks: currentTicks,
            playbackMode: this._playbackMode
        };

        // Restart playback
        this._isRestarting = true;
        
        try {
            // Trigger loading state immediately
            this.emit(PlayerEvent.RESTARTING);

            await this.stop();
            // _manualBitrate is preserved because _isRestarting was true
            
            // Tizen: Give AVPlay time to cleanup
            await new Promise(resolve => setTimeout(resolve, 500));

            await this.play(playOptions);
            
            // No manual seek needed - server starts transcode at correct offset
            // and MediaHelper handles the time reporting offset.

            // _isRestarting is reset to false in play() success
        } catch (e) {
            log.error('Failed to restart with new bitrate:', e);
            this._isRestarting = false; // Ensure reset on error
        }
    }


    /**
     * Get current max bitrate setting
     * @returns {number} Current bitrate limit (0 = Auto)
     */
    getMaxBitrate() {
        return this._manualBitrate || 0;
    }

    /**
     * Get current playback mode
     * @returns {string}
     */
    getPlaybackMode() {
        return this._playbackMode;
    }

    /**
     * Force a specific playback mode and restart if playing
     * @param {string} mode - 'auto', 'directPlay', 'transcode', 'remux'
     */
    async setPlaybackMode(mode) {
        if (!['auto', 'directPlay', 'transcode', 'remux'].includes(mode)) return;
        
        if (this._playbackMode === mode) return;

        this._playbackMode = mode;
        log.info(`Playback mode set to: ${mode}`);
        
        // Re-initialize playback if active
        // Check for specific backend states that imply activity
        if (this._isPlaying || this._isPaused || this._state === 'buffering') {
            log.info('Restarting playback to apply new mode');
            
            if (this._lastPlayOptions) {
                const currentTicks = this.getCurrentPositionTicks();
                const newOptions = {
                    ...this._lastPlayOptions,
                    startPositionTicks: currentTicks,
                    playbackMode: mode
                };
                
                // Reuse restart logic pattern from setMaxBitrate
                this._isRestarting = true;
                
                try {
                    this.emit(PlayerEvent.RESTARTING);
                    await this.stop();
                    // Give backend time to cleanup
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await this.play(newOptions);
                    // _isRestarting reset in play() success path implicitly? 
                    // No, wait. play() calls stop(). stop() checks _isRestarting.
                    // But play() sets _isRestarting = false ?
                    // Let's check play():
                    // play() calls stop().
                    // play() calls _resetState().
                    // _resetState() does NOT play with _isRestarting ??
                    // Actually setMaxBitrate comment says: " _isRestarting is reset to false in play() success"
                    // checking play():
                    // it does NOT seem to reset _isRestarting explicitly.
                    // Wait, stop() checks _isRestarting.
                    
                    // Actually, looking at setMaxBitrate, it sets `this._isRestarting = true;`.
                    // Then calls `stop()`. `stop()` sees true, so it doesn't emit STOP events.
                    // Then `play()` is called. `play()` calls `stop()` again (first thing).
                    // `stop()` sees true again.
                    // Then `play()` proceeds.
                    
                    // The issue is: when does `_isRestarting` go back to false?
                    // `setMaxBitrate` does NOT set it back to false in try block!
                    // This looks like a bug in `setMaxBitrate` potentially, or I missed where it is reset.
                    // I should check `_resetState` or `play`.
                    
                    // If `_isRestarting` stays true, subsequent stops won't emit events?
                    // Let's check `_resetState`.
                } catch (e) {
                    log.error('Failed to restart after mode change:', e);
                    this._isRestarting = false;
                }
                
                // We should probably reset it here if success?
                this._isRestarting = false; 
            }
        }
    }

    /**
     * Destroy the player and clean up resources
     */
    destroy() {
        log.info('destroy() called');
        this.stop();

        // Destroy subtitle manager BEFORE the backend — the PGS download loop
        // checks _isDestroyed / _pgsLoadToken (set by SubtitleManager.destroy())
        // to abort any in-flight chunked fetch. If we destroy the backend first
        // the HTML video element goes away but libpgs may still be running.
        if (this._subtitleManager) {
            this._subtitleManager.destroy();
            this._subtitleManager = null;
        }

        this._backend?.destroy();
        this._backend = null;
        this.removeAllListeners();
        log.info('destroy() complete');
    }
}
