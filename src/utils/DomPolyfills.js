/**
 * ============================================================================
 * Litefin Tizen - Platform Polyfills (Web API)
 * ============================================================================
 * Polyfills for Web APIs missing in older Chromium versions that core-js does
 * not cover (core-js only polyfills JS language built-ins).
 *
 * These are bundled via webpack entry arrays for Normal (Chrome 63) and
 * Legacy (Chrome 47) builds. For Chrome 32 (Ultra-Legacy), these are provided
 * inline in index.ultra-legacy.html so they run before the webpack bundle.
 * Modern/Debug builds (Chrome 85+) do not include this file at all.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// AbortController — added in Chrome 66. Required for fetch timeout patterns
// in ApiClient and FontLoader on Tizen 5.0 (Chromium 63).
// ----------------------------------------------------------------------------
if (typeof AbortController === 'undefined') {
    window.AbortController = function AbortController() {
        this.signal = Object.create(null);
        this.signal.aborted = false;
        this.signal.onabort = null;
        this.signal.addEventListener = function () {};
        this.signal.removeEventListener = function () {};
        this.signal.dispatchEvent = function () {};

        const _signal = this.signal;

        this.abort = function () {
            if (_signal.aborted) return;
            _signal.aborted = true;
            if (typeof _signal.onabort === 'function') {
                _signal.onabort({ type: 'abort', target: _signal });
            }
        };
    };
}

// ----------------------------------------------------------------------------
// NodeList.forEach() — added in Chrome 51. Used in FocusManager, LazyLoader.
// ----------------------------------------------------------------------------
if (typeof NodeList !== 'undefined' && NodeList.prototype && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = Array.prototype.forEach;
}

// ----------------------------------------------------------------------------
// Element.after() — added in Chrome 54. DOM mutation helper.
// ----------------------------------------------------------------------------
if (typeof Element !== 'undefined' && !Element.prototype.after) {
    Element.prototype.after = function () {
        const argArr = Array.prototype.slice.call(arguments);
        const parent = this.parentNode;
        if (parent) {
            const next = this.nextSibling;
            for (let i = 0; i < argArr.length; i++) {
                const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                parent.insertBefore(node, next);
            }
        }
    };
}
