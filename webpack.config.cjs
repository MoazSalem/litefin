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
function getPlugins() {
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
        new CopyWebpackPlugin({
            patterns: [
                { from: 'config.xml', to: 'config.xml' },
                { from: 'appinfo.json', to: 'appinfo.json' },
                { from: 'icon.png', to: 'icon.png' },
                { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
                { from: 'src/locales', to: 'locales' },
                { from: 'node_modules/libpgs/dist/libpgs.worker.js', to: 'js/libpgs.worker.js' },
                /*
                 * WebOS SDK: required for window.webOS and window.webOS.service to exist.
                 * Without this script the Luna service check in ApiClient.js
                 * will silently fall through to the HTTP scan on WebOS.
                 * The file is a no-op on non-WebOS platforms so safe to include in all builds.
                 */
                { from: 'node_modules/webostvjs/webOSTV.js', to: 'js/webOSTV.js' }
            ]
        }),
        new webpack.DefinePlugin({
            __APP_VERSION__: JSON.stringify(require('./package.json').version)
        })
    ];
}

// ============================================================================
// ES6 build - Tizen 6.5+ / WebOS 6.0+ (No transpilation, pure ES6+, no source maps)
// ============================================================================
const es6Config = {
    name: 'es6',
    mode: 'production',
    // No source maps — keeps the bundle lean for production deployment
    entry: './src/index.js',

    output: {
        path: path.resolve(__dirname, 'dist/es6'),
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
            }
        ]
    },

    plugins: getPlugins()
};

// ============================================================================
// Debug build - Tizen 6.5+ (ES6, full source maps for sdb/remote DevTools)
// Use this when you need readable stack traces while debugging on-device.
// Never ship this build — source maps roughly double the output size.
// ============================================================================
const debugConfig = {
    name: 'debug',
    mode: 'production',
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
            }
        ]
    },

    plugins: getPlugins()
};

// ============================================================================
// Normal build - Tizen 5.0+ (Chromium 63)
// ============================================================================
const normalConfig = {
    name: 'normal',
    mode: 'production',
    // No source maps — production build
    entry: './src/index.js',

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
                exclude: /node_modules[\\/](?!(screenfull)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
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
            }
        ]
    },

    plugins: getPlugins()
};

// ============================================================================
// Legacy build - Tizen 3.0+ / webOS 4.0+ (Chromium 47, ES5)
// ============================================================================
const legacyConfig = {
    name: 'legacy',
    mode: 'production',
    entry: ['url-search-params-polyfill', './src/index.js'],

    output: {
        path: path.resolve(__dirname, 'dist/legacy'),
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
                exclude: /node_modules[\\/](?!(screenfull)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
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
            }
        ]
    },

    plugins: getPlugins()
};

// ============================================================================
// Ultra-Legacy build - Tizen 2.3+ / WebOS 1.0+ (Chromium 32, heavy polyfills)
// ============================================================================
const ultraLegacyConfig = {
    name: 'ultra-legacy',
    target: ['web', 'es5'],
    mode: 'production',
    entry: ['whatwg-fetch', 'url-search-params-polyfill', './src/index.js'],

    output: {
        path: path.resolve(__dirname, 'dist/ultra-legacy'),
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
                test: /\.m?js$/,
                exclude: /node_modules[\\/](?!(screenfull|css-vars-ponyfill|hls\.js|libpgs)[\\/])/,
                use: {
                    loader: 'babel-loader',
                    options: {
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
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
            {
                test: /\.(woff|woff2|eot|ttf|otf)$/i,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[name][ext]'
                }
            }
        ]
    },

    plugins: getPlugins()
};

// Export all configs. Run a specific one with --config-name <name>.
// e.g. npx webpack --config webpack.config.cjs --config-name debug
module.exports = [es6Config, debugConfig, normalConfig, legacyConfig, ultraLegacyConfig];
