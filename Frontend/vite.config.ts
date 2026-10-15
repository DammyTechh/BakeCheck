/// <reference types="vitest/config" />
// `defineConfig` comes from vitest/config rather than vite so that the `test`
// block below type-checks. Importing it from 'vite' compiles under `vite dev`
// but fails `tsc -b`, which is what the production build runs — so the error
// only ever appeared at deploy time.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // Source maps ship: this is a laboratory tool, and a stack trace from a
    // technician's browser is worth more than hiding the bundle.
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
});
