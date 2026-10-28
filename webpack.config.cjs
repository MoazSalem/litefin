/**
 * ============================================================================
 * Litefin Tizen - Webpack Configuration
 * ============================================================================
 * Triple-build system supporting:
 * - Native build (Tizen 6.0+): No transpilation, pure ES6+
 * - Modern build (Tizen 5.0+): Transpiled for Chromium 69
 * - Legacy build (Tizen 3.0+): Transpiled for Chromium 38 (ES5)
 * ============================================================================
 */

const webpack = require('webpack');
const path = require('path');
const fs = require('fs');

// Read version from config.xml (Single Source of Truth)
const configXmlPath = path.resolve(__dirname, 'config.xml');
const configXmlContent = fs.readFileSync(configXmlPath, 'utf8');
const versionMatch = configXmlContent.match(/<widget[^>]*\sversion="([^"]+)"/);
const APP_VERSION = versionMatch ? versionMatch[1] : '0.0.0';

console.log(`Building Litefin v${APP_VERSION}`);

const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');

// ============================================================================
// Comment & Legal-Notice Stripping
// ============================================================================
// Every build tier ships with ALL comments removed - source annotations in
// first-party modules, legal banner comments importing with "!" in
// third-party code, and the per-chunk *.js.LICENSE.txt sidecar files Terser
// normally emits. This is a deliberate licensing tradeoff: the upstream
// projects remain MIT/BSD/Apache licensed and their full license texts are
// available at their source repositories (see package.json dependencies);
// they are just no longer duplicated into every distribution package.
// Tradeoff chosen for storage-constrained Smart TV flash memory.
//
// Note: copied plain-script vendor/worker files (webOSTV.js, libpgs.worker.js,
// subtitles-octopus-worker.js, ...) need no special handling - in webpack 5
// TerserPlugin's processAssets pass also walks CopyPlugin-emitted assets.
//
// Minimizer configuration shared by the tier configs. Fresh plugin instances
// per call - webpack does not support sharing plugin instances between
// concurrently-applied configurations.
// ============================================================================

/**
 * Builds the [JavaScript, CSS] minimizer pair used by every tier config.
 * - TerserPlugin replaces webpack's implicit default ('...' entry) so the
 *   options are explicit: no comment survives and no *.js.LICENSE.txt
 *   sidecars are emitted. Compression parameters mirror webpack's built-in
 *   TerserPlugin defaults exactly so output stays byte-comparable with the
 *   previous configuration; only the comment-facing options differ.
 * - CssMinimizerPlugin runs the cssnano 'default' preset with ALL comments
 *   discarded, matching the css-minify-loader pipeline legacy/ultra-legacy
 *   already use for inlined CSS.
 *
 * @returns {Array} minimizer plugin list (fresh instances)
 */
function getMinimizers() {
    return [
        new TerserPlugin({
            // Keep legal comments in the bundle itself; never emit sidecar files
            extractComments: false,
            terserOptions: {
                compress: { passes: 2 },
                mangle: { safari10: false },
                format: { comments: false, safari10: false }
            }
        }),
        new CssMinimizerPlugin({
            minimizerOptions: {
                preset: ['default', { discardComments: { removeAll: true } }]
            }
        })
    ];
}

/**
 * Initial-chunk splitting for the TV tiers.
 *
 * The old TV-tier policy was total consolidation (splitChunks:false) so that
 * a single self-contained main.js was read from package storage. As main.js
 * grew past 2 MB that policy outlived its usefulness: a 2 MB script pays a
 * full V8 parse ahead of first paint, and per-script compile-buffer sizing
 * (V8's AST/bytecode zones) is friendlier to ~700-800 KB units.
 *
 * Policy:
 * - chunks: 'initial'          Only boot chunks are split; the dynamically
 *                              imported page/player chunks stay fully
 *                              self-contained exactly as before.
 * - minSize: 400000            Never emit a small chunk - a <400 KB fragment
 *                              would cost another file read for trivial gain.
 * - maxSize: 800000            Cap every initial script near ~700-800 KB so
 *                              V8 keeps each compile cache/AST zone small.
 * - maxInitialRequests: 3      The boot parity contract for the TV package:
 *                              the entry chunk plus at most 2 split partners
 *                              are ~2.4 MB, i.e. a 2.2 MB main busts into
 *                              exactly three ~700 KB scripts.
 *
 * The extra initial chunks are loaded by the webpack bootstrap inside the
 * entry chunk (runtimeChunk stays false) through the same script-injection
 * machinery the async page chunks already use - proven working on file://
 * package storage on Tizen/webOS.
 *
 * @returns {Object} splitChunks options shared by every TV tier config
 */
