const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

    return {
        entry: './src/index.js',
        output: {
            path: path.resolve(__dirname, '../src/player'),
            filename: isProduction ? 'jellyfin-player.min.js' : 'jellyfin-player.js',
            library: {
                name: 'JellyfinPlayer',
                type: 'umd',
                export: 'default',
            },
            globalObject: 'this',
            clean: false, // Don't clean src/player as it has OSD files
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
                // Ignore SCSS imports - styles handled by litefin
                {
                    test: /\.s[ac]ss$/i,
                    use: 'null-loader',
                },
            ],
        },
        plugins: [
            // Define __DEBUG__ constant based on build mode
            new webpack.DefinePlugin({
                __DEBUG__: JSON.stringify(!isProduction),
            }),
        ],
        optimization: {
            minimize: isProduction,
            minimizer: [
                new TerserPlugin({
                    extractComments: false, // Don't create LICENSE.txt file
                }),
            ],
        },
        devtool: isProduction ? false : 'inline-source-map', // No source maps in prod
    };
};
