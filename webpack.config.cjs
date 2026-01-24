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

const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// ============================================================================
// Shared plugins factory
// ============================================================================
function getPlugins() {
    return [
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
                { from: 'icon.png', to: 'icon.png' },
                { from: 'src/assets', to: 'assets', noErrorOnMissing: true }
            ]
        })
    ];
}

// ============================================================================
// ES6 build - Tizen 6.0+ (No transpilation, pure ES6+)
// ============================================================================
const es6Config = {
    name: 'es6',
    mode: 'production',
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
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
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
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [['@babel/preset-env', {
                            targets: { chrome: '69' },
                            useBuiltIns: 'usage',
                            corejs: 3
                        }]]
                    }
                }
            },
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
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
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [['@babel/preset-env', {
                            targets: { chrome: '47' },
                            useBuiltIns: 'usage',
                            corejs: 3
                        }]]
                    }
                }
            },
            { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] }
        ]
    },

    plugins: getPlugins()
};

module.exports = [es6Config, normalConfig, legacyConfig];

