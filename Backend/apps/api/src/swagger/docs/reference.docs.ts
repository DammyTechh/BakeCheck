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
  CreateReferenceChartDto,
  CreateReferenceLevelDto,
  CreateTestMethodDto,
  UpdateReferenceChartDto,
  UpdateReferenceLevelDto,
  UpdateTestMethodDto,
} from '../../modules/reference-data/dto/reference.dto';

/**
 * OpenAPI documentation for test methods and reference charts.
 *
 * ## Validation status is the central concept
 *
 * Every method, chart and level carries a `validationStatus`, and the
 * analysis pipeline reads it when deciding what it may report:
 *
 * | Status         | Meaning |
 * |----------------|---------|
 * | `DRAFT`        | Being configured. Usable for screening; nothing is established. |
 * | `ILLUSTRATIVE` | Colours came from a picture, not from measured standards. **Not a calibration.** |
 * | `REVIEWED`     | A second person has checked it. Still not a validated reference. |
 * | `VALIDATED`    | Traceable to prepared standards measured under controlled conditions. |
 * | `ARCHIVED`     | Superseded. Retained so historical results keep their reference. |
 *
 * Reaching `REVIEWED` or `VALIDATED` requires the `reference:validate`
 * capability and records who made the call and when.
 *
 * A chart built from a photograph defaults to `ILLUSTRATIVE` and should stay
 * there. Reading pixels off an image tells you what the image looks like; it
 * establishes no relationship between a colour and a concentration in any
 * sample matrix.
 *
 * ## Colour values
 *
 * Matching uses **CIELAB**, not RGB. Supply `labL`/`labA`/`labB` when you
 * have them; supply RGB and the server converts (sRGB, D65 assumed). A level
 * with neither cannot take part in matching, and is reported with
 * `usableForMatching: false`.
 */
