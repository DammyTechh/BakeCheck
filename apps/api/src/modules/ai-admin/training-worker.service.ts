import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { AiClientService } from '../../integrations/python-ai/ai-client.service';
import {
  AiDatasetExample,
  AiTrainingRequest,
  AiTrainingResponse,
} from '../../integrations/python-ai/training-client.types';
import { AuditService } from '../audit/audit.service';

interface QueuedJob {
  id: string;
  test_method_id: string;
  laboratory_id: string | null;
  requested_params: Record<string, unknown>;
  requested_by: string | null;
  correlation_id: string | null;
}

/**
 * Consumes queued training jobs.
 *
 * This is the piece that turns `POST /ai/training-jobs` from a row in a table
 * into an actual trained model. It polls for `QUEUED` jobs, assembles the
 * approved dataset examples, hands them to the AI service, and writes back
 * the dataset version, the model version and the evaluation.
 *
 * ## What it deliberately does not do
 *
 * **It never activates a model.** Every model version it writes is
 * `status: TRAINED` with `is_active = false`. Activation requires a human
 * approval through `POST /ai/models/{id}/approve`, and the database enforces
 * that with a CHECK constraint on `approved_by`. A worker that promoted its
 * own output would make the whole review chain decorative.
 *
 * **It does not retry.** A failed training run is recorded as `FAILED` with
 * its reason. Retrying automatically would hide a real data problem behind
 * repeated expensive runs.
 *
 * ## Why polling
 *
 * A single `SELECT … FOR UPDATE SKIP LOCKED` is enough at this scale and
 * needs no Redis, no broker and no extra failure mode. `SKIP LOCKED` is what
 * makes it safe to run more than one API instance: two workers polling
 * simultaneously will never claim the same job.
 */
