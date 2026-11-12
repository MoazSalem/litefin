/**
 * ============================================================================
 * Litefin Tizen - Tizen Adapter
 * ============================================================================
 * Handles all Tizen-specific functionality including:
 * - Remote control key registration
 * - App lifecycle (exit, suspend, resume)
 * - Device info and capabilities
 * - Platform detection
 * ============================================================================
 */

import { eventBus } from '../core/EventBus.js';
import { storage } from '../utils/StorageService.js';
import { logger } from '../utils/Logger.js';
import { platformInfo } from '../utils/PlatformInfo.js';

const log = logger.create('TizenAdapter');

// ============================================================================
// Key code mappings for Samsung TV remotes
// ============================================================================
const TIZEN_KEYS = {
    // Navigation
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ENTER: 13,
    BACK: 10009,

    // Media controls
    PLAY: 415,
    PAUSE: 19,
    STOP: 413,
    PLAY_PAUSE: 10252,
    REWIND: 412,
    FAST_FORWARD: 417,
    PREVIOUS: 10232,
    NEXT: 10233,

    // Color buttons
    RED: 403,
    GREEN: 404,
    YELLOW: 405,
    BLUE: 406,

    // Numeric
    NUM_0: 48,
    NUM_1: 49,
    NUM_2: 50,
    NUM_3: 51,
    NUM_4: 52,
    NUM_5: 53,
    NUM_6: 54,
    NUM_7: 55,
    NUM_8: 56,
    NUM_9: 57,

    // Other
    INFO: 457,
    TOOLS: 433, // Often used as "Options"
    MENU: 18,
    CHANNEL_UP: 427,
    CHANNEL_DOWN: 428,
    VOLUME_UP: 447,
    VOLUME_DOWN: 448,
    MUTE: 449
};

// ============================================================================
// Boot warmup tuning (runs entirely behind the opaque #app-splash)
// ============================================================================
const WARMUP_WIDTH = 1920;
const WARMUP_HEIGHT = 1080;
// Keep the native plane playing long enough for the compositor to promote the
// plane and present real frames, but short enough to never delay first paint.
const WARMUP_PLAY_HOLD_MS = 200;
// Per-candidate prepareAsync budget: an invalid URI can fail silently on some
// firmwares, so we advance to the next candidate instead of waiting forever.
const WARMUP_PREPARE_TIMEOUT_MS = 900;
// wgt-package resolution budget before falling back to the WebView URL.
const WARMUP_RESOLVE_TIMEOUT_MS = 500;
// Hard ceiling for the whole warmup cycle.
const WARMUP_MAX_MS = 3000;

class TizenAdapter {
    constructor() {
        this._isTizen = false;
        this._tizenVersion = null;
        this._deviceInfo = null;
        this._compositorWarmed = false;
        this._compositorWarmupProbe = null;
        this._warmupActive = false;
        this._warmupTimerId = null;
        this._warmupPrepareTimerId = null;
        this._warmupHoldTimerId = null;
        this._warmupGen = 0;
        this._warmupCandidates = [];
        this._warmupCandidateIndex = 0;
        this._warmupAttempt = 0;
        this._warmupPrepared = false;
        this._warmupVideoEl = null;
        this._warmupSplashEl = null;
        this._warmupSplashPrevBg = '';
        this._warmupPlayerActive = false;

        // Detect Tizen environment
        this._detectPlatform();
    }

    /**
     * Detect if running on Tizen platform
     * Uses centralized platformInfo single source of truth when available,
     * falling back safely in isolated VM sandboxes.
     * @private
     */
    _detectPlatform() {
        if (typeof platformInfo !== 'undefined') {
            this._isTizen = platformInfo.isTizen;
            this._tizenVersion = platformInfo.tizenVersion;
        } else {
            this._isTizen = typeof tizen !== 'undefined';
            this._tizenVersion = null;
        }

        if (this._isTizen) {
            // Try to get Tizen app info for diagnostic telemetry
            try {
                const appInfo = typeof tizen !== 'undefined' ? tizen.application.getCurrentApplication().appInfo : null;
                if (appInfo) {
                    log.info(
                        `Running on Tizen (App: ${appInfo.id} v${appInfo.version}, OS v${this._tizenVersion || 'unknown'})`
                    );
                } else {
                    log.info(`Running on Tizen OS v${this._tizenVersion || 'unknown'}`);
                }
            } catch (e) {
                log.info(`Running on Tizen OS v${this._tizenVersion || 'unknown'}`);
            }
        } else {
            log.info('Not running on Samsung Tizen platform');
        }
    }

    /**
     * Initialize Tizen-specific features
     * Call this after DOM is ready
     */
    init() {
        // Enforce strict platform isolation - never run on non-Tizen targets
        if (!this._isTizen) {
            log.info('TizenAdapter: Skipped initialization (target is not Samsung Tizen TV)');
            return;
        }

        log.info('Initializing TizenAdapter for Samsung TV hardware...');

        this._lastInputTime = Date.now();

        // Register remote control keys
        this._registerKeys();

        // Setup key event handler
        this._setupKeyHandler();

        // Setup mouse listeners for Tizen pointer/air-mouse mode
        document.addEventListener('mousemove', () => this.reportInput(), { passive: true });
        document.addEventListener('mousedown', () => this.reportInput(), { passive: true });

        // Get device info
        this._getDeviceInfo();

        // Prime hardware overlay / AVPlay compositor pipeline on Tizen boot
        // while #app-splash covers the screen, without touching playback state.
        this.warmupCompositor();

        log.info('TizenAdapter initialized');
    }

