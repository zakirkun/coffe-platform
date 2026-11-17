import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV === 'development';
const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  output: 'standalone',
  // The Docker image is built from the monorepo root; trace workspace packages from there.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  reactStrictMode: true,
  // In development the UI (:3000) and the API (:4000) are separate processes: REST and Better
  // Auth go through the rewrite below (same-origin cookies), the browser WebSocket connects to
  // the API directly. Production serves both behind one origin, so neither applies.
  env: isDevelopment
    ? {
        NEXT_PUBLIC_WS_URL:
          process.env.NEXT_PUBLIC_WS_URL ?? `${apiUrl.replace(/^http/, 'ws')}/api/ws`,
      }
    : {},
  async rewrites() {
    return isDevelopment ? [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }] : [];
  },
};

export default nextConfig;
