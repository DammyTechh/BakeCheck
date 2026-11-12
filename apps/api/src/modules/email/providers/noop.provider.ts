import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider, EmailResult } from '../email.types';

/**
 * The default provider: sends nothing and says so.
 *
 * It logs the subject and recipient at debug level so a developer can see
 * that the application tried to send something, then returns DISABLED. It
 * deliberately does not return ACCEPTED — the rest of the system must be able
 * to distinguish "delivered" from "no provider configured".
 */
@Injectable()
export class NoopEmailProvider implements EmailProvider {
  readonly name = 'noop';
  private readonly logger = new Logger(NoopEmailProvider.name);

  isEnabled(): boolean {
    return false;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    this.logger.debug(
      { to: message.to, subject: message.subject },
      'Email delivery is disabled; message was not sent',
    );
    return {
      status: 'DISABLED',
      provider: this.name,
      reason: 'EMAIL_DRIVER=noop — no email provider is configured',
    };
  }
}
