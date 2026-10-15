import { Injectable } from '@nestjs/common';
import { ApiError, ErrorCode } from '../errors/api-error';
import { AuthenticatedUser } from '../types/request-context';
import { Permission, roleHasPermission, UserRole } from '../types/roles';

/**
 * Authorisation for routes keyed by a resource id rather than a laboratory id.
 *
 * `LaboratoryScopeGuard` handles routes where the laboratory is in the URL or
 * body. But `GET /analyses/:id` does not name a laboratory — it has to be
 * looked up from the record first, which is a database call and therefore not
 * something a guard should do before the handler has decided what it needs.
 *
 * So those routes resolve the owning laboratory in the service layer and then
 * call `assertAccess` here. Same rule, same failure mode as the guard: an
 * unauthorised laboratory is reported as 404, so a caller cannot probe for the
 * existence of records they may not see.
 */
@Injectable()
export class AccessControlService {
  /**
   * Confirms membership and returns the caller's role in that laboratory.
   * Throws 404 when there is no membership.
   */
  assertLaboratoryAccess(
    user: AuthenticatedUser,
    laboratoryId: string,
    resourceName = 'Resource',
  ): UserRole {
    if (user.role === UserRole.SUPER_ADMIN) return UserRole.SUPER_ADMIN;

    const membership = user.memberships.find(
      (entry) => entry.laboratoryId === laboratoryId,
    );
    if (!membership) throw ApiError.notFound(resourceName);
    return membership.role;
  }

  /**
   * Membership plus a capability check, evaluated against the caller's role in
   * that specific laboratory.
   */
  assertAccess(
    user: AuthenticatedUser,
    laboratoryId: string,
    permission: Permission,
    resourceName = 'Resource',
  ): UserRole {
    const role = this.assertLaboratoryAccess(user, laboratoryId, resourceName);

    if (!roleHasPermission(role, permission)) {
      // Here a 403 is correct: membership is already established, so the
      // caller knows the record exists. Only the capability is missing.
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `This operation requires: ${permission}`,
      );
    }
    return role;
  }

  /** Non-throwing variant, for conditional fields in a response. */
  hasAccess(user: AuthenticatedUser, laboratoryId: string): boolean {
    return (
      user.role === UserRole.SUPER_ADMIN ||
      user.memberships.some((entry) => entry.laboratoryId === laboratoryId)
    );
  }

  /** The laboratories this caller may read. Empty for SUPER_ADMIN (= all). */
  accessibleLaboratoryIds(user: AuthenticatedUser): string[] {
    return user.memberships.map((entry) => entry.laboratoryId);
  }
}
