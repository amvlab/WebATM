const path = require('path');
const webpack = require('webpack');
const { WebpackManifestPlugin } = require('webpack-manifest-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production' || process.env.NODE_ENV === 'production';
  const integratedBuild = process.env.INTEGRATED_BUILD === 'true';

  console.log(`Building in ${isProduction ? 'production' : 'development'} mode${integratedBuild ? ' (integrated)' : ''}`);

  // Compile-time feature flag. In the default build this is `false`, so the
  // `if (INTEGRATED_BUILD)` branch in main.ts (and its dynamic import of
  // src/integrated/*) is dead-code-eliminated -- no integrated chunk is emitted.
  const definePlugin = new webpack.DefinePlugin({
    INTEGRATED_BUILD: JSON.stringify(integratedBuild),
  });

  const baseConfig = {
    entry: './src/main.ts',
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
      path: path.resolve(__dirname, '..', 'WebATM', 'static', 'dist'),
    },
  };

  if (isProduction) {
    return {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        filename: '[name].[contenthash].js',
        clean: true,
      },
      optimization: {
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            three: {
              test: /[\\/]node_modules[\\/]three[\\/]/,
              name: 'three',
              chunks: 'async',
              priority: 20,
            },
            vendor: {
              test: /[\\/]node_modules[\\/]/,
              name: 'vendor',
              chunks: 'all',
              priority: 10,
            },
            default: {
              name: 'app',
              chunks: 'all',
              priority: 5,
              reuseExistingChunk: true,
            },
          },
        },
        runtimeChunk: {
          name: 'runtime',
        },
      },
      plugins: [
        definePlugin,
        new WebpackManifestPlugin({
          fileName: 'manifest.json',
          publicPath: '',
        }),
      ],
      mode: 'production',
      devtool: false,
    };
  }

  return {
    ...baseConfig,
    output: {
      ...baseConfig.output,
      filename: 'bundle.js',
      clean: false,
    },
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
    },
    plugins: [
      definePlugin,
      new WebpackManifestPlugin({
        fileName: 'manifest.json',
        publicPath: '',
        generate: () => ({
          'main.js': 'bundle.js'
        }),
      }),
    ],
    mode: 'development',
    devtool: 'source-map',
  };
};
