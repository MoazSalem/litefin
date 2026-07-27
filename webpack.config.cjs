/**
 * ============================================================================
 * Litefin Tizen - Webpack Configuration
 * ============================================================================
 * Triple-build system supporting:
 * - Native build (Tizen 6.0+): No transpilation, pure ES6+
 * - Modern build (Tizen 5.0+): Transpiled for Chromium 69
 * - Legacy build (Tizen 3.0+): Transpiled for Chromium 47 (ES5)
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

// ============================================================================
// Shared plugins factory
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
        // Copy translation localization files
        { from: 'src/locales', to: 'locales' },
        // Copy libpgs web worker file
        { from: 'node_modules/libpgs/dist/libpgs.worker.js', to: 'js/libpgs.worker.js' },
        /*
         * WebOS SDK: required for window.webOS and window.webOS.service to exist.
         * Without this script the Luna service check in ApiClient.js
         * will silently fall through to the HTTP scan on WebOS.
         * The file is a no-op on non-WebOS platforms so safe to include in all builds.
         */
        { from: 'node_modules/webostvjs/webOSTV.js', to: 'js/webOSTV.js' }
    ];

    if (buildTier === 'modern') {
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

    return [
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
            __APP_VERSION__: JSON.stringify(require('./package.json').version)
        })
    ];
}

// ============================================================================
// Modern build - Tizen 6.5+ / WebOS 6.0+ (No transpilation, pure ES6+, no source maps)
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
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
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
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
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
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
    },

    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules[\\/](?!(screenfull|assjs)[\\/])/,
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
// Legacy build - Tizen 3.0+ / webOS 4.0+ (Chromium 47, ES5)
// ============================================================================
const legacyConfig = {
    name: 'legacy',
    mode: 'production',
    performance: {
        maxAssetSize: 4000000,
        maxEntrypointSize: 4000000,
        hints: 'warning'
    },
    entry: [
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
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
    },

    resolve: {
        alias: {
            // Use the pre-transpiled ES5 build to avoid Babel OOM during legacy transpilation
            'hls.js': 'hls.js/dist/hls.min.js'
        }
    },

    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules[\\/](?!(screenfull|assjs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        compact: true,
                        presets: [
                            [
                                '@babel/preset-env',
                                {
                                    targets: { chrome: '47' },
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

    // Legacy tier: LibassWasmRenderer is stubbed — no WASM workers are shipped.
    plugins: [
        ...getPlugins('legacy'),
        new webpack.NormalModuleReplacementPlugin(
            /src[\/\\]player[\/\\]core[\/\\]LibassWasmRenderer\.js$/,
            path.resolve(__dirname, 'src/player/core/LibassWasmRenderer.legacy.js')
        )
    ]
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
        './src/index.js'
    ],

    output: {
        path: path.resolve(__dirname, 'dist/ultra-legacy'),
        filename: 'js/[name].js',
        clean: true
    },

    optimization: {
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
    },

    resolve: {
        alias: {
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
                                    targets: { chrome: '32' },
                                    useBuiltIns: 'usage',
                                    corejs: 3
                                }
                            ]
                        ]
                    }
                }
            },
            /*
             * style-loader is used here (not MiniCssExtractPlugin) because:
             * Ultra-legacy apps run off the file:// protocol (local install).
             * MiniCssExtractPlugin creates a separate main.css file that the
             * css-vars-ponyfill tries to fetch via XMLHttpRequest, which is
             * blocked by strict CORS rules on file:// in these ancient runtimes.
             * style-loader bundles the CSS directly into the JS chunks as
             * inline <style> tags — no network request, no CORS problem.
             */
            { test: /\.css$/, use: ['style-loader', 'css-loader'] },
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
         *      backup-logger <script> tag before any other scripts.
         *   2. An extra CopyWebpackPlugin entry to ship backup-logger.js to dist.
         *   3. NormalModuleReplacementPlugin to swap LibassWasmRenderer with a stub
         *      so the WASM dependencies are kept out of the bundle.
         *
         * The backup logger patches console.* BEFORE the webpack bundle executes,
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
         * Push backup-logger.js into the CopyPlugin pattern list.
         * CopyPlugin exposes its patterns array directly.
         */
        base.forEach(function (p) {
            if (p.patterns) {
                p.patterns.push({ from: 'src/backup-logger.js', to: 'js/backup-logger.js' });
            }
        });

        base.push(
            new webpack.NormalModuleReplacementPlugin(
                /src[\/\\]player[\/\\]core[\/\\]LibassWasmRenderer\.js$/,
                path.resolve(__dirname, 'src/player/core/LibassWasmRenderer.legacy.js')
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
        // Shared optimization settings
        splitChunks: { chunks: 'all', maxSize: 100000 },
        minimizer: ['...', new CssMinimizerPlugin()]
    },

    module: {
        rules: [
            {
                // Transpile JS using Babel for Chromium 63
                test: /\.js$/,
                exclude: /node_modules[\\/](?!(screenfull|assjs)[\\/])/,
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

// Export all configs. Run a specific one with --config-name <name>.
// e.g. npx webpack --config webpack.config.cjs --config-name debug
module.exports = [modernConfig, debugConfig, normalConfig, legacyConfig, ultraLegacyConfig, normalOblongConfig];
