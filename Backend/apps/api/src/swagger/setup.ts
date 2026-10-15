import { INestApplication, Logger } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { AppConfig } from '../config/configuration';

/**
 * Builds the OpenAPI document and mounts Swagger UI.
 *
 * The document is generated from the running application, so paths,
 * parameters and DTO schemas always match the code. The prose — summaries,
 * descriptions, examples and documented error cases — comes from the
 * decorator modules in ./docs. See ./README.md.
 */

const API_DESCRIPTION = `
Laboratory-assisted chemical screening platform.

## What this API does, and does not, claim

BreadGuard AI measures the colour of a prepared laboratory sample from a
photograph and compares it against a configured reference chart. Everything it
returns from an image is a **screening estimate**.

It is not a chemical measurement, and the API is shaped so that a client
cannot accidentally present it as one:

- an analysis result always reports \`isConfirmedMeasurement: false\`;
- \`prediction.estimatedConcentration\` is \`null\` unless a validated model, a
  validated method and a validated reference chart all apply;
- \`prediction.confidence\` is \`null\` in reference-matching mode, because a
  colour distance is not a probability;
- every result carries a \`limitations\` array built from the real validation
  state of the method, chart and model that produced it.

Confirmed concentrations live in a separate resource,
\`POST /samples/{id}/laboratory-measurements\`, and come from analytical
instruments — never from this platform's image analysis.

**No result from this API should be used on its own to declare a sample safe,
unsafe, compliant or non-compliant.**

## Prototype state

The shipped configuration runs in reference-matching mode against an
*illustrative* colour chart. No predictive model has been validated against
confirmed laboratory measurements. See \`docs/ai-methodology.md\` and
\`docs/prototype-limitations.md\` in the repository.

## Authentication

Obtain an access token from \`POST /api/v1/auth/login\` and send it as
\`Authorization: Bearer <token>\`. Access tokens are short-lived; rotate them
through \`POST /api/v1/auth/refresh\`, which also issues a replacement refresh
token. Browser clients should rely on the HttpOnly refresh cookie rather than
storing the token in JavaScript.

## Laboratory isolation

Every record belongs to exactly one laboratory. Requesting a record from a
laboratory you are not a member of returns **404, not 403** — the two cases
are deliberately indistinguishable, so record existence is not disclosed.

## Errors

Every error returns the same envelope:

\`\`\`json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": ["email must be a valid email address"],
    "correlationId": "6f1d2c3a-9b8e-4a7f-8c1d-2e3f4a5b6c7d",
    "timestamp": "2026-10-11T12:34:56.789Z",
    "path": "/api/v1/auth/register"
  }
}
\`\`\`

Branch on \`code\`, not on \`message\`. Quote \`correlationId\` when reporting a
problem: it ties the response to the server-side log line and to the audit
record.
`.trim();

export function buildOpenApiDocument(
  app: INestApplication,
  config: AppConfig,
): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('BreadGuard AI API')
    .setDescription(API_DESCRIPTION)
    .setVersion('0.1.0')
    .setLicense('Proprietary', '')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from POST /api/v1/auth/login',
      },
      'bearer',
    )
    .addCookieAuth(
      config.auth.refreshCookieName,
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'HttpOnly refresh token. Set automatically; used only by ' +
          '/auth/refresh and /auth/logout.',
      },
      'refreshCookie',
    )
    // Tag order drives the order of sections in Swagger UI, so it follows the
    // order a developer actually works through the API.
    .addTag('Health', 'Liveness and readiness probes')
    .addTag('Authentication', 'Registration, sign-in and session lifecycle')
    .addTag('Laboratories', 'Laboratories and membership')
    .addTag('Reference data', 'Test methods and reference colour charts')
    .addTag('Samples', 'Sample registration and retrieval')
    .addTag('Images', 'Image upload and retrieval')
    .addTag('Analyses', 'Image analysis and screening results')
    .addTag(
      'Feedback and measurements',
      'Technician annotations and confirmatory laboratory measurements',
    )
    .addTag('AI administration', 'Model registry, training and release')
    .addServer(`/${config.http.globalPrefix}/v1`, 'Versioned API root');

  const document = SwaggerModule.createDocument(app, builder.build(), {
    // Operation ids come from method names, which keeps generated clients
    // readable (`authLogin` rather than `AuthController_login`).
    operationIdFactory: (controllerKey, methodKey) => {
      const prefix = controllerKey.replace(/Controller$/, '');
      return `${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}_${methodKey}`;
    },
    deepScanRoutes: true,
  });

  // The health probes are deliberately VERSION_NEUTRAL and excluded from the
  // global prefix, so they live at the server root rather than under
  // /api/v1 — a load balancer should not have to know the API's version to
  // check liveness.
  //
  // The document-level server above is /api/v1, and Swagger UI joins that to
  // each path, so it was advertising /api/v1/health and "Try it out" returned
  // 404 for an endpoint that works perfectly at /health. OpenAPI lets a path
  // item override the server list, which is exactly what this is for.
  for (const path of Object.keys(document.paths)) {
    if (path === '/health' || path.startsWith('/health/')) {
      document.paths[path].servers = [
        { url: '/', description: 'Server root (health probes are unversioned)' },
      ];
    }
  }

  return document;
}

export function setupSwagger(app: INestApplication, config: AppConfig): void {
  const logger = new Logger('Swagger');

  if (!config.swagger.enabled) {
    logger.log('Swagger UI is disabled (SWAGGER_ENABLED=false)');
    return;
  }

  if (config.isProduction) {
    // Not fatal — some deployments legitimately expose docs behind an
    // authenticating proxy — but it should be a conscious decision.
    logger.warn(
      'Swagger UI is enabled in production. Place it behind authentication ' +
        'at the ingress, or set SWAGGER_ENABLED=false.',
    );
  }

  const document = buildOpenApiDocument(app, config);

  SwaggerModule.setup(config.swagger.path, app, document, {
    jsonDocumentUrl: `${config.swagger.path}-json`,
    yamlDocumentUrl: `${config.swagger.path}-yaml`,
    swaggerOptions: {
      // Keeps the token across page reloads while reading the docs.
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      displayRequestDuration: true,
    },
    customSiteTitle: 'BreadGuard AI API',
  });

  logger.log(`Swagger UI:   /${config.swagger.path}`);
  logger.log(`OpenAPI JSON: /${config.swagger.path}-json`);
}
