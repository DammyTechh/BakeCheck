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
  TooManyRequestsResponse,
  UnauthorizedResponse,
} from '../shared/responses';
import { CreateSampleDto, UpdateSampleDto } from '../../modules/samples/dto/sample.dto';
import {
  PaginatedSamplesResponse,
  SampleResponse,
} from '../../modules/samples/dto/sample.response';

/**
 * OpenAPI documentation for /api/v1/samples/*.
 *
 * Laboratory isolation applies to every route here: a sample is only visible
 * to members of the laboratory that registered it. Requesting a sample from
 * another laboratory returns 404, never 403 — the two cases are deliberately
 * indistinguishable so record existence is not disclosed.
 */
export const SamplesDocs = {
  create: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Register a sample',
        description: [
          "Creates a sample record in one of the caller's laboratories.",
          '',
          "`sampleCode` is your laboratory's own identifier and must be",
          'unique within that laboratory. Two laboratories may use the same',
          'code without clashing.',
          '',
          '`preparationNotes` and `dilutionFactor` record what your',
          'laboratory actually did. This platform supplies no preparation',
          'protocol and validates none — the values are stored as provenance',
          'for results derived from this sample.',
          '',
          'Requires the `sample:create` capability (LAB_TECHNICIAN and above).',
        ].join('\n'),
      }),
      ApiBody({
        type: CreateSampleDto,
        examples: {
          bread: {
            summary: 'Bread sample with a method assigned',
            value: {
              laboratoryId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              sampleCode: 'BG-2026-0042',
              sampleType: 'bread',
              productName: 'White sandwich loaf',
              batchReference: 'LOT-88213',
              manufacturer: 'Example Bakery Ltd',
              testMethodId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
              preparationNotes: '10 g crumb extracted per in-house SOP BG-SOP-04 rev 2.',
              dilutionFactor: 10,
            },
          },
        },
      }),
      ApiCreatedResponse({ type: SampleResponse }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: sample:create'),
      NotFoundResponse('Laboratory'),
      ConflictResponse('Sample code "BG-2026-0042" is already in use in this laboratory'),
      TooManyRequestsResponse(),
    ),

  list: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List samples',
        description: [
          'Returns a paginated list of samples for one laboratory.',
          '',
          '`laboratoryId` is required and must be one the caller belongs to.',
          'There is no endpoint that returns samples across laboratories.',
          '',
          '**Filtering**: `search` matches sample code, product name and batch',
          'reference. `status`, `sampleType`, `testMethodId`, `receivedFrom`',
          'and `receivedTo` narrow further and combine with AND.',
          '',
          '**Sorting**: `sortBy` accepts `createdAt`, `receivedAt`,',
          '`sampleCode` or `status`; anything else falls back to `createdAt`.',
        ].join('\n'),
      }),
      ApiOkResponse({ type: PaginatedSamplesResponse }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      NotFoundResponse('Laboratory'),
    ),

  findOne: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get a sample',
        description:
          'Returns one sample with its method, technician and counts of ' +
          'images, analyses and confirmatory measurements. A ' +
          '`measurementCount` of 0 means nothing about this sample has been ' +
          'chemically confirmed.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ type: SampleResponse }),
      UnauthorizedResponse(),
      NotFoundResponse('Sample'),
    ),

  update: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update a sample',
        description: [
          'Updates sample metadata and status.',
          '',
          'Only the fields declared on the request body are updatable.',
          'Unknown properties are rejected outright rather than ignored, so a',
          'client cannot reach columns such as `laboratory_id` or',
          '`created_by` through this endpoint.',
          '',
          'Requires the `sample:update` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: UpdateSampleDto }),
      ApiOkResponse({ type: SampleResponse }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: sample:update'),
      NotFoundResponse('Sample'),
    ),
};
