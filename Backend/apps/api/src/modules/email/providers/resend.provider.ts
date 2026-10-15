import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/configuration';
import { EmailMessage, EmailProvider, EmailResult } from '../email.types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resend adapter.
 *
 * Implemented against Resend's HTTP API with `fetch` rather than pulling in
 * the SDK: one endpoint, one POST, no dependency to keep patched.
 *
 * If RESEND_API_KEY is absent the provider reports itself disabled and every
 * send returns DISABLED. It never reports ACCEPTED for a message that no
 * provider actually took.
 */
@Injectable()
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly logger = new Logger(ResendProvider.name);

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return Boolean(this.config.email.resendApiKey);
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    if (!this.isEnabled()) {
      return {
        status: 'DISABLED',
        provider: this.name,
        reason: 'RESEND_API_KEY is not configured',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.email.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.email.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Read the body for diagnostics, but keep it short — and never log
        // the Authorization header we just sent.
        const detail = await response.text().catch(() => '');
        this.logger.warn(
          { status: response.status, detail: detail.slice(0, 300) },
          'Resend rejected the message',
        );
        return {
          status: 'FAILED',
          provider: this.name,
          reason: `Resend responded ${response.status}`,
        };
      }

      const body = (await response.json()) as { id?: string };
      return {
        status: 'ACCEPTED',
        provider: this.name,
        providerMessageId: body.id,
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      this.logger.warn(
        { err: (error as Error).message },
        aborted ? 'Resend request timed out' : 'Resend request failed',
      );
      return {
        status: 'FAILED',
        provider: this.name,
        reason: aborted ? 'Request timed out' : 'Network or transport error',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
