import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import {
  BadRequestResponse,
  ConflictResponse,
  ForbiddenResponse,
  NotFoundResponse,
  UnauthorizedResponse,
} from '../shared/responses';
import { ErrorCode } from '../../common/errors/api-error';
import {
  AddMemberDto,
  CreateLaboratoryDto,
  UpdateLaboratoryDto,
  UpdateMemberDto,
} from '../../modules/laboratories/dto/laboratory.dto';

/**
 * OpenAPI documentation for laboratories and membership.
 *
 * ## Isolation
 *
 * A laboratory is the unit of data isolation. Samples, images, analyses,
 * measurements and annotations all belong to exactly one, and a member of one
 * laboratory cannot read another's records.
 *
 * Attempting to reach another laboratory's data returns **404, not 403** —
 * the two cases are deliberately indistinguishable, because a 403 would
 * confirm that a record with that id exists.
 *
 * ## Roles
 *
 * Roles are per laboratory, not global. The same person may be LAB_ADMIN in
 * one and LAB_TECHNICIAN in another, and their capabilities are evaluated
 * against the laboratory being accessed. SUPER_ADMIN is the only role that
 * crosses laboratory boundaries.
 */
export const LaboratoriesDocs = {
  create: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Register a laboratory',
        description:
          'Creates a laboratory and makes the caller its LAB_ADMIN in the ' +
          'same transaction — a laboratory with no administrator would be ' +
          'immediately unmanageable. `code` must be unique platform-wide.',
      }),
      ApiBody({ type: CreateLaboratoryDto }),
      ApiCreatedResponse({ description: 'Laboratory created; caller is LAB_ADMIN.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ConflictResponse('Laboratory code "LAG-CENTRAL-01" is already in use'),
    ),

  list: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List your laboratories',
        description:
          'Returns only laboratories the caller belongs to. There is no ' +
          'endpoint that lists every laboratory on the platform, except for ' +
          'SUPER_ADMIN.',
      }),
      ApiOkResponse({ description: 'Paginated laboratories.' }),
      UnauthorizedResponse(),
    ),

  findOne: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({ summary: 'Get a laboratory' }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'The laboratory, with member and sample counts.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Laboratory'),
    ),

  update: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update a laboratory',
        description:
          'Updates laboratory details. Changing `status` affects every ' +
          'member and is restricted to platform administrators. Requires the ' +
          '`lab:update` capability.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: UpdateLaboratoryDto }),
      ApiOkResponse({ description: 'The updated laboratory.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: lab:update'),
      NotFoundResponse('Laboratory'),
    ),

  listMembers: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List laboratory members',
        description:
          'Members with their per-laboratory role and status, ordered by ' +
          'role seniority then name.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'Laboratory members.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Laboratory'),
    ),

  addMember: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Add a member',
        description: [
          'Adds an **existing** account to this laboratory.',
          '',
          'This endpoint does not create users. That is deliberate: creating',
          'an account here would mean an administrator setting another',
          "person's password. People register themselves, then an",
          'administrator grants access.',
          '',
          'An invitation email is attempted but never blocking — when no mail',
          'provider is configured the membership is still created, and the',
          'email is recorded as disabled rather than reported as sent.',
          '',
          'Granting SUPER_ADMIN requires SUPER_ADMIN. Requires the',
          '`member:manage` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: AddMemberDto }),
      ApiCreatedResponse({ description: 'Member added.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: member:manage'),
      NotFoundResponse('User'),
      ConflictResponse('That user is already a member of this laboratory.'),
    ),

  updateMember: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: "Change a member's role or revoke access",
        description: [
          "Updates a member's role or status within this laboratory.",
          '',
          '**The last administrator cannot be demoted or revoked.** Promote',
          'another member first — otherwise the laboratory would be left',
          'unmanageable and would need a database fix.',
          '',
          'Requires the `member:manage` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Laboratory id', format: 'uuid' }),
      ApiParam({ name: 'userId', format: 'uuid' }),
      ApiBody({ type: UpdateMemberDto }),
      ApiOkResponse({ description: 'Membership updated.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: member:manage'),
      NotFoundResponse('Membership'),
      ConflictResponse(
        "This is the laboratory's only administrator.",
        ErrorCode.CONFLICTING_STATE,
      ),
    ),
};
