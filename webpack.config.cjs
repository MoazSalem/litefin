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
                { from: 'icon.png', to: 'icon.png' },
                { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
                { from: 'node_modules/libpgs/dist/libpgs.worker.js', to: 'libpgs.worker.js' }
            ]
        }),
        new webpack.DefinePlugin({
            __APP_VERSION__: JSON.stringify(require('./package.json').version)
        })
    ];
}

// ============================================================================
// ES6 build - Tizen 6.0+ (No transpilation, pure ES6+)
// ============================================================================
const es6Config = {
    name: 'es6',
    mode: 'production',
    devtool: 'source-map', // Enable source maps for debugging
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
// Normal build - Tizen 5.0+ (Chromium 69)
// ============================================================================
const normalConfig = {
    name: 'normal',
    mode: 'production',
    devtool: 'source-map', // Enable source maps
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
                                    targets: { chrome: '69' },
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
// Legacy build - Tizen 3.0+ (Chromium 47, ES5)
// ============================================================================
const legacyConfig = {
    name: 'legacy',
    mode: 'production',
    entry: './src/index.js',

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

module.exports = [es6Config, normalConfig, legacyConfig];
