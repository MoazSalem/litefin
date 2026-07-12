/**
 * ============================================================================
 * WebOS RVFC Polyfill
 * ============================================================================
 * On webOS TV the video is rendered in a hardware overlay that is not
 * accessible via the DOM. Frame-count APIs (getVideoPlaybackQuality,
 * webkitDecodedFrameCount, webkitDroppedFrameCount, etc.) all return 0,
 * which causes the native requestVideoFrameCallback to never fire its
 * callbacks — breaking JASSUB's entire render loop.
 *
 * This polyfill installs requestVideoFrameCallback / cancelVideoFrameCallback
 * directly on the video *instance* (instance properties shadow the broken
 * prototype methods). It drives the loop with requestAnimationFrame and
 * fires whenever currentTime advances; the first call always fires
 * immediately so the renderer can produce the initial frame even when the
 * video starts paused.
 *
 * Usage:
 *   import { installWebOSRVFCPolyfill } from '../utils/webos-rvfc-polyfill.js';
 *   installWebOSRVFCPolyfill(videoElement);
 * ============================================================================
 */

export const installWebOSRVFCPolyfill = (video) => {
    if (!video || video._rvfcPolyfillInstalled) return;

    const callbackMap = {};
    let counter = 0;

    video.requestVideoFrameCallback = function (callback) {
        const handle = ++counter;
        const el = this;
        let lastTime = -1;

        const loop = (now) => {
            if (!callbackMap[handle]) return;
            const currentTime = el.currentTime;
            if (lastTime < 0 || currentTime !== lastTime) {
                lastTime = currentTime;
                delete callbackMap[handle];
                callback(now, {
                    presentationTime: now,
                    expectedDisplayTime: now + 1000 / 60,
                    width: el.videoWidth,
                    height: el.videoHeight,
                    mediaTime: Math.max(0, currentTime),
                    presentedFrames: 0,
                    processingDuration: 0
                });
            } else {
                callbackMap[handle] = window.requestAnimationFrame(loop);
            }
        };

        callbackMap[handle] = window.requestAnimationFrame(loop);
        return handle;
    };

    video.cancelVideoFrameCallback = function (handle) {
        window.cancelAnimationFrame(callbackMap[handle]);
        delete callbackMap[handle];
    };

    video._rvfcPolyfillInstalled = true;
};
