import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Two projects with different resource profiles:
 *
 * - unit: pure TypeScript and in-memory fakes. Cheap, so files run in parallel.
 * - integration: each file may boot PostgreSQL-in-WebAssembly (several hundred MB of memory and
 *   seconds of CPU) and do real cryptography. Running them all at once exhausts memory on a typical
 *   laptop or CI runner, which showed up as multi-minute boots and hook timeouts. Their files run
 *   one at a time.
 *
 * `npm test` runs the two projects one after the other so their memory use never stacks.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Never start one worker per core: memory, not CPU, is the limit.
    maxWorkers: 3,
    coverage: {
      provider: 'v8',
      include: ['{packages,services,lambdas}/*/src/**/*.ts'],
      exclude: ['**/index.ts', '**/main.ts', '**/cli/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            '{services,lambdas}/*/test/unit/**/*.test.ts',
            'tools/test/**/*.test.ts',
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'packages/*/test/integration/**',
            'packages/ui/**',
          ],
          // Generous for cold starts (first import of Fastify and friends) on a busy machine; a
          // unit test that genuinely hangs still fails.
          testTimeout: 30_000,
        },
      },
      {
        // Web components: need a DOM, and Svelte compiled as custom elements.
        extends: true,
        plugins: [svelte({ compilerOptions: { customElement: true } })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['packages/ui/test/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{packages,services,lambdas}/*/test/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          // PostgreSQL-in-WebAssembly takes seconds to boot, and longer on a busy machine.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
