import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AuthenticatedRequest, AuthenticatedUser } from '../types/request-context';
import { Permission, UserRole } from '../types/roles';

/** Marks a route as reachable without authentication. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires every listed capability. */
export const PERMISSIONS_KEY = 'requiredPermissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Requires one of the listed platform roles. */
export const ROLES_KEY = 'requiredRoles';
export const RequireRoles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Declares that a route operates inside one laboratory, and names the request
 * property holding its id. LaboratoryScopeGuard reads this and verifies the
 * caller's membership before the handler runs.
 */
export const LAB_SCOPE_KEY = 'laboratoryScope';
export interface LabScopeOptions {
  /** Where to find the laboratory id. */
  source: 'param' | 'query' | 'body' | 'resolved';
  /** Property name within that source. */
  key: string;
  /** When false, a missing id is allowed (cross-lab listing endpoints). */
  required?: boolean;
}
export const LaboratoryScope = (options: LabScopeOptions) =>
  SetMetadata(LAB_SCOPE_KEY, options);

/** The authenticated user, or one of its properties. */
export const CurrentUser = createParamDecorator(
  (property: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return property ? request.user?.[property] : request.user;
  },
);

/** The laboratory id resolved and authorised by LaboratoryScopeGuard. */
export const CurrentLaboratory = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().laboratoryId,
);

/** The per-request correlation id, for propagation to the AI service. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().correlationId,
);
