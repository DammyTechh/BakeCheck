import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { AuthenticatedUser } from '../../common/types/request-context';
import {
  AiReferenceLevelInput,
  AnalyzeImageResponse,
} from '../../integrations/python-ai/ai-client.types';
import { AiClientService } from '../../integrations/python-ai/ai-client.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ImagesService } from '../images/images.service';
import { AnalyzeSampleDto } from '../samples/dto/sample.dto';
import { AnalysisResponse } from './dto/analysis.response';

interface MethodRow {
  id: string;
  code: string;
  name: string;
  method_version: string;
  concentration_unit: string;
  validation_status: string;
  target_analyte: string;
}

interface ChartRow {
  id: string;
  version: number;
  validation_status: string;
  name: string;
}

interface LevelRow {
  id: string;
  label: string;
  concentration_value: string | null;
  concentration_unit: string;
  sort_order: number;
  lab_l: string | null;
  lab_a: string | null;
  lab_b: string | null;
  lab_std: string | null;
  validation_status: string;
}

/**
 * Analysis orchestration.
 *
 * This is where the platform's central scientific claim is enforced: an
 * image-derived result is a *screening estimate*, and the record says so in
 * structured, queryable form rather than only in prose.
 *
 * Specifically:
 *  • `mode` is stored, so a reference-matching result can never later be read
 *    as model inference.
 *  • `model_validated` is denormalised at write time, capturing whether the
 *    producing method and model were validated *then*, not now.
 *  • `estimated_concentration` stays NULL unless a validated model supports a
 *    number. A colour match against an illustrative chart does not.
 *  • `limitations` are assembled from the actual state of the method, chart
 *    and model and persisted with the result.
 */
@Injectable()
export class AnalysesService {
  private readonly logger = new Logger(AnalysesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiClient: AiClientService,
    private readonly imagesService: ImagesService,
    private readonly auditService: AuditService,
  ) {}

  async analyze(
    sampleId: string,
    laboratoryId: string,
    dto: AnalyzeSampleDto,
    actor: AuthenticatedUser,
    correlationId: string,
  ): Promise<AnalysisResponse> {
    // ── Gather and validate inputs ────────────────────────────────────────
    const sample = await this.db.queryOne<{
      id: string;
      sample_code: string;
      test_method_id: string | null;
    }>(
      `SELECT id, sample_code, test_method_id
         FROM samples WHERE id = $1 AND laboratory_id = $2`,
      [sampleId, laboratoryId],
    );
    if (!sample) throw ApiError.notFound('Sample');

    if (!sample.test_method_id) {
      throw ApiError.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Assign a test method to this sample before running an analysis. ' +
          'A colour measurement is meaningless without the method that produced it.',
      );
    }

    const image = await this.imagesService.findOne(dto.imageId);
    if (image.laboratory_id !== laboratoryId || image.sample_id !== sampleId) {
      // Image belongs elsewhere: report as not-found, consistent with the
      // rest of the isolation model.
      throw ApiError.notFound('Image');
    }

    const method = await this.db.queryOne<MethodRow>(
      `SELECT id, code, name, method_version, concentration_unit,
              validation_status::text AS validation_status, target_analyte
         FROM test_methods WHERE id = $1`,
      [sample.test_method_id],
    );
    if (!method) throw ApiError.notFound('Test method');

    const chart = await this.resolveChart(dto.referenceChartId, method.id, laboratoryId);

    const levels = await this.db.query<LevelRow>(
      `SELECT id, label, concentration_value, concentration_unit, sort_order,
              lab_l, lab_a, lab_b, lab_std, validation_status::text AS validation_status
         FROM reference_levels
        WHERE reference_chart_id = $1 AND lab_l IS NOT NULL
        ORDER BY sort_order`,
      [chart.id],
    );

    if (levels.length < 2) {
      throw ApiError.unprocessable(
        ErrorCode.REFERENCE_DATA_INCOMPLETE,
        `Reference chart "${chart.name}" has fewer than two levels with ` +
          'colour values. Add CIELAB values to the chart before analysing.',
      );
    }