    /**
     * Resolves the local packaged URL for assets/warmup.mp4 without being
     * corrupted by hash-router fragments or file:// origin quirks on Tizen.
     * Mirrors i18n._getUrl() directory resolution.
     *
     * This is the URL form an HTML5 <video> element resolves against the
     * WebView document. AVPlay needs a filesystem path instead — see
     * _resolveWarmupCandidates().
     *
     * @returns {string} Resolved URL pointing to assets/warmup.mp4
     * @private
     */
    _resolveWarmupVideoUrl() {
        let base = '';
        if (typeof window !== 'undefined' && window.location) {
            const href = window.location.href || '';
            const protocol = window.location.protocol || '';

            if (protocol === 'file:') {
                // Strip hash/query before slicing directory so deep links don't corrupt path
                const pathOnly = href.split('#')[0].split('?')[0];
                base = pathOnly.substring(0, pathOnly.lastIndexOf('/') + 1);
            } else if (window.location.origin && window.location.pathname) {
                const pageUrl = window.location.origin + window.location.pathname;
                base = pageUrl.substring(0, pageUrl.lastIndexOf('/') + 1);
            }
        }
        return base + 'assets/warmup.mp4';
    }

    /**
     * Returns true while a boot-time AVPlay hardware warmup cycle is in flight.
     * @returns {boolean}
     */
    isWarmupActive() {
        return !!this._warmupActive;
    }

    /**
     * Resolves the native AVPlay manager from the Samsung webapis namespace,
     * falling back to the standard Tizen global on older firmwares.
     *
     * @returns {Object|null}
     * @private
     */
    _getAvplay() {
        if (typeof window === 'undefined') return null;
        return (window.webapis && window.webapis.avplay) || (window.tizen && window.tizen.avplay) || null;
    }

    /**
     * Clears every timer owned by the boot warmup cycle.
     * @private
     */
    _clearWarmupTimers() {
        if (this._warmupTimerId) {
            clearTimeout(this._warmupTimerId);
            this._warmupTimerId = null;
        }
        if (this._warmupPrepareTimerId) {
            clearTimeout(this._warmupPrepareTimerId);
            this._warmupPrepareTimerId = null;
        }
        if (this._warmupHoldTimerId) {
            clearTimeout(this._warmupHoldTimerId);
            this._warmupHoldTimerId = null;
        }
    }

    /**
     * Aborts any in-flight boot AVPlay warmup immediately and releases native
     * AVPlay resources so real media playback can call avplay.open() cleanly.
     *
     * Also tears down the full-screen warmup layers and drops the temporary
     * player-active transparency classes. App.hideSplash() calls this right
     * before #app-splash starts fading out, so the user can never see a
     * black or transparent flash between the warmup plane and the home page.
     *
     * @returns {boolean} true if an active warmup cycle was cancelled
     */
    abortWarmup() {
        const wasActive = !!this._warmupActive;
        // Advance generation token so late async prepareAsync callbacks cannot touch a
        // subsequent real video session opened after abortWarmup() returns.
        this._warmupGen += 1;
        this._clearWarmupTimers();
        this._warmupActive = false;

        if (wasActive) {
            // Release native AVPlay state cleanly before returning control to TizenAVPlayer
            const avplay = this._getAvplay();
            if (avplay) {
                try {
                    if (typeof avplay.setListener === 'function') {
                        avplay.setListener(null);
                    }
                } catch (_) {
                    // Ignore listener cleanup errors during abort
                }
                try {
                    if (typeof avplay.stop === 'function') {
                        avplay.stop();
                    }
                } catch (_) {
                    // Ignore stop errors if still preparing
                }
                try {
                    if (typeof avplay.close === 'function') {
                        avplay.close();
                    }
                } catch (_) {
                    // Ignore close errors if already NONE
                }
            }
        }

        this._teardownWarmupLayers();

        if (wasActive) {
            log.info('AVPlay hardware warmup aborted for real playback');
        }
        return wasActive;
    }

