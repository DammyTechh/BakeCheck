import { Request } from 'express';
import { UserRole } from './roles';

/** One laboratory the caller belongs to, with their role there. */
export interface LabMembershipSummary {
  laboratoryId: string;
  laboratoryCode: string;
  laboratoryName: string;
  role: UserRole;
}

/**
 * The authenticated caller, resolved once per request by JwtAuthGuard and
 * attached to `req.user`. Services read this instead of re-decoding the token.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  /** Platform role. Only SUPER_ADMIN crosses laboratory boundaries. */
  role: UserRole;
  status: string;
  tokenVersion: number;
  memberships: LabMembershipSummary[];
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  correlationId: string;
  /**
   * Set by LaboratoryScopeGuard once a route's laboratory has been resolved
   * and the caller's membership verified.
   */
  laboratoryId?: string;
  laboratoryRole?: UserRole;
}

/** JWT access-token payload. Kept small: it travels on every request. */
export interface AccessTokenPayload {
  /** Subject — the user id. */
  sub: string;
  email: string;
  role: UserRole;
  /** Token version at issue time; a mismatch means the token was revoked. */
  tv: number;
  iat?: number;
  exp?: number;
}

/** Refresh-token payload. Carries the rotation family so replay is detectable. */
export interface RefreshTokenPayload {
  sub: string;
  /** Refresh-token row id. */
  jti: string;
  /** Rotation family id. */
  fam: string;
  iat?: number;
  exp?: number;
}
