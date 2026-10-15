import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { buildPaginationMeta, PaginatedResult } from '../../common/dto/pagination.dto';
import { AuthenticatedUser } from '../../common/types/request-context';
import { UserRole } from '../../common/types/roles';
import { AuditAction, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import {
  AddMemberDto,
  CreateLaboratoryDto,
  ListLaboratoriesQueryDto,
  UpdateLaboratoryDto,
  UpdateMemberDto,
} from './dto/laboratory.dto';

@Injectable()
export class LaboratoriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Creates a laboratory and makes the creator its administrator.
   *
   * The creator becomes LAB_ADMIN in the same transaction — a laboratory with
   * no administrator would be immediately unmanageable, and someone would
   * have to fix it in the database.
   */
  async create(
    dto: CreateLaboratoryDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM laboratories WHERE code = $1',
      [dto.code],
    );
    if (existing) {
      throw ApiError.conflict(
        ErrorCode.ALREADY_EXISTS,
        `Laboratory code "${dto.code}" is already in use`,
      );
    }

    const laboratoryId = await this.db.transaction(async (client) => {
      const rows = await client.query<{ id: string }>(
        `INSERT INTO laboratories (
           code, name, contact_email, contact_phone, address_line1,
           address_line2, city, region, country, postal_code,
           accreditation_ref, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          dto.code,
          dto.name,
          dto.contactEmail ?? null,
          dto.contactPhone ?? null,
          dto.addressLine1 ?? null,
          dto.addressLine2 ?? null,
          dto.city ?? null,
          dto.region ?? null,
          dto.country ?? null,
          dto.postalCode ?? null,
          dto.accreditationRef ?? null,
          actor.id,
        ],
      );
      const id = rows.rows[0].id;

      await client.query(
        `INSERT INTO laboratory_memberships
           (laboratory_id, user_id, role, status, accepted_at)
         VALUES ($1, $2, 'LAB_ADMIN', 'ACTIVE', now())`,
        [id, actor.id],
      );

      return id;
    });

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId,
      action: AuditAction.LAB_CREATE,
      resourceType: 'laboratory',
      resourceId: laboratoryId,
      correlationId,
      metadata: { code: dto.code, name: dto.name },
    });

    return this.findOne(laboratoryId);
  }

  async list(
    query: ListLaboratoriesQueryDto,
    actor: AuthenticatedUser,
  ): Promise<PaginatedResult<Record<string, unknown>>> {
    const params: unknown[] = [];
    const filters: string[] = [];

    // A non-super-admin sees only laboratories they belong to. There is no
    // endpoint that lists every laboratory on the platform.
    if (actor.role !== UserRole.SUPER_ADMIN) {
      const labIds = actor.memberships.map((m) => m.laboratoryId);
      if (labIds.length === 0) {
        return {
          data: [],
          meta: buildPaginationMeta(query.page ?? 1, query.take, 0),
        };
      }
      params.push(labIds);
      filters.push(`l.id = ANY($${params.length}::uuid[])`);
    }

    if (query.search) {
      params.push(`%${query.search}%`);
      filters.push(`(l.name ILIKE $${params.length} OR l.code ILIKE $${params.length})`);
    }
    if (query.status) {
      params.push(query.status);
      filters.push(`l.status = $${params.length}::laboratory_status`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM laboratories l ${where}`,
      params,
    );

    params.push(query.take, query.offset);
    const rows = await this.db.query(
      `SELECT l.*,
              (SELECT COUNT(*) FROM laboratory_memberships m
                WHERE m.laboratory_id = l.id AND m.status = 'ACTIVE')::text
                AS member_count,
              (SELECT COUNT(*) FROM samples s WHERE s.laboratory_id = l.id)::text
                AS sample_count
         FROM laboratories l
         ${where}
        ORDER BY l.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      data: rows.map((row) => this.map(row)),
      meta: buildPaginationMeta(
        query.page ?? 1,
        query.take,
        Number(totalRow?.count ?? 0),
      ),
    };
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT l.*,
              (SELECT COUNT(*) FROM laboratory_memberships m
                WHERE m.laboratory_id = l.id AND m.status = 'ACTIVE')::text
                AS member_count,
              (SELECT COUNT(*) FROM samples s WHERE s.laboratory_id = l.id)::text
                AS sample_count
         FROM laboratories l WHERE l.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Laboratory');
    return this.map(row);
  }

  async update(
    id: string,
    dto: UpdateLaboratoryDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    await this.findOne(id);

    const assignable: Record<string, unknown> = {
      name: dto.name,
      contact_email: dto.contactEmail,
      contact_phone: dto.contactPhone,
      address_line1: dto.addressLine1,
      address_line2: dto.addressLine2,
      city: dto.city,
      region: dto.region,
      country: dto.country,
      postal_code: dto.postalCode,
      accreditation_ref: dto.accreditationRef,
    };

    const params: unknown[] = [id];
    const updates: string[] = [];

    for (const [column, value] of Object.entries(assignable)) {
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }

    if (dto.status !== undefined) {
      // Suspending or archiving a laboratory affects every one of its members,
      // so it is a platform-level decision.
      if (actor.role !== UserRole.SUPER_ADMIN) {
        throw ApiError.forbidden(
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          "Only a platform administrator can change a laboratory's status.",
        );
      }
      params.push(dto.status);
      updates.push(`status = $${params.length}::laboratory_status`);
    }

    if (updates.length === 0) return this.findOne(id);

    await this.db.query(
      `UPDATE laboratories SET ${updates.join(', ')} WHERE id = $1`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: id,
      action: AuditAction.LAB_UPDATE,
      resourceType: 'laboratory',
      resourceId: id,
      correlationId,
      metadata: { fields: updates.length },
    });

    return this.findOne(id);
  }

  async listMembers(laboratoryId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query(
      `SELECT m.id, m.user_id, m.role, m.status, m.invited_at, m.accepted_at,
              m.created_at, u.email, u.full_name, u.job_title, u.status AS user_status,
              u.last_login_at
         FROM laboratory_memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.laboratory_id = $1
        ORDER BY
          CASE m.role
            WHEN 'SUPER_ADMIN' THEN 0
            WHEN 'LAB_ADMIN' THEN 1
            WHEN 'LAB_REVIEWER' THEN 2
            ELSE 3
          END,
          u.full_name`,
      [laboratoryId],
    );

    return rows.map((row) => ({
      membershipId: row.id,
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name,
      jobTitle: row.job_title,
      role: row.role,
      status: row.status,
      userStatus: row.user_status,
      invitedAt: (row.invited_at as Date | null)?.toISOString() ?? null,
      acceptedAt: (row.accepted_at as Date | null)?.toISOString() ?? null,
      lastLoginAt: (row.last_login_at as Date | null)?.toISOString() ?? null,
      createdAt: (row.created_at as Date).toISOString(),
    }));
  }

  /**
   * Adds an existing user to a laboratory.
   *
   * Only works for an account that already exists — this endpoint does not
   * create users, because that would let an administrator set another
   * person's password. Invitation email is attempted but never blocking.
   */
  async addMember(
    laboratoryId: string,
    dto: AddMemberDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const laboratory = await this.db.queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM laboratories WHERE id = $1',
      [laboratoryId],
    );
    if (!laboratory) throw ApiError.notFound('Laboratory');

    const user = await this.db.queryOne<{
      id: string;
      email: string;
      full_name: string;
    }>('SELECT id, email, full_name FROM users WHERE email = $1', [dto.email]);

    if (!user) {
      throw ApiError.notFound('User');
    }

    // Only SUPER_ADMIN may mint another SUPER_ADMIN.
    if (dto.role === UserRole.SUPER_ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Only a platform administrator can grant the SUPER_ADMIN role.',
      );
    }

    const existing = await this.db.queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM laboratory_memberships
        WHERE laboratory_id = $1 AND user_id = $2`,
      [laboratoryId, user.id],
    );

    if (existing && existing.status === 'ACTIVE') {
      throw ApiError.conflict(
        ErrorCode.ALREADY_EXISTS,
        'That user is already a member of this laboratory.',
      );
    }

    await this.db.query(
      `INSERT INTO laboratory_memberships
         (laboratory_id, user_id, role, status, invited_by, invited_at, accepted_at)
       VALUES ($1,$2,$3::user_role,'ACTIVE',$4,now(),now())
       ON CONFLICT (laboratory_id, user_id) DO UPDATE
         SET role = EXCLUDED.role,
             status = 'ACTIVE',
             revoked_at = NULL,
             invited_by = EXCLUDED.invited_by,
             accepted_at = now()`,
      [laboratoryId, user.id, dto.role, actor.id],
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId,
      action: AuditAction.MEMBER_ADD,
      resourceType: 'laboratory_membership',
      resourceId: user.id,
      correlationId,
      metadata: { addedUserId: user.id, role: dto.role },
    });

    void this.emailService.sendLaboratoryInvitation({
      to: user.email,
      inviterName: actor.fullName,
      laboratoryName: laboratory.name,
      invitationToken: '',
    });

    return { laboratoryId, userId: user.id, role: dto.role, status: 'ACTIVE' };
  }

  async updateMember(
    laboratoryId: string,
    userId: string,
    dto: UpdateMemberDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const membership = await this.db.queryOne<{ id: string; role: string }>(
      `SELECT id, role FROM laboratory_memberships
        WHERE laboratory_id = $1 AND user_id = $2`,
      [laboratoryId, userId],
    );
    if (!membership) throw ApiError.notFound('Membership');

    if (dto.role === UserRole.SUPER_ADMIN && actor.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Only a platform administrator can grant the SUPER_ADMIN role.',
      );
    }

    // Removing the last administrator would leave the laboratory unmanageable.
    if (
      membership.role === 'LAB_ADMIN' &&
      ((dto.role !== undefined && dto.role !== UserRole.LAB_ADMIN) ||
        dto.status === 'REVOKED')
    ) {
      const adminCount = await this.db.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM laboratory_memberships
          WHERE laboratory_id = $1 AND role = 'LAB_ADMIN' AND status = 'ACTIVE'`,
        [laboratoryId],
      );
      if (Number(adminCount?.count ?? 0) <= 1) {
        throw ApiError.conflict(
          ErrorCode.CONFLICTING_STATE,
          "This is the laboratory's only administrator. Promote another " +
            'member before changing this one.',
        );
      }
    }

    const params: unknown[] = [laboratoryId, userId];
    const updates: string[] = [];

    if (dto.role !== undefined) {
      params.push(dto.role);
      updates.push(`role = $${params.length}::user_role`);
    }
    if (dto.status !== undefined) {
      params.push(dto.status);
      updates.push(`status = $${params.length}::membership_status`);
      if (dto.status === 'REVOKED') updates.push('revoked_at = now()');
    }

    if (updates.length === 0) {
      return { laboratoryId, userId, unchanged: true };
    }

    await this.db.query(
      `UPDATE laboratory_memberships SET ${updates.join(', ')}
        WHERE laboratory_id = $1 AND user_id = $2`,
      params,
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId,
      action: AuditAction.MEMBER_UPDATE,
      resourceType: 'laboratory_membership',
      resourceId: userId,
      correlationId,
      metadata: { role: dto.role, status: dto.status },
    });

    return { laboratoryId, userId, role: dto.role, status: dto.status };
  }

  private map(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      city: row.city,
      region: row.region,
      country: row.country,
      postalCode: row.postal_code,
      accreditationRef: row.accreditation_ref,
      status: row.status,
      memberCount: Number(row.member_count ?? 0),
      sampleCount: Number(row.sample_count ?? 0),
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
