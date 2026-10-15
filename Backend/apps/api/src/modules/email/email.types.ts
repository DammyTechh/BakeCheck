/**
 * Email provider contract.
 *
 * The central rule: a provider reports what actually happened. When no
 * provider is configured the result is `DISABLED`, never a fake success. Call
 * sites must treat delivery as best-effort and must not block a user action
 * on it.
 */

export type EmailDeliveryStatus =
  /** A provider accepted the message for delivery. */
  | 'ACCEPTED'
  /** No provider is configured. Nothing was sent, and nothing pretended to be. */
  | 'DISABLED'
  /** A provider was configured but rejected or errored on the request. */
  | 'FAILED';

export interface EmailResult {
  status: EmailDeliveryStatus;
  /** Provider-side id, when one was returned. */
  providerMessageId?: string;
  provider: string;
  /** Why it failed or was skipped. Safe to log; carries no credentials. */
  reason?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailProvider {
  readonly name: string;
  /** True when this provider is configured well enough to attempt delivery. */
  isEnabled(): boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';