    /**
     * Resolves the real packaged filesystem location of assets/warmup.mp4.
     *
     * avplay.open() does NOT accept the WebView-relative 'assets/warmup.mp4'
     * URL that HTML5 <video> resolves: it needs an absolute Linux path
     * (/opt/usr/.../res/wgt/assets/warmup.mp4) or a tizen.filesystem URI.
     *
     * Returns an ordered candidate list — raw Linux path first, file:// URI
     * second, WebView URL last — so warmupCompositor() can retry the next
     * form when a firmware rejects one with PLAYER_ERROR_INVALID_URI.
     *
     * @param {Function} onResolved - Called with the ordered candidate array
     * @private
     */
    _resolveWarmupCandidates(onResolved) {
        const fallbackUrl = this._resolveWarmupVideoUrl();
        const candidates = [];

        const addCandidate = (value) => {
            if (!value) return;
            const str = String(value);
            if (candidates.indexOf(str) === -1) candidates.push(str);
        };
        // Joins assets/warmup.mp4 onto a directory path/URI and emits both the
        // raw Linux form (AVPlay's preferred) and the file:// form.
        const addAssetPath = (base) => {
            if (!base) return;
            let dir = String(base);
            if (dir.charAt(dir.length - 1) !== '/') dir += '/';
            addCandidate(dir + 'assets/warmup.mp4');
            const raw = dir.replace(/^file:\/\//, '');
            if (raw !== dir) addCandidate(raw + 'assets/warmup.mp4');
        };

        let settled = false;
        let budgetTimer = null;
        const finish = (reason) => {
            if (settled) return;
            settled = true;
            if (budgetTimer) {
                clearTimeout(budgetTimer);
                budgetTimer = null;
            }
            // HTML5 <video> fallback: always last, always resolvable by the WebView
            addCandidate(fallbackUrl);
            log.info(`AVPlay warmup URL candidates (${reason}): ${candidates.join(' | ')}`);
            onResolved(candidates);
        };

        const fsApi = typeof tizen !== 'undefined' && tizen.filesystem ? tizen.filesystem : null;
        if (!fsApi || typeof fsApi.resolve !== 'function') {
            finish('tizen.filesystem unavailable');
            return;
        }

        // A wedged filesystem backend must never delay splash dismissal.
        budgetTimer = setTimeout(() => finish('resolve timeout'), WARMUP_RESOLVE_TIMEOUT_MS);

        const onDir = (dir) => {
            try {
                if (dir && dir.path) {
                    // dir.path is the absolute Linux directory (/opt/usr/.../res/wgt)
                    addAssetPath(dir.path);
                }
            } catch (_) {
                // Ignore malformed directory handles
            }
            try {
                if (dir && typeof dir.toURI === 'function') {
                    const dirUri = dir.toURI();
                    if (dirUri) addAssetPath(dirUri);
                }
            } catch (_) {
                // toURI() is missing on a few legacy Tizen 2.3 builds
            }
            try {
                if (typeof fsApi.toURI === 'function') {
                    const directUri = fsApi.toURI('wgt-package/assets/warmup.mp4');
                    if (directUri) {
                        addCandidate(directUri);
                        addCandidate(String(directUri).replace(/^file:\/\//, ''));
                    }
                }
            } catch (_) {
                // Ignore toURI() failures; dir.path candidates already cover it
            }
            finish('wgt-package resolved');
        };

        try {
            fsApi.resolve(
                'wgt-package',
                onDir,
                (err) => {
                    log.warn('AVPlay warmup: tizen.filesystem.resolve(wgt-package) failed', err);
                    finish('resolve error');
                },
                'r'
            );
        } catch (err) {
            log.warn('AVPlay warmup: tizen.filesystem.resolve threw', err);
            finish('resolve threw');
        }
    }

    /**
     * Mounts the full-screen AVPlay <object> used by the warmup cycle.
     *
     * The element belongs exclusively to the warmup cycle and is removed again
     * in _teardownWarmupLayers(). Real playback is not affected: TizenAVPlayer
     * mounts its own hardware-plane host element before calling avplay.open().
     *
     * @private
     */
    _mountWarmupObjectLayer() {
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
            return;
        }
        try {
            let probe =
                typeof document.getElementById === 'function' ? document.getElementById('litefin-avplay-warmup') : null;
            if (!probe) {
                probe = document.createElement('object');
                probe.id = 'litefin-avplay-warmup';
                probe.type = 'application/avplayer';
                document.body.appendChild(probe);
            }
            probe.setAttribute('aria-hidden', 'true');
            probe.style.position = 'fixed';
            probe.style.top = '0px';
            probe.style.left = '0px';
            probe.style.pointerEvents = 'none';
            probe.style.width = WARMUP_WIDTH + 'px';
            probe.style.height = WARMUP_HEIGHT + 'px';
            probe.style.opacity = '1';
            probe.style.zIndex = '0';
            probe.style.background = '#000000';
            this._compositorWarmupProbe = probe;
        } catch (err) {
            log.debug('TizenAdapter: Failed to mount AVPlayer warmup <object>', err);
        }
    }

    /**
     * Mounts a full-screen HTML5 <video> playing the same warmup clip.
     *
     * Unlike AVPlay, <video> resolves the WebView-relative assets/warmup.mp4
     * URL, so this warms the media element / software decoder pipeline in
     * parallel behind the opaque splash.
     *
     * @private
     */
    _mountWarmupVideoLayer() {
        if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
            return;
        }
        try {
            const video = document.createElement('video');
            video.id = 'litefin-html5-warmup';
            video.setAttribute('aria-hidden', 'true');
            video.setAttribute('muted', '');
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.setAttribute('autoplay', '');
            video.setAttribute('loop', '');
            video.setAttribute('preload', 'auto');
            video.muted = true;
            video.volume = 0;
            video.style.position = 'fixed';
            video.style.top = '0px';
            video.style.left = '0px';
            video.style.width = WARMUP_WIDTH + 'px';
            video.style.height = WARMUP_HEIGHT + 'px';
            video.style.objectFit = 'cover';
            video.style.opacity = '1';
            video.style.pointerEvents = 'none';
            video.style.zIndex = '0';
            video.style.background = '#000000';
            video.src = this._resolveWarmupVideoUrl();
            document.body.appendChild(video);
            this._warmupVideoEl = video;
            if (typeof video.play === 'function') {
                const playResult = video.play();
                if (playResult && typeof playResult.catch === 'function') {
                    playResult.catch(() => {});
                }
            }
            log.info(`Mounted HTML5 warmup <video> (${video.src})`);
        } catch (err) {
            log.debug('TizenAdapter: HTML5 warmup <video> mount skipped', err);
        }
    }

    /**
     * Forces the boot splash opaque black for the duration of the warmup so
     * the hardware video plane behind the (now transparent) WebView can never
     * bleed through. The previous inline value is restored on teardown.
     * @private
     */
    _maskSplashForWarmup() {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
            return;
        }
        try {
            const splash = document.getElementById('app-splash');
            if (!splash || !splash.style) return;
            this._warmupSplashEl = splash;
            this._warmupSplashPrevBg = splash.style.backgroundColor || '';
            splash.style.backgroundColor = '#000000';
        } catch (_) {
            // Splash may already be detached on a very fast boot
        }
    }

