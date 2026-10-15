import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { EmailTemplates } from './email.templates';
import { EMAIL_PROVIDER, EmailProvider, EmailResult } from './email.types';

/**
 * Application-facing email API.
 *
 * Every method returns an EmailResult describing what actually happened.
 * Callers that treat email as optional (registration, invitations) should
 * `void` the promise; callers that need to report delivery state to a user
 * should await and inspect `status`.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Reported by GET /api/v1/health so operators can see the real state. */
  getStatus(): { enabled: boolean; provider: string; reason?: string } {
    const enabled = this.provider.isEnabled();
    return {
      enabled,
      provider: this.provider.name,
      ...(enabled
        ? {}
        : { reason: 'No email provider is configured; delivery is disabled' }),
    };
  }

  private async dispatch(
    to: string,
    rendered: { subject: string; html: string; text: string },
    context: string,
  ): Promise<EmailResult> {
    const result = await this.provider.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    // Log the outcome without the recipient's full address: the local part is
    // personal data and ends up in aggregated logs.
    this.logger.log(
      {
        context,
        status: result.status,
        provider: result.provider,
        recipientDomain: to.split('@')[1],
        ...(result.reason ? { reason: result.reason } : {}),
      },
      `Email ${result.status.toLowerCase()}`,
    );

    return result;
  }

  async sendWelcome(params: { to: string; fullName: string }): Promise<EmailResult> {
    return this.dispatch(
      params.to,
      EmailTemplates.welcome({
        fullName: params.fullName,
        appBaseUrl: this.config.email.appBaseUrl,
      }),
      'welcome',
    );
  }

  async sendPasswordReset(params: {
    to: string;
    fullName: string;
    resetToken: string;
    expiresInMinutes: number;
  }): Promise<EmailResult> {
    const resetUrl =
      `${this.config.email.appBaseUrl}/reset-password` +
      `?token=${encodeURIComponent(params.resetToken)}`;

    return this.dispatch(
      params.to,
      EmailTemplates.passwordReset({
        fullName: params.fullName,
        resetUrl,
        expiresInMinutes: params.expiresInMinutes,
      }),
      'password_reset',
    );
  }

  async sendLaboratoryInvitation(params: {
    to: string;
    inviterName: string;
    laboratoryName: string;
    invitationToken: string;
  }): Promise<EmailResult> {
    const acceptUrl =
      `${this.config.email.appBaseUrl}/accept-invitation` +
      `?token=${encodeURIComponent(params.invitationToken)}`;

    return this.dispatch(
      params.to,
      EmailTemplates.laboratoryInvitation({
        inviterName: params.inviterName,
        laboratoryName: params.laboratoryName,
        acceptUrl,
      }),
      'laboratory_invitation',
    );
  }

  /**
   * Prepared for a future flow. Verification is not required by the
   * prototype, so nothing calls this during registration today.
   */
  async sendEmailVerification(params: {
    to: string;
    fullName: string;
    verificationToken: string;
  }): Promise<EmailResult> {
    const verifyUrl =
      `${this.config.email.appBaseUrl}/verify-email` +
      `?token=${encodeURIComponent(params.verificationToken)}`;

    return this.dispatch(
      params.to,
      EmailTemplates.emailVerification({
        fullName: params.fullName,
        verifyUrl,
      }),
      'email_verification',
    );
  }

  async sendAnalysisReviewRequest(params: {
    to: string;
    sampleCode: string;
    laboratoryName: string;
    analysisId: string;
  }): Promise<EmailResult> {
    const reviewUrl = `${this.config.email.appBaseUrl}/analyses/${params.analysisId}`;
    return this.dispatch(
      params.to,
      EmailTemplates.analysisReviewRequested({
        sampleCode: params.sampleCode,
        laboratoryName: params.laboratoryName,
        reviewUrl,
      }),
      'analysis_review',
    );
  }
}
