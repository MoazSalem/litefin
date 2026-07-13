/**
 * ============================================================================
 * Litefin Tizen - Background Theme Song Player
 * ============================================================================
 * Optimized HTML5 background audio controller singleton.
 * Orchestrates premium, Apple-style smooth volumetric fades on TV systems,
 * ensuring hardware decoders are cleanly initialized and released.
 * ============================================================================
 */

import { logger } from './Logger.js';
import { eventBus } from '../core/EventBus.js';
import { storage } from './StorageService.js';

const log = logger.create('ThemeSongPlayer');

class ThemeSongPlayer {
    constructor() {
        // Shared audio instance to optimize resource usage on TV hardware
        this._audio = null;

        // Track the currently playing URL to avoid redundant restarts
        this._currentUrl = null;

        // Keep track of the active show's owner ID to sustain music across seasons
        this._ownerId = null;

        // References to active volume interpolation timers
        this._fadeInterval = null;

        // References to deferred stop grace period timers
        this._deferredStopTimer = null;

        // Track whether playback is currently fading out/stopping
        this._isFadingOut = false;

        // Dynamic animation duration configs (in milliseconds)
        this.FADE_IN_DURATION = 1500;
        this.FADE_OUT_DURATION = 1000;

        // Step interval for volume interpolation (60fps smooth volume adjustments = ~16ms)
        this.FADE_INTERVAL_STEP = 30;

        // ====================================================================
        // Playback Conflict Preventer
        // ====================================================================
        // Under Apple's HIG principles, media experiences should be seamless.
        // We listen to the global application EventBus for any 'player:play' events.
        // As soon as video or trailer playback begins, we instantly silence the
        // background theme music to avoid conflicting overlapping audio tracks.
        eventBus.on('player:play', () => {
            log.info('Global playback initiation detected; stopping theme song instantly');
            this.stopInstant();
        });
    }

    /**
     * Lazy initializer for the single HTML5 Audio element.
     * Prevents browser security roadblocks by instantiating only on demand.
     */
    _initAudio() {
        if (this._audio) return;

        log.debug('Initializing HTML5 Audio element instance');
        this._audio = new Audio();

        // Set standard properties for continuous background score ambiance
        this._audio.loop = true;

        // Ensure volume starts fully silent for visual-auditory transition sync
        this._audio.volume = 0;
    }

    /**
     * Plays a show's theme song with a premium, smooth fade-in effect.
     *
     * @param {string} url - The direct authorized stream URL from Jellyfin
     * @param {string} ownerId - Unique ID of the series/parent item owning this theme
     */
    play(url, ownerId) {
        // Initialize if not already created
        this._initAudio();

        // --------------------------------------------------------------------
        // Cancel any active deferred stop grace timers.
        // A fresh theme playback command has arrived, so we keep the active
        // decoders running without triggering the scheduled shutdown.
        // --------------------------------------------------------------------
        this._clearDeferredStop();

        // Guard: If we are already playing this exact show's music, sustain it
        if (this._currentUrl === url && this._ownerId === ownerId && !this._isFadingOut) {
            log.debug('Theme song already playing for owner', ownerId);
            return;
        }

        // Cancel any active volumetric transitions before switching streams
        this._clearFade();
        this._isFadingOut = false;

        log.info('Starting theme song playback for owner', ownerId);
        this._currentUrl = url;
        this._ownerId = ownerId;

        try {
            // Load the new stream path into the HTML5 controller
            this._audio.src = url;
            this._audio.volume = 0; // Force absolute silence before starting

            // Begin background media decoding and playback
            this._audio
                .play()
                .then(() => {
                    // Safety check: if the user navigated away or stopped playback
                    // while the stream was loading, abort the fade-in and pause!
                    if (this._currentUrl !== url) {
                        log.warn('Theme playback resolved after being cancelled; aborting');
                        this._audio.pause();
                        return;
                    }
                    // Trigger dynamic fade-in over 1.5 seconds once playback starts
                    this._fadeIn();
                })
                .catch((err) => {
                    // Auto-fail gracefully (e.g. if autoplay policies block instant audio or if aborted)
                    log.warn('Autoplay blocked or stream load failed/aborted', err);
                });
        } catch (err) {
            log.error('Failed to trigger background play pipeline', err);
        }
    }