    /**
     * Toggles the player-active transparency classes exactly like PlayerPage
     * does. Only classes added by the warmup are removed again.
     *
     * @param {boolean} enable - true to add, false to remove
     * @private
     */
    _applyWarmupPlayerActive(enable) {
        if (typeof document === 'undefined' || !document.documentElement || !document.body) {
            return;
        }
        try {
            if (enable) {
                if (this._warmupPlayerActive) return;
                document.documentElement.classList.add('player-active');
                document.body.classList.add('player-active');
                this._warmupPlayerActive = true;
                return;
            }
            if (!this._warmupPlayerActive) return;
            document.documentElement.classList.remove('player-active');
            document.body.classList.remove('player-active');
            this._warmupPlayerActive = false;
        } catch (_) {
            // Never let DOM cleanup break splash dismissal
        }
    }

    /**
     * Removes the full-screen warmup layers, drops player-active and restores
     * the splash background. Idempotent — safe to call from abortWarmup(),
     * _finishWarmup() and App.hideSplash().
     * @private
     */
    _teardownWarmupLayers() {
        const video = this._warmupVideoEl;
        this._warmupVideoEl = null;
        if (video) {
            try {
                if (typeof video.pause === 'function') video.pause();
            } catch (_) {
                // Ignore pause on already-detached elements
            }
            try {
                video.removeAttribute('src');
                if (typeof video.load === 'function') video.load();
            } catch (_) {
                // Ignore src teardown errors on legacy WebKit
            }
            try {
                if (video.parentNode) video.parentNode.removeChild(video);
            } catch (_) {
                // Ignore detached-node removal
            }
        }

        /*
         * Remove the full-screen 1920x1080 AVPlay plane entirely. The element is
         * owned by the warmup cycle; TizenAVPlayer mounts its own
         * application/avplayer host before opening a real stream, so nothing
         * dormant is left behind in the DOM.
         */
        if (this._compositorWarmupProbe) {
            const probe = this._compositorWarmupProbe;
            this._compositorWarmupProbe = null;
            try {
                if (probe.parentNode) probe.parentNode.removeChild(probe);
            } catch (_) {
                // Ignore detached-node removal
            }
        }

        this._applyWarmupPlayerActive(false);

        if (this._warmupSplashEl) {
            try {
                this._warmupSplashEl.style.backgroundColor = this._warmupSplashPrevBg;
            } catch (_) {
                // Splash may already be detached
            }
            this._warmupSplashEl = null;
            this._warmupSplashPrevBg = '';
        }
    }

    /**
     * Boot-time compositor warmup.
     *
     * Runs a real native AVPlayManager cycle — open -> setDisplayRect ->
     * prepareAsync -> play -> stop -> close — against assets/warmup.mp4 at
     * 1920x1080 directly behind the still-opaque #app-splash, and warms the
     * HTML5 <video> pipeline in parallel. Every layer is torn down before the
     * splash fades (see abortWarmup()), so the user never sees a black or
     * transparent flash.
     *
     * @returns {boolean} True when Tizen warmup executed or had already run
     */
    warmupCompositor() {
        // Hard isolation guard — never touch hardware plane primitives off Tizen
        if (!this._isTizen) {
            return false;
        }
        if (this._compositorWarmed) {
            return true;
        }
        this._compositorWarmed = true;

        this._wakeAudioPipeline();

        const avplay = this._getAvplay();
        const hasFullPipeline =
            avplay &&
            typeof avplay.open === 'function' &&
            typeof avplay.setDisplayRect === 'function' &&
            typeof avplay.prepareAsync === 'function' &&
            typeof avplay.play === 'function' &&
            typeof avplay.stop === 'function' &&
            typeof avplay.close === 'function';

        if (!hasFullPipeline) {
            // Legacy firmware: no prepareAsync, so no plane can be opened. Just
            // read AVPlay state to touch the pipeline; TizenAVPlayer will mount
            // its own application/avplayer host when real playback starts.
            if (avplay && typeof avplay.getState === 'function') {
                avplay.getState();
            }
            log.debug('TizenAdapter: AVPlay prepareAsync unavailable — basic warmup executed');
            return true;
        }

        // Never clobber an active real playback session if somehow open already
        let currentState = 'NONE';
        try {
            if (typeof avplay.getState === 'function') {
                currentState = avplay.getState();
            }
        } catch (_) {
            currentState = 'NONE';
        }
        if (currentState === 'PLAYING' || currentState === 'PAUSED' || currentState === 'READY') {
            log.debug(`TizenAdapter: Skipping AVPlay warmup because state is already ${currentState}`);
            return true;
        }

        const warmupGen = ++this._warmupGen;
        this._warmupActive = true;
        this._warmupCandidates = [];
        this._warmupCandidateIndex = 0;
        this._warmupAttempt = 0;
        this._warmupPrepared = false;

        // Full-screen native plane + HTML5 <video> behind the opaque splash
        this._mountWarmupObjectLayer();
        this._mountWarmupVideoLayer();
        this._maskSplashForWarmup();
        this._applyWarmupPlayerActive(true);

        log.info(`Starting AVPlay hardware warmup (${WARMUP_WIDTH}x${WARMUP_HEIGHT} behind #app-splash)`);

        // Hard ceiling: never let a wedged decoder hold the splash hostage.
        this._warmupTimerId = setTimeout(() => {
            this._warmupTimerId = null;
            this._finishWarmup('watchdog timeout', warmupGen);
        }, WARMUP_MAX_MS);

        this._resolveWarmupCandidates((candidates) => {
            if (!this._warmupActive || this._warmupGen !== warmupGen) return;
            this._warmupCandidates = candidates;
            this._tryWarmupCandidate(warmupGen);
        });

        return true;
    }

