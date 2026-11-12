import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { AuthenticatedUser } from '../../common/types/request-context';
import { AiClientService } from '../../integrations/python-ai/ai-client.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  ApproveModelDto,
  CreateTrainingJobDto,
  RollbackModelDto,
} from './dto/ai-admin.dto';

/**
 * Model lifecycle administration.
 *
 * The governing rules, enforced here and backed by database constraints:
 *
 *   1. **Approval is a human act.** `is_active` cannot be set without
 *      `approved_by` and `approved_at` (CHECK constraint in migration 0005).
 *      No code path approves a model automatically.
 *
 *   2. **Evaluation precedes approval.** A model with no evaluation cannot be
 *      approved, because there would be nothing to base the decision on.
 *
 *   3. **Accuracy alone is never sufficient.** Approval is refused when the
 *      evaluation shows too little data or severe class imbalance, with the
 *      numbers in the error so the administrator can see why.
 *
 *   4. **Rollback has a defined target.** A model records the version it
 *      replaced, so reverting is a known operation rather than a guess.
 */
@Injectable()
export class AiAdminService {
  private readonly logger = new Logger(AiAdminService.name);

  /**
   * Minimum evidence required before a model may be approved.
   *
   * These are deliberately conservative engineering floors, not statistical
   * guarantees. A model that clears them is not thereby validated — it is
   * merely not obviously unsupportable.
   */
  private static readonly MIN_TEST_EXAMPLES = 30;
  private static readonly MIN_EXAMPLES_PER_CLASS = 5;
  private static readonly MIN_MACRO_F1 = 0.6;

  constructor(
    private readonly db: DatabaseService,
    private readonly aiClient: AiClientService,
    private readonly auditService: AuditService,
  ) {}

  async getStatus(correlationId: string): Promise<Record<string, unknown>> {
    const activeModel = await this.db.queryOne(
      `SELECT mv.*, dv.version AS dataset_version_label
         FROM model_versions mv
         LEFT JOIN dataset_versions dv ON dv.id = mv.dataset_version_id
        WHERE mv.is_active
        ORDER BY mv.released_at DESC NULLS LAST
        LIMIT 1`,
    );

    // The AI service may legitimately be down; the dashboard must still
    // render, so a failure here degrades rather than throws.
    let serviceStatus: unknown = null;
    let reachable = true;
    try {
      serviceStatus = await this.aiClient.getStatus(correlationId);
    } catch (error) {
      reachable = false;
      this.logger.warn(
        { err: (error as Error).message },
        'AI service status unavailable',
      );
    }

    const counts = await this.db.queryOne<{
      pending_annotations: string;
      approved_examples: string;
      confirmed_measurements: string;
      dataset_versions: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM annotations
           WHERE submitted_for_review AND review_status = 'PENDING')::text
           AS pending_annotations,
         (SELECT COUNT(*) FROM dataset_examples
           WHERE review_status = 'APPROVED' AND usage_authorized AND NOT excluded)::text
           AS approved_examples,
         (SELECT COUNT(*) FROM laboratory_measurements
           WHERE confirmation_status = 'CONFIRMED')::text
           AS confirmed_measurements,
         (SELECT COUNT(*) FROM dataset_versions)::text AS dataset_versions`,
    );

    const approvedExamples = Number(counts?.approved_examples ?? 0);
    const confirmedMeasurements = Number(counts?.confirmed_measurements ?? 0);

    return {
      serviceReachable: reachable,
      service: serviceStatus,
      activeModel: activeModel ? this.mapModel(activeModel) : null,
      mode:
        activeModel?.model_type === 'REFERENCE_MATCHER'
          ? 'REFERENCE_MATCHING'
          : 'MODEL_INFERENCE',
      dataReadiness: {
        pendingAnnotations: Number(counts?.pending_annotations ?? 0),
        approvedExamples,
        confirmedMeasurements,
        datasetVersions: Number(counts?.dataset_versions ?? 0),
        minimumExamplesForTraining: AiAdminService.MIN_TEST_EXAMPLES,
        // The honest headline for an administrator looking at this screen.
        readyForTraining: approvedExamples >= AiAdminService.MIN_TEST_EXAMPLES,
        readinessNote:
          confirmedMeasurements === 0
            ? 'No confirmed laboratory measurements have been recorded. Until ' +
              'there are, any trained model would be learning from technician ' +
              'opinion rather than from measured ground truth.'
            : `${confirmedMeasurements} confirmed measurement(s) available as ` +
              'ground truth.',
      },
    };
  }

  async listModels(filters: {
    testMethodId?: string;
    status?: string;
  }): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (filters.testMethodId) {
      params.push(filters.testMethodId);
      where.push(`mv.test_method_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      where.push(`mv.status = $${params.length}::model_release_status`);
    }

