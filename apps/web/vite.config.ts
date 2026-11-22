import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * In development the browser talks to one origin (this dev server), which forwards each service's
 * path to the port it runs on. In production a load balancer does the same by path.
 */
const target = (port: number) => ({ target: `http://localhost:${port}`, changeOrigin: false });

export default defineConfig({
  plugins: [
    sveltekit({
      // A static single-page app (ADR-0007): no server-side rendering, so it can be served from S3
      // behind CloudFront. Unknown paths fall back to index.html and the client router takes over.
      adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
    }),
  ],
  server: {
    proxy: {
      '/api/v1/identity': target(3001),
      '/api/v1/habit': target(3002),
      '/api/v1/event-tracking': target(3003),
      '/api/v1/challenge': target(3004),
      '/api/v1/insight': target(3005),
      '/api/v1/notification': target(3006),
    },
  },
});