function getTvInitialSplitChunks() {
    return {
        chunks: 'initial',
        minSize: 400000,
        maxSize: 800000,
        maxInitialRequests: 3
    };
}

// ============================================================================
// Shared plugins factory
// ============================================================================
// Master Localization Source Dictionary (en-us.json)
// ============================================================================
// Lazily loads and caches the canonical English localization dictionary.
// Used during build-time packaging to compile locales into keyless value arrays
// and prune redundant untranslated strings, relying on i18n.js fallback resolution.
let masterEnUsLocale = null;
function getMasterEnUsLocale() {
    // Return cached dictionary if already parsed from disk
    if (masterEnUsLocale) {
        return masterEnUsLocale;
    }

    try {
        // Resolve absolute path to the canonical English locale file
        const enPath = path.resolve(__dirname, 'src/locales/en-us.json');

        // Read and parse the source dictionary synchronously
        masterEnUsLocale = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    } catch (err) {
        // Fallback to empty dictionary if source file cannot be read
        masterEnUsLocale = {};
    }

    return masterEnUsLocale;
}

// Cached list of canonical localization keys (excluding section comments)
let masterEnUsKeys = null;
function getMasterEnUsKeys() {
    if (masterEnUsKeys) {
        return masterEnUsKeys;
    }

    // Extract sorted list of operational keys, omitting group comments like "_Litefin Specific Keys"
    const en = getMasterEnUsLocale();
    masterEnUsKeys = Object.keys(en).filter(k => !k.startsWith('_'));
    return masterEnUsKeys;
}

// ============================================================================
/**
 * Factory function to generate Webpack plugins required for different tiers.
 * Supports customizing the application icon source.
 *
 * @param {string} tier - The build tier ('modern' or 'legacy')
 * @param {object} [options] - Additional options to configure build output
 * @param {string} [options.iconSrc] - The source path of the app icon (defaults to 'assets/icon.png')
 */
