/**
 * Email templates.
 *
 * Plain functions returning subject/html/text. Every interpolated value is
 * HTML-escaped: a user-supplied display name must not be able to inject
 * markup into a message sent to someone else.
 *
 * Each template ships a text alternative, which keeps the mail out of spam
 * filters and readable in clients that refuse HTML.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = 'BreadGuard AI';

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;">
      <tr><td style="padding:28px 32px;">
        <p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#15803d;">${BRAND}</p>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${heading}</h1>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
        <p style="margin:0;">${BRAND} is a laboratory screening tool. Screening results are
        estimates and are not confirmed chemical measurements.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

const button = (url: string, label: string): string =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(url)}"
     style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;
            padding:11px 20px;border-radius:6px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a></p>`;

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

export const EmailTemplates = {
  welcome(params: { fullName: string; appBaseUrl: string }): RenderedTemplate {
    const name = escapeHtml(params.fullName);
    return {
      subject: `Welcome to ${BRAND}`,
      html: layout(
        `Welcome, ${name}`,
        `<p style="margin:0 0 12px;line-height:1.6;">Your account is ready. You can sign in and begin
         registering samples straight away.</p>
         ${button(params.appBaseUrl, 'Open BreadGuard AI')}`,
      ),
      text:
        `Welcome, ${params.fullName}\n\n` +
        `Your ${BRAND} account is ready. Sign in at ${params.appBaseUrl}\n`,
    };
  },

  passwordReset(params: {
    fullName: string;
    resetUrl: string;
    expiresInMinutes: number;
  }): RenderedTemplate {
    const name = escapeHtml(params.fullName);
    return {
      subject: `Reset your ${BRAND} password`,
      html: layout(
        'Reset your password',
        `<p style="margin:0 0 12px;line-height:1.6;">Hello ${name}, use the link below to choose a new
         password. It expires in ${params.expiresInMinutes} minutes.</p>
         ${button(params.resetUrl, 'Choose a new password')}
         <p style="margin:0;line-height:1.6;color:#64748b;font-size:13px;">If you did not request this,
         you can ignore this message — your password will not change.</p>`,
      ),
      text:
        `Reset your ${BRAND} password\n\n` +
        `Hello ${params.fullName},\n\n` +
        `Open this link to choose a new password (expires in ${params.expiresInMinutes} minutes):\n` +
        `${params.resetUrl}\n\n` +
        `If you did not request this, ignore this message.\n`,
    };
  },

  laboratoryInvitation(params: {
    inviterName: string;
    laboratoryName: string;
    acceptUrl: string;
  }): RenderedTemplate {
    const lab = escapeHtml(params.laboratoryName);
    const inviter = escapeHtml(params.inviterName);
    return {
      subject: `You have been invited to ${params.laboratoryName} on ${BRAND}`,
      html: layout(
        `Join ${lab}`,
        `<p style="margin:0 0 12px;line-height:1.6;">${inviter} has invited you to join
         <strong>${lab}</strong> on ${BRAND}.</p>
         ${button(params.acceptUrl, 'Accept invitation')}`,
      ),
      text:
        `${params.inviterName} invited you to join ${params.laboratoryName} on ${BRAND}.\n\n` +
        `Accept: ${params.acceptUrl}\n`,
    };
  },

  emailVerification(params: { fullName: string; verifyUrl: string }): RenderedTemplate {
    const name = escapeHtml(params.fullName);
    return {
      subject: `Confirm your ${BRAND} email address`,
      html: layout(
        'Confirm your email address',
        `<p style="margin:0 0 12px;line-height:1.6;">Hello ${name}, confirm this address to finish
         setting up your account.</p>
         ${button(params.verifyUrl, 'Confirm email address')}`,
      ),
      text:
        `Hello ${params.fullName},\n\n` +
        `Confirm your email address: ${params.verifyUrl}\n`,
    };
  },

  analysisReviewRequested(params: {
    sampleCode: string;
    laboratoryName: string;
    reviewUrl: string;
  }): RenderedTemplate {
    const sample = escapeHtml(params.sampleCode);
    const lab = escapeHtml(params.laboratoryName);
    return {
      subject: `Review requested for sample ${params.sampleCode}`,
      html: layout(
        `Review requested: ${sample}`,
        `<p style="margin:0 0 12px;line-height:1.6;">A screening result for sample <strong>${sample}</strong>
         at ${lab} has been submitted for review.</p>
         <p style="margin:0 0 12px;line-height:1.6;color:#b45309;">This is an unvalidated screening
         estimate, not a confirmed measurement.</p>
         ${button(params.reviewUrl, 'Open the result')}`,
      ),
      text:
        `Review requested for sample ${params.sampleCode} at ${params.laboratoryName}.\n\n` +
        `This is an unvalidated screening estimate, not a confirmed measurement.\n\n` +
        `${params.reviewUrl}\n`,
    };
  },
};
