/**
 * ============================================================================
 * Litefin - Movi Video Player Backend Stub (TV / Non-Desktop Builds)
 * ============================================================================
 * Lightweight no-op stub that replaces the full MoviVideoPlayer implementation
 * during compilation of smart television targets (Samsung Tizen and LG webOS).
 *
 * MoviPlayer relies on WebCodecs, SharedArrayBuffer, and heavy WebAssembly
 * binaries (movi.wasm) that are unsupported or suboptimal on TV hardware.
 *
 * Swapping MoviVideoPlayer with this zero-dependency stub via Webpack resolve
 * aliases ensures that neither the movi-player JavaScript runtime nor the
 * 30MB+ WebAssembly binaries are bundled into television distributions (.wgt / .ipk).
 *
 * @module core/MoviVideoPlayerStub
 * ============================================================================
 */

import { logger } from '../../utils/Logger.js';

// Initialize scoped diagnostic logger for the stub
const log = logger.create('MoviVideoPlayerStub');

/**
 * MoviVideoPlayer Stub Implementation
 * Implements the standard player backend interface with safe no-op methods.
 */
export class MoviVideoPlayer {
    /**
     * @param {Object} options - Initialization options
     */
    constructor(options = {}) {
        // Log diagnostic warning that MoviPlayer is not present on this build target
        log.warn('MoviVideoPlayer is not bundled in television build tiers (Samsung Tizen / LG webOS).');

        // Retain basic references to satisfy calling interfaces
        this.container = options.container || null;
        this.settings = options.settings || null;
        this.onEvent = options.onEvent || (() => {});
    }

    /**
     * Start playback stub — rejects immediately as Movi is unsupported on TV builds
     * @param {Object} _playOptions - Playback parameters
     * @returns {Promise<void>} Rejection promise
     */
    play(_playOptions) {
        log.error('Cannot start playback: MoviPlayer backend is only supported on Desktop builds.');
        return Promise.reject(new Error('MoviPlayer is not available in television builds.'));
    }

    /**
     * Pause playback stub
     */
    pause() {
        // No-op on television stub
    }

    /**
     * Seek playback stub
     * @param {number} _ticks - Target position in ticks
     */
    seek(_ticks) {
        // No-op on television stub
    }

    /**
     * Stop playback stub
     */
    stop() {
        // No-op on television stub
    }

    /**
     * Set playback volume stub
     * @param {number} _volume - Volume level 0..100
     */
    setVolume(_volume) {
        // No-op on television stub
    }

    /**
     * Mute / unmute audio stub
     * @param {boolean} _muted - Mute flag
     */
    setMuted(_muted) {
        // No-op on television stub
    }

    /**
     * Set playback rate stub
     * @param {number} _rate - Playback speed multiplier
     */
    setPlaybackRate(_rate) {
        // No-op on television stub
    }

    /**
     * Switch active audio track index stub
     * @param {number} _index - Media stream index
     */
    setAudioStreamIndex(_index) {
        // No-op on television stub
    }

    /**
     * Retrieve available audio tracks stub
     * @returns {Array} Empty track list
     */
    getAudioTracks() {
        return [];
    }

    /**
     * Retrieve current playback diagnostics stub
     * @returns {Object} Diagnostic summary
     */
    getPlaybackInfo() {
        return {
            player: 'None (Stub)',
            bitDepth: null
        };
    }

    /**
     * Check if player is paused
     * @returns {boolean} Always true in stub mode
     */
    isPaused() {
        return true;
    }

    /**
     * Check if player supports seeking
     * @returns {boolean} False in stub mode
     */
    isSeekable() {
        return false;
    }

    /**
     * Retrieve current playback duration in ticks
     * @returns {number} 0 in stub mode
     */
    getDurationTicks() {
        return 0;
    }

    /**
     * Retrieve current playback position in ticks
     * @returns {number} 0 in stub mode
     */
    getCurrentPositionTicks() {
        return 0;
    }

    /**
     * Retrieve underlying HTML video element
     * @returns {null} Null in stub mode
     */
    getVideoElement() {
        return null;
    }

    /**
     * Retrieve underlying movi custom element
     * @returns {null} Null in stub mode
     */
    getMoviElement() {
        return null;
    }

    /**
     * Teardown and clean up stub
     */
    destroy() {
        this.container = null;
        this.settings = null;
        this.onEvent = () => {};
    }
}
