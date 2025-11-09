const path = require('path');
const { WebpackManifestPlugin } = require('webpack-manifest-plugin');

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production' || process.env.NODE_ENV === 'production';
  const isDevelopment = !isProduction;

  console.log(`Building in ${isProduction ? 'production' : 'development'} mode`);

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
      path: path.resolve(__dirname, 'dist'),
    },
  };

  if (isProduction) {
    // Production configuration
    return {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        filename: '[name].[contenthash].js',
        clean: true, // Clean dist folder before each build in production
      },
      optimization: {
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
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
        new WebpackManifestPlugin({
          fileName: 'manifest.json',
          publicPath: '',
        }),
      ],
      mode: 'production',
      devtool: false, // Disable source maps in production to save space
    };
  } else {
    // Development configuration
    return {
      ...baseConfig,
      output: {
        ...baseConfig.output,
        filename: 'bundle.js', // Simple filename for development
        clean: false, // Preserve files for incremental builds
      },
      // No code splitting in development for simplicity
      optimization: {
        splitChunks: false,
        runtimeChunk: false,
      },
      plugins: [
        // Create a simple manifest for development compatibility
        new WebpackManifestPlugin({
          fileName: 'manifest.json',
          publicPath: '',
          generate: () => ({
            'main.js': 'bundle.js'
          }),
        }),
      ],
      mode: 'development',
      devtool: 'source-map', // Enable source maps for debugging
    };
  }
};