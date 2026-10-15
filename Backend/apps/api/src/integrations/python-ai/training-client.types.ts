/**
 * Wire contract for the internal training endpoints.
 *
 * Mirrors `services/ai/app/schemas/training.py`. The API owns the data and
 * sends examples as plain values; the AI service never touches the database,
 * which keeps all authorisation on this side of the boundary.
 */

export type AiLabelSource =
  | 'LABORATORY_MEASUREMENT'
  | 'REFERENCE_STANDARD'
  | 'TECHNICIAN_ANNOTATION'
  | 'SYNTHETIC_FIXTURE';

export interface AiDatasetExample {
  id: string;
  sampleId: string;
  sampleImageId: string;

  labelLevelId: string | null;
  labelText: string | null;
  labelConcentration: number | null;
  labelUnit: string | null;
  labelSource: AiLabelSource;

  sampleType: string;
  /** Colour statistics cached at approval time, so training never re-reads images. */
  colorFeatures: Record<string, unknown>;
  qualityVerdict: string | null;

  /** Ties every example from one physical sample together, for split grouping. */
  groupKey: string;
  perceptualHash: string | null;

  captureDevice: string | null;
  lightingNote: string | null;
}

export interface AiTrainingRequest {
  testMethodId: string;
  modelName: string;
  modelVersion: string | null;
  examples: AiDatasetExample[];
  /** Used to score the reference matcher as the baseline to beat. */
  referenceLevels: Array<{
    id: string;
    label: string;
    concentrationValue: number | null;
    concentrationUnit: string;
    sortOrder: number;
    labL: number;
    labA: number;
    labB: number;
    labStd: number | null;
  }>;
  modelType: 'logistic_regression' | 'random_forest';
  testFraction: number;
  validationFraction: number;
  splitSeed: number;
  correlationId: string;
}

export interface AiQualityIssue {
  code: string;
  severity: 'warning' | 'critical';
  message: string;
  affectedCount: number;
}

export interface AiDatasetVersion {
  version: string;
  exampleIds: string[];
  splitAssignment: Record<string, string>;
  exampleCount: number;
  trainCount: number;
  validationCount: number;
  testCount: number;
  classDistribution: Record<string, number>;
  labelSourceDistribution: Record<string, number>;
  qualityReport: Record<string, unknown>;
  contentChecksum: string;
}

export interface AiEvaluation {
  split: string;
  sampleSize: number;
  accuracy: number;
  macroF1: number;
  weightedF1: number;
  balancedAccuracy: number;
  confusionMatrix: Record<string, unknown>;
  perClassMetrics: Record<
    string,
    { precision: number; recall: number; f1: number; support: number }
  >;
  subgroupMetrics: Record<string, unknown>;
  baselineComparison: Record<string, unknown>;
  expectedCalibrationError: number | null;
  brierScore: number | null;
  evaluationLimitations: string[];
  releaseRecommendation: 'APPROVE' | 'REJECT' | 'INSUFFICIENT_DATA';
  releaseBlockers: string[];
}

export interface AiTrainedModel {
  name: string;
  version: string;
  modelType: string;
  /** Always false from a training run. Only an explicit approval sets it. */
  approved: boolean;
  validated: boolean;
  artifactChecksum: string;
  artifactSizeBytes: number;
  featureOrder: string[];
  classes: string[];
  calibrated: boolean;
  calibrationSkippedReason: string | null;
  trainingExamples: number;
  hyperparameters: Record<string, unknown>;
  limitations: string[];
}

export interface AiTrainingResponse {
  /**
   * `refused` is a successful outcome, not an error: the dataset could not
   * support training, and the issues say why. "Not enough data yet" is the
   * expected state of this system for a long time.
   */
  status: 'succeeded' | 'refused' | 'failed';
  refusalReason: string | null;
  dataset: AiDatasetVersion | null;
  model: AiTrainedModel | null;
  evaluation: AiEvaluation | null;
  issues: AiQualityIssue[];
  durationMs: number;
  correlationId: string;
}

export interface AiApproveModelRequest {
  name: string;
  version: string;
  approvedBy: string;
  /**
   * Asserting scientific validation is a stronger claim than approving a
   * model for use, so it is a separate flag and defaults to false.
   */
  validated: boolean;
  correlationId: string;
}

export interface AiApproveModelResponse {
  name: string;
  version: string;
  approved: boolean;
  validated: boolean;
  /** Whether the registry actually made this the active model. */
  loaded: boolean;
  message: string;
}
