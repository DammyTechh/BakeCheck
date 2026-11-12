/**
 * Role model.
 *
 * A user carries a platform role on `users.role` and a per-laboratory role on
 * `laboratory_memberships.role`. Laboratory-scoped checks always use the
 * membership role; the platform role only elevates SUPER_ADMIN, which is the
 * single role allowed to cross laboratory boundaries.
 */
export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  LAB_ADMIN = 'LAB_ADMIN',
  LAB_TECHNICIAN = 'LAB_TECHNICIAN',
  LAB_REVIEWER = 'LAB_REVIEWER',
}

/**
 * Capabilities, named after what they permit rather than who holds them.
 * Controllers ask for a capability; this file decides which roles have it.
 * Adding a role then means editing one table, not hunting every controller.
 */
export enum Permission {
  // Laboratories & membership
  LAB_READ = 'lab:read',
  LAB_UPDATE = 'lab:update',
  LAB_CREATE = 'lab:create',
  MEMBER_READ = 'member:read',
  MEMBER_MANAGE = 'member:manage',

  // Samples & analysis
  SAMPLE_READ = 'sample:read',
  SAMPLE_CREATE = 'sample:create',
  SAMPLE_UPDATE = 'sample:update',
  IMAGE_UPLOAD = 'image:upload',
  ANALYSIS_RUN = 'analysis:run',
  ANALYSIS_READ = 'analysis:read',

  // Review & confirmation
  FEEDBACK_CREATE = 'feedback:create',
  FEEDBACK_REVIEW = 'feedback:review',
  MEASUREMENT_CREATE = 'measurement:create',
  MEASUREMENT_CONFIRM = 'measurement:confirm',

  // Reference data
  REFERENCE_READ = 'reference:read',
  REFERENCE_MANAGE = 'reference:manage',
  REFERENCE_VALIDATE = 'reference:validate',

  // Model lifecycle
  MODEL_READ = 'model:read',
  MODEL_TRAIN = 'model:train',
  MODEL_APPROVE = 'model:approve',
  DATASET_APPROVE = 'dataset:approve',

  // Audit
  AUDIT_READ = 'audit:read',
}

/**
 * Role → capability table.
 *
 * Deliberate separations:
 *  • A technician can submit feedback but cannot approve their own example
 *    into a training dataset — that needs a reviewer. Self-approval would let
 *    one person's opinion become ground truth unchecked.
 *  • A technician can record a measurement but cannot mark it CONFIRMED.
 *  • Only LAB_ADMIN and SUPER_ADMIN can approve or roll back a model, because
 *    that decision changes what every future result means.
 */
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: Object.values(Permission),

  [UserRole.LAB_ADMIN]: [
    Permission.LAB_READ,
    Permission.LAB_UPDATE,
    Permission.MEMBER_READ,
    Permission.MEMBER_MANAGE,
    Permission.SAMPLE_READ,
    Permission.SAMPLE_CREATE,
    Permission.SAMPLE_UPDATE,
    Permission.IMAGE_UPLOAD,
    Permission.ANALYSIS_RUN,
    Permission.ANALYSIS_READ,
    Permission.FEEDBACK_CREATE,
    Permission.FEEDBACK_REVIEW,
    Permission.MEASUREMENT_CREATE,
    Permission.MEASUREMENT_CONFIRM,
    Permission.REFERENCE_READ,
    Permission.REFERENCE_MANAGE,
    Permission.REFERENCE_VALIDATE,
    Permission.MODEL_READ,
    Permission.MODEL_TRAIN,
    Permission.MODEL_APPROVE,
    Permission.DATASET_APPROVE,
    Permission.AUDIT_READ,
  ],

  [UserRole.LAB_REVIEWER]: [
    Permission.LAB_READ,
    Permission.MEMBER_READ,
    Permission.SAMPLE_READ,
    Permission.SAMPLE_UPDATE,
    Permission.ANALYSIS_READ,
    Permission.FEEDBACK_CREATE,
    Permission.FEEDBACK_REVIEW,
    Permission.MEASUREMENT_CREATE,
    Permission.MEASUREMENT_CONFIRM,
    Permission.REFERENCE_READ,
    Permission.REFERENCE_MANAGE,
    Permission.REFERENCE_VALIDATE,
    Permission.MODEL_READ,
    Permission.DATASET_APPROVE,
    Permission.AUDIT_READ,
  ],

  [UserRole.LAB_TECHNICIAN]: [
    Permission.LAB_READ,
    Permission.MEMBER_READ,
    Permission.SAMPLE_READ,
    Permission.SAMPLE_CREATE,
    Permission.SAMPLE_UPDATE,
    Permission.IMAGE_UPLOAD,
    Permission.ANALYSIS_RUN,
    Permission.ANALYSIS_READ,
    Permission.FEEDBACK_CREATE,
    Permission.MEASUREMENT_CREATE,
    Permission.REFERENCE_READ,
    Permission.MODEL_READ,
  ],
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForRole(role: UserRole): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}
