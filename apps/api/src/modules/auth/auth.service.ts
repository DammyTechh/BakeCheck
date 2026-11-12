import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PoolClient } from 'pg';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { ARGON2_OPTIONS } from '../../common/security/password.constants';
import {
  AuthenticatedUser,
  LabMembershipSummary,
} from '../../common/types/request-context';
import { permissionsForRole, UserRole } from '../../common/types/roles';
import { AuditAction, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { IssuedTokens, SessionContext, TokenService } from './token.service';
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { UserProfileResponse } from './dto/auth.response';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  job_title: string | null;
  role: UserRole;
  status: string;
  token_version: number;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

/** Lockout policy for repeated failed logins. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

/**
 * Registration, login, session lifecycle and profile.
 *
 * Email verification is deliberately not required: the prototype must be
 * usable with no mail provider configured. The `email_verified_at` column
 * exists so enabling verification later is a policy change, not a migration.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuditService,
    private readonly emailService: EmailService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async register(
    dto: RegisterDto,
    session: SessionContext,
    correlationId?: string,
  ): Promise<{ tokens: IssuedTokens; profile: UserProfileResponse }> {
    const existing = await this.db.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      [dto.email],
    );
    if (existing) {
      // Registration necessarily reveals whether an address is taken — there
      // is no way to create an account without it. Login does not leak this.
      throw ApiError.conflict(
        ErrorCode.ALREADY_EXISTS,
        'An account with this email address already exists',
      );
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    const result = await this.db.transaction(async (client) => {
      // Self-registration always yields the least-privileged role. Elevation
      // is an explicit administrative act, never a field in this request.
      const userRows = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, full_name, job_title, role, status)
         VALUES ($1, $2, $3, $4, 'LAB_TECHNICIAN', 'ACTIVE')
         RETURNING *`,
        [dto.email, passwordHash, dto.fullName, dto.jobTitle ?? null],
      );
      const user = userRows.rows[0];

      if (dto.laboratoryCode) {
        const labRows = await client.query<{ id: string; status: string }>(
          'SELECT id, status FROM laboratories WHERE code = $1',
          [dto.laboratoryCode],
        );
        const lab = labRows.rows[0];

        if (!lab) {
          throw ApiError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            `No laboratory exists with code "${dto.laboratoryCode}"`,
          );
        }
        if (lab.status !== 'ACTIVE') {
          throw ApiError.badRequest(
            ErrorCode.CONFLICTING_STATE,
            'That laboratory is not accepting members',
          );
        }

        await client.query(
          `INSERT INTO laboratory_memberships
             (laboratory_id, user_id, role, status, accepted_at)
           VALUES ($1, $2, 'LAB_TECHNICIAN', 'ACTIVE', now())`,
          [lab.id, user.id],
        );
      }

      return user;
    });

    const tokens = await this.tokenService.issueTokens(
      {
        id: result.id,
        email: result.email,
        role: result.role,
        tokenVersion: result.token_version,
      },
      session,
    );

    await this.auditService.record({
      actorUserId: result.id,
      actorEmail: result.email,
      action: AuditAction.AUTH_REGISTER,
      resourceType: 'user',
      resourceId: result.id,
      correlationId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      metadata: { laboratoryCode: dto.laboratoryCode ?? null },
    });

    // Fire-and-forget: a mail failure must not fail registration, and when no
    // provider is configured this records "disabled" rather than pretending.
    void this.emailService.sendWelcome({
      to: result.email,
      fullName: result.full_name,
    });

    return {
      tokens,
      profile: await this.buildProfile(result.id),
    };
  }

  async login(
    dto: LoginDto,
    session: SessionContext,
    correlationId?: string,
  ): Promise<{ tokens: IssuedTokens; profile: UserProfileResponse }> {
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [
      dto.email,
    ]);

    // Verify against a dummy hash when the account does not exist, so that a
    // probe cannot distinguish "unknown email" from "wrong password" by
    // response time. Argon2 is slow by design; skipping it would be a tell.
    if (!user) {
      await this.dummyVerify();
      await this.auditService.record({
        actorEmail: dto.email,
        action: AuditAction.AUTH_LOGIN_FAILED,
        outcome: 'FAILURE',
        correlationId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        metadata: { reason: 'unknown_email' },
      });
      throw ApiError.unauthorized(
        ErrorCode.INVALID_CREDENTIALS,
        'Email or password is incorrect',
      );
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60000);
      throw ApiError.forbidden(
        ErrorCode.ACCOUNT_SUSPENDED,
        `Too many failed attempts. Try again in ${minutes} minute(s).`,
      );
    }

    const valid = await argon2.verify(user.password_hash, dto.password);

    if (!valid) {
      await this.registerFailedLogin(user);
      await this.auditService.record({
        actorUserId: user.id,
        actorEmail: user.email,
        action: AuditAction.AUTH_LOGIN_FAILED,
        outcome: 'FAILURE',
        correlationId,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        metadata: { reason: 'bad_password' },
      });
      throw ApiError.unauthorized(
        ErrorCode.INVALID_CREDENTIALS,
        'Email or password is incorrect',
      );
    }

    if (user.status !== 'ACTIVE') {
      throw ApiError.forbidden(
        ErrorCode.ACCOUNT_SUSPENDED,
        `Account status is ${user.status}`,
      );
    }

    // Successful login: clear the failure counter and record the timestamp.
    await this.db.query(
      `UPDATE users
          SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [user.id],
    );

    // Opportunistic rehash if the cost parameters have since been raised.
    if (argon2.needsRehash(user.password_hash, ARGON2_OPTIONS)) {
      const rehashed = await argon2.hash(dto.password, ARGON2_OPTIONS);
      await this.db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        user.id,
        rehashed,
      ]);
      this.logger.log({ userId: user.id }, 'Password hash upgraded');
    }

    const tokens = await this.tokenService.issueTokens(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tokenVersion: user.token_version,
      },
      session,
    );

    await this.auditService.record({
      actorUserId: user.id,
      actorEmail: user.email,
      action: AuditAction.AUTH_LOGIN,
      resourceType: 'user',
      resourceId: user.id,
      correlationId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });

    return { tokens, profile: await this.buildProfile(user.id) };
  }

  async refresh(
    presentedToken: string,
    session: SessionContext,
    correlationId?: string,
  ): Promise<{ tokens: IssuedTokens; profile: UserProfileResponse }> {
    const { tokens, userId } = await this.tokenService.rotateRefreshToken(
      presentedToken,
      session,
    );

    await this.auditService.record({
      actorUserId: userId,
      action: AuditAction.AUTH_REFRESH,
      correlationId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    });

    return { tokens, profile: await this.buildProfile(userId) };
  }

  async logout(
    presentedToken: string | undefined,
    actor: AuthenticatedUser | undefined,
    correlationId?: string,
  ): Promise<void> {
    if (presentedToken) {
      await this.tokenService.revokeToken(presentedToken, 'logout');
    }
    if (actor) {
      await this.auditService.record({
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: AuditAction.AUTH_LOGOUT,
        correlationId,
      });
    }
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    correlationId?: string,
  ): Promise<void> {
    const user = await this.db.queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [
      userId,
    ]);
    if (!user) throw ApiError.notFound('User');

    const valid = await argon2.verify(user.password_hash, dto.currentPassword);
    if (!valid) {
      throw ApiError.unauthorized(
        ErrorCode.INVALID_CREDENTIALS,
        'Current password is incorrect',
      );
    }

    if (dto.currentPassword === dto.newPassword) {
      throw ApiError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'The new password must differ from the current one',
      );
    }

    const newHash = await argon2.hash(dto.newPassword, ARGON2_OPTIONS);

    // Bumping token_version invalidates every outstanding access token; the
    // refresh revocation closes the refresh side. A password change should
    // end every session, including any the attacker holds.
    await this.db.transaction(async (client: PoolClient) => {
      await client.query(
        `UPDATE users
            SET password_hash = $2, token_version = token_version + 1
          WHERE id = $1`,
        [userId, newHash],
      );
      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    });

    await this.auditService.record({
      actorUserId: userId,
      actorEmail: user.email,
      action: AuditAction.AUTH_PASSWORD_CHANGED,
      resourceType: 'user',
      resourceId: userId,
      correlationId,
    });
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfileResponse> {
    const updates: string[] = [];
    const params: unknown[] = [userId];

    if (dto.fullName !== undefined) {
      params.push(dto.fullName);
      updates.push(`full_name = $${params.length}`);
    }
    if (dto.jobTitle !== undefined) {
      params.push(dto.jobTitle);
      updates.push(`job_title = $${params.length}`);
    }

    if (updates.length === 0) return this.buildProfile(userId);

    await this.db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $1`, params);
    return this.buildProfile(userId);
  }

  /** Assembles the profile returned by /auth/me and after authentication. */
  async buildProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.db.queryOne<UserRow>(
      `SELECT id, email, full_name, job_title, role, status, last_login_at, created_at
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw ApiError.notFound('User');

    const memberships = await this.db.query<{
      laboratory_id: string;
      laboratory_code: string;
      laboratory_name: string;
      role: UserRole;
    }>(
      `SELECT m.laboratory_id,
              l.code AS laboratory_code,
              l.name AS laboratory_name,
              m.role
         FROM laboratory_memberships m
         JOIN laboratories l ON l.id = m.laboratory_id
        WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND l.status = 'ACTIVE'
        ORDER BY l.name`,
      [userId],
    );

    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      jobTitle: user.job_title,
      role: user.role,
      status: user.status,
      memberships: memberships.map((row): LabMembershipSummary => ({
        laboratoryId: row.laboratory_id,
        laboratoryCode: row.laboratory_code,
        laboratoryName: row.laboratory_name,
        role: row.role,
      })),
      permissions: permissionsForRole(user.role),
      lastLoginAt: user.last_login_at?.toISOString() ?? null,
      createdAt: user.created_at.toISOString(),
    };
  }

  private async registerFailedLogin(user: UserRow): Promise<void> {
    const attempts = user.failed_login_count + 1;
    const shouldLock = attempts >= MAX_FAILED_LOGINS;

    await this.db.query(
      `UPDATE users
          SET failed_login_count = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [user.id, attempts, shouldLock, String(LOCKOUT_MINUTES)],
    );

    if (shouldLock) {
      this.logger.warn(
        { userId: user.id, attempts },
        'Account locked after repeated failed logins',
      );
    }
  }

  /**
   * Burns roughly the same time as a real verification, so an attacker cannot
   * enumerate accounts by measuring how fast the rejection comes back.
   */
  private async dummyVerify(): Promise<void> {
    // A fixed, syntactically valid Argon2id hash of a value nobody uses.
    const DUMMY_HASH =
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEyMw$' +
      'KpP8jPEMNRHPnLlhLjMOA8/RCDH8OM3Y+n0k6gFhcNI';
    try {
      await argon2.verify(DUMMY_HASH, 'not-a-real-password');
    } catch {
      // Expected to fail or be unverifiable; the point is the elapsed time.
    }
  }
}
