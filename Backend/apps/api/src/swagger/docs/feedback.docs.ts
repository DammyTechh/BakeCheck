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
  CreateFeedbackDto,
  CreateMeasurementDto,
  ReviewFeedbackDto,
} from '../../modules/feedback/dto/feedback.dto';

/**
 * OpenAPI documentation for feedback and laboratory measurements.
 *
 * ## Two different kinds of evidence
 *
 * These endpoints look similar and are deliberately kept apart.
 *
 * **Feedback (an annotation)** is a technician's reading of a screening
 * result — an informed opinion about a colour. It has no concentration field,
 * because a person looking at a tube is not measuring one. If it ever reaches
 * a training set it carries `label_source: TECHNICIAN_ANNOTATION`.
 *
 * **A laboratory measurement** is a number from an analytical instrument. It
 * carries its own method, instrument, uncertainty, detection limit and
 * provenance, and it is the only thing in this system that may be described
 * as a confirmed concentration.
 *
 * Both responses carry an explicit `evidenceType` and `isConfirmedMeasurement`
 * so a consumer cannot mistake one for the other.
 *
 * Collapsing the two would let a confident guess become ground truth — which
 * is how a model learns to reproduce human error at scale.
 *
 * ## Review
 *
 * An annotation becomes eligible for a training dataset only after a reviewer
 * approves it, and **a reviewer cannot approve their own annotation**. The
 * check is on user id, not role: even a laboratory administrator cannot wave
 * through their own work, because self-approval would make the review step
 * decorative.
 */
export const FeedbackDocs = {
  create: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Record feedback on an analysis',
        description: [
          "Records a technician's reading of a screening result: a corrected",
          'reference level, a corrected region, a quality opinion, or a flag',
          'that the prediction is unreliable.',
          '',
          '`agreesWithPrediction` is derived, not asked — if you name a level,',
          'the server compares it with what the pipeline produced.',
          '',
          'Set `submitForReview: true` to put the annotation into the review',
          'queue. Without it the feedback is recorded but never becomes',
          'training data.',
          '',
          'This is interpretation, not measurement. To record an instrument',
          'result, use `POST /samples/{id}/laboratory-measurements`.',
          '',
          'Requires the `feedback:create` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Analysis id', format: 'uuid' }),
      ApiBody({ type: CreateFeedbackDto }),
      ApiCreatedResponse({
        description: 'Feedback recorded with evidenceType TECHNICIAN_ANNOTATION.',
      }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: feedback:create'),
      NotFoundResponse('Analysis'),
    ),

  list: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List feedback on an analysis',
        description:
          'All annotations recorded against one analysis, newest first, with ' +
          'their review status.',
      }),
      ApiParam({ name: 'id', description: 'Analysis id', format: 'uuid' }),
      ApiOkResponse({ description: 'Annotations.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Analysis'),
    ),

  review: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Approve or reject an annotation',
        description: [
          'Decides whether an annotation may be used as a dataset example.',
          '',
          '**You cannot review your own annotation.** Another reviewer must',
          'approve it. Enforced on user id regardless of role.',
          '',
          'Requires the `feedback:review` capability (LAB_REVIEWER or',
          'LAB_ADMIN).',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Annotation id', format: 'uuid' }),
      ApiBody({ type: ReviewFeedbackDto }),
      ApiOkResponse({ description: 'The reviewed annotation.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('You cannot review your own annotation.'),
      NotFoundResponse('Feedback'),
      ConflictResponse(
        'This annotation has already been approved.',
        ErrorCode.CONFLICTING_STATE,
      ),
    ),

  createMeasurement: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Record a laboratory measurement',
        description: [
          'Records a confirmatory result from an analytical instrument.',
          '',
          '**This is the only endpoint that records a confirmed**',
          '**concentration.** An image analysis never produces one.',
          '',
          '`measurementMethod` is free text: the confirmatory technique need',
          "not be one of this platform's configured test methods, and usually",
          'is not — it is typically a chromatographic or spectrometric method.',
          '',
          'Supply either `concentrationValue` or `belowDetectionLimit: true`.',
          'Below-detection is recorded explicitly rather than as a',
          'concentration of zero, because those are different claims.',
          '',
          '`confirmationStatus: CONFIRMED` requires the `measurement:confirm`',
          'capability and moves the sample to CONFIRMED — the only route to',
          'that status. A technician records PRELIMINARY; a reviewer confirms.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiBody({
        type: CreateMeasurementDto,
        examples: {
          detected: {
            summary: 'Analyte detected',
            value: {
              measurementMethod: 'IC-ICP-MS',
              instrument: 'Example IC-7700',
              concentrationValue: 0.42,
              concentrationUnit: 'ppm',
              uncertainty: 0.05,
              detectionLimit: 0.01,
              measuredAt: '2026-10-11T09:30:00Z',
              confirmationStatus: 'PRELIMINARY',
              provenance: 'Internal confirmatory run, batch 2026-284',
            },
          },
          notDetected: {
            summary: 'Below the detection limit',
            value: {
              measurementMethod: 'IC-ICP-MS',
              belowDetectionLimit: true,
              detectionLimit: 0.01,
              concentrationUnit: 'ppm',
              measuredAt: '2026-10-11T09:30:00Z',
            },
          },
        },
      }),
      ApiCreatedResponse({
        description: 'Measurement recorded with evidenceType LABORATORY_MEASUREMENT.',
      }),
      BadRequestResponse(
        'Supply a concentration value, or set belowDetectionLimit.',
        undefined,
      ),
      UnauthorizedResponse(),
      ForbiddenResponse('Marking a measurement CONFIRMED requires: measurement:confirm'),
      NotFoundResponse('Sample'),
    ),

  listMeasurements: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: "List a sample's laboratory measurements",
        description:
          'Confirmatory measurements for one sample, newest first. An empty ' +
          'list means nothing about this sample has been chemically confirmed.',
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiOkResponse({ description: 'Laboratory measurements.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Sample'),
    ),
};