    /**
     * Wake the browser audio HAL / WebAudio thread silently so first playback
     * or mixer transitions do not stall the UI compositor later.
     * @private
     */
    _wakeAudioPipeline() {
        try {
            const AudioCtx = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
            if (!AudioCtx) return;

            const audioCtx = new AudioCtx();
            const closeAudioCtx = () => {
                try {
                    if (typeof audioCtx.close === 'function' && audioCtx.state !== 'closed') {
                        const closePromise = audioCtx.close();
                        if (closePromise && typeof closePromise.catch === 'function') {
                            closePromise.catch(() => {});
                        }
                    }
                } catch (_) {
                    // Ignore cleanup errors on restricted or mocked audio contexts
                }
            };

            if (typeof audioCtx.resume === 'function') {
                const resumeResult = audioCtx.resume();
                // Modern Chromium returns a Promise from resume(); legacy WebKit may not
                if (resumeResult && typeof resumeResult.then === 'function') {
                    resumeResult.then(closeAudioCtx, closeAudioCtx);
                } else {
                    closeAudioCtx();
                }
            } else {
                closeAudioCtx();
            }
        } catch (_) {
            // AudioContext blocked or unavailable in headless/stub environments
        }
    }

    /**
     * Opens and prepares the next warmup URL candidate.
     *
     * @param {number} warmupGen - Generation token of the owning warmup cycle
     * @private
     */
    _tryWarmupCandidate(warmupGen) {
        if (!this._warmupActive || this._warmupGen !== warmupGen) return;

        const avplay = this._getAvplay();
        if (!avplay) {
            this._finishWarmup('AVPlay unavailable', warmupGen);
            return;
        }

        if (this._warmupCandidateIndex >= this._warmupCandidates.length) {
            this._finishWarmup('all URL candidates rejected', warmupGen);
            return;
        }

        const warmupUrl = this._warmupCandidates[this._warmupCandidateIndex];
        const attempt = ++this._warmupAttempt;
        this._warmupPrepared = false;

        // Attempt token: a stale prepareAsync callback from a candidate that was
        // already abandoned (timeout / invalid URI) must never drive the next
        // candidate's native session.
        const isCurrentAttempt = () =>
            this._warmupActive && this._warmupGen === warmupGen && this._warmupAttempt === attempt;

        const onPrepared = () => {
            if (!isCurrentAttempt()) return;
            if (this._warmupPrepareTimerId) {
                clearTimeout(this._warmupPrepareTimerId);
                this._warmupPrepareTimerId = null;
            }
            this._warmupPrepared = true;

            let state = 'UNKNOWN';
            try {
                if (typeof avplay.getState === 'function') state = avplay.getState();
            } catch (_) {
                state = 'UNKNOWN';
            }
            log.info(`AVPlay warmup prepareAsync succeeded (state=${state}) for ${warmupUrl}`);

            try {
                avplay.play();
                log.info('AVPlay warmup prepareAsync + play() succeeded');
            } catch (playErr) {
                const msg = playErr && playErr.message ? playErr.message : String(playErr || 'unknown');
                this._finishWarmup(`play error: ${msg}`, warmupGen);
                return;
            }

            // Let the plane present real frames behind the opaque splash before
            // releasing the single hardware decoder slot.
            this._warmupHoldTimerId = setTimeout(() => {
                this._warmupHoldTimerId = null;
                let playingState = 'UNKNOWN';
                try {
                    if (typeof avplay.getState === 'function') playingState = avplay.getState();
                } catch (_) {
                    playingState = 'UNKNOWN';
                }
                log.info(`AVPlay warmup reached ${playingState} state after play()`);
                this._finishWarmup(`completed ${WARMUP_PLAY_HOLD_MS}ms play cycle`, warmupGen);
            }, WARMUP_PLAY_HOLD_MS);
        };

        const onPrepareError = (prepErr) => {
            if (!isCurrentAttempt()) return;
            if (this._warmupPrepareTimerId) {
                clearTimeout(this._warmupPrepareTimerId);
                this._warmupPrepareTimerId = null;
            }
            const msg = prepErr && prepErr.message ? prepErr.message : String(prepErr || 'unknown');
            this._retryWarmupCandidate(`prepareAsync rejected ${warmupUrl} (${msg})`, warmupGen);
        };

        // Per-candidate watchdog: an invalid URI can fail silently on some firmware.
        this._warmupPrepareTimerId = setTimeout(() => {
            this._warmupPrepareTimerId = null;
            if (!isCurrentAttempt() || this._warmupPrepared) return;
            this._retryWarmupCandidate(`prepareAsync timed out for ${warmupUrl}`, warmupGen);
        }, WARMUP_PREPARE_TIMEOUT_MS);

        try {
            log.info(`Starting AVPlay hardware warmup (${warmupUrl})`);
            avplay.open(warmupUrl);
            avplay.setDisplayRect(0, 0, WARMUP_WIDTH, WARMUP_HEIGHT);
            avplay.prepareAsync(onPrepared, onPrepareError);
        } catch (openErr) {
            if (this._warmupPrepareTimerId) {
                clearTimeout(this._warmupPrepareTimerId);
                this._warmupPrepareTimerId = null;
            }
            if (!isCurrentAttempt()) return;
            const msg = openErr && openErr.message ? openErr.message : String(openErr || 'unknown');
            this._retryWarmupCandidate(`open/prepareAsync threw for ${warmupUrl} (${msg})`, warmupGen);
        }
    }

