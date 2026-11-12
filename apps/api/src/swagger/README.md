# OpenAPI documentation

All Swagger/OpenAPI documentation for the BreadGuard AI REST API lives in this
folder. **Controllers contain no documentation decorators** beyond a single
`@ApiTags` on the class and one `@XxxDocs.operation()` per route.

## Why it is separated

A controller annotated inline ends up two-thirds documentation and one-third
code — summaries, descriptions, every response schema and every error case
interleaved with the handler. Pulling it out keeps handlers readable and gives
the API documentation a single place to live, review and change.

## Layout

```
swagger/
  README.md              ← this file
  setup.ts               ← builds the document, mounts Swagger UI
  export-openapi.ts      ← writes openapi.json without booting an HTTP server
  shared/
    responses.ts         ← reusable error responses (401, 403, 404, 422, 429…)
    schemas.ts           ← shared schema fragments (pagination, limitations…)
    examples.ts          ← realistic request/response examples
  docs/
    auth.docs.ts         ← POST /auth/register, /login, /refresh, …
    laboratories.docs.ts
    test-methods.docs.ts
    reference-charts.docs.ts
    samples.docs.ts
    images.docs.ts
    analyses.docs.ts
    feedback.docs.ts
    measurements.docs.ts
    ai.docs.ts
    health.docs.ts
```

## How a docs module works

Each file exports an object of factory functions. Every function returns a
single composed decorator built with Nest's `applyDecorators`:

```ts
export const AuthDocs = {
  login: () =>
    applyDecorators(
      ApiOperation({ summary: '…', description: '…' }),
      ApiBody({ type: LoginDto }),
      ApiOkResponse({ type: AuthTokensResponse }),
      UnauthorizedResponse('Email or password is incorrect'),
      TooManyRequestsResponse(),
    ),
};
```

The controller then reads:

```ts
@Post('login')
@AuthDocs.login()
async login(@Body() dto: LoginDto) { … }
```

## Keeping it honest

The spec is generated from the running application, not hand-written, so the
routes, parameters and DTO schemas always match the code. What this folder
controls is the prose: summaries, descriptions, examples and which error cases
are documented.

Two rules when editing:

1. **If you add a route, add its docs here.** A route with no entry shows up in
   the spec as a bare path with no description, which is worse than useless.
2. **Do not document behaviour the code does not have.** The scientific
   caveats in these descriptions (screening estimate vs confirmed measurement,
   unvalidated reference data) are load-bearing — they must match what the
   endpoint actually returns.

## Viewing it

- Swagger UI: `GET /api/docs` (enabled by `SWAGGER_ENABLED`)
- OpenAPI JSON: `GET /api/docs-json`
- Offline export: `npm run openapi:export` → writes `openapi.json`

In production, set `SWAGGER_ENABLED=false` or place the path behind
authentication at the ingress. See `docs/deployment.md`.