export const ReferenceDocs = {
  createMethod: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Create a test method',
        description: [
          'Defines a test method: what it looks for, in what matrix, by what',
          'procedure.',
          '',
          'Created as `DRAFT`. This platform supplies no chemistry — the',
          'reagent system, preparation protocol, detection limits and',
          "thresholds must come from your laboratory's own validated SOP.",
          '`procedureReference` and `reagentNotes` are free text recorded as',
          'provenance, not validated by this system.',
          '',
          '`applicableMatrix` matters: a method validated for bread crumb',
          'extract is not thereby valid for flour, and the matrix travels with',
          'every result derived from the method.',
          '',
          'Omitting `laboratoryId` creates a **platform-wide** method visible',
          'to every laboratory, which requires SUPER_ADMIN.',
        ].join('\n'),
      }),
      ApiBody({ type: CreateTestMethodDto }),
      ApiCreatedResponse({ description: 'Test method created with status DRAFT.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse(
        'Only a platform administrator can create a platform-wide test method',
      ),
      ConflictResponse('A method with this code and version already exists'),
    ),

  listMethods: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List test methods',
        description:
          "Returns methods belonging to the caller's laboratories plus any " +
          'platform-wide ones. Filter by `validationStatus` to find methods ' +
          'not yet validated.',
      }),
      ApiOkResponse({ description: 'Paginated test methods.' }),
      UnauthorizedResponse(),
    ),

  getMethod: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({ summary: 'Get a test method' }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'The test method.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Test method'),
    ),

  updateMethod: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update a test method',
        description: [
          'Updates method metadata and validation status.',
          '',
          '**Setting `validationStatus` to `REVIEWED` or `VALIDATED` requires',
          'the `reference:validate` capability** and records the caller as the',
          'validating reviewer with a timestamp.',
          '',
          'Marking a method VALIDATED is a scientific claim: that its',
          'performance has been established for the stated matrix, with known',
          'detection limits and measurement uncertainty. The system records',
          'who made that claim.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: UpdateTestMethodDto }),
      ApiOkResponse({ description: 'The updated test method.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse(
        'Marking reference data as VALIDATED requires: reference:validate',
      ),
      NotFoundResponse('Test method'),
    ),

  createChart: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Create a reference chart',
        description: [
          'Creates a colour chart for a test method, optionally with its',
          'levels in the same request.',
          '',
          '**Defaults to `ILLUSTRATIVE`**, which is the honest status for a',
          'chart whose colours came from an image.',
          '',
          '**Versioning**: `version` is assigned automatically from the',
          'highest existing version for this method and name. Pass',
          '`supersedesId` to replace an earlier chart — the old one is',
          'archived rather than deleted, so historical results keep pointing',
          'at the version that actually produced them.',
          '',
          '**Colour**: supply CIELAB where you have it. RGB alone is accepted',
          'and converted (sRGB, D65). `illuminant` and `captureDevice` are',
          'worth recording — without them, colour comparison across devices is',
          'unreliable, and the pipeline says so in its warnings.',
        ].join('\n'),
      }),
      ApiBody({
        type: CreateReferenceChartDto,
        examples: {
          withLevels: {
            summary: 'Chart with a six-step ladder',
            value: {
              testMethodId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
              name: 'Bromate colour ladder, lot 2026-A',
              source: 'Vendor insert, lot 2026-A',
              illuminant: 'D65',
              validationStatus: 'ILLUSTRATIVE',
              levels: [
                {
                  label: 'No Bromate',
                  concentrationValue: 0,
                  sortOrder: 0,
                  rgbR: 240,
                  rgbG: 240,
                  rgbB: 240,
                },
                {
                  label: 'Trace Amount',
                  concentrationValue: 0.1,
                  sortOrder: 1,
                  rgbR: 212,
                  rgbG: 236,
                  rgbB: 244,
                },
                {
                  label: 'Low Level',
                  concentrationValue: 0.5,
                  sortOrder: 2,
                  rgbR: 120,
                  rgbG: 207,
                  rgbB: 247,
                },
                {
                  label: 'Moderate Level',
                  concentrationValue: 1,
                  sortOrder: 3,
                  rgbR: 1,
                  rgbG: 132,
                  rgbB: 241,
                },
                {
                  label: 'High Level',
                  concentrationValue: 5,
                  sortOrder: 4,
                  rgbR: 1,
                  rgbG: 38,
                  rgbB: 156,
                },
                {
                  label: 'Very High Level',
                  concentrationValue: 10,
                  sortOrder: 5,
                  rgbR: 2,
                  rgbG: 5,
                  rgbB: 112,
                },
              ],
            },
          },
        },
      }),
      ApiCreatedResponse({ description: 'Chart created with its levels.' }),
      BadRequestResponse('Reference level "Low Level" has no colour.', undefined),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: reference:manage'),
      NotFoundResponse('Test method'),
    ),

  listCharts: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List reference charts',
        description:
          'Charts visible to the caller. Each carries `levelCount`, ' +
          '`usableLevelCount` (levels with CIELAB values) and ' +
          '`isIllustrativeOnly`.',
      }),
      ApiOkResponse({ description: 'Paginated reference charts.' }),
      UnauthorizedResponse(),
    ),

  getChart: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get a reference chart',
        description:
          'The chart with all its levels in ladder order. Each level reports ' +
          '`usableForMatching` — false means it has no CIELAB value and will ' +
          'be skipped during matching.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'The chart and its levels.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Reference chart'),
    ),

  updateChart: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update a reference chart',
        description:
          'Updates chart metadata or validation status. Set `isActive: false` ' +
          'to archive it; historical results keep their link to it.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: UpdateReferenceChartDto }),
      ApiOkResponse({ description: 'The updated chart.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse(
        'Marking reference data as VALIDATED requires: reference:validate',
      ),
      NotFoundResponse('Reference chart'),
    ),

  addLevel: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Add a level to a chart',
        description:
          'Adds one step to the ladder. `sortOrder` must be unique within ' +
          'the chart and should follow concentration order — the ' +
          'out-of-range check projects a measurement onto the line between ' +
          'the first and last levels.',
      }),
      ApiParam({ name: 'id', description: 'Reference chart id', format: 'uuid' }),
      ApiBody({ type: CreateReferenceLevelDto }),
      ApiCreatedResponse({ description: 'The chart with its new level.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: reference:manage'),
      NotFoundResponse('Reference chart'),
      ConflictResponse(
        'A level already occupies that sort order',
        ErrorCode.ALREADY_EXISTS,
      ),
    ),

  updateLevel: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Update a reference level',
        description: [
          "Updates one level's label, concentration or colour.",
          '',
          'Supplying RGB without CIELAB recomputes Lab automatically — the',
          'two are kept consistent, because a level whose RGB and Lab',
          'disagreed would match against one value while displaying another.',
          '',
          '`colorSource` records how the colour was obtained.',
          '`IMAGE_SAMPLED` means it was read off a picture, which is not a',
          'calibrated colorimetric measurement.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Reference level id', format: 'uuid' }),
      ApiBody({ type: UpdateReferenceLevelDto }),
      ApiOkResponse({ description: 'The chart containing the updated level.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: reference:manage'),
      NotFoundResponse('Reference level'),
    ),
};
