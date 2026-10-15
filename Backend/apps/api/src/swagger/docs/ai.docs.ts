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
  UnprocessableResponse,
} from '../shared/responses';
import { ErrorCode } from '../../common/errors/api-error';
import {
  ApproveModelDto,
  CreateTrainingJobDto,
  RollbackModelDto,
} from '../../modules/ai-admin/dto/ai-admin.dto';

/**
 * OpenAPI documentation for model administration.
 *
 * ## The governing rules
 *
 * 1. **Approval is a human act.** A model cannot become active without an
 *    attributed approver — enforced by a database constraint, not merely by
 *    application code. Nothing approves a model automatically, and no amount
 *    of new data promotes one on its own.
 *
 * 2. **Evaluation precedes approval.** A model with no evaluation cannot be
 *    approved; there would be nothing to base the decision on.
 *
 * 3. **Accuracy alone is never sufficient.** On an imbalanced dataset, a
 *    model that always predicts the majority class scores well on accuracy
 *    and is useless. Approval checks macro F1, per-class support and test-set
 *    size.
 *
 * 4. **Overrides are possible but attributable.** An administrator who
 *    disagrees with the release criteria can approve anyway by supplying
 *    `overrideReason` — which is written to the audit log with the specific
 *    blockers that were overridden.
 *
 * ## Prototype state
 *
 * Until a laboratory has recorded confirmed measurements, the active model is
 * the baseline reference matcher, which reports itself as not validated. The
 * status endpoint's `dataReadiness` block states plainly how much ground
 * truth exists — and training on technician opinion alone teaches a model to
 * reproduce human error at scale, which is why `confirmedMeasurements` is
 * surfaced separately from `approvedExamples`.
 */
export const AiDocs = {
  status: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'AI service and model status',
        description: [
          'Reports the active model, whether the vision service is reachable,',
          'and how much training data exists.',
          '',
          '`dataReadiness.confirmedMeasurements` is the number worth watching:',
          'it counts confirmed laboratory measurements, which are the only',
          'ground truth a predictive model can honestly be trained against.',
          '',
          'Degrades rather than fails when the vision service is unreachable —',
          '`serviceReachable` goes false and the rest of the response still',
          'renders, so an operator can see what is wrong.',
        ].join('\n'),
      }),
      ApiOkResponse({ description: 'Service status and data readiness.' }),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:read'),
    ),

  listModels: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'List model versions',
        description:
          'Model registry entries, newest first, with release status, ' +
          'dataset version and approval provenance.',
      }),
      ApiOkResponse({ description: 'Model versions.' }),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:read'),
    ),

  getModel: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get a model version with its evaluations',
        description: [
          'One model version plus every evaluation recorded against it.',
          '',
          'Each evaluation carries a confusion matrix, per-class precision,',
          'recall and support, macro F1, calibration metrics where there was',
          'enough data to estimate them, and `evaluationLimitations` — the',
          'plain-language caveats an administrator should read before',
          'approving anything.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'The model version and its evaluations.' }),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:read'),
      NotFoundResponse('Model version'),
    ),

  createTrainingJob: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Queue a training job',
        description: [
          'Queues controlled retraining from approved dataset examples.',
          '',
          '**Only approved, authorised, non-excluded examples are used.** An',
          'uploaded image never becomes training data on its own — it must be',
          'annotated, submitted, and approved by someone other than its',
          'author.',
          '',
          '**Refused when the data does not support it**: fewer than 30',
          'approved examples, or fewer than two distinct labels. The error',
          'reports the actual counts.',
          '',
          '**Splitting** groups by physical sample, so near-duplicate images',
          'of the same tube cannot land on both sides of the train/test',
          'boundary and inflate the score.',
          '',
          'Requires the `model:train` capability.',
        ].join('\n'),
      }),
      ApiBody({ type: CreateTrainingJobDto }),
      ApiCreatedResponse({ description: 'Training job queued.' }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:train'),
      NotFoundResponse('Test method'),
      UnprocessableResponse(
        'Training needs at least 30 approved examples; there are 4.',
        ErrorCode.INSUFFICIENT_DATA,
      ),
    ),

  getTrainingJob: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Get a training job',
        description:
          'Status and progress of one job, including the dataset version it ' +
          'created and the model version it produced.',
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiOkResponse({ description: 'The training job.' }),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:read'),
      NotFoundResponse('Training job'),
    ),

  approveModel: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Approve and release a model',
        description: [
          'Makes a model the active one for its method. The previous active',
          "model is stood down and recorded as this one's predecessor, which",
          'gives rollback a defined target.',
          '',
          '**Refused when the evaluation does not support it.** The checks are:',
          '',
          '- test set of at least 30 examples;',
          '- macro F1 of at least 0.6 (not accuracy — see the note above);',
          '- at least 5 test examples in every class.',
          '',
          'A 422 lists exactly which checks failed. Supply `overrideReason` to',
          'approve regardless; the override and its reason are written to the',
          'audit log alongside the specific blockers.',
          '',
          'Requires the `model:approve` capability (LAB_ADMIN or SUPER_ADMIN).',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: ApproveModelDto }),
      ApiOkResponse({ description: 'The model is now active.' }),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:approve'),
      NotFoundResponse('Model version'),
      ConflictResponse(
        'This model is already the active model.',
        ErrorCode.CONFLICTING_STATE,
      ),
      UnprocessableResponse(
        'The evaluation does not support approving this model: macro F1 is 0.41.',
        ErrorCode.INSUFFICIENT_DATA,
      ),
    ),

  rollbackModel: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: 'Roll back the active model',
        description: [
          'Withdraws the active model and reactivates its predecessor.',
          '',
          '`reason` is required and stored permanently — a withdrawn model is',
          'part of the record of what produced past results, and why it',
          'stopped being trusted.',
          '',
          'The target defaults to the version this model replaced, falling',
          'back to the baseline reference matcher, which always exists and is',
          'always safe to return to.',
          '',
          'Results produced by the withdrawn model are **not** altered: they',
          'keep their recorded model name, version and validation state, so',
          'history stays honest about what produced it.',
          '',
          'The response carries both ends of the switch — the `withdrawn`',
          'model and the one that is `nowActive` — together with',
          '`analysisServiceConfirmed`. Check that flag: when it is `false`',
          'the rollback is recorded in the database but the analysis service',
          'did not confirm the switch and may still be serving the withdrawn',
          'model. `warning` then explains what to do.',
          '',
          'Requires the `model:approve` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', format: 'uuid' }),
      ApiBody({ type: RollbackModelDto }),
      ApiOkResponse({
        description:
          'The withdrawn model, the model now active, and whether the ' +
          'analysis service confirmed the switch.',
      }),
      BadRequestResponse(),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: model:approve'),
      NotFoundResponse('Model version'),
      ConflictResponse(
        'This model is not active, so there is nothing to roll back.',
        ErrorCode.CONFLICTING_STATE,
      ),
    ),
};
