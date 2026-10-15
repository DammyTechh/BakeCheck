# ADR 0001 — NestJS 11 (CommonJS) rather than NestJS 12 (ESM)

**Status**: Accepted
**Date**: 2026-10-11

## Context

The API was initially scaffolded on NestJS 10. A dependency audit of the
production tree surfaced advisories reachable from the request path:

| Package     | Severity | Reached via                        |
|-------------|----------|------------------------------------|
| `sharp`     | high     | direct — libvips/libheif/librsvg CVEs |
| `js-yaml`   | high     | `@nestjs/swagger`                  |
| `lodash`    | high     | `@nestjs/config`                   |
| `qs`        | moderate | `express` / `body-parser`          |
| `multer`    | —        | 1.x deprecated, DoS advisories     |
| `file-type` | moderate | `@nestjs/common`                   |

The `sharp` finding matters most: this service decodes untrusted uploaded
images, so a libvips parsing vulnerability is directly exposed to anonymous
input. It was not acceptable to ship on it.

Upgrading to the current major, **NestJS 12**, cleared the Nest-side
advisories. But NestJS 12 ships `"type": "module"` — it is ESM-only. Adopting
it means converting the entire application to ESM.

## Decision

Use **NestJS 11.2.7**, which is CommonJS, together with:

- `sharp` ^0.35.5 (libvips CVEs fixed)
- `typescript` ^5.9.3
- npm `overrides` in the **workspace root** for `qs`, `multer` and `js-yaml`

Result: `npm audit --omit=dev` reports **0 vulnerabilities**.

## Why not NestJS 12 / ESM

ESM is where the ecosystem is going, and this decision should be revisited.
It was rejected *for now* on cost and risk, not on principle:

1. **Breadth of change.** Every relative import needs an explicit `.js`
   extension. That is a mechanical change across the codebase, but it is a
   change to every file, and it is easy to get subtly wrong.
2. **Test tooling friction.** ts-jest's ESM mode requires
   `--experimental-vm-modules`, and mocking behaves differently. The spec
   requires a meaningful automated test suite; a flaky or half-working test
   runner undermines the deliverable more than a one-major-version lag does.
3. **`ts-node` for the CLI scripts.** The migration and seed scripts run under
   ts-node, whose ESM loader is noticeably more fragile than its CJS path.
4. **The security argument does not require it.** Overrides reach the same
   endpoint — zero known vulnerabilities — without the migration.

NestJS 11 is a currently supported major, so this is not an unsupported stack.

## Notes on the overrides

npm resolves `overrides` from the **workspace root only**. Placing them in
`apps/api/package.json` silently does nothing in a workspaces repo — the field
is ignored and the audit still reports the vulnerable versions. They live in
the root `package.json`.

`npm install` alone does not always re-resolve an override against an already
materialised `node_modules`. After changing an override, verify with:

```bash
rm -rf node_modules package-lock.json && npm install
npm audit --omit=dev
```

## Consequences

- The application stays CommonJS; `tsconfig` uses `module: commonjs` with
  `moduleResolution: node`.
- `sharp` exports its types as named exports beside a default export, so
  `image-validation.service.ts` imports `Metadata` and `OutputInfo` explicitly
  rather than through a `sharp.*` namespace.
- The overrides need review whenever Nest or Express is upgraded: an override
  that outlives its purpose can hold a package *back*.
- Revisit on the next major upgrade. Moving to NestJS 12 should be a deliberate
  piece of work — convert imports, switch ts-jest to ESM mode, re-verify the
  CLI scripts — not a side effect of a routine dependency bump.