function getPlugins(tier, options = {}) {
    // Determine the build tier, falling back to 'modern' by default
    const buildTier = tier || 'modern';

    // Retrieve the source icon path, defaulting to standard icon.png in assets/
    const iconSrc = options.iconSrc || 'assets/icon.png';

    // Build files pattern list for CopyWebpackPlugin
    const patterns = [
        // Copy Tizen config file to root of build directory
        { from: 'config.xml', to: 'config.xml' },
        // Copy WebOS app info to root of build directory
        { from: 'appinfo.json', to: 'appinfo.json' },
        // Copy selected icon file as assets/icon.png to built directory
        { from: iconSrc, to: 'assets/icon.png' },
        // Copy WebOS icons from root assets/ to build assets/
        { from: 'assets/icon-80.png', to: 'assets/icon-80.png' },
        { from: 'assets/icon-130.png', to: 'assets/icon-130.png' },
        // Copy general assets (images, resources, etc.)
        { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
        /*
         * Canonical translation keys dictionary:
         * Emits _keys.json containing only the ordered keys array.
         * Shipped once so external tools or standalone XHR fallbacks can reference the index schema.
         */
        {
            from: 'src/locales/en-us.json',
            to: 'locales/_keys.json',
            transform() {
                // Emit single-line compact array of keys
                return JSON.stringify(getMasterEnUsKeys());
            }
        },
        /*
         * Translation localization dictionaries (src/locales/*.json):
         * Compiles human-readable key-value dictionaries into ultra-compact keyless
         * value arrays. Cuts locale payload sizes by over 50% across all 26 languages
         * (~1.3 MB uncompressed savings) while maintaining standard readable JSON
         * in source control for translators.
         *
         * Non-English locales omit strings identical to en-us.json (as empty strings),
         * allowing i18n.js to transparently resolve them from the fallback dictionary.
         */
        {
            from: 'src/locales',
            to: 'locales',
            transform(content, absoluteFrom) {
                // Ensure we only process locale JSON files
                if (typeof absoluteFrom === 'string' && absoluteFrom.endsWith('.json')) {
                    try {
                        // Parse raw JSON buffer to a JavaScript object
                        const parsed = JSON.parse(content.toString('utf8'));
                        const masterEnglish = getMasterEnUsLocale();
                        const keys = getMasterEnUsKeys();
                        const isPrimaryEnglish = absoluteFrom.endsWith('en-us.json');

                        // Map each canonical key to its corresponding translated string value
                        const values = new Array(keys.length);
                        for (let i = 0; i < keys.length; i++) {
                            const k = keys[i];
                            const val = parsed[k];

                            // For non-English locales, omit values identical to English fallback
                            if (!isPrimaryEnglish && val === masterEnglish[k]) {
                                values[i] = '';
                            } else {
                                values[i] = (val !== undefined && val !== null) ? val : '';
                            }
                        }

                        // Emit single-line, fully minified value array payload
                        return JSON.stringify(values);
                    } catch (err) {
                        // In case of syntax or parse issues, fallback gracefully to raw content
                        return content;
                    }
                }

                // Non-JSON assets (e.g. languages.js) pass through unmutated
                return content;
            }
        },
        /*
         * libpgs web worker ships unminified (95% comments) and is a Worker-script
         * payload outside webpack's graph -> stripped via transform below.
         */
        /*
         * WebOS SDK: required for window.webOS and window.webOS.service to exist.
         * Without this script the Luna service check in ApiClient.js
         * will silently fall through to the HTTP scan on WebOS.
         * The file is a no-op on non-WebOS platforms so safe to include in all builds.
         */
        { from: 'node_modules/webostvjs/webOSTV.js', to: 'js/webOSTV.js' },
        // Copy early boot diagnostic console logger for all builds
        { from: 'src/logger.js', to: 'js/logger.js' },
        // Copy early DOM and ES2015 polyfills script for all builds
        { from: 'src/early-polyfills.js', to: 'js/early-polyfills.js' },
        // Copy libpgs web worker file
        { from: 'node_modules/libpgs/dist/libpgs.worker.js', to: 'js/libpgs.worker.js' }
    ];

    // Include libass-wasm worker assets for modern, legacy, desktop, and web build tiers.
    // Legacy tier includes the WASM workers for newer devices running legacy builds,
    // with runtime WebAssembly feature gating falling back to libjass on unsupported hardware.
    if (buildTier === 'modern' || buildTier === 'legacy' || buildTier === 'desktop' || buildTier === 'web') {
        patterns.push(
            {
                from: 'node_modules/@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.js',
                to: 'js/subtitles-octopus-worker.js'
            },
            {
                from: 'node_modules/@jellyfin/libass-wasm/dist/js/subtitles-octopus-worker.wasm',
                to: 'js/subtitles-octopus-worker.wasm'
            },
            {
                from: 'node_modules/@jellyfin/libass-wasm/dist/js/default.woff2',
                to: 'assets/fonts/default.woff2',
                noErrorOnMissing: true
            }
        );
    }

    // Copy movi-player WASM binary for desktop and web build tiers.
    // Strictly excluded from TV builds to prevent ballooning package size.
    if (buildTier === 'desktop' || buildTier === 'web') {
        patterns.push({
            from: 'node_modules/movi-player/dist/movi.wasm',
            to: 'wasm/movi.wasm',
            noErrorOnMissing: true
        });
    }

    const pluginList = [
        new MiniCssExtractPlugin({
            filename: 'css/[name].css'
        }),
        new HtmlWebpackPlugin({
            filename: 'index.html',
            template: 'src/index.html',
            inject: 'body',
            scriptLoading: 'blocking'
        }),
        new CopyWebpackPlugin({ patterns }),
        new webpack.DefinePlugin({
            __APP_VERSION__: JSON.stringify(require('./package.json').version),
            __I18N_KEYS__: JSON.stringify(getMasterEnUsKeys())
        })
    ];

    // For TV build tiers (non-desktop and non-web), replace MoviVideoPlayer with a lightweight stub
    // to guarantee movi-player and its WebAssembly/demuxing code are excluded from TV bundles.
    if (buildTier !== 'desktop' && buildTier !== 'web') {
        pluginList.push(
            new webpack.NormalModuleReplacementPlugin(
                /src[\\/]player[\\/]core[\\/]MoviVideoPlayer\.js$/,
                path.resolve(__dirname, 'src/player/core/MoviVideoPlayer.stub.js')
            ),
            /*
             * =======================================================================
             * TV Bundle CSS: drop mobile-only stylesheets
             * =======================================================================
             * Tizen/webOS TV tiers never mount MobileNav (App.js suppresses it for
             * platformInfo.isTv) and LayoutManager strips the mobile attributes
             * (html[data-litefin-portrait|scaled|touch]) on TV hardware, so
             * android-mobile.css and mobile-nav.css can never match on a TV yet
             * cost ~180KB of raw stylesheet text inside the inline CSS bundle.
             *
             * ScrollController's data-horizontal-scroll compositing rules apply on
             * TVs too - those live in scroll-compositing.css and are included in
             * BOTH bundle.css and bundle.tv.css, so no behavior is lost here.
             * =======================================================================
             */
            new webpack.NormalModuleReplacementPlugin(
                /src[\\/]styles[\\/]bundle\.css$/,
                path.resolve(__dirname, 'src/styles/bundle.tv.css')
            )
        );
    }

    return pluginList;
}

// ============================================================================
// TV Resolve Aliases
// ============================================================================
// Base resolve aliases for television build targets (Samsung Tizen / LG webOS).
// Substitutes MoviVideoPlayer with a lightweight stub and aliases movi-player packages to false,
// ensuring television packages remain lean and free of unnecessary WebAssembly / demuxing assets.
const tvResolveAliases = {
    [path.resolve(__dirname, 'src/player/core/MoviVideoPlayer.js')]: path.resolve(__dirname, 'src/player/core/MoviVideoPlayer.stub.js'),
    'movi-player': false,
    'movi-player/element': false,
    'movi-player/element/slim': false
};

// ============================================================================
// Modern build - Tizen 6.5+ / WebOS 22+ (No transpilation, pure ES6+, no source maps)
// Formerly referred to as the "ES6" build tier. Renamed to "Modern" to ensure
// non-technical users can easily distinguish this as the appropriate package
// for newer/modern television models.
// ============================================================================
const modernConfig = {
    // Unique identifier for this configuration used in the CLI build command
    name: 'modern',
    // Output production bundle optimization
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    // No source maps — keeps the bundle lean for production deployment
    entry: './src/index.js',

    output: {
        // Output directly into the user-friendly modern folder within dist
        path: path.resolve(__dirname, 'dist/modern'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases
        }
    },

    module: {
        rules: [
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Modern tier: WASM-capable (ES6+ / no transpilation needed)
    plugins: getPlugins('modern')
};

// ============================================================================
// Debug build - Tizen 6.5+ (ES6, full source maps for sdb/remote DevTools)
// Use this when you need readable stack traces while debugging on-device.
// Never ship this build — source maps roughly double the output size.
// ============================================================================
const debugConfig = {
    name: 'debug',
    mode: 'production',
    performance: { hints: false },
    devtool: 'source-map', // Full source maps for on-TV debugging via sdb
    entry: './src/index.js',

    output: {
        path: path.resolve(__dirname, 'dist/debug'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases
        }
    },

    module: {
        rules: [
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Modern tier: same WASM-capable worker set as es6, just with source maps
    plugins: getPlugins('modern')
};

// ============================================================================
// Normal build - Tizen 5.0+ (Chromium 63)
// ============================================================================
const normalConfig = {
    name: 'normal',
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    // No source maps — production build
    entry: ['./src/utils/DomPolyfills.js', './src/utils/AssJsPolyfills.js', './src/index.js'],

    output: {
        path: path.resolve(__dirname, 'dist/normal'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases
        }
    },

    module: {
        rules: [
            {
                test: /\.m?js$/,
                exclude: /node_modules[\\/](?!(screenfull|css-vars-ponyfill|libpgs|assjs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        compact: true,
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: { chrome: '63' },
                                    useBuiltIns: 'usage',
                                    corejs: 3
                                }
                            ]
                        ]
                    }
                }
            },
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Modern tier: Chromium 63 supports WASM and OffscreenCanvas
    plugins: getPlugins('modern')
};

// ============================================================================
// Legacy build - Tizen 3.0+ / webOS 4.0+ (Chromium 38, true ES5)
// ============================================================================
const legacyConfig = {
    name: 'legacy',
    target: ['web', 'es5'],
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    entry: [
        'whatwg-fetch',
        'url-search-params-polyfill',
        './src/utils/DomPolyfills.js',
        './src/utils/AssJsPolyfills.js',
        './src/index.js'
    ],

    output: {
        path: path.resolve(__dirname, 'dist/legacy'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases,
            // Use the pre-transpiled ES5 build to avoid Babel OOM during legacy transpilation
            'hls.js': 'hls.js/dist/hls.min.js'
        }
    },

    module: {
        rules: [
            {
                test: /\.m?js$/,
                exclude: /node_modules[\\/](?!(screenfull|css-vars-ponyfill|libpgs|assjs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        compact: true,
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: { chrome: '38' },
                                    useBuiltIns: 'usage',
                                    corejs: 3
                                }
                            ]
                        ]
                    }
                }
            },
            /*
             * =======================================================================
             * Consolidated Singleton CSS Inlining for Legacy Smart TVs (file://)
             * =======================================================================
             * Legacy TV platforms (webOS 3.x and Tizen 3.0, running Chromium 38-47)
             * lack native CSS custom property ('var()') support.
             *
             * When packaged into local TV applications (webOS IPK and Tizen WGT),
             * the app executes under the file:// protocol. MiniCssExtractPlugin
             * outputs discrete external CSS files linked via <link rel="stylesheet">,
             * which fail or hang on file:// XHR requests.
             *
             * Furthermore, standard 'style-loader' injects dozens of individual
             * <style> tags (one per imported CSS module), forcing the browser to
             * rebuild its internal stylesheet rule tree 47+ times and flooding the DOM.
             *
             * By configuring 'injectType: singletonStyleTag', all bundled CSS is
             * concatenated directly into ONE single <style id="litefin-bundled-styles">
             * element. This eliminates multiple DOM reflows, reduces memory footprint,
             * and allows our CSS variable transformer to process the entire stylesheet
             * in a single pass in under 20ms.
             * =======================================================================
             */
            /*
             * css-minify-loader runs FIRST (use array executes bottom-up) on the
             * raw stylesheet text, before css-loader wraps it in a JS string.
             * style-loader injects the resulting string verbatim and Terser
             * cannot touch it, so without this loader every comment and byte of
             * whitespace in the .css sources ships inside main.js.
             */
            {
                test: /\.css$/,
                use: [
                    {
                        loader: 'style-loader',
                        options: {
                            injectType: 'singletonStyleTag',
                            attributes: {
                                id: 'litefin-bundled-styles'
                            }
                        }
                    },
                    'css-loader',
                    path.resolve(__dirname, 'css-minify-loader.cjs')
                ]
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Legacy tier: Ships full LibassWasmRenderer and WASM workers with runtime feature detection.
    plugins: getPlugins('legacy')
};

// ============================================================================
// Ultra-Legacy build - Tizen 2.3+ / WebOS 1.0+ (Chromium 32, heavy polyfills)
// ============================================================================
const ultraLegacyConfig = {
    name: 'ultra-legacy',
    target: ['web', 'es5'],
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    entry: [
        /*
         * POLYFILL LOAD ORDER — CRITICAL for Chrome 32 / Tizen 2.x:
         * These must come first so Symbol, Promise, Map, and Set are
         * already on the global scope before the regenerator-runtime
         * chunk executes. If core-js is split into a lazy chunk that
         * loads AFTER regenerator-runtime, you get:
         *   "TypeError: undefined is not a function"
         * because regenerator-runtime internally calls Symbol() and
         * iterates with for-of (which needs Symbol.iterator).
         */
        'core-js/es/symbol', // Symbol — used by regenerator-runtime
        'core-js/es/promise', // Promise — async/await transpilation target
        'core-js/es/map', // Map — used by several core-js internals
        'core-js/es/set', // Set — used by several core-js internals
        'core-js/es/array/from', // Array.from — spread/iterator polyfill
        'whatwg-fetch', // fetch() for Tizen 2.x / WebOS 1.x
        'url-search-params-polyfill', // URLSearchParams for Chrome 32
        './src/utils/DomPolyfills.js',
        './src/utils/AssJsPolyfills.js',
        './src/index.js'
    ],

    output: {
        path: path.resolve(__dirname, 'dist/ultra-legacy'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases,
            // Use the pre-transpiled ES5 build to avoid Babel OOM during legacy transpilation
            'hls.js': 'hls.js/dist/hls.min.js'
        }
    },

    module: {
        rules: [
            {
                test: /\.m?js$/,
                exclude: /node_modules[\\/](?!(screenfull|css-vars-ponyfill|libpgs|assjs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        compact: true,
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    /*
                                     * =======================================================================
                                     * Target Environment Configuration
                                     * =======================================================================
                                     * Downgraded target to Chrome 26 to support ancient webOS 1.0 and 2.0
                                     * platforms which run older Chromium runtimes. This forces Babel to
                                     * transpile down further and include matching polyfills.
                                     */
                                    targets: { chrome: '26' },
                                    useBuiltIns: 'usage',
                                    corejs: 3
                                }
                            ]
                        ]
                    }
                }
            },
            /*
             * =======================================================================
             * Consolidated Singleton CSS Inlining for Ultra-Legacy Runtimes
             * =======================================================================
             * Ultra-legacy apps (webOS 1.x-2.x, Tizen 2.x, Chrome 26-32) run from
             * local file:// installs with strict CORS restrictions on external CSS.
             *
             * Standard style-loader creates dozens of distinct <style> tags, causing
             * significant memory overhead and repeated stylesheet re-parses on 512MB
             * memory TV hardware.
             *
             * Using 'injectType: singletonStyleTag' bundles all CSS into a single
             * <style id="litefin-bundled-styles"> element, eliminating DOM fragmentation
             * and enabling near-instantaneous CSS custom property resolution.
             * =======================================================================
             * css-minify-loader runs FIRST (use array executes bottom-up) on the raw
             * stylesheet text, before css-loader wraps it in a JS string. The injected
             * style string bypasses Terser entirely, so raw .css comments and
             * whitespace would otherwise ship verbatim inside js/main.js.
             * =======================================================================
             */
            {
                test: /\.css$/,
                use: [
                    {
                        loader: 'style-loader',
                        options: {
                            injectType: 'singletonStyleTag',
                            attributes: {
                                id: 'litefin-bundled-styles'
                            }
                        }
                    },
                    'css-loader',
                    path.resolve(__dirname, 'css-minify-loader.cjs')
                ]
            },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    plugins: (function () {
        /*
         * Ultra-legacy gets its own extended plugin list:
         *   1. A separate HTML template (index.ultra-legacy.html) that includes the
         *      logger.js <script> tag before any other scripts.
         *   2. An extra CopyWebpackPlugin entry to ship logger.js to dist.
         *   3. NormalModuleReplacementPlugin to swap LibassWasmRenderer with a stub
         *      so the WASM dependencies are kept out of the bundle.
         *
         * The logger patches console.* BEFORE the webpack bundle executes,
         * which is the only effective way to intercept the boot crash on Chrome 32/38
         * (Tizen 2.x / WebOS 3.x). All other build tiers do not need or include it.
         */
        var base = getPlugins('ultra-legacy');

        /* Swap HtmlWebpackPlugin for the ultra-legacy-specific template */
        base = base.map(function (p) {
            if (p.constructor && p.constructor.name === 'HtmlWebpackPlugin') {
                return new HtmlWebpackPlugin({
                    filename: 'index.html',
                    template: 'src/index.ultra-legacy.html',
                    inject: 'body',
                    scriptLoading: 'blocking'
                });
            }
            return p;
        });

        /*
         * Push logger.js into the CopyPlugin pattern list.
         * CopyPlugin exposes its patterns array directly.
         */
        base.forEach(function (p) {
            if (p.patterns) {
                p.patterns.push({ from: 'src/logger.js', to: 'js/logger.js' });
            }
        });

        base.push(
            new webpack.NormalModuleReplacementPlugin(
                /src[\/\\]player[\/\\]core[\/\\]LibassWasmRenderer\.js$/,
                path.resolve(__dirname, 'src/player/core/LibassWasmRenderer.legacy.js')
            ),
            new webpack.NormalModuleReplacementPlugin(
                /src[\/\\]player[\/\\]core[\/\\]ASSJSRenderer\.js$/,
                path.resolve(__dirname, 'src/player/core/ASSJSRenderer.legacy.js')
            )
        );

        return base;
    })()
};

// ============================================================================
// Normal Oblong build - Tizen 5.0+ (Chromium 63) with oblong icon
// ============================================================================
/**
 * Configuration for the "Normal Oblong" build target.
 * Matches the "normal" configuration but replaces the default icon with icon_oblong.png.
 */
const normalOblongConfig = {
    // Unique identifier for this configuration
    name: 'normal-oblong',
    // Run in production mode for optimization
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    // The main app entry point
    entry: ['./src/utils/DomPolyfills.js', './src/utils/AssJsPolyfills.js', './src/index.js'],

    output: {
        // Output to the specific normal-oblong folder in dist
        path: path.resolve(__dirname, 'dist/normal-oblong'),
        // Keep standard JavaScript subdirectory layout
        filename: 'js/[name].js',
        // Clean output directory before building
        clean: true
    },

    optimization: {
        // TV boot bundle splitting: a multi-MB single main.js is cut into
        // ≤~800 KB initial chunks (V8 compile-zone friendly) by the shared
        // policy in getTvInitialSplitChunks(). Async page/player chunks stay
        // fully self-contained, as before.
        splitChunks: getTvInitialSplitChunks(),
        runtimeChunk: false,
        minimizer: getMinimizers()
    },

    resolve: {
        alias: {
            ...tvResolveAliases
        }
    },

    module: {
        rules: [
            {
                // Transpile JS using Babel for Chromium 63
                test: /\.m?js$/,
                exclude: /node_modules[\\/](?!(screenfull|css-vars-ponyfill|libpgs|assjs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        compact: true,
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: { chrome: '63' },
                                    useBuiltIns: 'usage',
                                    corejs: 3
                                }
                            ]
                        ]
                    }
                }
            },
            // Load and package CSS stylesheets
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            // Handle font assets
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            // Prevent loading WASM files on output
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Load plugins with the modern tier configuration, selecting icon_oblong.png from assets/
    plugins: getPlugins('modern', { iconSrc: 'assets/icon_oblong.png' })
};

// ============================================================================
// Desktop build - Pake / Native Desktop Wrapper (Windows, macOS, Linux)
// ============================================================================
// Pure ES6+ environment with modern Chromium/WebKit webview engine.
// Bundles the full MoviVideoPlayer backend and movi.wasm WebAssembly binary
// for hardware-accelerated playback and native MKV/WebCodecs demuxing.
// ============================================================================
const desktopConfig = {
    // Unique identifier for this configuration
    name: 'desktop',
    // Output production bundle optimization
    mode: 'production',
    performance: {
        maxAssetSize: 15000000,
        maxEntrypointSize: 15000000,
        hints: false
    },
    // No source maps — keeps the bundle lean for desktop releases
    entry: './src/index.js',

    output: {
        // Output directly into the dedicated desktop directory within dist
        path: path.resolve(__dirname, 'dist/desktop'),
        filename: 'js/[name].js',
        clean: true
    },

    // Development server configuration for testing the desktop tier in browsers
    devServer: {
        static: {
            directory: path.resolve(__dirname, 'dist/desktop')
        },
        compress: true,
        port: 8080,
        hot: true
    },

    optimization: {
        splitChunks: { chunks: 'all', maxSize: 250000 },
        minimizer: getMinimizers()
    },

    module: {
        rules: [
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Desktop tier: Includes libass-wasm and movi.wasm, without stubbing MoviVideoPlayer
    plugins: getPlugins('desktop')
};

// ============================================================================
// Web build - Standalone Jellyfin Server Plugin Web Client
// ============================================================================
// Modern ES2020+ bundle served directly by the Litefin Jellyfin plugin.
// Includes the full MoviVideoPlayer engine and movi.wasm for local demuxing,
// hardware decoding, and MKV playback in modern web browsers.
// Assets are built with relative publicPath so they resolve seamlessly under
// subpaths like /litefin/ or reverse-proxied /jellyfin/litefin/.
// ============================================================================
const webConfig = {
    // Unique identifier for web configuration target
    name: 'web',
    // Output production bundle optimization
    mode: 'production',
    performance: {
        maxAssetSize: 15000000,
        maxEntrypointSize: 15000000,
        hints: false
    },
    // Application entrypoint
    entry: './src/index.js',

    output: {
        // Output into dedicated dist/web folder consumed by plugin packaging
        path: path.resolve(__dirname, 'dist/web'),
        // Output JavaScript bundles into the js/ subfolder
        filename: 'js/[name].js',
        // Omitting an explicit publicPath allows Webpack 5's automatic ('auto') relative public path
        // mechanism to calculate correct relative traversal paths (e.g. '../assets/fonts/...')
        // for assets declared in CSS stylesheets extracted to the css/ directory.
        // Specifying a literal './' here incorrectly forces CSS asset URLs to './assets/fonts/...',
        // causing browsers loading /litefin/css/main.css to 404 on /litefin/css/assets/fonts/....
        clean: true
    },

    // Development server configuration for browser testing
    devServer: {
        static: {
            directory: path.resolve(__dirname, 'dist/web')
        },
        compress: true,
        port: 8081,
        hot: true
    },

    optimization: {
        // Chunk splitting for efficient browser caching
        splitChunks: { chunks: 'all', maxSize: 250000 },
        minimizer: getMinimizers()
    },

    module: {
        rules: [
            // Standard stylesheet processing
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            // Font asset packaging
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            },
            // WebAssembly asset handling
            {
                test: /\.wasm$/,
                type: 'asset/resource',
                generator: {
                    emit: false
                }
            }
        ]
    },

    // Web tier: Bundles libass-wasm and movi.wasm without stubbing MoviVideoPlayer
    plugins: getPlugins('web')
};

// Export all configs. Run a specific one with --config-name <name>.
// e.g. npx webpack --config webpack.config.cjs --config-name web
module.exports = [
    modernConfig,
    debugConfig,
    normalConfig,
    legacyConfig,
    ultraLegacyConfig,
    normalOblongConfig,
    desktopConfig,
    webConfig
];

