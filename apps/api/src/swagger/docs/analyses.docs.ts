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
  AiServiceUnavailableResponse,
  BadRequestResponse,
  ForbiddenResponse,
  NotFoundResponse,
  TooManyRequestsResponse,
  UnauthorizedResponse,
  UnprocessableResponse,
} from '../shared/responses';
import { ErrorCode } from '../../common/errors/api-error';
import { AnalyzeSampleDto } from '../../modules/samples/dto/sample.dto';
import { AnalysisResponse } from '../../modules/analyses/dto/analysis.response';

/**
 * OpenAPI documentation for analysis endpoints.
 *
 * ## What an analysis result is, and is not
 *
 * Every response from these endpoints is an **image-derived screening
 * estimate**. It is not a chemical measurement, and the API is built so that
 * a client cannot accidentally present it as one:
 *
 * - `isConfirmedMeasurement` is always `false` on an analysis.
 * - `prediction.estimatedConcentration` is `null` unless a validated model, a
 *   validated method and a validated reference chart all apply. In prototype
 *   reference-matching mode it is always `null`.
 * - `prediction.confidence` is `null` in `REFERENCE_MATCHING` mode, because a
 *   colour distance is a distance, not a probability.
 * - `prediction.referenceConcentration` is the value *printed on the matched
 *   reference level*. It describes the chart, not the sample.
 * - `limitations` is assembled per result from the real validation state of
 *   the method, chart and model. Display it; it is not boilerplate.
 *
 * Confirmed concentrations live in
 * `POST /samples/{id}/laboratory-measurements`.
 */
export const AnalysesDocs = {
  analyze: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Analyse an uploaded image',
        description: [
          'Runs the vision pipeline against a previously uploaded image and',
          'persists the result.',
          '',
          '**Pipeline**: decode and validate → detect the tube region →',
          'extract colour statistics → assess image quality → compare with the',
          'reference chart → model inference.',
          '',
          '**Region of interest**: omit `roi` to let the service detect the',
          'tube. Supply it to override detection, which is worth doing when',
          'the response reports `roi.mode` as `CENTER_FALLBACK` — that value',
          'means no tube was found and a central crop was measured instead.',
          '',
          '**Quality rejection is a 200, not an error.** When the image is too',
          'poor to measure, the response returns with',
          '`status: "REJECTED_QUALITY"`, the measurement intact and',
          '`prediction.label` null. The pipeline deliberately does not force a',
          'classification out of an image whose colour information is gone.',
          '',
          '**Preconditions**: the sample must have a test method assigned, and',
          'that method must have an active reference chart with at least two',
          'levels carrying CIELAB values.',
          '',
          'Requires the `analysis:run` capability. Rate-limited more tightly',
          'than ordinary endpoints, because each call is CPU-heavy.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiBody({
        type: AnalyzeSampleDto,
        examples: {
          automatic: {
            summary: 'Let the service find the tube',
            value: { imageId: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' },
          },
          manualRegion: {
            summary: 'Specify the region manually',
            value: {
              imageId: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
              roi: { x: 420, y: 680, width: 180, height: 320 },
            },
          },
        },
      }),
      ApiCreatedResponse({
        description: 'Analysis complete. Check `status`: COMPLETED or REJECTED_QUALITY.',
        type: AnalysisResponse,
      }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: analysis:run'),
      NotFoundResponse('Sample'),
      UnprocessableResponse(
        'No active reference chart exists for this test method.',
        ErrorCode.REFERENCE_DATA_INCOMPLETE,
      ),
      TooManyRequestsResponse(),
      AiServiceUnavailableResponse(),
    ),

  findOne: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get an analysis result',
        description:
          'Returns one result with its prediction, measured colour, quality ' +
          'assessment, model provenance and limitations. ' +
          '`confirmedMeasurementCount` reports how many confirmed laboratory ' +
          'measurements are linked to it — zero means nothing has ' +
          'independently confirmed this result.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ type: AnalysisResponse }),
      UnauthorizedResponse(),
      NotFoundResponse('Analysis'),
    ),

  listForSample: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: "List a sample's analyses",
        description:
          'All analyses run against one sample, newest first. A sample may ' +
          'be analysed repeatedly — after a retake, or against a revised ' +
          'reference chart — and every attempt is retained.',
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiOkResponse({ type: [AnalysisResponse] }),
      UnauthorizedResponse(),
      NotFoundResponse('Sample'),
    ),
};
