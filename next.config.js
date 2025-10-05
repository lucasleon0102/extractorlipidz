/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // não falha o build por erro de lint
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
