const path = require('path');
const webpack = require('webpack');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const CssMinimizerPlugin = require('css-minimizer-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

    return {
        entry: './src/index.js',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: isProduction ? 'jellyfin-player.min.js' : 'jellyfin-player.js',
            library: {
                name: 'JellyfinPlayer',
                type: 'umd',
                export: 'default',
            },
            globalObject: 'this',
            clean: true,
        },
        module: {
            rules: [
                {
                    test: /\.js$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'babel-loader',
                        options: {
                            presets: ['@babel/preset-env'],
                        },
                    },
                },
                {
                    test: /\.s[ac]ss$/i,
                    use: [
                        MiniCssExtractPlugin.loader,
                        'css-loader',
                        'sass-loader',
                    ],
                },
            ],
        },
        plugins: [
            // Define __DEBUG__ constant based on build mode
            new webpack.DefinePlugin({
                __DEBUG__: JSON.stringify(!isProduction),
            }),
            new MiniCssExtractPlugin({
                filename: 'jellyfin-player.css',
            }),
            new HtmlWebpackPlugin({
                template: './html/player.template.html',
                filename: 'player.html',
                inject: 'head',
            }),
            new HtmlWebpackPlugin({
                template: './html/settings.template.html',
                filename: 'settings.html',
                inject: 'head',
            }),
        ],
        optimization: {
            minimize: isProduction,
            minimizer: [
                new TerserPlugin(),
                new CssMinimizerPlugin(),
            ],
        },
        devtool: isProduction ? 'source-map' : 'inline-source-map',
        devServer: {
            static: './dist',
            hot: true,
        },
    };
};
