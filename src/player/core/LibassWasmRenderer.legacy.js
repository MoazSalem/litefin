/**
 * ============================================================================
 * LibassWasmRenderer — Legacy/Ultra-Legacy Stub
 * ============================================================================
 * SubtitlesOctopus (libass-wasm) requires WebAssembly, which is not supported
 * on legacy platforms (e.g. Chrome 47 / Tizen 3.x / WebOS 4.x and older).
 *
 * This stub exposes the exact same class signature as the real LibassWasmRenderer
 * so SubtitleManager compiles cleanly, but the constructor throws immediately
 * so the setup logic falls back to ASSRenderer (libjass) at runtime.
 *
 * NOTE: Swapped in by NormalModuleReplacementPlugin during legacy/ultra-legacy builds.
 * ============================================================================
 */

export default class LibassWasmRenderer {
    /**
     * =========================================================================
     * Stub Capability Check
     * =========================================================================
     * Always returns false in ultra-legacy builds because WebAssembly dependencies
     * and workers are excluded from the bundle.
     *
     * @returns {boolean} Always false.
     */
    static isSupported() {
        return false;
    }

    constructor({ container, video, width, height } = {}) {
        throw new Error(
            'LibassWasmRenderer is not supported on this platform ' +
            '(WebAssembly is not available)'
        );
    }

    tick() {}
    resize() {}
    async setTrack() {}
    setDelay() {}
    async setFontStyles() {}
    show() {}
    hide() {}
    clearTrack() {}
    clear() {}
    play() {}
    pause() {}
    destroy() {}
}
