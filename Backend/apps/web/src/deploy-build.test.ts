import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the one property that matters about the deploy build: it must not
 * depend on the test tooling.
 *
 * This is here because the Vercel build failed on exactly that. Two faults,
 * neither visible locally:
 *
 *  - `tsconfig.app.json` had `include: ["src"]` and no `exclude`, so
 *    `tsc -b` type-checked all five test files while building the site.
 *  - `vite.config.ts` imported `defineConfig` from `vitest/config` so that
 *    its `test` block would type-check.
 *
 * Both worked on this machine, where npm hoisted everything needed. Vercel
 * resolved two packages fewer and the build died with TS2688/TS2307 straight
 * after `npm install`. A test runner must never be required to ship the site.
 *
 * These assertions read the config files as text rather than importing them,
 * so they fail on the thing a reviewer would actually have to notice.
 */
const root = resolve(__dirname, '..');
const read = (name: string): string =>
  readFileSync(resolve(root, name), 'utf8');

describe('the deploy build is independent of the test tooling', () => {
  it('does not type-check test files', () => {
    const cfg = JSON.parse(read('tsconfig.app.json')) as {
      exclude?: string[];
    };
    expect(cfg.exclude).toBeDefined();
    const excluded = cfg.exclude!.join(' ');
    expect(excluded).toContain('*.test.ts');
    expect(excluded).toContain('*.test.tsx');
    expect(excluded).toContain('test-setup');
  });

  it('does not pull vitest types into the app project', () => {
    const cfg = JSON.parse(read('tsconfig.app.json')) as {
      compilerOptions: { types?: string[] };
    };
    expect(cfg.compilerOptions.types ?? []).not.toContain('vitest/globals');
  });

  it('keeps vitest out of vite.config.ts entirely', () => {
    // Comments in that file explain this very rule and name vitest, so match
    // on what actually creates a dependency: imports and type references.
    const config = read('vite.config.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(config).not.toMatch(/from\s+['"]vitest/);
    expect(config).not.toMatch(/require\(\s*['"]vitest/);
    expect(config).not.toMatch(/reference\s+types\s*=\s*["']vitest/);
    // And the `test` block that forced the import in the first place.
    expect(config).not.toMatch(/^\s*test:\s*\{/m);
  });

  it('declares @types/node rather than relying on a transitive copy', () => {
    // tsconfig.node.json sets types: ["node"]. @types/node reached the build
    // only as a transitive dependency of vite/vitest; when the host hoisted
    // the tree differently it vanished, and the build could not explain why.
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['@types/node']).toBeDefined();
  });

  it('declares every type package its tsconfigs ask for', () => {
    // Generalises the case above: any name in a `types` array has to be a
    // declared dependency, not something that happens to be hoisted.
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.devDependencies),
      ...Object.keys(pkg.dependencies ?? {}),
    ]);
    // `vite/client` ships inside vite itself, so the package name is "vite".
    const packageFor = (type: string): string =>
      type.startsWith('@') ? type.split('/').slice(0, 2).join('/') : type.split('/')[0]!;

    for (const file of ['tsconfig.app.json', 'tsconfig.node.json']) {
      const cfg = JSON.parse(read(file)) as {
        compilerOptions: { types?: string[] };
      };
      for (const type of cfg.compilerOptions.types ?? []) {
        const name = type === 'node' ? '@types/node' : packageFor(type);
        expect(declared.has(name), `${file} needs "${name}" declared`).toBe(true);
      }
    }
  });
});