    /**
     * Releases a half-open native session and advances to the next URL
     * candidate (raw Linux path -> file:// URI -> WebView URL).
     *
     * @param {string} reason - Human-readable rejection reason for the log
     * @param {number} warmupGen - Generation token of the owning warmup cycle
     * @private
     */
    _retryWarmupCandidate(reason, warmupGen) {
        if (!this._warmupActive || this._warmupGen !== warmupGen) return;

        // Invalidate the abandoned attempt before touching the native session:
        // a synchronous prepare error callback from stop()/close() must not
        // trigger another retry for the same candidate.
        this._warmupAttempt += 1;

        const avplay = this._getAvplay();
        if (avplay) {
            try {
                if (typeof avplay.stop === 'function') avplay.stop();
            } catch (_) {
                // Ignore stop errors if still preparing
            }
            try {
                if (typeof avplay.close === 'function') avplay.close();
            } catch (_) {
                // Ignore close errors if already NONE
            }
        }

        this._warmupCandidateIndex += 1;
        log.warn(`AVPlay warmup ${reason} — trying next URL candidate`);

        if (this._warmupCandidateIndex >= this._warmupCandidates.length) {
            this._finishWarmup('all URL candidates rejected', warmupGen);
            return;
        }
        this._tryWarmupCandidate(warmupGen);
    }

    /**
     * Ends the warmup cycle: clears timers, releases the native decoder and
     * removes every temporary layer. Idempotent.
     *
     * @param {string} reason - Human-readable completion reason for the log
     * @param {number} [warmupGen] - Generation token of the owning warmup cycle
     * @private
     */
    _finishWarmup(reason, warmupGen) {
        if (warmupGen !== undefined && this._warmupGen !== warmupGen) return;

        this._clearWarmupTimers();
        const wasActive = this._warmupActive;
        this._warmupActive = false;

        if (wasActive) {
            const avplay = this._getAvplay();
            if (avplay) {
                try {
                    if (typeof avplay.setListener === 'function') avplay.setListener(null);
                } catch (_) {
                    // Safe ignore on firmwares without an active listener
                }
                try {
                    if (typeof avplay.stop === 'function') avplay.stop();
                } catch (_) {
                    // Safe ignore if prepare failed before entering READY/PLAYING
                }
                try {
                    if (typeof avplay.close === 'function') avplay.close();
                } catch (_) {
                    // Safe ignore if already NONE
                }
            }
        }

        this._teardownWarmupLayers();

        if (wasActive) {
            log.info(`AVPlay hardware warmup closed (${reason})`);
        }
    }

    /**
     * Get idle time in milliseconds
     * @returns {number} Idle time
     */
    get idleTime() {
        return Date.now() - (this._lastInputTime || Date.now());
    }

    /**
     * Report an input interaction (mouse, touch etc from outside)
     */
    reportInput() {
        this._lastInputTime = Date.now();
    }

    /**
     * Register remote control keys with Tizen
     * @private
     */
    _registerKeys() {
        if (!this._isTizen) return;

        try {
            const keys = [
                'MediaPlay',
                'MediaPause',
                'MediaStop',
                'MediaPlayPause',
                'MediaRewind',
                'MediaFastForward',
                'MediaTrackPrevious',
                'MediaTrackNext',
                'ColorF0Red',
                'ColorF1Green',
                'ColorF2Yellow',
                'ColorF3Blue',
                'Info',
                'Tools',
                // Numeric keys (0-9). Tizen does NOT deliver these to the web app
                // unless registered. Needed so the profile PIN keypad can read
                // physical remote number presses (see ui/PinDialog.js).
                '0',
                '1',
                '2',
                '3',
                '4',
                '5',
                '6',
                '7',
                '8',
                '9'
            ];

            keys.forEach((key) => {
                try {
                    tizen.tvinputdevice.registerKey(key);
                } catch (e) {
                    // Key might not be available on all devices
                }
            });

            log.info('Remote keys registered');
        } catch (e) {
            log.error('Failed to register keys:', e);
        }
    }

