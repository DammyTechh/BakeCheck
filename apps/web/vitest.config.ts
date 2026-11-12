/// <reference types="vitest/config" />
// Test configuration, kept out of vite.config.ts on purpose.
//
// The deploy build type-checks vite.config.ts. If the `test` block lived
// there, vite.config.ts would have to import from 'vitest/config', and
// deploying the site would depend on the test runner being installed — which
// is how the Vercel build broke. This file is never part of the deploy build:
// tsconfig.node.json includes only vite.config.ts, and tsconfig.test.json
// covers this one.
//
// `mergeConfig` means plugins, aliases and server settings are inherited
// rather than restated, so the two configs cannot drift.
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      globals: false,
    },
  }),
);
