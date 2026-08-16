/**
 * ============================================================================
 * Early Boot Polyfills — DOM & ES2015 Foundation
 * ============================================================================
 * Loaded before any Webpack bundle chunks or application scripts execute.
 * Polyfills missing DOM methods (closest, matches, forEach, append, after)
 * and ES2015 containers (WeakSet, WeakMap) required by dependencies like hls.js.
 * ============================================================================
 */
(function () {
    // ------------------------------------------------------------------------
    // Element.closest() — added in Chrome 41 / WebOS 3.0+
    // ------------------------------------------------------------------------
    if (typeof Element !== 'undefined' && !Element.prototype.closest) {
        Element.prototype.closest = function (selector) {
            var el = this;
            while (el && el.nodeType === 1) {
                if (el.matches ? el.matches(selector) : el.webkitMatchesSelector ? el.webkitMatchesSelector(selector) : false) {
                    return el;
                }
                el = el.parentElement || el.parentNode;
            }
            return null;
        };
    }

    // ------------------------------------------------------------------------
    // Element.matches() — vendor-prefixed in Chrome 32 (webkitMatchesSelector)
    // ------------------------------------------------------------------------
    if (typeof Element !== 'undefined' && !Element.prototype.matches) {
        Element.prototype.matches =
            Element.prototype.msMatchesSelector ||
            Element.prototype.webkitMatchesSelector ||
            function (selector) {
                var matches = (this.document || this.ownerDocument).querySelectorAll(selector);
                var i = matches.length;
                while (--i >= 0 && matches.item(i) !== this) {}
                return i > -1;
            };
    }

    // ------------------------------------------------------------------------
    // NodeList.forEach() — added in Chrome 51
    // ------------------------------------------------------------------------
    if (typeof NodeList !== 'undefined' && NodeList.prototype && !NodeList.prototype.forEach) {
        NodeList.prototype.forEach = Array.prototype.forEach;
    }

    // ------------------------------------------------------------------------
    // ChildNode.append() — added in Chrome 54
    // ------------------------------------------------------------------------
    if (typeof Element !== 'undefined' && !Element.prototype.append) {
        Element.prototype.append = function () {
            var argArr = Array.prototype.slice.call(arguments);
            for (var i = 0; i < argArr.length; i++) {
                var node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                this.appendChild(node);
            }
        };
    }

    // ------------------------------------------------------------------------
    // ChildNode.after() — added in Chrome 54
    // ------------------------------------------------------------------------
    if (typeof Element !== 'undefined' && !Element.prototype.after) {
        Element.prototype.after = function () {
            var argArr = Array.prototype.slice.call(arguments);
            var parent = this.parentNode;
            if (parent) {
                var next = this.nextSibling;
                for (var i = 0; i < argArr.length; i++) {
                    var node = typeof argArr[i] === 'string' ? document.createTextNode(argArr[i]) : argArr[i];
                    parent.insertBefore(node, next);
                }
            }
        };
    }

    // ------------------------------------------------------------------------
    // WeakSet polyfill — required by hls.js on ancient WebKit (WebOS WebKit/538)
    // ------------------------------------------------------------------------
    if (typeof WeakSet === 'undefined') {
        window.WeakSet = function (iterable) {
            this._items = [];
            if (iterable && typeof iterable.forEach === 'function') {
                var self = this;
                iterable.forEach(function (v) {
                    self.add(v);
                });
            }
        };
        window.WeakSet.prototype.add = function (value) {
            if (this._items.indexOf(value) === -1) {
                this._items.push(value);
            }
            return this;
        };
        window.WeakSet.prototype.has = function (value) {
            return this._items.indexOf(value) !== -1;
        };
        window.WeakSet.prototype.delete = function (value) {
            var idx = this._items.indexOf(value);
            if (idx !== -1) {
                this._items.splice(idx, 1);
                return true;
            }
            return false;
        };
    }

    // ------------------------------------------------------------------------
    // WeakMap polyfill — required alongside WeakSet for hls.js
    // ------------------------------------------------------------------------
    if (typeof WeakMap === 'undefined') {
        window.WeakMap = function (iterable) {
            this._keys = [];
            this._values = [];
            if (iterable && typeof iterable.forEach === 'function') {
                var self = this;
                iterable.forEach(function (pair) {
                    self.set(pair[0], pair[1]);
                });
            }
        };
        window.WeakMap.prototype.set = function (key, value) {
            var idx = this._keys.indexOf(key);
            if (idx !== -1) {
                this._values[idx] = value;
            } else {
                this._keys.push(key);
                this._values.push(value);
            }
            return this;
        };
        window.WeakMap.prototype.get = function (key) {
            var idx = this._keys.indexOf(key);
            return idx !== -1 ? this._values[idx] : undefined;
        };
        window.WeakMap.prototype.has = function (key) {
            return this._keys.indexOf(key) !== -1;
        };
        window.WeakMap.prototype.delete = function (key) {
            var idx = this._keys.indexOf(key);
            if (idx !== -1) {
                this._keys.splice(idx, 1);
                this._values.splice(idx, 1);
                return true;
            }
            return false;
        };
    }
})();
