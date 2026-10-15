import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { AuthenticatedUser } from '../../common/types/request-context';
import { Permission, roleHasPermission, UserRole } from '../../common/types/roles';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  CreateFeedbackDto,
  CreateMeasurementDto,
  ReviewFeedbackDto,
} from './dto/feedback.dto';

/**
 * Technician feedback and confirmatory laboratory measurements.
 *
 * The distinction this module exists to preserve:
 *
 *   • An **annotation** is a technician's reading of a screening result. It is
 *     an informed opinion about a colour. It is evidence, but it is not a
 *     measurement, and it carries label_source TECHNICIAN_ANNOTATION if it
 *     ever reaches a training set.
 *
 *   • A **laboratory measurement** is a number from an analytical instrument.
 *     It lives in its own table, with its own method, uncertainty and
 *     provenance, and it is the only thing in this system that may be
 *     described as a confirmed concentration.
 *
 * Collapsing the two would let a confident guess become ground truth, which is
 * exactly how a model learns to repeat human error at scale.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditService: AuditService,
  ) {}

  async createFeedback(
    analysisId: string,
    dto: CreateFeedbackDto,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const analysis = await this.db.queryOne<{
      id: string;
      sample_id: string;
      laboratory_id: string;
      predicted_level_id: string | null;
    }>(
      `SELECT id, sample_id, laboratory_id, predicted_level_id
         FROM analysis_results WHERE id = $1`,
      [analysisId],
    );
    if (!analysis) throw ApiError.notFound('Analysis');

    if (dto.correctedLevelId) {
      const level = await this.db.queryOne<{ id: string }>(
        `SELECT rl.id FROM reference_levels rl
           JOIN reference_charts rc ON rc.id = rl.reference_chart_id
          WHERE rl.id = $1`,
        [dto.correctedLevelId],
      );
      if (!level) throw ApiError.notFound('Reference level');
    }

    // Whether the technician agrees is derived, not asked: if they named a
    // level, compare it with what the pipeline produced.
    const agrees =
      dto.correctedLevelId !== undefined
        ? dto.correctedLevelId === analysis.predicted_level_id
        : null;

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO annotations (
         analysis_id, sample_id, laboratory_id, corrected_level_id,
         agrees_with_prediction, roi_x, roi_y, roi_width, roi_height,
         feedback_reason, quality_opinion, flagged_unreliable, notes,
         submitted_for_review, annotated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::quality_verdict,$12,$13,$14,$15)
       RETURNING id`,
      [
        analysisId,
        analysis.sample_id,
        analysis.laboratory_id,
        dto.correctedLevelId ?? null,
        agrees,
        dto.roi?.x ?? null,
        dto.roi?.y ?? null,
        dto.roi?.width ?? null,
        dto.roi?.height ?? null,
        dto.feedbackReason ?? null,
        dto.qualityOpinion ?? null,
        dto.flaggedUnreliable ?? false,
        dto.notes ?? null,
        dto.submitForReview ?? false,
        actor.id,
      ],
    );
    if (!row) throw ApiError.internal('Failed to record the feedback');

    // Submitting for review moves the sample into the review queue.
    if (dto.submitForReview) {
      await this.db.query(
        `UPDATE samples SET status = 'UNDER_REVIEW'
          WHERE id = $1 AND status IN ('ANALYZED', 'REGISTERED', 'PREPARED')`,
        [analysis.sample_id],
      );
    }

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: analysis.laboratory_id,
      action: AuditAction.FEEDBACK_CREATE,
      resourceType: 'annotation',
      resourceId: row.id,
      correlationId,
      metadata: {
        analysisId,
        agreesWithPrediction: agrees,
        flaggedUnreliable: dto.flaggedUnreliable ?? false,
        submittedForReview: dto.submitForReview ?? false,
      },
    });

    return this.getFeedback(row.id);
  }

  async getFeedback(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT a.*, u.full_name AS annotator_name,
              rl.label AS corrected_label,
              reviewer.full_name AS reviewer_name
         FROM annotations a
         LEFT JOIN users u ON u.id = a.annotated_by
         LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
         LEFT JOIN reference_levels rl ON rl.id = a.corrected_level_id
        WHERE a.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Feedback');
    return this.mapAnnotation(row);
  }

  async listForAnalysis(
    analysisId: string,
    laboratoryId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query(
      `SELECT a.*, u.full_name AS annotator_name,
              rl.label AS corrected_label,
              reviewer.full_name AS reviewer_name
         FROM annotations a
         LEFT JOIN users u ON u.id = a.annotated_by
         LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
         LEFT JOIN reference_levels rl ON rl.id = a.corrected_level_id
        WHERE a.analysis_id = $1 AND a.laboratory_id = $2
        ORDER BY a.created_at DESC`,
      [analysisId, laboratoryId],
    );
    return rows.map((row) => this.mapAnnotation(row));
  }

  /**
   * Approve or reject an annotation for dataset use.
   *
   * Deliberately cannot be done by the person who wrote it: self-approval
   * would make the review step decorative. The check is on user id, not role,
   * so even a laboratory administrator cannot wave through their own
   * annotation.
   */
  async reviewFeedback(
    id: string,
    dto: ReviewFeedbackDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    if (!roleHasPermission(effectiveRole, Permission.FEEDBACK_REVIEW)) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Reviewing feedback requires the ${Permission.FEEDBACK_REVIEW} capability.`,
      );
    }

    const annotation = await this.db.queryOne<{
      id: string;
      laboratory_id: string;
      annotated_by: string;
      review_status: string;
    }>(
      `SELECT id, laboratory_id, annotated_by, review_status::text AS review_status
         FROM annotations WHERE id = $1`,
      [id],
    );
    if (!annotation) throw ApiError.notFound('Feedback');

    if (annotation.annotated_by === actor.id) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'You cannot review your own annotation. Another reviewer must approve it.',
      );
    }

    if (annotation.review_status !== 'PENDING') {
      throw ApiError.conflict(
        ErrorCode.CONFLICTING_STATE,
        `This annotation has already been ${annotation.review_status.toLowerCase()}.`,
      );
    }

    await this.db.query(
      `UPDATE annotations
          SET review_status = $2::review_status,
              reviewed_by = $3,
              reviewed_at = now(),
              review_notes = $4
        WHERE id = $1`,
      [id, dto.decision, actor.id, dto.reviewNotes ?? null],
    );

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: annotation.laboratory_id,
      action: 'feedback.review',
      resourceType: 'annotation',
      resourceId: id,
      correlationId,
      metadata: { decision: dto.decision },
    });

    return this.getFeedback(id);
  }

  // ── Laboratory measurements ───────────────────────────────────────────────

  async createMeasurement(
    sampleId: string,
    dto: CreateMeasurementDto,
    actor: AuthenticatedUser,
    effectiveRole: UserRole,
    correlationId?: string,
  ): Promise<Record<string, unknown>> {
    const sample = await this.db.queryOne<{
      id: string;
      laboratory_id: string;
    }>('SELECT id, laboratory_id FROM samples WHERE id = $1', [sampleId]);
    if (!sample) throw ApiError.notFound('Sample');

    if (dto.analysisId) {
      const analysis = await this.db.queryOne<{ id: string }>(
        'SELECT id FROM analysis_results WHERE id = $1 AND sample_id = $2',
        [dto.analysisId, sampleId],
      );
      if (!analysis) throw ApiError.notFound('Analysis');
    }

    // The schema requires either a value or an explicit below-detection flag.
    // Enforced here too, with a message that explains why.
    if (dto.concentrationValue === undefined && !dto.belowDetectionLimit) {
      throw ApiError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Supply a concentration value, or set belowDetectionLimit to record ' +
          'that the analyte was not detected. A measurement with neither is ' +
          'not a result.',
      );
    }

    // Marking a measurement CONFIRMED is a separate authority from recording
    // it. A technician may record; confirming needs a reviewer.
    const requestedStatus = dto.confirmationStatus ?? 'PRELIMINARY';
    if (
      requestedStatus === 'CONFIRMED' &&
      !roleHasPermission(effectiveRole, Permission.MEASUREMENT_CONFIRM)
    ) {
      throw ApiError.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        `Marking a measurement CONFIRMED requires the ` +
          `${Permission.MEASUREMENT_CONFIRM} capability. Record it as ` +
          'PRELIMINARY and have a reviewer confirm it.',
      );
    }

    const row = await this.db.queryOne<{ id: string }>(
      `INSERT INTO laboratory_measurements (
         sample_id, laboratory_id, analysis_id, measurement_method, instrument,
         concentration_value, concentration_unit, uncertainty, detection_limit,
         below_detection_limit, measured_at, measured_by, reviewed_by,
         reviewed_at, confirmation_status, provenance, certificate_ref, notes,
         created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 $15::confirmation_status,$16,$17,$18,$12)
       RETURNING id`,
      [
        sampleId,
        sample.laboratory_id,
        dto.analysisId ?? null,
        dto.measurementMethod,
        dto.instrument ?? null,
        dto.concentrationValue ?? null,
        dto.concentrationUnit,
        dto.uncertainty ?? null,
        dto.detectionLimit ?? null,
        dto.belowDetectionLimit ?? false,
        dto.measuredAt,
        actor.id,
        requestedStatus === 'CONFIRMED' ? actor.id : null,
        requestedStatus === 'CONFIRMED' ? new Date().toISOString() : null,
        requestedStatus,
        dto.provenance ?? null,
        dto.certificateRef ?? null,
        dto.notes ?? null,
      ],
    );
    if (!row) throw ApiError.internal('Failed to record the measurement');

    // A confirmed measurement moves the sample to CONFIRMED — the only path
    // to that status. An image analysis alone never reaches it.
    if (requestedStatus === 'CONFIRMED') {
      await this.db.query(
        `UPDATE samples SET status = 'CONFIRMED'
          WHERE id = $1 AND status <> 'ARCHIVED'`,
        [sampleId],
      );
    }

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: sample.laboratory_id,
      action:
        requestedStatus === 'CONFIRMED'
          ? AuditAction.MEASUREMENT_CONFIRM
          : AuditAction.MEASUREMENT_CREATE,
      resourceType: 'laboratory_measurement',
      resourceId: row.id,
      correlationId,
      metadata: {
        sampleId,
        method: dto.measurementMethod,
        confirmationStatus: requestedStatus,
        belowDetectionLimit: dto.belowDetectionLimit ?? false,
      },
    });

    return this.getMeasurement(row.id);
  }

  async getMeasurement(id: string): Promise<Record<string, unknown>> {
    const row = await this.db.queryOne(
      `SELECT lm.*, measurer.full_name AS measured_by_name,
              reviewer.full_name AS reviewed_by_name
         FROM laboratory_measurements lm
         LEFT JOIN users measurer ON measurer.id = lm.measured_by
         LEFT JOIN users reviewer ON reviewer.id = lm.reviewed_by
        WHERE lm.id = $1`,
      [id],
    );
    if (!row) throw ApiError.notFound('Measurement');
    return this.mapMeasurement(row);
  }

  async listMeasurementsForSample(
    sampleId: string,
    laboratoryId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query(
      `SELECT lm.*, measurer.full_name AS measured_by_name,
              reviewer.full_name AS reviewed_by_name
         FROM laboratory_measurements lm
         LEFT JOIN users measurer ON measurer.id = lm.measured_by
         LEFT JOIN users reviewer ON reviewer.id = lm.reviewed_by
        WHERE lm.sample_id = $1 AND lm.laboratory_id = $2
        ORDER BY lm.measured_at DESC`,
      [sampleId, laboratoryId],
    );
    return rows.map((row) => this.mapMeasurement(row));
  }

  async resolveAnalysisLaboratory(analysisId: string): Promise<string> {
    const row = await this.db.queryOne<{ laboratory_id: string }>(
      'SELECT laboratory_id FROM analysis_results WHERE id = $1',
      [analysisId],
    );
    if (!row) throw ApiError.notFound('Analysis');
    return row.laboratory_id;
  }

  async resolveAnnotationLaboratory(annotationId: string): Promise<string> {
    const row = await this.db.queryOne<{ laboratory_id: string }>(
      'SELECT laboratory_id FROM annotations WHERE id = $1',
      [annotationId],
    );
    if (!row) throw ApiError.notFound('Feedback');
    return row.laboratory_id;
  }

  private mapAnnotation(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      analysisId: row.analysis_id,
      sampleId: row.sample_id,
      laboratoryId: row.laboratory_id,
      correctedLevelId: row.corrected_level_id,
      correctedLabel: row.corrected_label,
      agreesWithPrediction: row.agrees_with_prediction,
      roi:
        row.roi_x !== null
          ? {
              x: Number(row.roi_x),
              y: Number(row.roi_y),
              width: Number(row.roi_width),
              height: Number(row.roi_height),
            }
          : null,
      feedbackReason: row.feedback_reason,
      qualityOpinion: row.quality_opinion,
      flaggedUnreliable: row.flagged_unreliable,
      notes: row.notes,
      submittedForReview: row.submitted_for_review,
      reviewStatus: row.review_status,
      reviewedBy: row.reviewed_by,
      reviewerName: row.reviewer_name,
      reviewedAt: (row.reviewed_at as Date | null)?.toISOString() ?? null,
      reviewNotes: row.review_notes,
      annotatedBy: row.annotated_by,
      annotatorName: row.annotator_name,
      // Stated explicitly so a consumer cannot mistake this for a measurement.
      evidenceType: 'TECHNICIAN_ANNOTATION',
      isConfirmedMeasurement: false,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private mapMeasurement(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      sampleId: row.sample_id,
      laboratoryId: row.laboratory_id,
      analysisId: row.analysis_id,
      measurementMethod: row.measurement_method,
      instrument: row.instrument,
      concentrationValue:
        row.concentration_value !== null ? Number(row.concentration_value) : null,
      concentrationUnit: row.concentration_unit,
      uncertainty: row.uncertainty !== null ? Number(row.uncertainty) : null,
      detectionLimit: row.detection_limit !== null ? Number(row.detection_limit) : null,
      belowDetectionLimit: row.below_detection_limit,
      measuredAt: (row.measured_at as Date).toISOString(),
      measuredBy: row.measured_by,
      measuredByName: row.measured_by_name,
      reviewedBy: row.reviewed_by,
      reviewedByName: row.reviewed_by_name,
      reviewedAt: (row.reviewed_at as Date | null)?.toISOString() ?? null,
      confirmationStatus: row.confirmation_status,
      provenance: row.provenance,
      certificateRef: row.certificate_ref,
      notes: row.notes,
      // The counterpart of the same flag on annotations and analyses.
      evidenceType: 'LABORATORY_MEASUREMENT',
      isConfirmedMeasurement: row.confirmation_status === 'CONFIRMED',
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}