    /**
     * Stops current playback with a premium, smooth fade-out effect.
     * Gracefully releases resource handles to avoid holding TV decoders.
     */
    stop() {
        // Clear any active deferred stop grace timers
        this._clearDeferredStop();

        // If we are not playing or loading anything, or already fading out, do nothing
        if (!this._audio || !this._currentUrl || this._isFadingOut) {
            return;
        }

        // If the audio element is paused (e.g. still loading or failed), stop instantly.
        // This resolves the critical race condition where the page is exited before
        // the audio play promise has resolved.
        if (this._audio.paused) {
            log.info('Theme song is paused/loading; stopping instantly');
            this.stopInstant();
            return;
        }

        log.info('Initiating theme song fade-out stop sequence');

        // CRITICAL: Synchronously nullify the active URL and owner at the very start
        // of the stop sequence. This ensures any pending play() promises that resolve
        // during the 1-second fade-out will immediately fail the safety check and abort,
        // rather than clearing the fade-out timer, hijacking the slider, and looping forever.
        this._currentUrl = null;
        this._ownerId = null;

        this._clearFade();
        this._isFadingOut = true;

        // Perform smooth volumetric decay over 1.0 second
        this._fadeOut(() => {
            // Callback once volume reaches 0: pause, reset source, and clear state
            if (this._audio) {
                this._audio.pause();
                this._audio.src = ''; // Force stream release
                log.debug('HTML5 Audio decoders successfully released');
            }
            this._isFadingOut = false;
        });
    }

    /**
     * Instantly stops playback without any volumetric transitions.
     * Essential for immediate video/audio playback handoffs.
     */
    stopInstant() {
        this._clearDeferredStop();
        this._clearFade();
        this._isFadingOut = false;

        if (this._audio) {
            this._audio.pause();
            this._audio.src = '';
            this._audio.volume = 0;
        }

        this._currentUrl = null;
        this._ownerId = null;
        log.debug('Theme playback instantly terminated for handoff');
    }

    /**
     * Schedules a deferred stop transition over a brief grace period.
     * Prevents music from stopping and restarting when transitioning
     * between seasons/episodes of the same parent show.
     *
     * @param {number} delayMs - Delay duration in milliseconds
     */
    stopDeferred(delayMs = 2000) {
        this._clearDeferredStop();

        log.debug('Scheduling deferred theme stop in', delayMs, 'ms');
        this._deferredStopTimer = setTimeout(() => {
            this._deferredStopTimer = null;
            log.info('Theme song deferred stop timer expired; stopping');
            this.stop();
        }, delayMs);
    }

    /**
     * Clears and nullifies the active deferred stop grace timer.
     */
    _clearDeferredStop() {
        if (this._deferredStopTimer) {
            clearTimeout(this._deferredStopTimer);
            this._deferredStopTimer = null;
            log.debug('Deferred stop grace timer cancelled');
        }
    }

    /**
     * Interpolates volume from 0 to the user-configured target volume level
     * for a premium, Apple-style smooth entry transition.
     */
    _fadeIn() {
        // Read the user's custom volume preference from local storage.
        // Under Apple's HIG principles, sound levels should default to a comfortable,
        // ambient level (30% or 0.3) rather than blasting at 100%.
        const targetVolume = parseFloat(storage.getItem('pref:themeSongVolume') || '0.3');

        // Calculate the total number of updates needed to complete the transition
        // based on the configured step size (e.g. 1500ms / 30ms = 50 steps).
        const steps = this.FADE_IN_DURATION / this.FADE_INTERVAL_STEP;

        // Compute the amount of volume to add during each step interval
        const volumeIncrement = targetVolume / steps;
        let currentStep = 0;

        this._fadeInterval = setInterval(() => {
            // Safety check: if audio instance is destroyed mid-fade, abort immediately
            if (!this._audio) {
                this._clearFade();
                return;
            }

            currentStep++;

            // Slowly increase the volume level up to the target cap
            const nextVolume = Math.min(targetVolume, currentStep * volumeIncrement);
            this._audio.volume = nextVolume;

            // Target volume reached: clear the interval to stop looping
            if (nextVolume >= targetVolume) {
                log.debug('Volumetric fade-in transition completed with target:', targetVolume);
                this._clearFade();
            }
        }, this.FADE_INTERVAL_STEP);
    }

    /**
     * Interpolates volume from its current level down to 0 before executing a callback.
     *
     * @param {Function} onComplete - Action to execute once silent
     */
    _fadeOut(onComplete) {
        const steps = this.FADE_OUT_DURATION / this.FADE_INTERVAL_STEP;
        const startVolume = this._audio ? this._audio.volume : 0;
        const volumeDecrement = startVolume / steps;
        let currentStep = 0;

        this._fadeInterval = setInterval(() => {
            if (!this._audio) {
                this._clearFade();
                onComplete();
                return;
            }

            currentStep++;
            // Slowly decay the volume fraction
            const nextVolume = Math.max(0, startVolume - currentStep * volumeDecrement);
            this._audio.volume = nextVolume;

            // Silence reached: end transition and clean up
            if (nextVolume <= 0) {
                this._clearFade();
                onComplete();
            }
        }, this.FADE_INTERVAL_STEP);
    }

    /**
     * Utility method to cancel all active interpolation timers.
     */
    _clearFade() {
        if (this._fadeInterval) {
            clearInterval(this._fadeInterval);
            this._fadeInterval = null;
        }
    }
}

// Export a single shared global player instance
export const themeSongPlayer = new ThemeSongPlayer();