    /**
     * Setup global key event handler
     * @private
     */
    _setupKeyHandler() {
        document.addEventListener('keydown', (e) => {
            this._lastInputTime = Date.now();
            const keyCode = e.keyCode;

            // Block Tizen's default spatial navigation unless user is typing in an input field.
            // Failing to prevent default allows the TV to natively jump its internal hardware focus
            // instantly before JS calculates the virtual row, triggering ghost focusin loops.
            const activeElem = document.activeElement;
            const isTextInput =
                activeElem &&
                !activeElem.readOnly &&
                ((activeElem.tagName === 'INPUT' && activeElem.type !== 'range') || activeElem.tagName === 'TEXTAREA');

            /*
             * Space bar control helper:
             * We only want to hijack the space bar if the player is actively rendering
             * on screen. This prevents breaking standard browser scroll functionality
             * on the settings, details, or library grid pages.
             */
            const isPlayerActive = window.location.hash.startsWith('#/player');

            // Physical keyboard media player shortcuts (J/K/L/M) on attached keyboards
            if (isPlayerActive && !isTextInput && !e.ctrlKey && !e.altKey && !e.metaKey) {
                switch (e.key) {
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                        return;
                    case 'j':
                    case 'J':
                        e.preventDefault();
                        eventBus.emit('key:rewind', e);
                        return;
                    case 'l':
                    case 'L':
                        e.preventDefault();
                        eventBus.emit('key:fastForward', e);
                        return;
                    case 'm':
                    case 'M':
                        e.preventDefault();
                        eventBus.emit('remote:togglemute');
                        return;
                    default:
                        break;
                }
            }

            if (!isTextInput) {
                const keysToPrevent = [
                    TIZEN_KEYS.LEFT,
                    TIZEN_KEYS.RIGHT,
                    TIZEN_KEYS.UP,
                    TIZEN_KEYS.DOWN,
                    TIZEN_KEYS.ENTER
                ];
                if (isPlayerActive && keyCode === 32) {
                    keysToPrevent.push(32);
                }
                if (keysToPrevent.includes(keyCode)) {
                    e.preventDefault();
                }
            }

            // Map key codes to events
            switch (keyCode) {
                // Space bar mapping for web/desktop players
                case 32:
                    if (!isTextInput && isPlayerActive) {
                        e.preventDefault();
                        eventBus.emit('key:playPause', e);
                    }
                    break;
                // Navigation
                case TIZEN_KEYS.LEFT:
                    eventBus.emit('key:left', e);
                    break;
                case TIZEN_KEYS.RIGHT:
                    eventBus.emit('key:right', e);
                    break;
                case TIZEN_KEYS.UP:
                    eventBus.emit('key:up', e);
                    break;
                case TIZEN_KEYS.DOWN:
                    eventBus.emit('key:down', e);
                    break;
                case TIZEN_KEYS.ENTER:
                    eventBus.emit('key:enter', e);
                    break;
                case TIZEN_KEYS.BACK:
                    e.preventDefault();
                    eventBus.emit('key:back', e);
                    break;
                case 27: // Escape
                case 8: // Backspace
                    if (!isTextInput) {
                        e.preventDefault();
                        eventBus.emit('key:back', e);
                    }
                    break;

                // Media controls
                case TIZEN_KEYS.PLAY:
                    e.preventDefault();
                    eventBus.emit('key:play', e);
                    break;
                case TIZEN_KEYS.PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:pause', e);
                    break;
                case TIZEN_KEYS.PLAY_PAUSE:
                    e.preventDefault();
                    eventBus.emit('key:playPause', e);
                    break;
                case TIZEN_KEYS.STOP:
                    e.preventDefault();
                    eventBus.emit('key:stop', e);
                    break;
                case TIZEN_KEYS.REWIND:
                    e.preventDefault();
                    eventBus.emit('key:rewind', e);
                    break;
                case TIZEN_KEYS.FAST_FORWARD:
                    e.preventDefault();
                    eventBus.emit('key:fastForward', e);
                    break;

                // Color buttons
                case TIZEN_KEYS.RED:
                    eventBus.emit('key:red', e);
                    break;
                case TIZEN_KEYS.GREEN:
                    eventBus.emit('key:green', e);
                    break;
                case TIZEN_KEYS.YELLOW:
                    eventBus.emit('key:yellow', e);
                    break;
                case TIZEN_KEYS.BLUE:
                    eventBus.emit('key:blue', e);
                    break;

                case TIZEN_KEYS.INFO:
                    eventBus.emit('key:info', e);
                    break;

                case TIZEN_KEYS.TOOLS:
                    eventBus.emit('key:options', e);
                    break;

                case TIZEN_KEYS.CHANNEL_UP:
                    eventBus.emit('key:channelUp', e);
                    break;

                case TIZEN_KEYS.CHANNEL_DOWN:
                    eventBus.emit('key:channelDown', e);
                    break;

                default:
                    // Emit generic key event with code
                    eventBus.emit('key:any', { keyCode, event: e });
                    break;
            }
        });

        log.info('Key handler setup');
    }

    /**
     * Get device information
     * @private
     */
    _getDeviceInfo() {
        if (!this._isTizen) {
            this._deviceInfo = {
                model: 'Browser',
                platform: 'Web',
                resolution: {
                    width: window.innerWidth,
                    height: window.innerHeight
                }
            };
            return;
        }

        try {
            // Get display info
            tizen.systeminfo.getPropertyValue('DISPLAY', (display) => {
                this._deviceInfo = {
                    resolution: {
                        width: display.resolutionWidth,
                        height: display.resolutionHeight
                    }
                };

                // Check for 4K/8K support
                if (typeof webapis !== 'undefined' && webapis.productinfo) {
                    try {
                        if (webapis.productinfo.is8KPanelSupported && webapis.productinfo.is8KPanelSupported()) {
                            this._deviceInfo.maxResolution = '8K';
                        } else if (webapis.productinfo.isUdPanelSupported && webapis.productinfo.isUdPanelSupported()) {
                            this._deviceInfo.maxResolution = '4K';
                        } else {
                            this._deviceInfo.maxResolution = 'FHD';
                        }
                    } catch (e) {
                        this._deviceInfo.maxResolution = 'Unknown';
                    }
                }

                log.info('Device info (Physical):', this._deviceInfo);

                const manualRes = storage.getItem('player:maxResolution');
                if (manualRes && manualRes !== 'auto') {
                    log.info(`⚠️ MANUAL RESOLUTION OVERRIDE ACTIVE: ${manualRes}`);
                }
            });
        } catch (e) {
            log.error('Failed to get device info:', e);
        }
    }

