import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, LAB_SCOPE_KEY, LabScopeOptions } from '../decorators';
import { ApiError, ErrorCode } from '../errors/api-error';
import { AuthenticatedRequest } from '../types/request-context';
import { UserRole } from '../types/roles';

/**
 * Laboratory-level data isolation.
 *
 * On any route annotated with @LaboratoryScope, this resolves the target
 * laboratory id and confirms the caller holds an active membership there,
 * before the handler runs. It then records the caller's role *in that
 * laboratory* on the request, which is what PermissionsGuard evaluates.
 *
 * Failure is reported as 404, not 403: telling an outsider "this exists but
 * you may not see it" confirms that another laboratory holds a record with
 * that id, which is itself a disclosure.
 *
 * This is the application-layer half of isolation. The RLS policies in
 * migration 0006 are the database-layer half; both must agree.
 */
@Injectable()
export class LaboratoryScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const options = this.reflector.getAllAndOverride<LabScopeOptions>(LAB_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw ApiError.unauthorized(
        ErrorCode.AUTHENTICATION_REQUIRED,
        'Authentication is required',
      );
    }

    const laboratoryId = this.extract(request, options);

    if (!laboratoryId) {
      if (options.required === false) return true;
      throw ApiError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        `A laboratory id is required (${options.source}.${options.key})`,
      );
    }

    if (!this.isUuid(laboratoryId)) {
      throw ApiError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Laboratory id must be a UUID',
      );
    }

    const membership = user.memberships.find(
      (entry) => entry.laboratoryId === laboratoryId,
    );

    if (!membership) {
      // SUPER_ADMIN is the one role permitted to operate across laboratories.
      if (user.role === UserRole.SUPER_ADMIN) {
        request.laboratoryId = laboratoryId;
        request.laboratoryRole = UserRole.SUPER_ADMIN;
        return true;
      }
      throw ApiError.notFound('Laboratory');
    }

    request.laboratoryId = laboratoryId;
    request.laboratoryRole = membership.role;
    return true;
  }

  private extract(
    request: AuthenticatedRequest,
    options: LabScopeOptions,
  ): string | undefined {
    switch (options.source) {
      case 'param':
        return (request.params as Record<string, string>)?.[options.key];
      case 'query':
        return (request.query as Record<string, string>)?.[options.key];
      case 'body':
        return (request.body as Record<string, string>)?.[options.key];
      case 'resolved':
        // Already placed on the request by an earlier step.
        return request.laboratoryId;
      default:
        return undefined;
    }
  }

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
