// The production build config, and nothing else.
//
// `defineConfig` comes from 'vite', not 'vitest/config', and there is no
// `test` block here. That is deliberate: this file is type-checked by
// `tsc -b` during the deploy build, so anything it imports becomes a
// dependency of deployment itself. Importing from 'vitest/config' made the
// Vercel build fail with TS2307 the moment vitest was not resolvable —
// a test runner has no business being required to ship the site.
//
// Test configuration lives in vitest.config.ts, which merges this file.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    // Source maps ship: this is a laboratory tool, and a stack trace from a
    // technician's browser is worth more than hiding the bundle.
    sourcemap: true,
  },
});
