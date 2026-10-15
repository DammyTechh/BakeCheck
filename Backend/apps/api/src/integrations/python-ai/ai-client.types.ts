/**
 * Wire contract with the internal Python service.
 *
 * These types mirror the Pydantic models in `services/ai/app/schemas/`. The
 * contract is versioned by `pipeline_version` in the response, so a mismatch
 * is visible in the stored analysis record rather than failing silently.
 *
 * Numeric fields that the pipeline cannot justify are `null`, never a
 * fabricated default. A reader must be able to distinguish "measured zero"
 * from "not determined".
 */

export interface AiReferenceLevelInput {
  id: string;
  label: string;
  concentrationValue: number | null;
  concentrationUnit: string;
  sortOrder: number;
  /** CIELAB (D65). Levels without one cannot participate in matching. */
  labL: number;
  labA: number;
  labB: number;
  labStd: number | null;
}

export interface AiRegionOfInterest {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnalyzeImageRequest {
  /** Base64 of the *normalised* derivative, not the original upload. */
  imageBase64: string;
  mimeType: string;
  /** Operator-supplied region. When absent the service detects one. */
  roi?: AiRegionOfInterest | null;
  referenceLevels: AiReferenceLevelInput[];
  testMethod: {
    id: string;
    code: string;
    version: string;
    concentrationUnit: string;
    validationStatus: string;
  };
  referenceChart: {
    id: string;
    version: number;
    validationStatus: string;
  } | null;
  correlationId: string;
}

export type AiAnalysisMode = 'reference_matching' | 'model_inference' | 'hybrid';
export type AiQualityVerdict = 'usable' | 'marginal' | 'unusable';

export interface AiQualityWarning {
  /** Stable identifier, e.g. 'blur', 'overexposure', 'glare'. */
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  /** Measured value behind the warning, when there is one. */
  measuredValue: number | null;
  threshold: number | null;
}

export interface AiImageQuality {
  usable: boolean;
  verdict: AiQualityVerdict;
  /** 0–1 composite. Not a probability; an ordinal summary of the checks. */
  score: number;
  warnings: AiQualityWarning[];
  sharpness: number | null;
  meanBrightness: number | null;
  clippingFraction: number | null;
  contrast: number | null;
}

export interface AiColorFeatures {
  rgbMedian: [number, number, number];
  rgbMean: [number, number, number];
  rgbStd: [number, number, number];
  hsvMedian: [number, number, number];
  labMedian: [number, number, number];
  labMean: [number, number, number];
  labStd: [number, number, number];
  labIqr: [number, number, number];
  saturationMean: number;
  brightnessMean: number;
  contrastScore: number | null;
  sharpnessScore: number | null;
  clippingFraction: number;
  backgroundLab: [number, number, number] | null;
  pixelCount: number;
  maskedFraction: number;
  colorSpace: string;
}

export interface AiReferenceCandidate {
  referenceLevelId: string;
  label: string;
  concentrationValue: number | null;
  /** CIEDE2000 perceptual distance. Lower is closer. */
  colorDistance: number;
}

export interface AiReferenceMatch {
  referenceLevelId: string | null;
  label: string | null;
  colorDistance: number | null;
  /** Runner-up levels, nearest first. */
  alternatives: AiReferenceCandidate[];
  /** True when the colour sits beyond the ends of the reference ladder. */
  outOfRange: boolean;
}

export interface AiPrediction {
  label: string | null;
  /** Null unless a validated model supports a numeric estimate. */
  estimatedConcentration: number | null;
  unit: string | null;
  /** Null in reference-matching mode — a distance is not a probability. */
  confidence: number | null;
}

export interface AiModelInfo {
  name: string;
  version: string;
  /** False until the model has been evaluated and approved. */
  validated: boolean;
  modelType: string;
  datasetVersion: string | null;
}

export interface AnalyzeImageResponse {
  analysisId: string;
  status: 'completed' | 'rejected_quality' | 'failed';
  mode: AiAnalysisMode;
  imageQuality: AiImageQuality;
  colorFeatures: AiColorFeatures | null;
  roi: AiRegionOfInterest & {
    mode: 'AUTO_TUBE_DETECTION' | 'MANUAL_SELECTION' | 'CENTER_FALLBACK';
    confidence: number | null;
  };
  prediction: AiPrediction;
  referenceMatch: AiReferenceMatch;
  model: AiModelInfo;
  /** Plain-language caveats, surfaced verbatim to the user. */
  limitations: string[];
  pipelineVersion: string;
  processingMs: number;
  correlationId: string;
}

export interface AiServiceStatus {
  status: 'ok' | 'degraded';
  pipelineVersion: string;
  activeModel: AiModelInfo | null;
  /** Models the service can load right now. */
  availableModels: Array<{ name: string; version: string; validated: boolean }>;
  mode: AiAnalysisMode;
  uptimeSeconds: number;
}
