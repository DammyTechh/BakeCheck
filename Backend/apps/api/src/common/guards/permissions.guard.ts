import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, ROLES_KEY } from '../decorators';
import { ApiError, ErrorCode } from '../errors/api-error';
import { AuthenticatedRequest } from '../types/request-context';
import { Permission, roleHasPermission, UserRole } from '../types/roles';

/**
 * Enforces @RequireRoles and @RequirePermissions.
 *
 * Runs after LaboratoryScopeGuard so that, on a laboratory-scoped route, the
 * capability check uses the caller's role *in that laboratory* rather than
 * their platform role. A LAB_ADMIN in one laboratory is an ordinary member in
 * another, and must not inherit admin powers there.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles?.length && !requiredPermissions?.length) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw ApiError.unauthorized(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Authentication is required',
      );
    }

    // Platform-role gate (e.g. SUPER_ADMIN-only routes) always uses the
    // platform role, never the laboratory one.
    if (requiredRoles?.length && !requiredRoles.includes(user.role)) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Your role does not permit this operation',
      );
    }

    if (requiredPermissions?.length) {
      // Inside a laboratory, the membership role decides.
      const effectiveRole =
        user.role === UserRole.SUPER_ADMIN
          ? UserRole.SUPER_ADMIN
          : (request.laboratoryRole ?? user.role);

      const missing = requiredPermissions.filter(
        (permission) => !roleHasPermission(effectiveRole, permission),
      );

      if (missing.length > 0) {
        throw ApiError.forbidden(
          ErrorCode.INSUFFICIENT_PERMISSIONS,
          `This operation requires: ${missing.join(', ')}`,
        );
      }
    }

    return true;
  }
}
