import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { redactMetadata } from '../../common/logging/logger';

/** Canonical action names. Grouped `domain.verb` so they are easy to filter. */
export const AuditAction = {
  AUTH_REGISTER: 'auth.register',
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_REFRESH: 'auth.refresh',
  AUTH_REFRESH_REUSE_DETECTED: 'auth.refresh_reuse_detected',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',

  LAB_CREATE: 'laboratory.create',
  LAB_UPDATE: 'laboratory.update',
  MEMBER_ADD: 'membership.add',
  MEMBER_UPDATE: 'membership.update',

  METHOD_CREATE: 'test_method.create',
  METHOD_UPDATE: 'test_method.update',
  CHART_CREATE: 'reference_chart.create',
  CHART_UPDATE: 'reference_chart.update',
  LEVEL_CREATE: 'reference_level.create',
  LEVEL_UPDATE: 'reference_level.update',

  SAMPLE_CREATE: 'sample.create',
  SAMPLE_UPDATE: 'sample.update',
  IMAGE_UPLOAD: 'image.upload',
  IMAGE_DOWNLOAD: 'image.download',
  IMAGE_REJECTED: 'image.rejected',

  ANALYSIS_START: 'analysis.start',
  ANALYSIS_COMPLETE: 'analysis.complete',
  ANALYSIS_FAILED: 'analysis.failed',

  FEEDBACK_CREATE: 'feedback.create',
  MEASUREMENT_CREATE: 'measurement.create',
  MEASUREMENT_CONFIRM: 'measurement.confirm',

  DATASET_EXAMPLE_APPROVE: 'dataset.example_approve',
  DATASET_VERSION_CREATE: 'dataset.version_create',
  TRAINING_JOB_CREATE: 'model.training_job_create',
  MODEL_APPROVE: 'model.approve',
  MODEL_ROLLBACK: 'model.rollback',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  actorUserId?: string | null;
  actorEmail?: string | null;
  laboratoryId?: string | null;
  action: AuditActionValue | string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  correlationId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail.
 *
 * Writes never throw into the caller: an audit failure must not roll back a
 * legitimate business operation, and must not turn a successful request into
 * a 500. Failures are logged loudly instead, so a broken trail is visible.
 *
 * All metadata passes through `redactMetadata` before it is persisted.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DatabaseService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_logs (
           actor_user_id, actor_email, laboratory_id, action,
           resource_type, resource_id, outcome, correlation_id,
           ip_address, user_agent, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entry.actorUserId ?? null,
          entry.actorEmail ?? null,
          entry.laboratoryId ?? null,
          entry.action,
          entry.resourceType ?? null,
          entry.resourceId ?? null,
          entry.outcome ?? 'SUCCESS',
          entry.correlationId ?? null,
          // An invalid inet value would reject the row; normalise first.
          this.normaliseIp(entry.ipAddress),
          entry.userAgent?.slice(0, 500) ?? null,
          JSON.stringify(redactMetadata(entry.metadata ?? {})),
        ],
      );
    } catch (error) {
      this.logger.error(
        {
          err: (error as Error).message,
          action: entry.action,
          correlationId: entry.correlationId,
        },
        'Failed to write audit log entry',
      );
    }
  }

  /** Paginated audit history for one laboratory. */
  async listForLaboratory(
    laboratoryId: string,
    options: { limit: number; offset: number; action?: string },
  ): Promise<{ rows: unknown[]; total: number }> {
    const filters: string[] = ['laboratory_id = $1'];
    const params: unknown[] = [laboratoryId];

    if (options.action) {
      params.push(options.action);
      filters.push(`action = $${params.length}`);
    }

    const where = filters.join(' AND ');

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE ${where}`,
      params,
    );

    params.push(options.limit, options.offset);
    const rows = await this.db.query(
      `SELECT id, actor_user_id, actor_email, action, resource_type,
              resource_id, outcome, correlation_id, metadata, created_at
         FROM audit_logs
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows, total: Number(totalRow?.count ?? 0) };
  }

  /** IPv4/IPv6 only; anything else becomes NULL rather than failing the insert. */
  private normaliseIp(value?: string | null): string | null {
    if (!value) return null;
    // Express reports IPv4-mapped IPv6 as ::ffff:127.0.0.1.
    const cleaned = value.replace(/^::ffff:/, '');
    const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(cleaned);
    const isIpv6 = /^[0-9a-f:]+$/i.test(cleaned) && cleaned.includes(':');
    return isIpv4 || isIpv6 ? cleaned : null;
  }
}
