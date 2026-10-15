import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { IS_PUBLIC_KEY } from '../decorators';
import { ApiError, ErrorCode } from '../errors/api-error';
import {
  AccessTokenPayload,
  AuthenticatedRequest,
  LabMembershipSummary,
} from '../types/request-context';
import { UserRole } from '../types/roles';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: string;
  token_version: number;
}

interface MembershipRow {
  laboratory_id: string;
  laboratory_code: string;
  laboratory_name: string;
  role: UserRole;
}

/**
 * Verifies the bearer access token and loads the caller.
 *
 * Applied globally in AppModule, so a route is protected unless it opts out
 * with @Public() — the safe default: forgetting a decorator leaves a route
 * locked rather than open.
 *
 * The user record is re-read on every request rather than trusted from the
 * token. That costs one indexed query but means a suspended account or a
 * revoked session stops working immediately, instead of lingering until the
 * access token expires.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly db: DatabaseService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw ApiError.unauthorized(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'An access token is required',
      );
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.auth.accessSecret,
      });
    } catch (error) {
      const expired = (error as Error)?.name === 'TokenExpiredError';
      throw ApiError.unauthorized(
        expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        expired ? 'Access token has expired' : 'Access token is invalid',
      );
    }

    const user = await this.db.queryOne<UserRow>(
      `SELECT id, email, full_name, role, status, token_version
         FROM users
        WHERE id = $1`,
      [payload.sub],
    );

    if (!user) {
      throw ApiError.unauthorized(ErrorCode.TOKEN_INVALID, 'Account no longer exists');
    }

    // A password change or forced logout bumps token_version, which retires
    // every access token issued before it.
    if (user.token_version !== payload.tv) {
      throw ApiError.unauthorized(
        ErrorCode.TOKEN_INVALID,
        'Session has been revoked; sign in again',
      );
    }

    if (user.status !== 'ACTIVE') {
      throw ApiError.forbidden(
        ErrorCode.ACCOUNT_SUSPENDED,
        `Account status is ${user.status}`,
      );
    }

    const memberships = await this.db.query<MembershipRow>(
      `SELECT m.laboratory_id,
              l.code AS laboratory_code,
              l.name AS laboratory_name,
              m.role
         FROM laboratory_memberships m
         JOIN laboratories l ON l.id = m.laboratory_id
        WHERE m.user_id = $1
          AND m.status = 'ACTIVE'
          AND l.status = 'ACTIVE'`,
      [user.id],
    );

    request.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      status: user.status,
      tokenVersion: user.token_version,
      memberships: memberships.map((row): LabMembershipSummary => ({
        laboratoryId: row.laboratory_id,
        laboratoryCode: row.laboratory_code,
        laboratoryName: row.laboratory_name,
        role: row.role,
      })),
    };

    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    // Case-insensitive scheme, but the token itself must be present.
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
