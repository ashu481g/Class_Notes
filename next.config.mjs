/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Load these with plain Node require on the server; bundling breaks ws's native helpers.
  serverExternalPackages: ["msedge-tts", "ws"],
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // pptxgenjs references Node built-ins (only used when running under Node); stub them in the browser.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, https: false, http: false, path: false, os: false, "image-size": false };
    }
    return config;
  },
};

export default nextConfig;