    const rows = await this.db.query(
      `SELECT mv.*, dv.version AS dataset_version_label,
              approver.full_name AS approved_by_name
         FROM model_versions mv
         LEFT JOIN dataset_versions dv ON dv.id = mv.dataset_version_id
         LEFT JOIN users approver ON approver.id = mv.approved_by
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY mv.created_at DESC
        LIMIT 100`,
      params,
    );

    return rows.map((row) => this.mapModel(row));
  }

  async getModel(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT mv.*, dv.version AS dataset_version_label,
              approver.full_name AS approved_by_name
         FROM model_versions mv
         LEFT JOIN dataset_versions dv ON dv.id = mv.dataset_version_id
         LEFT JOIN users approver ON approver.id = mv.approved_by
        WHERE mv.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Model version');

    const evaluations = await this.db.query(
      `SELECT * FROM model_evaluations
        WHERE model_version_id = $1
        ORDER BY created_at DESC`,
      [id],
    );

    return {
      ...this.mapModel(row),
      evaluations: evaluations.map((evaluation) => this.mapEvaluation(evaluation)),
    };
  }

  /**
   * Approve a model and make it active.
   *
   * Refuses when the evidence does not support the decision, and says exactly
   * what was missing. An administrator who disagrees can record an override
   * reason, which is audited — the point is that the decision is deliberate
   * and attributable, not that it is impossible.
   */
  async approveModel(
    id: string,
    dto: ApproveModelDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const model = await this.db.queryOne<{
      id: string;
      name: string;
      version: string;
      status: string;
      test_method_id: string | null;
      is_active: boolean;
      model_type: string;
    }>(
      `SELECT id, name, version, status::text AS status, test_method_id,
              is_active, model_type
         FROM model_versions WHERE id = $1`,
      [id],
    );
    if (!model) throw ApiError.notFound('Model version');

    if (model.is_active) {
      throw ApiError.conflict(
        ErrorCode.CONFLICTING_STATE,
        'This model is already the active model.',
      );
    }
    if (model.status === 'FAILED' || model.status === 'REJECTED') {
      throw ApiError.conflict(
        ErrorCode.CONFLICTING_STATE,
        `A model with status ${model.status} cannot be approved.`,
      );
    }

    const evaluation = await this.db.queryOne<Record<string, unknown>>(
      `SELECT * FROM model_evaluations
        WHERE model_version_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );

    if (!evaluation) {
      throw ApiError.unprocessable(
        ErrorCode.INSUFFICIENT_DATA,
        'This model has no evaluation. Approving it would mean releasing a ' +
          'model whose performance nobody has measured.',
      );
    }

    const blockers = this.assessReleaseBlockers(evaluation);

    if (blockers.length > 0 && !dto.overrideReason) {
      throw ApiError.unprocessable(
        ErrorCode.INSUFFICIENT_DATA,
        'The evaluation does not support approving this model: ' +
          blockers.join('; ') +
          '. Supply overrideReason to approve anyway; the override is audited.',
        { blockers },
      );
    }

    const previous = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM model_versions
        WHERE is_active AND test_method_id IS NOT DISTINCT FROM $1 AND name = $2`,
      [model.test_method_id, model.name],
    );

    await this.db.transaction(async (client) => {
      // Stand the previous model down first: a partial unique index permits
      // only one active model per (method, name).
      if (previous) {
        await client.query(
          `UPDATE model_versions
              SET is_active = false, status = 'ROLLED_BACK',
                  rolled_back_at = now(),
                  rollback_reason = 'superseded by an approved model'
            WHERE id = $1`,
          [previous.id],
        );
      }

      await client.query(
        `UPDATE model_versions
            SET status = 'RELEASED', is_active = true,
                approved_by = $2, approved_at = now(), released_at = now(),
                previous_version_id = $3,
                notes = COALESCE($4, notes)
          WHERE id = $1`,
        [id, actor.id, previous?.id ?? null, dto.notes ?? null],
      );

      await client.query(
        `UPDATE model_evaluations
            SET decided_by = $2, decided_at = now(), decision_notes = $3
          WHERE id = $1`,
        [evaluation.id, actor.id, dto.notes ?? null],
      );
    });

    // Load it in the AI service. Until this succeeds the database says
    // RELEASED while the service is still serving the previous model, so a
    // failure here has to be surfaced rather than swallowed.
    //
    // A reference matcher has no artifact to load: it is the built-in
    // baseline, and the service already has it.
    let activated = true;
    let activationNote: string | null = null;

    if (model.model_type !== 'REFERENCE_MATCHER') {
      try {
        const activation = await this.aiClient.approveModel({
          name: model.name,
          version: model.version,
          approvedBy: actor.id,
          // Approving a model for use is not the same as certifying it
          // scientifically. That remains a separate, explicit assertion.
          validated: false,
          correlationId: correlationId ?? randomUUID(),
        });
        activated = activation.loaded;
        if (!activation.loaded) activationNote = activation.message;
      } catch (error) {
        activated = false;
        activationNote =
          error instanceof Error ? error.message : 'Unknown activation failure';
        this.logger.error(
          { modelId: id, err: activationNote },
          'Model approved in the database but could not be loaded by the AI service',
        );
      }
    }

    if (!activated) {
      // Roll the database back to match reality: a model recorded as active
      // that the service is not running would make every later result
      // misattributed.
      await this.db.query(
        `UPDATE model_versions
            SET is_active = false, status = 'EVALUATED',
                approved_by = NULL, approved_at = NULL, released_at = NULL
          WHERE id = $1`,
        [id],
      );
      if (previous) {
        await this.db.query(
          `UPDATE model_versions
              SET is_active = true, status = 'RELEASED', rolled_back_at = NULL,
                  rollback_reason = NULL
            WHERE id = $1`,
          [previous.id],
        );
      }

      throw ApiError.badGateway(
        ErrorCode.AI_SERVICE_ERROR,
        'The model was not activated: the analysis service could not load ' +
          `its artifact. ${activationNote ?? ''} The previous model remains ` +
          'active and no approval was recorded.',
      );
    }

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.MODEL_APPROVE,
      resourceType: 'model_version',
      resourceId: id,
      correlationId,
      metadata: {
        modelName: model.name,
        modelVersion: model.version,
        previousVersionId: previous?.id ?? null,
        blockersOverridden: blockers.length > 0 ? blockers : undefined,
        overrideReason: dto.overrideReason,
      },
    });

    this.logger.log(
      { modelId: id, actor: actor.id, overridden: blockers.length > 0 },
      'Model approved and released',
    );

    return this.getModel(id);
  }

  async rollbackModel(
    id: string,
    dto: RollbackModelDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const model = await this.db.queryOne<{
      id: string;
      name: string;
      is_active: boolean;
      previous_version_id: string | null;
      test_method_id: string | null;
    }>(
      `SELECT id, name, is_active, previous_version_id, test_method_id
         FROM model_versions WHERE id = $1`,
      [id],
    );
    if (!model) throw ApiError.notFound('Model version');

    if (!model.is_active) {
      throw ApiError.conflict(
        ErrorCode.CONFLICTING_STATE,
        'This model is not active, so there is nothing to roll back.',
      );
    }

    // Prefer the recorded predecessor; otherwise the baseline matcher, which
    // always exists and is always safe to fall back to.
    const target =
      dto.targetVersionId ??
      model.previous_version_id ??
      (
        await this.db.queryOne<{ id: string }>(
          `SELECT id FROM model_versions
            WHERE model_type = 'REFERENCE_MATCHER'
              AND test_method_id IS NOT DISTINCT FROM $1
            ORDER BY created_at ASC LIMIT 1`,
          [model.test_method_id],
        )
      )?.id;

    if (!target) {
      throw ApiError.unprocessable(
        ErrorCode.CONFLICTING_STATE,
        'No previous model version is available to roll back to.',
      );
    }

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE model_versions
            SET is_active = false, status = 'ROLLED_BACK',
                rolled_back_at = now(), rollback_reason = $2
          WHERE id = $1`,
        [id, dto.reason],
      );

      await client.query(
        `UPDATE model_versions
            SET is_active = true, status = 'RELEASED', released_at = now()
          WHERE id = $1`,
        [target],
      );
    });

    // Tell the AI service too. It never throws — rollback is the path you
    // take when something is already wrong, and it must not fail because a
    // second thing is also wrong. A failure is reported to the operator.
    const targetRow = await this.db.queryOne<{
      name: string;
      version: string;
      model_type: string;
    }>('SELECT name, version, model_type FROM model_versions WHERE id = $1', [target]);

    let serviceSwitched = false;
    if (targetRow?.model_type === 'REFERENCE_MATCHER') {
      serviceSwitched = await this.aiClient.resetToBaseline(
        correlationId ?? randomUUID(),
      );
    } else if (targetRow) {
      try {
        const activation = await this.aiClient.approveModel({
          name: targetRow.name,
          version: targetRow.version,
          approvedBy: actor.id,
          validated: false,
          correlationId: correlationId ?? randomUUID(),
        });
        serviceSwitched = activation.loaded;
      } catch {
        serviceSwitched = false;
      }
    }

    if (!serviceSwitched) {
      // The database now reflects the rollback but the service may still be
      // running the withdrawn model. Loud, because it needs a human.
      this.logger.error(
        { from: id, to: target },
        'Rolled back in the database, but the analysis service did not ' +
          'confirm the switch. It may still be running the withdrawn model.',
      );
    }

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: AuditAction.MODEL_ROLLBACK,
      resourceType: 'model_version',
      resourceId: id,
      correlationId,
      metadata: {
        reason: dto.reason,
        rolledBackTo: target,
        analysisServiceConfirmed: serviceSwitched,
      },
    });

    this.logger.warn(
      { from: id, to: target, actor: actor.id, reason: dto.reason },
      'Model rolled back',
    );

    // Return both ends of the switch, not just the model that is now active.
    // Returning the new active model alone reads as "isActive: true" against
    // a request to withdraw something, and — more importantly — it gives the
    // caller no way to learn that the analysis service may still be running
    // the withdrawn model. The operator who just triggered the rollback is
    // exactly the person who needs to know that.
    return {
      withdrawn: await this.getModel(id),
      nowActive: await this.getModel(target),
      analysisServiceConfirmed: serviceSwitched,
      warning: serviceSwitched
        ? null
        : 'The database records the rollback, but the analysis service did ' +
          'not confirm the switch. It may still be running the withdrawn ' +
          'model. Verify GET /ai/status before relying on any new result.',
    };
  }

  /**
   * Queue a training job.
   *
   * Refuses when there is not enough approved data, rather than producing a
   * model that would be meaningless. The error states how many examples exist
   * and how many are needed.
   */
  async createTrainingJob(
    dto: CreateTrainingJobDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const method = await this.db.queryOne<{ id: string; code: string }>(
      'SELECT id, code FROM test_methods WHERE id = $1',
      [dto.testMethodId],
    );
    if (!method) throw ApiError.notFound('Test method');

    const eligible = await this.db.queryOne<{
      total: string;
      measurement_backed: string;
      distinct_labels: string;
    }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE label_source = 'LABORATORY_MEASUREMENT')::text
                AS measurement_backed,
              COUNT(DISTINCT label_level_id)::text AS distinct_labels
         FROM dataset_examples
        WHERE test_method_id = $1
          AND review_status = 'APPROVED'
          AND usage_authorized
          AND NOT excluded`,
      [dto.testMethodId],
    );

    const total = Number(eligible?.total ?? 0);
    const measurementBacked = Number(eligible?.measurement_backed ?? 0);
    const distinctLabels = Number(eligible?.distinct_labels ?? 0);

    if (total < AiAdminService.MIN_TEST_EXAMPLES) {
      throw ApiError.unprocessable(
        ErrorCode.INSUFFICIENT_DATA,
        `Training needs at least ${AiAdminService.MIN_TEST_EXAMPLES} approved ` +
          `examples for method ${method.code}; there are ${total}. ` +
          'Collect and approve more reviewed examples first.',
        { approvedExamples: total, required: AiAdminService.MIN_TEST_EXAMPLES },
      );
    }

    if (distinctLabels < 2) {
      throw ApiError.unprocessable(
        ErrorCode.INSUFFICIENT_DATA,
        'Training needs examples spanning at least two distinct labels; a ' +
          'single-class dataset cannot teach a classifier anything.',
        { distinctLabels },
      );
    }

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO training_jobs (
         test_method_id, laboratory_id, status, requested_params,
         requested_by, correlation_id
       ) VALUES ($1,$2,'QUEUED',$3,$4,$5)
       RETURNING id`,
      [
        dto.testMethodId,
        dto.laboratoryId ?? null,
        JSON.stringify({
          modelType: dto.modelType ?? 'SKLEARN_CLASSIFIER',
          testSplit: dto.testSplit ?? 0.2,
          validationSplit: dto.validationSplit ?? 0.2,
          notes: dto.notes,
          eligibleExamples: total,
          measurementBackedExamples: measurementBacked,
        }),
        actor.id,
        correlationId ?? null,
      ],
    );
    if (!row) throw ApiError.internal('Failed to queue the training job');

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: dto.laboratoryId ?? null,
      action: AuditAction.TRAINING_JOB_CREATE,
      resourceType: 'training_job',
      resourceId: row.id,
      correlationId,
      metadata: {
        testMethodId: dto.testMethodId,
        eligibleExamples: total,
        measurementBackedExamples: measurementBacked,
      },
    });

    return this.getTrainingJob(row.id);
  }

  async getTrainingJob(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT tj.*, tm.code AS method_code, u.full_name AS requested_by_name
         FROM training_jobs tj
         JOIN test_methods tm ON tm.id = tj.test_method_id
         LEFT JOIN users u ON u.id = tj.requested_by
        WHERE tj.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Training job');

    return {
      id: row.id,
      testMethodId: row.test_method_id,
      testMethodCode: row.method_code,
      laboratoryId: row.laboratory_id,
      datasetVersionId: row.dataset_version_id,
      modelVersionId: row.model_version_id,
      status: row.status,
      requestedParams: row.requested_params,
      progress: row.progress,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      requestedBy: row.requested_by,
      requestedByName: row.requested_by_name,
      startedAt: (row.started_at as Date | null)?.toISOString() ?? null,
      finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  /**
   * Reasons an evaluation does not support release.
   *
   * Explicitly does NOT consider overall accuracy on its own: with an
   * imbalanced dataset a model that always predicts the majority class scores
   * well on accuracy while being useless. Macro F1 and per-class counts are
   * what is checked.
   */
  private assessReleaseBlockers(evaluation: Record<string, unknown>): string[] {
    const blockers: string[] = [];

    const sampleSize = Number(evaluation.sample_size ?? 0);
    if (sampleSize < AiAdminService.MIN_TEST_EXAMPLES) {
      blockers.push(
        `the test set holds ${sampleSize} examples, below the minimum of ` +
          `${AiAdminService.MIN_TEST_EXAMPLES}`,
      );
    }

    const macroF1 =
      evaluation.macro_f1 !== null && evaluation.macro_f1 !== undefined
        ? Number(evaluation.macro_f1)
        : null;
    if (macroF1 === null) {
      blockers.push('no macro F1 score was recorded');
    } else if (macroF1 < AiAdminService.MIN_MACRO_F1) {
      blockers.push(
        `macro F1 is ${macroF1.toFixed(3)}, below the minimum of ` +
          `${AiAdminService.MIN_MACRO_F1}`,
      );
    }

    const perClass = evaluation.per_class_metrics as Record<
      string,
      { support?: number }
    > | null;
    if (perClass && typeof perClass === 'object') {
      const thin = Object.entries(perClass)
        .filter(
          ([, metrics]) =>
            Number(metrics?.support ?? 0) < AiAdminService.MIN_EXAMPLES_PER_CLASS,
        )
        .map(([label]) => label);

      if (thin.length > 0) {
        blockers.push(
          `these classes have fewer than ${AiAdminService.MIN_EXAMPLES_PER_CLASS} ` +
            `test examples: ${thin.join(', ')}`,
        );
      }
    }

    return blockers;
  }

  private mapModel(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      testMethodId: row.test_method_id,
      name: row.name,
      version: row.version,
      modelType: row.model_type,
      datasetVersionId: row.dataset_version_id,
      datasetVersion: row.dataset_version_label,
      artifactChecksum: row.artifact_checksum,
      trainingParams: row.training_params,
      validationMetrics: row.validation_metrics,
      status: row.status,
      isActive: row.is_active,
      approvedBy: row.approved_by,
      approvedByName: row.approved_by_name,
      approvedAt: (row.approved_at as Date | null)?.toISOString() ?? null,
      releasedAt: (row.released_at as Date | null)?.toISOString() ?? null,
      rolledBackAt: (row.rolled_back_at as Date | null)?.toISOString() ?? null,
      rollbackReason: row.rollback_reason,
      previousVersionId: row.previous_version_id,
      limitations: row.limitations ?? [],
      notes: row.notes,
      // A reference matcher is never "validated"; it is not a trained model.
      isValidated: row.model_type !== 'REFERENCE_MATCHER' && row.status === 'RELEASED',
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private mapEvaluation(row: Record<string, unknown>): Record<string, unknown> {
    const num = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);

    return {
      id: row.id,
      modelVersionId: row.model_version_id,
      datasetVersionId: row.dataset_version_id,
      split: row.split,
      accuracy: num(row.accuracy),
      macroF1: num(row.macro_f1),
      weightedF1: num(row.weighted_f1),
      balancedAccuracy: num(row.balanced_accuracy),
      mae: num(row.mae),
      rmse: num(row.rmse),
      r2: num(row.r2),
      expectedCalibrationError: num(row.expected_calibration_error),
      brierScore: num(row.brier_score),
      confusionMatrix: row.confusion_matrix,
      perClassMetrics: row.per_class_metrics,
      subgroupMetrics: row.subgroup_metrics,
      baselineComparison: row.baseline_comparison,
      sampleSize: num(row.sample_size),
      evaluationLimitations: row.evaluation_limitations ?? [],
      releaseRecommendation: row.release_recommendation,
      decidedBy: row.decided_by,
      decidedAt: (row.decided_at as Date | null)?.toISOString() ?? null,
      decisionNotes: row.decision_notes,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}
