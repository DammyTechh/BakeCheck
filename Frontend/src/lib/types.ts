/**
 * Wire types, mirrored from the API's OpenAPI document.
 *
 * The nullable fields here are not incidental. `estimatedConcentration` and
 * `confidence` are null whenever the system has no basis for a number, and
 * the interface has to render that absence rather than substitute a zero or
 * a dash that reads like a measurement. See `analysisClaim` in claims.ts.
 */

export type Role = 'SUPER_ADMIN' | 'LAB_ADMIN' | 'LAB_TECHNICIAN' | 'LAB_REVIEWER';

export interface Membership {
  laboratoryId: string;
  laboratoryName: string;
  role: Role;
  status?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  role: Role;
  status: string;
  memberships: Membership[];
  permissions: string[];
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: UserProfile;
}

export type SampleStatus =
  | 'REGISTERED'
  | 'PREPARED'
  | 'ANALYZED'
  | 'UNDER_REVIEW'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'ARCHIVED';

export interface Sample {
  id: string;
  laboratoryId: string;
  sampleCode: string;
  sampleType: string;
  productName: string | null;
  batchReference: string | null;
  manufacturer: string | null;
  collectedAt: string | null;
  receivedAt: string | null;
  status: SampleStatus;
  testMethodId: string | null;
  testMethodCode: string | null;
  testMethodName: string | null;
  testMethodValidationStatus: string | null;
  technicianId: string | null;
  technicianName: string | null;
  preparationNotes: string | null;
  dilutionFactor: number | null;
  notes: string | null;
  /**
   * Counts rather than a nested latest analysis — the list endpoint does not
   * embed one, and inventing a `latestAnalysis` field here would silently
   * render "Not analysed" against every sample that had been analysed.
   */
  imageCount: number;
  analysisCount: number;
  measurementCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export type AnalysisMode = 'REFERENCE_MATCHING' | 'MODEL_INFERENCE' | 'HYBRID';
export type QualityVerdict = 'USABLE' | 'MARGINAL' | 'UNUSABLE';

export interface QualityWarning {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  measured?: number | null;
  threshold?: number | null;
}

export interface ReferenceCandidate {
  referenceLevelId: string;
  label: string;
  concentrationValue: number | null;
  colorDistance: number;
  colorRgb?: [number, number, number] | null;
}

export interface Analysis {
  id: string;
  sampleId: string;
  sampleCode: string;
  sampleImageId: string;
  laboratoryId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'REJECTED_QUALITY' | 'FAILED';
  mode: AnalysisMode;
  testMethod: {
    id: string;
    code: string;
    name: string;
    version: string;
    targetAnalyte: string;
    validationStatus: string;
  };
  referenceChart: {
    id: string;
    name: string;
    version: number;
    validationStatus: string;
  } | null;
  prediction: {
    referenceLevelId: string | null;
    label: string | null;
    referenceConcentration: number | null;
    referenceUnit: string | null;
    referenceColorRgb: [number, number, number] | null;
    /** Null unless the method AND chart AND model are all validated. */
    estimatedConcentration: number | null;
    concentrationUnit: string | null;
    /** Null in REFERENCE_MATCHING: a colour distance is not a probability. */
    confidence: number | null;
    colorDistance: number | null;
    alternatives: ReferenceCandidate[];
    outOfRange: boolean;
  };
  /**
   * No `usable` flag: the API reports a `verdict` and nothing else. An
   * earlier version of this file invented one, and because `undefined` is
   * falsy every single result rendered as "could not be measured" while the
   * unit tests — written against the same invented shape — passed.
   */
  imageQuality: {
    verdict: QualityVerdict;
    score: number | null;
    warnings: QualityWarning[];
  };
  measuredColor: {
    rgbMedian: [number, number, number] | null;
    labMedian: [number, number, number] | null;
    roi: { x: number; y: number; width: number; height: number } | null;
  } | null;
  model: {
    name: string | null;
    version: string | null;
    validated: boolean;
    pipelineVersion: string | null;
  };
  isConfirmedMeasurement: boolean;
  confirmedMeasurementCount: number;
  limitations: string[];
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReferenceLevel {
  id: string;
  label: string;
  concentrationValue: number | null;
  concentrationUnit: string;
  sortOrder: number;
  colorRgb: [number, number, number] | null;
  labL: number | null;
  labA: number | null;
  labB: number | null;
}

export interface ReferenceChart {
  id: string;
  testMethodId: string;
  version: number;
  name: string;
  illuminant: string | null;
  validationStatus: string;
  provenanceNote: string | null;
  isActive: boolean;
  levels: ReferenceLevel[];
}

export interface TestMethod {
  id: string;
  code: string;
  name: string;
  targetAnalyte: string;
  methodVersion: string;
  concentrationUnit: string;
  validationStatus: string;
  limitOfDetection: number | null;
  limitOfQuantitation: number | null;
  isActive: boolean;
}

export interface Laboratory {
  id: string;
  name: string;
  laboratoryType: string | null;
  country: string | null;
  city: string | null;
  status?: string;
  memberCount?: number;
  createdAt: string;
}

export interface LaboratoryMember {
  userId: string;
  fullName: string;
  email: string;
  role: Role;
  status: string;
  joinedAt: string;
}

export interface SampleImage {
  id: string;
  sampleId: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  source: string;
  createdAt: string;
}

// ── AI administration ──────────────────────────────────────────────────────

export interface AiStatus {
  serviceReachable: boolean;
  mode: AnalysisMode;
  service: {
    status: string;
    pipelineVersion: string;
    mode: string;
    activeModel: {
      name: string;
      version: string;
      validated: boolean;
      modelType: string;
    } | null;
    uptimeSeconds?: number;
  } | null;
  activeModel: ModelVersion | null;
  dataReadiness: {
    pendingAnnotations: number;
    approvedExamples: number;
    confirmedMeasurements: number;
    datasetVersions: number;
    minimumExamplesForTraining: number;
    readyForTraining: boolean;
    readinessNote: string | null;
  };
}

export interface ModelVersion {
  id: string;
  testMethodId: string | null;
  name: string;
  version: string;
  modelType: string;
  datasetVersion: string | null;
  artifactChecksum: string | null;
  validationMetrics: Record<string, number | null>;
  status: string;
  isActive: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  releasedAt: string | null;
  limitations: string[] | null;
  notes: string | null;
  createdAt: string;
  evaluations?: ModelEvaluation[];
}

export interface ModelEvaluation {
  id: string;
  split: string;
  sampleSize: number;
  accuracy: number | null;
  macroF1: number | null;
  balancedAccuracy: number | null;
  expectedCalibrationError: number | null;
  baselineComparison: Record<string, unknown>;
  evaluationLimitations: string[];
  releaseRecommendation: 'APPROVE' | 'REJECT' | 'INSUFFICIENT_DATA';
  createdAt: string;
}

export interface TrainingJob {
  id: string;
  testMethodId: string;
  testMethodCode: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  datasetVersionId: string | null;
  modelVersionId: string | null;
  requestedParams: Record<string, unknown>;
  progress: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  requestedByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