    /**
     * Exit the application
     */
    exit() {
        if (this._isTizen) {
            // Flush all pending storage writes to disk before exiting.
            // On Tizen 9.0+, Chromium 120 aggressively throttles background timers,
            // so the debounced flush may never fire if the app is suspended. Without
            // this explicit flush, critical keys (server URL, auth tokens) can be lost,
            // causing the app to start fresh on next launch.
            storage.flush();
            try {
                tizen.application.getCurrentApplication().exit();
            } catch (e) {
                log.error('Failed to exit:', e);
            }
        } else {
            log.info('Exit requested (browser mode - no action)');
        }
    }

    /**
     * Check if running on Tizen
     * @returns {boolean} True if on Tizen platform
     */
    isTizen() {
        return this._isTizen;
    }

    /**
     * Get the current Tizen platform version as a float (e.g. 5.0, 4.0, 3.0).
     *
     * Reads the platform.version capability once and caches the result on
     * _tizenVersion (already initialised to null in the constructor) so
     * subsequent calls are free lookups.
     *
     * Returns 0 when not running on Tizen or when the capability API throws.
     *
     * @returns {number} Tizen version as a float, or 0 if unavailable.
     */
    getTizenVersion() {
        /* Non-Tizen environment — return sentinel zero immediately. */
        if (!this._isTizen) return 0;

        /* Return the cached value from a previous call. */
        if (this._tizenVersion !== null) return this._tizenVersion;

        try {
            const raw = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version');
            this._tizenVersion = parseFloat(raw) || 0;
        } catch (e) {
            log.warn('Could not read Tizen platform version:', e);
            this._tizenVersion = 0;
        }

        return this._tizenVersion;
    }

    /**
     * Get device info
     * @returns {Object} Device information
     */
    getDeviceInfo() {
        return this._deviceInfo;
    }

    /**
     * Get device name
     * @returns {string} Device name (e.g. "Samsung Smart TV" or "Web Browser")
     */
    getDeviceName() {
        if (this._isTizen) {
            // Could try to get specific model if needed, but "Samsung Smart TV" is standard
            return 'Samsung Smart TV';
        }
        return 'Web Browser';
    }

    /**
     * Get device manufacturer
     * @returns {string} Manufacturer name
     */
    getManufacturer() {
        if (this._isTizen) {
            return 'Samsung';
        }
        return 'Generic';
    }

    /**
     * Get key codes map
     * @returns {Object} Key code constants
     */
    getKeyCodes() {
        return { ...TIZEN_KEYS };
    }
    /**
     * Get device IP address
     * @returns {Promise<string|null>} IP address (IPv4) or null
     */
    getIPAddress() {
        return new Promise((resolve) => {
            if (!this._isTizen) {
                resolve(null); // Browser - can't get local IP easily
                return;
            }

            try {
                tizen.systeminfo.getPropertyValue(
                    'NETWORK',
                    (network) => {
                        resolve(network.ipAddress || null);
                    },
                    (error) => {
                        log.warn('Failed to get network info', error);
                        resolve(null);
                    }
                );
            } catch (e) {
                log.error('Error getting IP:', e);
                resolve(null);
            }
        });
    }

    /**
     * Launch the native YouTube application on Samsung Tizen TVs and navigate
     * directly to the specified video.
     *
     * Tries known YouTube App IDs first. If the launch fails (app not installed,
     * or running in browser dev mode), falls back to opening the standard
     * YouTube URL in a browser tab.
     *
     * @param {string} videoId - The YouTube video ID (e.g. "dQw4w9WgXcQ")
     */
    launchYouTube(videoId) {
        if (!videoId) return;

        /* ── Browser / dev fallback ─────────────────────────────────────── */
        if (!this._isTizen) {
            log.info('launchYouTube: not on Tizen, opening browser tab');
            window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
            return;
        }

        log.info(`launchYouTube: launching YouTube app for videoId=${videoId}`);

        /* The ApplicationControl paired with the 111299001912 ID requires the 
           URL to be passed as ApplicationControlData rather than the main URI
           argument, otherwise the YouTube app fails to parse it and opens 
           the browser instead. */
        const appControl = new tizen.ApplicationControl(
            'http://tizen.org/appcontrol/operation/view',
            null, // uri
            null, // mime
            null, // category
            [
                new tizen.ApplicationControlData('http://tizen.org/appcontrol/data/url', [
                    `https://www.youtube.com/watch?v=${videoId}`
                ])
            ]
        );

        // Sequence of app IDs to try.
        // 111299001912 is standard Smart TV YouTube.
        // 9Ur5IzDKqV.TizenYouTube is an alternate reported on some sets.
        const appIds = ['111299001912', '9Ur5IzDKqV.TizenYouTube'];
        let currentTry = 0;

        const tryNextApp = () => {
            if (currentTry >= appIds.length) {
                // All known explicit App IDs failed.
                log.warn('launchYouTube: all explicit app IDs failed, falling back to browser');
                window.open(`https://www.youtube.com/watch?v=${videoId}`, '_blank');
                return;
            }

            const appId = appIds[currentTry];
            currentTry++;

            try {
                tizen.application.launchAppControl(
                    appControl,
                    appId,
                    () => log.info(`launchYouTube: successfully launched app ${appId}`),
                    (err) => {
                        log.warn(`launchYouTube: failed to launch ${appId}`, err);
                        tryNextApp();
                    }
                );
            } catch (e) {
                log.warn(`launchYouTube: exception launching ${appId}`, e);
                tryNextApp();
            }
        };

        tryNextApp();
    }
}

// Export singleton instance
export const tizenAdapter = new TizenAdapter();

// Also export constants
export { TIZEN_KEYS };

export default TizenAdapter;
