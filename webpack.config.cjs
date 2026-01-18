/**
 * ============================================================================
 * FastFin Tizen - Webpack Configuration
 * ============================================================================
 * Dual-build system supporting:
 * - Modern build (Tizen 4.0+): Native ES6, no transpilation
 * - Legacy build (Tizen 3.0): Transpiled to ES5 via Babel
 * ============================================================================
 */

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// ============================================================================
// Common configuration shared between builds
// ============================================================================
const commonConfig = {
    entry: './src/index.js',

    optimization: {
        splitChunks: {
            chunks: 'all',
            maxSize: 100000  // Keep chunks small for fast loading on TVs
        },
        minimizer: [
            '...',  // Keep default minimizers (terser)
            new CssMinimizerPlugin()
        ]
    },

    plugins: [
        new HtmlWebpackPlugin({
            template: './src/index.html',
            filename: 'index.html',
            inject: 'body'
        }),
        new MiniCssExtractPlugin({
            filename: 'css/[name].css'
        })
    ],

    module: {
        rules: [
            // CSS handling
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader']
            }
        ]
    }
};

// ============================================================================
// Modern build - Tizen 4.0+ (Native ES6)
// ============================================================================
const modernConfig = {
    ...commonConfig,
    name: 'modern',
    mode: 'production',

    output: {
        path: path.resolve(__dirname, 'dist/tizen4'),
        filename: 'js/[name].js',
        clean: true
    },

    plugins: [
        new HtmlWebpackPlugin({
            template: './src/index.html',
            filename: 'index.html',
            inject: 'body'
        }),
        new MiniCssExtractPlugin({
            filename: 'css/[name].css'
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'src/config.xml', to: 'config.xml' },
                { from: 'src/assets', to: 'assets', noErrorOnMissing: true }
            ]
        })
    ]
};

// ============================================================================
// Legacy build - Tizen 3.0 (Transpiled ES5)
// ============================================================================
const legacyConfig = {
    ...commonConfig,
    name: 'legacy',
    mode: 'production',

    output: {
        path: path.resolve(__dirname, 'dist/tizen3'),
        filename: 'js/[name].js',
        clean: true
    },

    module: {
        rules: [
            // Babel transpilation for ES5
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            ['@babel/preset-env', {
                                targets: { chrome: '47' },  // Chromium M47 = Tizen 3.0
                                useBuiltIns: 'usage',
                                corejs: 3
                            }]
                        ]
                    }
                }
            },
            // CSS handling
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, 'css-loader']
            }
        ]
    },

    plugins: [
        new HtmlWebpackPlugin({
            template: './src/index.html',
            filename: 'index.html',
            inject: 'body'
        }),
        new MiniCssExtractPlugin({
            filename: 'css/[name].css'
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: 'src/config.xml', to: 'config.xml' },
                { from: 'src/assets', to: 'assets', noErrorOnMissing: true }
            ]
        })
    ]
};

module.exports = [modernConfig, legacyConfig];
