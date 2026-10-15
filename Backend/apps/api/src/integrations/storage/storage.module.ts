import { Global, Logger, Module } from '@nestjs/common';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { LocalStorageProvider } from './local-storage.provider';
import { STORAGE_PROVIDER, StorageProvider } from './storage.types';
import { SupabaseStorageProvider } from './supabase-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      inject: [CONFIG_TOKEN],
      useFactory: (config: AppConfig): StorageProvider => {
        const logger = new Logger('StorageModule');

        if (config.storage.driver === 'supabase') {
          logger.log(
            `Using Supabase Storage (bucket: ${config.storage.bucket}). ` +
              'The bucket must be private.',
          );
          return new SupabaseStorageProvider(
            config.storage.supabaseUrl!,
            config.storage.supabaseServiceRoleKey!,
            config.storage.bucket,
          );
        }

        logger.log(`Using local filesystem storage at ${config.storage.localDir}`);
        if (config.isProduction) {
          // Worth shouting about: on Render/Fly/Heroku-style platforms the
          // filesystem is ephemeral and every uploaded image is lost on deploy.
          logger.error(
            'STORAGE_DRIVER=local in production. Uploaded images will be LOST ' +
              'whenever the container restarts. Set STORAGE_DRIVER=supabase.',
          );
        }
        return new LocalStorageProvider(config.storage.localDir);
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
