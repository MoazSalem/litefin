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
            while (--i >= 0) {
                if (matches.item(i) === this) {
                    return true;
                }
            }
            return false;
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
            if (
                el.matches
                    ? el.matches(selector)
                    : el.webkitMatchesSelector
                      ? el.webkitMatchesSelector(selector)
                      : false
            ) {
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
//
// IMPORTANT: The previous stub silently dropped all addEventListener calls,
// which broke the cancelDiscovery() flow in ApiClient.discoverServers().
// When testServer() wires up an 'abort' listener via parentSignal.addEventListener,
// the stub ignored it entirely — meaning onParentAbort() never fired and in-flight
// XHRs were never cancelled when cancelDiscovery() was called on WebOS 4.x.
//
// This functional polyfill properly maintains a listener registry and dispatches
// 'abort' events to all registered handlers, matching the real AbortSignal API
// closely enough for our XHR-based usage pattern.
// ----------------------------------------------------------------------------
if (typeof AbortController === 'undefined') {
    window.AbortController = function AbortController() {
        /*
         * Internal listener registry: maps eventType -> array of { listener, once }
         * We only ever fire 'abort' events in practice, but the map is generic.
         */
        const _listeners = {};
        const _signal = Object.create(null);

        _signal.aborted = false;
        _signal.onabort = null;

        /*
         * addEventListener — supports the { once } option so that testServer()'s
         * onParentAbort is automatically cleaned up after the first abort fires.
         * Without this, the polyfill stub silently ignored the call and the
         * XHR abort chain was completely broken on WebOS 4.x / Tizen 3.x.
         */
        _signal.addEventListener = function (type, listener, options) {
            if (!listener) return;
            if (!_listeners[type]) _listeners[type] = [];
            const once = options && options.once ? true : false;
            _listeners[type].push({ fn: listener, once: once });
        };

        /* removeEventListener — exact mirror of the spec for our use case. */
        _signal.removeEventListener = function (type, listener) {
            if (!_listeners[type]) return;
            _listeners[type] = _listeners[type].filter(function (entry) {
                return entry.fn !== listener;
            });
        };

        /* dispatchEvent — fires all registered handlers for the given type. */
        _signal.dispatchEvent = function (event) {
            const type = event && event.type;
            if (!type || !_listeners[type]) return;

            /* Snapshot before iteration: once-handlers remove themselves mid-loop. */
            const entries = _listeners[type].slice();
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                entry.fn.call(_signal, event);
                if (entry.once) {
                    _signal.removeEventListener(type, entry.fn);
                }
            }
        };

        this.signal = _signal;

        this.abort = function () {
            if (_signal.aborted) return;
            _signal.aborted = true;

            /* Fire the legacy onabort callback if set. */
            if (typeof _signal.onabort === 'function') {
                _signal.onabort({ type: 'abort', target: _signal });
            }

            /* Dispatch the 'abort' event to all addEventListener listeners. */
            _signal.dispatchEvent({ type: 'abort', target: _signal });
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

if (typeof DocumentFragment !== 'undefined' && !DocumentFragment.prototype.append) {
    DocumentFragment.prototype.append = function () {
        const argArr = Array.prototype.slice.call(arguments);
        for (let i = 0; i < argArr.length; i++) {
            const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
            this.appendChild(node);
        }
    };
}

if (typeof Document !== 'undefined' && !Document.prototype.append) {
    Document.prototype.append = function () {
        const argArr = Array.prototype.slice.call(arguments);
        for (let i = 0; i < argArr.length; i++) {
            const node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
            this.appendChild(node);
        }
    };
}
