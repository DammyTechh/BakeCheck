import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../../common/types/request-context';
import { UserRole } from '../../common/types/roles';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

/**
 * Issues and rotates tokens.
 *
 * Design:
 *  • Access tokens are short-lived JWTs, verified statelessly.
 *  • Refresh tokens are opaque random values. Only a SHA-256 hash is stored,
 *    so a database disclosure does not hand out usable sessions.
 *  • Every refresh rotates: the presented token is revoked and a new one
 *    issued. Presenting an already-rotated token means it leaked, so the
 *    entire family is revoked — which logs out the thief *and* the legitimate
 *    user, who then re-authenticates. That is the intended trade-off.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly db: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /**
   * SHA-256, not Argon2: refresh tokens are 256 bits of CSPRNG output, so
   * there is no low-entropy guess to slow down, and this runs on every
   * refresh. Argon2 here would cost latency and buy nothing.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async signAccessToken(user: {
    id: string;
    email: string;
    role: UserRole;
    tokenVersion: number;
  }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.tokenVersion,
    };
    return this.jwtService.signAsync(payload, {
      secret: this.config.auth.accessSecret,
      expiresIn: this.config.auth.accessTtlSeconds,
    });
  }

  /** Creates a new refresh-token row, optionally continuing an existing family. */
  private async createRefreshToken(
    userId: string,
    familyId: string | null,
    session: SessionContext,
  ): Promise<{ token: string; id: string; familyId: string; expiresAt: Date }> {
    const secret = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(secret);
    const expiresAt = new Date(Date.now() + this.config.auth.refreshTtlSeconds * 1000);
    const family = familyId ?? randomUUID();

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        userId,
        tokenHash,
        family,
        session.userAgent?.slice(0, 500) ?? null,
        this.normaliseIp(session.ipAddress),
        expiresAt,
      ],
    );

    if (!row) throw ApiError.internal('Failed to persist refresh token');

    // The value handed to the client is a signed JWT wrapping the opaque
    // secret. The JWT gives us expiry and tamper-evidence for free; the
    // secret is what is actually verified against the database.
    const payload: RefreshTokenPayload = {
      sub: userId,
      jti: row.id,
      fam: family,
    };
    const token = await this.jwtService.signAsync(
      { ...payload, s: secret },
      {
        secret: this.config.auth.refreshSecret,
        expiresIn: this.config.auth.refreshTtlSeconds,
      },
    );

    return { token, id: row.id, familyId: family, expiresAt };
  }

  /** Issues a fresh token pair at login. Starts a new rotation family. */
  async issueTokens(
    user: { id: string; email: string; role: UserRole; tokenVersion: number },
    session: SessionContext,
  ): Promise<IssuedTokens> {
    const accessToken = await this.signAccessToken(user);
    const refresh = await this.createRefreshToken(user.id, null, session);

    return {
      accessToken,
      refreshToken: refresh.token,
      accessTokenExpiresIn: this.config.auth.accessTtlSeconds,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  /**
   * Rotates a refresh token.
   *
   * Rejects, in order: a malformed or expired JWT; an unknown row; a secret
   * that does not match the stored hash; an expired row; and a token that has
   * already been rotated or revoked — the last of which triggers family-wide
   * revocation.
   */
  async rotateRefreshToken(
    presentedToken: string,
    session: SessionContext,
  ): Promise<{ tokens: IssuedTokens; userId: string; reuseDetected: boolean }> {
    let payload: RefreshTokenPayload & { s: string };
    try {
      payload = await this.jwtService.verifyAsync(presentedToken, {
        secret: this.config.auth.refreshSecret,
      });
    } catch (error) {
      const expired = (error as Error)?.name === 'TokenExpiredError';
      throw ApiError.unauthorized(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? 'Refresh token has expired' : 'Refresh token is invalid',
      );
    }

    const stored = await this.db.queryOne<RefreshTokenRow>(
      `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by
         FROM refresh_tokens
        WHERE id = $1`,
      [payload.jti],
    );

    if (!stored || stored.user_id !== payload.sub) {
      throw ApiError.unauthorized(ErrorCode.TOKEN_INVALID, 'Refresh token is invalid');
    }

    // Confirm the presented secret actually hashes to the stored value.
    const presentedHash = this.hashToken(payload.s);
    const matches = await this.db.queryOne<{ ok: boolean }>(
      `SELECT (token_hash = $1) AS ok FROM refresh_tokens WHERE id = $2`,
      [presentedHash, stored.id],
    );
    if (!matches?.ok) {
      throw ApiError.unauthorized(ErrorCode.TOKEN_INVALID, 'Refresh token is invalid');
    }

    // Already rotated or revoked → the token leaked. Burn the family.
    if (stored.revoked_at || stored.replaced_by) {
      await this.revokeFamily(stored.family_id, 'refresh_token_reuse_detected');
      this.logger.warn(
        { userId: stored.user_id, familyId: stored.family_id },
        'Refresh token reuse detected; revoked entire token family',
      );
      throw ApiError.unauthorized(
        ErrorCode.TOKEN_REUSED,
        'This session has been invalidated. Please sign in again.',
      );
    }

    if (stored.expires_at.getTime() <= Date.now()) {
      throw ApiError.unauthorized(ErrorCode.TOKEN_EXPIRED, 'Refresh token has expired');
    }

    const user = await this.db.queryOne<{
      id: string;
      email: string;
      role: UserRole;
      token_version: number;
      status: string;
    }>(`SELECT id, email, role, token_version, status FROM users WHERE id = $1`, [
      stored.user_id,
    ]);

    if (!user) {
      throw ApiError.unauthorized(ErrorCode.TOKEN_INVALID, 'Account no longer exists');
    }
    if (user.status !== 'ACTIVE') {
      throw ApiError.forbidden(
        ErrorCode.ACCOUNT_SUSPENDED,
        `Account status is ${user.status}`,
      );
    }

    // Issue the successor, then point the old row at it. Doing it in this
    // order means a crash in between leaves an unused new token rather than a
    // revoked old one with no replacement.
    const successor = await this.createRefreshToken(user.id, stored.family_id, session);

    await this.db.query(
      `UPDATE refresh_tokens
          SET revoked_at = now(),
              revoked_reason = 'rotated',
              replaced_by = $2
        WHERE id = $1`,
      [stored.id, successor.id],
    );

    const accessToken = await this.signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.token_version,
    });

    return {
      tokens: {
        accessToken,
        refreshToken: successor.token,
        accessTokenExpiresIn: this.config.auth.accessTtlSeconds,
        refreshTokenExpiresAt: successor.expiresAt,
      },
      userId: user.id,
      reuseDetected: false,
    };
  }

  /** Revokes one token (logout). Silent when the token is unrecognised. */
  async revokeToken(presentedToken: string, reason = 'logout'): Promise<string | null> {
    try {
      const payload = await this.jwtService.verifyAsync<
        RefreshTokenPayload & { s: string }
      >(presentedToken, { secret: this.config.auth.refreshSecret });

      await this.db.query(
        `UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = $2
          WHERE id = $1 AND revoked_at IS NULL`,
        [payload.jti, reason],
      );
      return payload.sub;
    } catch {
      // Logging out with a bad token is not an error worth surfacing.
      return null;
    }
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
  }

  /** Revokes every session for a user. Used on password change. */
  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  }

  /** Housekeeping: drop rows that expired more than 30 days ago. */
  async purgeExpired(): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM refresh_tokens
        WHERE expires_at < now() - interval '30 days'
        RETURNING id`,
    );
    return rows.length;
  }

  private normaliseIp(value?: string | null): string | null {
    if (!value) return null;
    const cleaned = value.replace(/^::ffff:/, '');
    const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(cleaned);
    const isIpv6 = /^[0-9a-f:]+$/i.test(cleaned) && cleaned.includes(':');
    return isIpv4 || isIpv6 ? cleaned : null;
  }
}
