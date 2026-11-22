import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/** Builds the components as one ES module of custom elements. */
export default defineConfig({
  plugins: [svelte({ compilerOptions: { customElement: true } })],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'teampulse-ui' },
    outDir: 'dist',
    sourcemap: true,
  },
});
