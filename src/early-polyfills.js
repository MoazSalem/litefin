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
                while (--i >= 0 && matches.item(i) !== this) { }
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

    // ------------------------------------------------------------------------
    // window.chrome — Chromium environment detection polyfill
    // ------------------------------------------------------------------------
    // In Android WebView, window.chrome is not defined by default, which causes
    // player engines (specifically movi-player CanvasRenderer) to falsely detect
    // Android WebView as a non-Chromium browser (such as Safari or Firefox).
    // This misidentification leads to selecting broken shader-based tone mapping
    // and failing native HDR / drawing buffer color space configuration, resulting
    // in black screen video output while audio plays normally.
    if (typeof window !== 'undefined' && !window.chrome) {
        // Define minimal chrome runtime object to satisfy Chromium environment checks
        window.chrome = {
            runtime: {}
        };
    }

    // ------------------------------------------------------------------------
    // WebGL2-to-WebGL1 Compatibility Bridge
    // ------------------------------------------------------------------------
    // Devices with legacy or budget mobile GPUs (e.g., ARM Mali-450 on Xiaomi
    // Mi Box 4 / Amlogic S905L TV boxes) only possess OpenGL ES 2.0 silicon.
    // Consequently, Android WebView cannot provide native WebGL 2.0 (OpenGL ES 3.0).
    //
    // Modern media players such as movi-player (CanvasRenderer) request "webgl2"
    // exclusively for drawing decoded video frames. When getContext("webgl2")
    // returns null, CanvasRenderer logs "WebGL2 not supported" and aborts the GL
    // pipeline entirely, leaving a black screen while audio continues.
    //
    // This bridge transparently falls back to WebGL 1.0, polyfills Vertex Array
    // Objects (OES_vertex_array_object extension), and transpiles GLSL ES 3.00
    // shaders (#version 300 es) to GLSL ES 1.00 on the fly so video renders smoothly.
    (function initWebGL2Bridge() {
        // Verify browser DOM environment with HTMLCanvasElement
        if (typeof window === 'undefined' || !window.HTMLCanvasElement) {
            return;
        }

        /**
         * Transpile GLSL ES 3.00 shader source code into GLSL ES 1.00.
         *
         * @param {string} source - The raw shader source code.
         * @param {number|string} type - GL shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER).
         * @param {WebGLRenderingContext} [gl] - Optional GL context for precision queries.
         * @returns {string} Transpiled WebGL 1 compatible shader code.
         */
        function transpileShaderToWebGL1(source, type, gl) {
            // Early return if not a WebGL 2 shader
            if (!source || typeof source !== 'string' || source.indexOf('#version 300 es') === -1) {
                return source;
            }

            // Strip the GLSL 3.00 directive as WebGL 1 expects GLSL ES 1.00
            var s = source.replace(/#version\s+300\s+es\s*/g, '');

            // Identify whether this is a vertex shader based on GL constant or body content
            // Determine if the shader target represents a vertex shader stage
            var isVert = type === 35633 || source.indexOf('gl_Position') !== -1;

            /*
             * Query underlying GPU hardware precision capabilities for fragment processing.
             * Embedded graphics architectures such as ARM Mali-400 / Mali-450 only support
             * IEEE 754 16-bit floating-point (mediump) in their fragment pipelines.
             */
            var hasHighpFrag = false;
            if (gl && gl.getShaderPrecisionFormat) {
                try {
                    var prec = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
                    hasHighpFrag = prec && prec.precision > 0;
                } catch (_) {
                    // Fall back to mediump assumption if precision query fails
                    hasHighpFrag = false;
                }
            }

            if (isVert) {
                // Replace layout(location = N) in -> attribute
                s = s.replace(/layout\s*\(\s*location\s*=\s*\d+\s*\)\s*in\s+/g, 'attribute ');
                // Replace vertex input declarations: in <type> <name>; -> attribute <type> <name>;
                s = s.replace(/(?:^|\n)\s*in\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s*;/g, function (match, t, name) {
                    return '\nattribute ' + t + ' ' + name + ';';
                });
                // Replace vertex varying outputs: out <type> <name>; -> varying <type> <name>;
                s = s.replace(/(?:^|\n)\s*out\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s*;/g, function (match, t, name) {
                    return '\nvarying ' + t + ' ' + name + ';';
                });

                /*
                 * OpenGL ES 2.0 / WebGL 1 requires matching precision qualifiers across
                 * pipeline stages for shared varying variables. If the fragment shader is
                 * constrained to mediump, enforce mediump on vertex varyings to avert
                 * program link-time precision mismatch errors.
                 */
                if (!hasHighpFrag) {
                    s = s.replace(/precision\s+highp\s+float\s*;/g, 'precision mediump float;');
                    s = s.replace(/\bhighp\s+/g, 'mediump ');
                    if (s.indexOf('precision mediump float;') === -1) {
                        s = 'precision mediump float;\n' + s;
                    }
                }
            } else {
                // If highp is not supported in the fragment shader, downscale precision to mediump
                if (!hasHighpFrag) {
                    s = s.replace(/precision\s+highp\s+float\s*;/g, 'precision mediump float;');
                    s = s.replace(/\bhighp\s+/g, 'mediump ');
                }

                // Replace fragment varying inputs: in <type> <name>; -> varying <type> <name>;
                s = s.replace(/(?:^|\n)\s*in\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s*;/g, function (match, t, name) {
                    return '\nvarying ' + t + ' ' + name + ';';
                });
                // Remove fragment output declaration: out vec4 outColor;
                s = s.replace(/(?:^|\n)\s*out\s+vec4\s+([a-zA-Z0-9_]+)\s*;/g, '');
                // Replace texture(...) lookup function with texture2D(...)
                s = s.replace(/\btexture\s*\(/g, 'texture2D(');
                // Declare local outColor in main() and assign to gl_FragColor at exit
                s = s.replace(/void\s+main\s*\(\s*\)\s*\{/, 'void main() {\n  vec4 outColor = vec4(0.0);');
                var lastBraceIdx = s.lastIndexOf('}');
                if (lastBraceIdx !== -1) {
                    s = s.slice(0, lastBraceIdx) + '\n  gl_FragColor = outColor;\n' + s.slice(lastBraceIdx);
                }
            }

            return s;
        }

        /**
         * Augments a WebGL 1 context to provide the WebGL 2 surface methods needed by Movi.
         *
         * @param {WebGLRenderingContext} gl - WebGL 1 rendering context.
         * @returns {WebGLRenderingContext} Augmented context.
         */
        function patchContextForWebGL2(gl) {
            // Guard against duplicate patching on cached contexts
            if (!gl || gl.__isWebGL2Bridged) {
                return gl;
            }
            gl.__isWebGL2Bridged = true;

            // Wire Vertex Array Objects (VAO) via OES_vertex_array_object extension
            var vaoExt = gl.getExtension('OES_vertex_array_object');
            if (vaoExt) {
                gl.createVertexArray = function () { return vaoExt.createVertexArrayOES(); };
                gl.bindVertexArray = function (vao) { return vaoExt.bindVertexArrayOES(vao); };
                gl.deleteVertexArray = function (vao) { return vaoExt.deleteVertexArrayOES(vao); };
                gl.isVertexArray = function (vao) { return vaoExt.isVertexArrayOES(vao); };
            } else {
                // Fallback no-op VAO emulation if extension is completely absent
                gl.createVertexArray = function () { return { __fallbackVao: true }; };
                gl.bindVertexArray = function () {};
                gl.deleteVertexArray = function () {};
                gl.isVertexArray = function (v) { return !!(v && v.__fallbackVao); };
            }

            // Provide color space properties expected by Chromium HDR pipelines
            if (!('drawingBufferColorSpace' in gl)) {
                var _drawingColorSpace = 'srgb';
                Object.defineProperty(gl, 'drawingBufferColorSpace', {
                    get: function () { return _drawingColorSpace; },
                    set: function (val) { _drawingColorSpace = val; },
                    configurable: true
                });
            }
            if (!('unpackColorSpace' in gl)) {
                var _unpackColorSpace = 'srgb';
                Object.defineProperty(gl, 'unpackColorSpace', {
                    get: function () { return _unpackColorSpace; },
                    set: function (val) { _unpackColorSpace = val; },
                    configurable: true
                });
            }

            // Expose WebGL 2 texture format constants
            if (gl.RGBA16F === undefined) { gl.RGBA16F = 0x881A; }
            if (gl.HALF_FLOAT === undefined) { gl.HALF_FLOAT = 0x140B; }

            // Intercept createShader to retain shader type
            var origCreateShader = gl.createShader;
            gl.createShader = function (type) {
                var shader = origCreateShader.call(this, type);
                if (shader) {
                    shader.__shaderType = type;
                }
                return shader;
            };

            // Intercept shaderSource to transpile GLSL ES 3.00 shaders to 1.00
            var origShaderSource = gl.shaderSource;
            gl.shaderSource = function (shader, source) {
                var shaderType = (shader && shader.__shaderType) || 0;
                var transpiled = transpileShaderToWebGL1(source, shaderType, gl);
                return origShaderSource.call(this, shader, transpiled);
            };

            return gl;
        }

        /**
         * Hooks getContext on the canvas prototype to gracefully fallback to WebGL 1.
         *
         * @param {Object} proto - Prototype object (HTMLCanvasElement or OffscreenCanvas).
         */
        function wrapGetContext(proto) {
            if (!proto || !proto.getContext) return;
            var origGetContext = proto.getContext;
            proto.getContext = function (type, options) {
                // First attempt the standard native request
                var ctx = origGetContext.call(this, type, options);
                if (!ctx && type === 'webgl2') {
                    // Fall back to WebGL 1 when WebGL 2 hardware support is missing
                    ctx = origGetContext.call(this, 'webgl', options) ||
                          origGetContext.call(this, 'experimental-webgl', options);
                    if (ctx) {
                        // Diagnostic log indicating WebGL2-to-WebGL1 bridge engagement
                        if (typeof console !== 'undefined' && console.warn) {
                            console.warn('[EarlyPolyfills] getContext("webgl2") fallback active: bridging WebGL1 context with GLSL shader transpilation & VAO emulation');
                        }
                        patchContextForWebGL2(ctx);
                    }
                }
                return ctx;
            };
        }

        // Wrap HTMLCanvasElement
        wrapGetContext(window.HTMLCanvasElement.prototype);

        // Wrap OffscreenCanvas if supported in this WebView
        if (typeof window.OffscreenCanvas !== 'undefined' && window.OffscreenCanvas.prototype) {
            wrapGetContext(window.OffscreenCanvas.prototype);
        }

        // Alias WebGL2RenderingContext constructor if missing
        if (typeof window.WebGL2RenderingContext === 'undefined' && typeof window.WebGLRenderingContext !== 'undefined') {
            window.WebGL2RenderingContext = window.WebGLRenderingContext;
        }
    })();
})();
