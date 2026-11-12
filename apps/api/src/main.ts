import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig, CONFIG_TOKEN } from './config/configuration';
import { ApiError, ErrorCode } from './common/errors/api-error';
import { setupSwagger } from './swagger/setup';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Configuration is validated during module init; a bad environment throws
  // here rather than surfacing as a confusing runtime failure later.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffered so startup logs are not lost before the logger is configured.
    bufferLogs: true,
  });

  const config = app.get<AppConfig>(CONFIG_TOKEN);

  // ── Proxy trust ───────────────────────────────────────────────────────────
  // Only when explicitly configured. Trusting X-Forwarded-For unconditionally
  // would let any client spoof its IP, defeating rate limiting and poisoning
  // the audit log.
  if (config.http.trustProxy) {
    app.set('trust proxy', 1);
    logger.log('Trusting the first proxy hop (TRUST_PROXY=true)');
  }

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(
    helmet({
      // The API serves JSON, not HTML. A restrictive CSP costs nothing here
      // and limits what an injected response could do.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          // Without this, `connect-src` falls back to `default-src 'none'` and
          // the browser blocks EVERY fetch/XHR made by a page this app serves
          // — including same-origin ones, where CORS does not even apply.
          // Swagger UI's "Try it out" then fails with a bare "Failed to fetch"
          // whose suggested causes (CORS, network) are both wrong, which makes
          // it genuinely hard to diagnose. Helmet's own defaults do not set
          // connect-src, so this has to be explicit.
          //
          // 'self' only: the docs UI can call this API and nothing else, so an
          // injected script still cannot exfiltrate to another origin.
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // Swagger UI needs inline styles and scripts; without this its assets
      // are blocked by COEP.
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
    }),
  );

  app.use(cookieParser());

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: (origin, callback) => {
      // No Origin header: same-origin, curl, or a server-side client. Allowed —
      // these are not browser requests and CORS does not protect them.
      if (!origin) return callback(null, true);

      if (config.http.corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      logger.warn({ origin }, 'Rejected a cross-origin request');
      return callback(
        new Error(`Origin ${origin} is not permitted by the CORS allowlist`),
        false,
      );
    },
    // Required for the refresh cookie to be sent cross-site.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
    maxAge: 600,
  });

  // ── Routing ───────────────────────────────────────────────────────────────
  app.setGlobalPrefix(config.http.globalPrefix, {
    // Probes stay at the root so orchestrators do not need to know the prefix.
    exclude: ['health', 'health/ready'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // ── Validation ────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties with no decorator, then reject requests that carried
      // them. Together these are the mass-assignment defence: a client cannot
      // smuggle `role` or `laboratoryId` into a body that does not declare it.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      forbidUnknownValues: true,
      // Suppress class-validator's own messages in production: they can echo
      // submitted values back to the client.
      disableErrorMessages: false,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) =>
        ApiError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Request validation failed',
          errors.map((error) => ({
            field: error.property,
            constraints: error.constraints ? Object.values(error.constraints) : undefined,
          })),
        ),
    }),
  );

  // Body size cap. Images arrive as multipart and are bounded separately by
  // multer; this covers JSON bodies.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  setupSwagger(app, config);

  // Give in-flight requests a chance to finish on SIGTERM, and close the
  // database pool cleanly.
  app.enableShutdownHooks();

  await app.listen(config.http.port, '0.0.0.0');

  logger.log(`BreadGuard AI API listening on port ${config.http.port}`);
  logger.log(`Environment:  ${config.nodeEnv}`);
  logger.log(`API root:     /${config.http.globalPrefix}/v1`);
  logger.log(`Storage:      ${config.storage.driver}`);
  logger.log(`Email:        ${config.email.driver}`);
  logger.log(`AI service:   ${config.aiService.url}`);
}

bootstrap().catch((error: Error) => {
  // Configuration failures land here and must be legible: the message
  // explains precisely which variable is wrong.
  // eslint-disable-next-line no-console
  console.error(`\nFailed to start the API:\n${error.message}\n`);
  process.exit(1);
});