    // ── Create the pending record up front ────────────────────────────────
    // Written before the call so a crash or timeout leaves a visible FAILED
    // record rather than silence.
    const pending = await this.db.queryOne<{ id: string }>(
      `INSERT INTO analysis_results (
         sample_id, sample_image_id, laboratory_id, test_method_id,
         reference_chart_id, status, mode, method_version,
         reference_chart_version, requested_by, correlation_id, started_at
       ) VALUES ($1,$2,$3,$4,$5,'PROCESSING','REFERENCE_MATCHING',$6,$7,$8,$9,now())
       RETURNING id`,
      [
        sampleId,
        dto.imageId,
        laboratoryId,
        method.id,
        chart.id,
        method.method_version,
        chart.version,
        actor.id,
        correlationId,
      ],
    );
    if (!pending) throw ApiError.internal('Failed to create the analysis record');
    const analysisId = pending.id;

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId,
      action: AuditAction.ANALYSIS_START,
      resourceType: 'analysis',
      resourceId: analysisId,
      correlationId,
      metadata: {
        sampleId,
        imageId: dto.imageId,
        testMethodCode: method.code,
        referenceChartId: chart.id,
        manualRoi: Boolean(dto.roi),
      },
    });

    // ── Call the vision service ───────────────────────────────────────────
    const imageBytes = await this.imagesService.getNormalisedBytes(dto.imageId);
    const startedAt = Date.now();

    let aiResult: AnalyzeImageResponse;
    try {
      aiResult = await this.aiClient.analyzeImage({
        imageBase64: imageBytes.toString('base64'),
        mimeType: 'image/png',
        roi: dto.roi ?? null,
        referenceLevels: levels.map((level): AiReferenceLevelInput => ({
          id: level.id,
          label: level.label,
          concentrationValue:
            level.concentration_value !== null ? Number(level.concentration_value) : null,
          concentrationUnit: level.concentration_unit,
          sortOrder: level.sort_order,
          labL: Number(level.lab_l),
          labA: Number(level.lab_a),
          labB: Number(level.lab_b),
          labStd: level.lab_std !== null ? Number(level.lab_std) : null,
        })),
        testMethod: {
          id: method.id,
          code: method.code,
          version: method.method_version,
          concentrationUnit: method.concentration_unit,
          validationStatus: method.validation_status,
        },
        referenceChart: {
          id: chart.id,
          version: chart.version,
          validationStatus: chart.validation_status,
        },
        correlationId,
      });
    } catch (error) {
      const apiError = error instanceof ApiError ? error : ApiError.internal();
      await this.db.query(
        `UPDATE analysis_results
            SET status = 'FAILED', error_code = $2, error_message = $3,
                completed_at = now(), duration_ms = $4
          WHERE id = $1`,
        [
          analysisId,
          apiError.code,
          apiError.message.slice(0, 500),
          Date.now() - startedAt,
        ],
      );

      await this.auditService.record({
        actorUserId: actor.id,
        laboratoryId,
        action: AuditAction.ANALYSIS_FAILED,
        resourceType: 'analysis',
        resourceId: analysisId,
        outcome: 'FAILURE',
        correlationId,
        metadata: { errorCode: apiError.code },
      });

      throw error;
    }

    // ── Persist the outcome ───────────────────────────────────────────────
    const limitations = this.buildLimitations(aiResult, method, chart);
    const durationMs = Date.now() - startedAt;

    // A concentration number is only persisted when a validated model
    // produced it. Reference matching against an illustrative chart yields a
    // label and a distance — never a number presented as a measurement.
    const mayReportConcentration =
      aiResult.mode === 'model_inference' &&
      aiResult.model.validated &&
      method.validation_status === 'VALIDATED' &&
      chart.validation_status === 'VALIDATED';

    const estimatedConcentration = mayReportConcentration
      ? aiResult.prediction.estimatedConcentration
      : null;

    const status =
      aiResult.status === 'rejected_quality' ? 'REJECTED_QUALITY' : 'COMPLETED';

    const mode =
      aiResult.mode === 'model_inference'
        ? 'MODEL_INFERENCE'
        : aiResult.mode === 'hybrid'
          ? 'HYBRID'
          : 'REFERENCE_MATCHING';

    await this.db.transaction(async (client) => {
      await client.query(
        `UPDATE analysis_results SET
           status = $2::analysis_status,
           mode = $3::analysis_mode,
           predicted_level_id = $4,
           predicted_label = $5,
           estimated_concentration = $6,
           concentration_unit = $7,
           confidence = $8,
           color_distance = $9,
           alternatives = $10,
           out_of_range = $11,
           quality_verdict = $12::quality_verdict,
           quality_score = $13,
           quality_warnings = $14,
           model_name = $15,
           model_version = $16,
           model_validated = $17,
           pipeline_version = $18,
           limitations = $19,
           inference_metadata = $20,
           completed_at = now(),
           duration_ms = $21
         WHERE id = $1`,
        [
          analysisId,
          status,
          mode,
          aiResult.referenceMatch.referenceLevelId,
          aiResult.referenceMatch.label,
          estimatedConcentration,
          estimatedConcentration !== null ? method.concentration_unit : null,
          // Enforced by a CHECK constraint too: reference matching stores no
          // confidence, because a colour distance is not a probability.
          mode === 'REFERENCE_MATCHING' ? null : aiResult.prediction.confidence,
          aiResult.referenceMatch.colorDistance,
          JSON.stringify(aiResult.referenceMatch.alternatives),
          aiResult.referenceMatch.outOfRange,
          aiResult.imageQuality.verdict.toUpperCase(),
          aiResult.imageQuality.score,
          JSON.stringify(aiResult.imageQuality.warnings),
          aiResult.model.name,
          aiResult.model.version,
          aiResult.model.validated,
          aiResult.pipelineVersion,
          JSON.stringify(limitations),
          JSON.stringify({
            processingMs: aiResult.processingMs,
            roiMode: aiResult.roi.mode,
            roiConfidence: aiResult.roi.confidence,
            aiAnalysisId: aiResult.analysisId,
            referenceLevelCount: levels.length,
          }),
          durationMs,
        ],
      );

      // Store the raw measurement alongside the interpretation, so a result
      // can be re-derived or audited without re-processing the image.
      if (aiResult.colorFeatures) {
        const features = aiResult.colorFeatures;
        await client.query(
          `INSERT INTO measured_color_features (
             analysis_id, sample_image_id, roi_x, roi_y, roi_width, roi_height,
             roi_mode, roi_confidence, pixel_count, masked_fraction,
             rgb_median, rgb_mean, rgb_std, hsv_median,
             lab_median, lab_mean, lab_std, lab_iqr,
             saturation_mean, brightness_mean, contrast_score, sharpness_score,
             clipping_fraction, background_lab, color_space,
             extraction_config, pipeline_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                     $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
           ON CONFLICT (analysis_id) DO NOTHING`,
          [
            analysisId,
            dto.imageId,
            aiResult.roi.x,
            aiResult.roi.y,
            aiResult.roi.width,
            aiResult.roi.height,
            aiResult.roi.mode,
            aiResult.roi.confidence,
            features.pixelCount,
            features.maskedFraction,
            features.rgbMedian,
            features.rgbMean,
            features.rgbStd,
            features.hsvMedian,
            features.labMedian,
            features.labMean,
            features.labStd,
            features.labIqr,
            features.saturationMean,
            features.brightnessMean,
            features.contrastScore,
            features.sharpnessScore,
            features.clippingFraction,
            features.backgroundLab,
            features.colorSpace,
            JSON.stringify({
              roiMode: aiResult.roi.mode,
              referenceChartId: chart.id,
              referenceChartVersion: chart.version,
            }),
            aiResult.pipelineVersion,
          ],
        );
      }

      // Advance the sample's status, but never past a review decision.
      await client.query(
        `UPDATE samples
            SET status = 'ANALYZED'
          WHERE id = $1 AND status IN ('REGISTERED', 'PREPARED')`,
        [sampleId],
      );
    });

    await this.auditService.record({
      actorUserId: actor.id,
      laboratoryId,
      action: AuditAction.ANALYSIS_COMPLETE,
      resourceType: 'analysis',
      resourceId: analysisId,
      correlationId,
      metadata: {
        status,
        mode,
        qualityVerdict: aiResult.imageQuality.verdict,
        predictedLabel: aiResult.referenceMatch.label,
        modelValidated: aiResult.model.validated,
      },
    });

    return this.findOne(analysisId, laboratoryId);
  }

  /**
   * Assembles the caveats stored with the result.
   *
   * Built from the actual state of the method, chart and model rather than
   * from a fixed string, so the record states precisely what was and was not
   * established at the time it was produced.
   */
  private buildLimitations(
    result: AnalyzeImageResponse,
    method: MethodRow,
    chart: ChartRow,
  ): string[] {
    const limitations: string[] = [];

    // Always first: the platform's core claim about what this result is.
    limitations.push(
      'This is an image-based screening estimate, not a chemically confirmed ' +
        'measurement. It must not be used on its own to declare a sample safe, ' +
        'unsafe, compliant or non-compliant.',
    );

    if (result.mode === 'reference_matching') {
      limitations.push(
        'Produced by colour-distance matching against reference levels. No ' +
          'trained predictive model was used, and no concentration was estimated.',
      );
    }

    if (method.validation_status !== 'VALIDATED') {
      limitations.push(
        `The test method "${method.code}" has validation status ` +
          `${method.validation_status}. No limit of detection, calibration ` +
          'curve or measurement uncertainty has been established for it in ' +
          'this system.',
      );
    }

    if (chart.validation_status === 'ILLUSTRATIVE') {
      limitations.push(
        `Reference chart "${chart.name}" is marked ILLUSTRATIVE: its colours ` +
          'were read from a picture rather than measured from prepared ' +
          'standards. It establishes no validated relationship between colour ' +
          `and ${method.target_analyte} concentration.`,
      );
    } else if (chart.validation_status !== 'VALIDATED') {
      limitations.push(
        `Reference chart "${chart.name}" has validation status ` +
          `${chart.validation_status} and is not a validated reference.`,
      );
    }

    if (!result.model.validated) {
      limitations.push(
        `Model "${result.model.name}" v${result.model.version} has not been ` +
          'validated against confirmed laboratory measurements.',
      );
    }

    if (!result.imageQuality.usable) {
      limitations.push(
        'Image quality was judged insufficient for reliable colour analysis. ' +
          'Capture a better image rather than relying on this result.',
      );
    }

    if (result.referenceMatch.outOfRange) {
      limitations.push(
        'The measured colour falls outside the range covered by this ' +
          'reference chart, so the closest level is an extrapolation.',
      );
    }

    // Anything the pipeline itself wants to say.
    limitations.push(...result.limitations);

    limitations.push(
      'Confirm any actionable result with a validated analytical method ' +
        'and record it under laboratory measurements.',
    );

    // De-duplicate while preserving order.
    return [...new Set(limitations)];
  }

  private async resolveChart(
    requestedId: string | undefined,
    testMethodId: string,
    laboratoryId: string,
  ): Promise<ChartRow> {
    if (requestedId) {
      const chart = await this.db.queryOne<ChartRow>(
        `SELECT id, version, validation_status::text AS validation_status, name
           FROM reference_charts
          WHERE id = $1
            AND test_method_id = $2
            AND (laboratory_id IS NULL OR laboratory_id = $3)
            AND is_active`,
        [requestedId, testMethodId, laboratoryId],
      );
      if (!chart) throw ApiError.notFound('Reference chart');
      return chart;
    }

    // Default: the newest active chart for this method that the laboratory
    // can see.
    const chart = await this.db.queryOne<ChartRow>(
      `SELECT id, version, validation_status::text AS validation_status, name
         FROM reference_charts
        WHERE test_method_id = $1
          AND (laboratory_id IS NULL OR laboratory_id = $2)
          AND is_active
        ORDER BY version DESC, created_at DESC
        LIMIT 1`,
      [testMethodId, laboratoryId],
    );

    if (!chart) {
      throw ApiError.unprocessable(
        ErrorCode.REFERENCE_DATA_INCOMPLETE,
        'No active reference chart exists for this test method. Create one ' +
          'with concentration levels and colour values before analysing.',
      );
    }
    return chart;
  }

  async resolveLaboratoryId(analysisId: string): Promise<string> {
    const row = await this.db.queryOne<{ laboratory_id: string }>(
      'SELECT laboratory_id FROM analysis_results WHERE id = $1',
      [analysisId],
    );
    if (!row) throw ApiError.notFound('Analysis');
    return row.laboratory_id;
  }

  async findOne(id: string, laboratoryId: string): Promise<AnalysisResponse> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      `SELECT a.*,
              s.sample_code,
              tm.code AS method_code,
              tm.name AS method_name,
              tm.target_analyte,
              tm.validation_status::text AS method_validation_status,
              rc.name AS chart_name,
              rc.validation_status::text AS chart_validation_status,
              rl.label AS level_label,
              rl.concentration_value AS level_concentration,
              rl.concentration_unit AS level_unit,
              rl.rgb_r, rl.rgb_g, rl.rgb_b,
              mcf.rgb_median, mcf.lab_median, mcf.roi_x, mcf.roi_y,
              mcf.roi_width, mcf.roi_height, mcf.roi_mode,
              (SELECT COUNT(*) FROM laboratory_measurements lm
                WHERE lm.analysis_id = a.id
                  AND lm.confirmation_status = 'CONFIRMED')::text
                AS confirmed_measurement_count
         FROM analysis_results a
         JOIN samples s ON s.id = a.sample_id
         JOIN test_methods tm ON tm.id = a.test_method_id
         LEFT JOIN reference_charts rc ON rc.id = a.reference_chart_id
         LEFT JOIN reference_levels rl ON rl.id = a.predicted_level_id
         LEFT JOIN measured_color_features mcf ON mcf.analysis_id = a.id
        WHERE a.id = $1 AND a.laboratory_id = $2`,
      [id, laboratoryId],
    );
    if (!row) throw ApiError.notFound('Analysis');
    return this.toResponse(row);
  }

  async listForSample(
    sampleId: string,
    laboratoryId: string,
  ): Promise<AnalysisResponse[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM analysis_results
        WHERE sample_id = $1 AND laboratory_id = $2
        ORDER BY created_at DESC`,
      [sampleId, laboratoryId],
    );
    return Promise.all(rows.map((row) => this.findOne(row.id, laboratoryId)));
  }

  private toResponse(row: Record<string, unknown>): AnalysisResponse {
    const num = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value);

    const confirmedCount = Number(row.confirmed_measurement_count ?? 0);

    return {
      id: row.id as string,
      sampleId: row.sample_id as string,
      sampleCode: row.sample_code as string,
      sampleImageId: row.sample_image_id as string,
      laboratoryId: row.laboratory_id as string,
      status: row.status as AnalysisResponse['status'],
      mode: row.mode as AnalysisResponse['mode'],

      testMethod: {
        id: row.test_method_id as string,
        code: row.method_code as string,
        name: row.method_name as string,
        version: (row.method_version as string) ?? null,
        targetAnalyte: row.target_analyte as string,
        validationStatus: row.method_validation_status as string,
      },

      referenceChart: row.reference_chart_id
        ? {
            id: row.reference_chart_id as string,
            name: row.chart_name as string,
            version: num(row.reference_chart_version),
            validationStatus: row.chart_validation_status as string,
          }
        : null,

      prediction: {
        referenceLevelId: (row.predicted_level_id as string) ?? null,
        label: (row.predicted_label as string) ?? null,
        referenceConcentration: num(row.level_concentration),
        referenceUnit: (row.level_unit as string) ?? null,
        referenceColorRgb:
          row.rgb_r !== null && row.rgb_r !== undefined
            ? [Number(row.rgb_r), Number(row.rgb_g), Number(row.rgb_b)]
            : null,
        estimatedConcentration: num(row.estimated_concentration),
        concentrationUnit: (row.concentration_unit as string) ?? null,
        confidence: num(row.confidence),
        colorDistance: num(row.color_distance),
        alternatives:
          (row.alternatives as AnalysisResponse['prediction']['alternatives']) ?? [],
        outOfRange: Boolean(row.out_of_range),
      },

      imageQuality: {
        verdict: (row.quality_verdict as string) ?? null,
        score: num(row.quality_score),
        warnings:
          (row.quality_warnings as AnalysisResponse['imageQuality']['warnings']) ?? [],
      },

      measuredColor: row.lab_median
        ? {
            rgbMedian: (row.rgb_median as number[]).map(Number) as [
              number,
              number,
              number,
            ],
            labMedian: (row.lab_median as string[]).map(Number) as [
              number,
              number,
              number,
            ],
            roi: {
              x: Number(row.roi_x),
              y: Number(row.roi_y),
              width: Number(row.roi_width),
              height: Number(row.roi_height),
              mode: row.roi_mode as string,
            },
          }
        : null,

      model: {
        name: (row.model_name as string) ?? null,
        version: (row.model_version as string) ?? null,
        validated: Boolean(row.model_validated),
        pipelineVersion: (row.pipeline_version as string) ?? null,
      },

      // The single most important field in this response: whether anything
      // has independently confirmed this result.
      isConfirmedMeasurement: false,
      confirmedMeasurementCount: confirmedCount,
      limitations: (row.limitations as string[]) ?? [],

      errorCode: (row.error_code as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      correlationId: (row.correlation_id as string) ?? null,
      durationMs: num(row.duration_ms),
      createdAt: (row.created_at as Date).toISOString(),
      completedAt: (row.completed_at as Date | null)?.toISOString() ?? null,
    };
  }
}
