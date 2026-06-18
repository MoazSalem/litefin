/**
 * ============================================================================
 * JassubRenderer — Legacy/Ultra-Legacy Stub
 * ============================================================================
 * Jassub requires OffscreenCanvas.transferControlToOffscreen() which was
 * introduced in Chrome 69. Legacy builds target Chrome 47 (Tizen 3.x /
 * WebOS 4.x) and ultra-legacy targets Chrome 32 (Tizen 2.x / WebOS 1.x) —
 * neither platform can run the WASM/WebGL pipeline.
 *
 * This stub exposes the exact same class signature as the real JassubRenderer
 * so SubtitleManager's instanceof checks and method calls compile cleanly,
 * but every method immediately throws so the engine selection logic in
 * SubtitleManager falls back to ASSRenderer (libjass) at runtime.
 *
 * NOTE: This file is swapped in by NormalModuleReplacementPlugin in the
 * legacyConfig and ultraLegacyConfig webpack builds. It is never shipped
 * in es6, debug, or normal builds.
 * ============================================================================
 */

export default class JassubRenderer {

    /* Match the real constructor signature so SubtitleManager compiles */
    constructor({ container, video, width, height } = {}) {
        /*
         * Throw immediately so SubtitleManager's try/catch in _loadASSTrack
         * catches it and stays on the ASSRenderer (libjass) path.
         * This is intentional — jassub is not supported on this platform.
         */
        throw new Error(
            'JassubRenderer is not supported on this platform ' +
            '(OffscreenCanvas.transferControlToOffscreen not available)'
        );
    }

    /* -----------------------------------------------------------------------
     * Stub implementations of the public API surface.
     * These are never called (the constructor always throws first), but they
     * prevent "method not a function" errors if the stub is ever instantiated
     * without being caught.
     * ----------------------------------------------------------------------- */

    tick() {}
    resize() {}
    async setTrack() {}
    setDelay() {}
    async setFontStyles() {}
    show() {}
    hide() {}
    clearTrack() {}
    clear() {}
    destroy() {}
}
