import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { AppConfig, CONFIG_TOKEN } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { LaboratoryScopeGuard } from './common/guards/laboratory-scope.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { SecurityModule } from './common/security/security.module';
import { PythonAiModule } from './integrations/python-ai/python-ai.module';
import { StorageModule } from './integrations/storage/storage.module';
import { AiAdminModule } from './modules/ai-admin/ai-admin.module';
import { AnalysesModule } from './modules/analyses/analyses.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmailModule } from './modules/email/email.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { HealthModule } from './modules/health/health.module';
import { ImagesModule } from './modules/images/images.module';
import { LaboratoriesModule } from './modules/laboratories/laboratories.module';
import { ReferenceDataModule } from './modules/reference-data/reference-data.module';
import { SamplesModule } from './modules/samples/samples.module';

/**
 * Root module.
 *
 * ## Global guard order
 *
 * Nest runs APP_GUARD providers in registration order, and the order here is
 * load-bearing:
 *
 *   1. ThrottlerGuard      — reject floods before doing any work, including
 *                            the database read that authentication needs.
 *   2. JwtAuthGuard        — establish who the caller is.
 *   3. LaboratoryScopeGuard — resolve which laboratory the route targets and
 *                            verify membership, recording the caller's role
 *                            *in that laboratory* on the request.
 *   4. PermissionsGuard    — check capabilities against that per-laboratory
 *                            role, not the platform role.
 *
 * Swapping 3 and 4 would evaluate a technician's capabilities using their
 * role in some other laboratory.
 *
 * Authentication is global, so a route is protected unless it opts out with
 * `@Public()` — forgetting a decorator leaves a route locked rather than open.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    SecurityModule,
    AuditModule,
    EmailModule,
    StorageModule,
    PythonAiModule,

    ThrottlerModule.forRootAsync({
      inject: [CONFIG_TOKEN],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.rateLimit.windowMs,
            limit: config.rateLimit.max,
          },
          // Named throttlers referenced by @Throttle on individual routes.
          { name: 'auth', ttl: 60_000, limit: config.rateLimit.authMax },
          { name: 'analysis', ttl: 60_000, limit: config.rateLimit.analysisMax },
          { name: 'upload', ttl: 60_000, limit: 30 },
        ],
      }),
    }),

    HealthModule,
    AuthModule,
    LaboratoriesModule,
    ReferenceDataModule,
    SamplesModule,
    ImagesModule,
    AnalysesModule,
    FeedbackModule,
    AiAdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: LaboratoryScopeGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Before everything, so even a rejected request carries a correlation id.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
