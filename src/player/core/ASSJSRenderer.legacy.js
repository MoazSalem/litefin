/**
 * ============================================================================
 * ASSJSRenderer — Ultra-Legacy Stub
 * ============================================================================
 * ASS.js (assjs) is not bundled on ultra-legacy build targets to keep
 * package size small and prevent modern JS parsing errors on older WebKits.
 *
 * Exposes the exact same class signature as ASSJSRenderer so SubtitleManager
 * compiles cleanly without pulling assjs into the bundle.
 * ============================================================================
 */

export default class ASSJSRenderer {
    constructor({ container, video, width, height } = {}) {
        throw new Error(
            'ASSJSRenderer is not supported on ultra-legacy builds'
        );
    }

    setStyleConfig() {}
    tick() {}
    resize() {}
    async setTrack() {}
    setDelay() {}
    async setFontStyles() {}
    play() {}
    pause() {}
    show() {}
    hide() {}
    clearTrack() {}
    clear() {}
    destroy() {}
}
