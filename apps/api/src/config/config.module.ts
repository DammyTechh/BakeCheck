import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfig, CONFIG_TOKEN, loadConfiguration } from './configuration';

/**
 * Exposes the validated `AppConfig` object under CONFIG_TOKEN.
 *
 * Everything injects this typed object rather than reading `process.env`
 * directly, so there is exactly one place where environment parsing happens
 * and exactly one place to audit for secret handling.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      // Per-app .env wins over the repo-root one; both are optional because in
      // production the platform (Render/Vercel/Docker) injects real env vars.
      envFilePath: ['.env', '../../.env'],
      // We validate with zod in loadConfiguration() instead.
      validate: undefined,
      cache: true,
    }),
  ],
  providers: [
    {
      provide: CONFIG_TOKEN,
      useFactory: (): AppConfig => loadConfiguration(),
    },
  ],
  exports: [CONFIG_TOKEN],
})
export class AppConfigModule {}
