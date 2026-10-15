import { Global, Logger, Module } from '@nestjs/common';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { EmailService } from './email.service';
import { EMAIL_PROVIDER, EmailProvider } from './email.types';
import { NoopEmailProvider } from './providers/noop.provider';
import { ResendProvider } from './providers/resend.provider';

/**
 * Selects the provider from EMAIL_DRIVER.
 *
 * Choosing `resend` without an API key falls back to the no-op provider and
 * says so, rather than booting a provider that will fail on every send.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [CONFIG_TOKEN],
      useFactory: (config: AppConfig): EmailProvider => {
        const logger = new Logger('EmailModule');

        if (config.email.driver === 'resend') {
          const provider = new ResendProvider(config);
          if (provider.isEnabled()) {
            logger.log('Email delivery enabled via Resend');
            return provider;
          }
          logger.warn(
            'EMAIL_DRIVER=resend but RESEND_API_KEY is missing; ' +
              'email delivery is disabled. The application continues normally.',
          );
          return new NoopEmailProvider();
        }

        logger.log('Email delivery is disabled (EMAIL_DRIVER=noop)');
        return new NoopEmailProvider();
      },
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
