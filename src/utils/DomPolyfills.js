/**
 * ============================================================================
 * Litefin Tizen - Platform Polyfills (Web API)
 * ============================================================================
 * Polyfills for Web APIs missing in older Chromium versions that core-js does
 * not cover (core-js only polyfills JS language built-ins).
 *
 * Included in Webpack entry arrays for Normal and Legacy builds.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// Element.matches() — added in Chrome 34 (vendor-prefixed in earlier WebKit).
// ----------------------------------------------------------------------------
if (typeof Element !== 'undefined' && !Element.prototype.matches) {
    Element.prototype.matches =
        Element.prototype.msMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function (selector) {
            const matches = (this.document || this.ownerDocument).querySelectorAll(selector);
            let i = matches.length;
            while (--i >= 0 && matches.item(i) !== this) {}
            return i > -1;
        };
}

// ----------------------------------------------------------------------------
// Element.closest() — added in Chrome 41. Used extensively in FocusManager,
// ScrollController, and pages for delegated event handling (e.target.closest).
// ----------------------------------------------------------------------------
if (typeof Element !== 'undefined' && !Element.prototype.closest) {
    Element.prototype.closest = function (selector) {
        let el = this;
        while (el && el.nodeType === 1) {
            if (el.matches ? el.matches(selector) : el.webkitMatchesSelector ? el.webkitMatchesSelector(selector) : false) {
                return el;
            }
            el = el.parentElement || el.parentNode;
        }
        return null;
    };
}

// ----------------------------------------------------------------------------
// Element.remove() — added in Chrome 23 / WebKit 537+.
// ----------------------------------------------------------------------------
if (typeof Element !== 'undefined' && !Element.prototype.remove) {
    Element.prototype.remove = function () {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    };
}

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
// ChildNode.after() / before() / prepend() / append() — added in Chrome 54.
// ----------------------------------------------------------------------------
if (typeof Element !== 'undefined') {
    if (!Element.prototype.after) {
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

    if (!Element.prototype.before) {
        Element.prototype.before = function () {
            const argArr = Array.prototype.slice.call(arguments);
            const parent = this.parentNode;
            if (parent) {
                for (let i = 0; i < argArr.length; i++) {
                    const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                    parent.insertBefore(node, this);
                }
            }
        };
    }

    if (!Element.prototype.prepend) {
        Element.prototype.prepend = function () {
            const argArr = Array.prototype.slice.call(arguments);
            const first = this.firstChild;
            for (let i = 0; i < argArr.length; i++) {
                const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                this.insertBefore(node, first);
            }
        };
    }

    if (!Element.prototype.append) {
        Element.prototype.append = function () {
            const argArr = Array.prototype.slice.call(arguments);
            for (let i = 0; i < argArr.length; i++) {
                const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                this.appendChild(node);
            }
        };
    }
}