@Injectable()
export class TrainingWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(TrainingWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly aiClient: AiClientService,
    private readonly auditService: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /**
   * Begins polling.
   *
   * Called explicitly rather than from OnModuleInit, so tests and one-shot
   * CLI runs can use this service without a background loop starting
   * underneath them.
   */
  start(intervalMs = 15_000): void {
    if (this.timer || this.stopped) return;

    this.logger.log(`Training worker polling every ${intervalMs / 1000}s`);
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);

    // Do not hold the process open for the sake of the poll timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. Safe to call directly; used by tests and the CLI. */
  async tick(): Promise<boolean> {
    // One job at a time per instance. Training is CPU-heavy on the AI
    // service, and overlapping runs would starve live analysis requests.
    if (this.running) return false;

    this.running = true;
    try {
      const job = await this.claimNextJob();
      if (!job) return false;

      await this.processJob(job);
      return true;
    } catch (error) {
      this.logger.error(
        { err: (error as Error).message },
        'Training worker cycle failed',
      );
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomically claim the oldest queued job.
   *
   * `FOR UPDATE SKIP LOCKED` inside the same statement that flips the status
   * means two instances polling at the same moment cannot both claim it —
   * the second simply skips the locked row and finds the next one.
   */
  private async claimNextJob(): Promise<QueuedJob | null> {
    const rows = await this.db.query<QueuedJob>(
      `UPDATE training_jobs
          SET status = 'RUNNING',
              started_at = now(),
              progress = jsonb_build_object(
                'stage', 'claimed',
                'claimed_at', now()
              )
        WHERE id = (
          SELECT id FROM training_jobs
           WHERE status = 'QUEUED'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
      RETURNING id, test_method_id, laboratory_id, requested_params,
                requested_by, correlation_id`,
    );

    return rows[0] ?? null;
  }

  private async processJob(job: QueuedJob): Promise<void> {
    const correlationId = job.correlation_id ?? randomUUID();
    const params = job.requested_params ?? {};

    this.logger.log(
      { jobId: job.id, testMethodId: job.test_method_id, correlationId },
      'Training job started',
    );

    try {
      const examples = await this.loadExamples(job.test_method_id);
      const referenceLevels = await this.loadReferenceLevels(job.test_method_id);

      await this.setProgress(job.id, {
        stage: 'examples_loaded',
        example_count: examples.length,
        reference_level_count: referenceLevels.length,
      });

      if (examples.length === 0) {
        await this.failJob(
          job,
          'NO_APPROVED_EXAMPLES',
          'No approved, authorised dataset examples exist for this test ' +
            'method. Examples must be reviewed and approved before they can ' +
            'be trained on.',
          correlationId,
        );
        return;
      }

      const request: AiTrainingRequest = {
        testMethodId: job.test_method_id,
        modelName: String(params.modelName ?? 'colour-classifier'),
        modelVersion: null,
        examples,
        referenceLevels,
        modelType:
          params.modelType === 'SKLEARN_REGRESSOR'
            ? 'random_forest'
            : 'logistic_regression',
        testFraction: Number(params.testSplit ?? 0.2),
        validationFraction: Number(params.validationSplit ?? 0.2),
        splitSeed: Number(params.splitSeed ?? 20261011),
        correlationId,
      };

      await this.setProgress(job.id, { stage: 'training' });

      const result = await this.aiClient.runTraining(
        request,
        this.config.training.timeoutMs,
      );

      if (result.status === 'refused') {
        // Not a failure. The dataset could not support training, and the
        // reasons are actionable — the job completes having produced no
        // model, which is the honest outcome.
        await this.completeRefused(job, result, correlationId);
        return;
      }

      if (
        result.status === 'failed' ||
        !result.dataset ||
        !result.model ||
        !result.evaluation
      ) {
        await this.failJob(
          job,
          'TRAINING_FAILED',
          result.refusalReason ?? 'Training failed without a reason.',
          correlationId,
        );
        return;
      }

      await this.persistSuccess(job, result, correlationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown training failure';
      this.logger.error(
        { jobId: job.id, correlationId, err: message },
        'Training job failed',
      );
      await this.failJob(job, 'WORKER_ERROR', message, correlationId);
    }
  }

  /**
   * Load the examples eligible for training.
   *
   * The filter is the whole governance story in one WHERE clause: approved
   * by a reviewer, authorised for use by the laboratory, and not excluded.
   * An uploaded image that nobody reviewed is invisible here.
   */
  private async loadExamples(testMethodId: string): Promise<AiDatasetExample[]> {
    const rows = await this.db.query<{
      id: string;
      sample_id: string;
      sample_image_id: string;
      label_level_id: string | null;
      label_text: string | null;
      label_concentration: string | null;
      label_unit: string | null;
      label_source: string;
      sample_type: string;
      color_features: Record<string, unknown>;
      quality_verdict: string | null;
      group_key: string;
      perceptual_hash: string | null;
      capture_device: string | null;
    }>(
      `SELECT de.id,
              de.sample_id,
              de.sample_image_id,
              de.label_level_id,
              de.label_text,
              de.label_concentration,
              de.label_unit,
              de.label_source::text AS label_source,
              de.sample_type,
              de.color_features,
              de.quality_verdict::text AS quality_verdict,
              de.group_key,
              de.perceptual_hash,
              si.capture_metadata->>'capture_device' AS capture_device
         FROM dataset_examples de
         LEFT JOIN sample_images si ON si.id = de.sample_image_id
        WHERE de.test_method_id = $1
          AND de.review_status = 'APPROVED'
          AND de.usage_authorized
          AND NOT de.excluded
        ORDER BY de.created_at`,
      [testMethodId],
    );

    return rows.map((row) => ({
      id: row.id,
      sampleId: row.sample_id,
      sampleImageId: row.sample_image_id,
      labelLevelId: row.label_level_id,
      labelText: row.label_text,
      labelConcentration:
        row.label_concentration !== null ? Number(row.label_concentration) : null,
      labelUnit: row.label_unit,
      labelSource: row.label_source as AiDatasetExample['labelSource'],
      sampleType: row.sample_type,
      colorFeatures: row.color_features ?? {},
      qualityVerdict: row.quality_verdict,
      groupKey: row.group_key,
      perceptualHash: row.perceptual_hash,
      captureDevice: row.capture_device,
      lightingNote: null,
    }));
  }

  /** The active chart's levels, used to score the baseline. */
  private async loadReferenceLevels(
    testMethodId: string,
  ): Promise<AiTrainingRequest['referenceLevels']> {
    const rows = await this.db.query<{
      id: string;
      label: string;
      concentration_value: string | null;
      concentration_unit: string;
      sort_order: number;
      lab_l: string;
      lab_a: string;
      lab_b: string;
      lab_std: string | null;
    }>(
      `SELECT rl.id, rl.label, rl.concentration_value, rl.concentration_unit,
              rl.sort_order, rl.lab_l, rl.lab_a, rl.lab_b, rl.lab_std
         FROM reference_levels rl
         JOIN reference_charts rc ON rc.id = rl.reference_chart_id
        WHERE rc.test_method_id = $1
          AND rc.is_active
          AND rl.lab_l IS NOT NULL
        ORDER BY rc.version DESC, rl.sort_order`,
      [testMethodId],
    );

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      concentrationValue:
        row.concentration_value !== null ? Number(row.concentration_value) : null,
      concentrationUnit: row.concentration_unit,
      sortOrder: row.sort_order,
      labL: Number(row.lab_l),
      labA: Number(row.lab_a),
      labB: Number(row.lab_b),
      labStd: row.lab_std !== null ? Number(row.lab_std) : null,
    }));
  }

  /**
   * Persist a successful run.
   *
   * One transaction: the dataset version, the model version and the
   * evaluation land together or not at all. A model row without its
   * evaluation would be unapprovable, and an evaluation without its model
   * would be orphaned.
   */
  private async persistSuccess(
    job: QueuedJob,
    result: AiTrainingResponse,
    correlationId: string,
  ): Promise<void> {
    const dataset = result.dataset!;
    const model = result.model!;
    const evaluation = result.evaluation!;

    await this.db.transaction(async (client) => {
      const datasetRows = await client.query<{ id: string }>(
        `INSERT INTO dataset_versions (
           test_method_id, version, description, example_ids, split_assignment,
           example_count, train_count, validation_count, test_count,
           class_distribution, quality_report, content_checksum, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (test_method_id, version) DO UPDATE
           SET content_checksum = EXCLUDED.content_checksum
         RETURNING id`,
        [
          job.test_method_id,
          dataset.version,
          `Built by training job ${job.id}`,
          dataset.exampleIds,
          JSON.stringify(dataset.splitAssignment),
          dataset.exampleCount,
          dataset.trainCount,
          dataset.validationCount,
          dataset.testCount,
          JSON.stringify(dataset.classDistribution),
          JSON.stringify({
            ...dataset.qualityReport,
            label_source_distribution: dataset.labelSourceDistribution,
            issues: result.issues,
          }),
          dataset.contentChecksum,
          job.requested_by,
        ],
      );
      const datasetVersionId = datasetRows.rows[0].id;

      // status TRAINED, is_active false. The database's
      // model_versions_active_requires_approval_chk makes it impossible to
      // set is_active without an approver, so this is belt and braces.
      const modelRows = await client.query<{ id: string }>(
        `INSERT INTO model_versions (
           test_method_id, name, version, model_type, dataset_version_id,
           artifact_checksum, artifact_size_bytes, training_params,
           validation_metrics, feature_schema, status, is_active,
           limitations, notes, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TRAINED',false,$11,$12,$13)
         RETURNING id`,
        [
          job.test_method_id,
          model.name,
          model.version,
          'SKLEARN_CLASSIFIER',
          datasetVersionId,
          model.artifactChecksum,
          model.artifactSizeBytes,
          JSON.stringify(model.hyperparameters),
          JSON.stringify({
            accuracy: evaluation.accuracy,
            macro_f1: evaluation.macroF1,
            balanced_accuracy: evaluation.balancedAccuracy,
            expected_calibration_error: evaluation.expectedCalibrationError,
          }),
          JSON.stringify({
            feature_order: model.featureOrder,
            classes: model.classes,
            calibrated: model.calibrated,
            calibration_skipped_reason: model.calibrationSkippedReason,
          }),
          JSON.stringify(model.limitations),
          `Trained from ${model.trainingExamples} examples. ` +
            `Recommendation: ${evaluation.releaseRecommendation}.`,
          job.requested_by,
        ],
      );
      const modelVersionId = modelRows.rows[0].id;

      await client.query(
        `INSERT INTO model_evaluations (
           model_version_id, dataset_version_id, split, accuracy, macro_f1,
           weighted_f1, balanced_accuracy, expected_calibration_error,
           brier_score, confusion_matrix, per_class_metrics, subgroup_metrics,
           baseline_comparison, sample_size, evaluation_limitations,
           release_recommendation
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          modelVersionId,
          datasetVersionId,
          evaluation.split,
          evaluation.accuracy,
          evaluation.macroF1,
          evaluation.weightedF1,
          evaluation.balancedAccuracy,
          evaluation.expectedCalibrationError,
          evaluation.brierScore,
          JSON.stringify(evaluation.confusionMatrix),
          JSON.stringify(evaluation.perClassMetrics),
          JSON.stringify(evaluation.subgroupMetrics),
          JSON.stringify(evaluation.baselineComparison),
          evaluation.sampleSize,
          JSON.stringify([
            ...evaluation.evaluationLimitations,
            ...evaluation.releaseBlockers.map((b) => `Release blocker: ${b}`),
          ]),
          evaluation.releaseRecommendation,
        ],
      );

      await client.query(
        `UPDATE training_jobs
            SET status = 'SUCCEEDED',
                dataset_version_id = $2,
                model_version_id = $3,
                finished_at = now(),
                progress = $4
          WHERE id = $1`,
        [
          job.id,
          datasetVersionId,
          modelVersionId,
          JSON.stringify({
            stage: 'completed',
            macro_f1: evaluation.macroF1,
            recommendation: evaluation.releaseRecommendation,
            blockers: evaluation.releaseBlockers,
            awaiting_approval: true,
          }),
        ],
      );
    });

    await this.auditService.record({
      actorUserId: job.requested_by,
      laboratoryId: job.laboratory_id,
      action: 'model.training_completed',
      resourceType: 'training_job',
      resourceId: job.id,
      correlationId,
      metadata: {
        modelName: model.name,
        modelVersion: model.version,
        datasetVersion: dataset.version,
        exampleCount: dataset.exampleCount,
        macroF1: evaluation.macroF1,
        recommendation: evaluation.releaseRecommendation,
        blockers: evaluation.releaseBlockers,
        // The headline: training produced a candidate, not a live model.
        activated: false,
      },
    });

    this.logger.log(
      {
        jobId: job.id,
        model: `${model.name} v${model.version}`,
        macroF1: evaluation.macroF1,
        recommendation: evaluation.releaseRecommendation,
        correlationId,
      },
      'Training job succeeded; model awaits human approval',
    );
  }

  /** A dataset that could not support training. Recorded, not treated as a bug. */
  private async completeRefused(
    job: QueuedJob,
    result: AiTrainingResponse,
    correlationId: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE training_jobs
          SET status = 'SUCCEEDED',
              finished_at = now(),
              error_code = 'DATASET_INSUFFICIENT',
              error_message = $2,
              progress = $3
        WHERE id = $1`,
      [
        job.id,
        (result.refusalReason ?? '').slice(0, 2000),
        JSON.stringify({
          stage: 'refused',
          reason: result.refusalReason,
          issues: result.issues,
          produced_model: false,
        }),
      ],
    );

    await this.auditService.record({
      actorUserId: job.requested_by,
      laboratoryId: job.laboratory_id,
      action: 'model.training_refused',
      resourceType: 'training_job',
      resourceId: job.id,
      correlationId,
      metadata: {
        reason: result.refusalReason,
        criticalIssues: result.issues
          .filter((i) => i.severity === 'critical')
          .map((i) => i.code),
      },
    });

    this.logger.log(
      { jobId: job.id, reason: result.refusalReason, correlationId },
      'Training refused: the dataset could not support it',
    );
  }

  private async failJob(
    job: QueuedJob,
    code: string,
    message: string,
    correlationId: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE training_jobs
          SET status = 'FAILED',
              finished_at = now(),
              error_code = $2,
              error_message = $3
        WHERE id = $1`,
      [job.id, code, message.slice(0, 2000)],
    );

    await this.auditService.record({
      actorUserId: job.requested_by,
      laboratoryId: job.laboratory_id,
      action: 'model.training_failed',
      resourceType: 'training_job',
      resourceId: job.id,
      outcome: 'FAILURE',
      correlationId,
      metadata: { errorCode: code },
    });
  }

  private async setProgress(
    jobId: string,
    progress: Record<string, unknown>,
  ): Promise<void> {
    await this.db.query(`UPDATE training_jobs SET progress = $2 WHERE id = $1`, [
      jobId,
      JSON.stringify({ ...progress, updated_at: new Date().toISOString() }),
    ]);
  }
}
