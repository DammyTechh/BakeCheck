import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReferenceCandidateResponse {
  @ApiProperty({ format: 'uuid' })
  referenceLevelId!: string;

  @ApiProperty({ example: 'Chart patch 3 — light blue' })
  label!: string;

  @ApiPropertyOptional({ nullable: true, example: 0.5 })
  concentrationValue!: number | null;

  @ApiProperty({
    example: 12.4,
    description: 'CIEDE2000 perceptual distance. Lower is closer.',
  })
  colorDistance!: number;
}

export class QualityWarningResponse {
  @ApiProperty({ example: 'blur' })
  code!: string;

  @ApiProperty({ enum: ['info', 'warning', 'critical'] })
  severity!: string;

  @ApiProperty({ example: 'The image is out of focus.' })
  message!: string;

  @ApiPropertyOptional({ nullable: true })
  measuredValue!: number | null;

  @ApiPropertyOptional({ nullable: true })
  threshold!: number | null;
}

export class AnalysisTestMethodResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'BROMATE-COLOUR-SCREEN' })
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  version!: string | null;

  @ApiProperty({ example: 'potassium bromate (reported as BrO3-)' })
  targetAnalyte!: string;

  @ApiProperty({
    enum: ['DRAFT', 'ILLUSTRATIVE', 'REVIEWED', 'VALIDATED', 'ARCHIVED'],
    description:
      'Anything other than VALIDATED means no analytical validation has been ' +
      'established for this method in this system.',
  })
  validationStatus!: string;
}

export class AnalysisReferenceChartResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  version!: number | null;

  @ApiProperty({
    enum: ['DRAFT', 'ILLUSTRATIVE', 'REVIEWED', 'VALIDATED', 'ARCHIVED'],
    description:
      'ILLUSTRATIVE means the colours were read from a picture, not measured ' +
      'from prepared standards.',
  })
  validationStatus!: string;
}

export class AnalysisPredictionResponse {
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  referenceLevelId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Chart patch 3 — light blue',
    description: 'The closest reference level by perceptual colour distance.',
  })
  label!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 0.5,
    description:
      'The concentration *printed on the matched reference level*. This is ' +
      "the chart's label, not a measurement of this sample.",
  })
  referenceConcentration!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'ppm' })
  referenceUnit!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: [Number],
    description: 'sRGB of the matched reference level, for side-by-side display.',
  })
  referenceColorRgb!: [number, number, number] | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'A concentration estimated for THIS sample. Null unless a validated ' +
      'model, a validated method and a validated reference chart all apply — ' +
      'which is not the case in prototype reference-matching mode.',
  })
  estimatedConcentration!: number | null;

  @ApiPropertyOptional({ nullable: true })
  concentrationUnit!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Model confidence in [0,1]. Always null in reference-matching mode: a ' +
      'colour distance is not a probability.',
  })
  confidence!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'CIEDE2000 distance to the matched reference colour.',
  })
  colorDistance!: number | null;

  @ApiProperty({ type: [ReferenceCandidateResponse] })
  alternatives!: ReferenceCandidateResponse[];

  @ApiProperty({
    description:
      'True when the measured colour lies beyond the ends of the reference ' +
      'ladder, making the match an extrapolation.',
  })
  outOfRange!: boolean;
}

export class AnalysisImageQualityResponse {
  @ApiPropertyOptional({ enum: ['USABLE', 'MARGINAL', 'UNUSABLE'], nullable: true })
  verdict!: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 1 })
  score!: number | null;

  @ApiProperty({ type: [QualityWarningResponse] })
  warnings!: QualityWarningResponse[];
}

export class MeasuredColorResponse {
  @ApiProperty({ type: [Number], example: [120, 207, 247] })
  rgbMedian!: [number, number, number];

  @ApiProperty({ type: [Number], example: [79.23, -15.54, -27.71] })
  labMedian!: [number, number, number];

  @ApiProperty()
  roi!: {
    x: number;
    y: number;
    width: number;
    height: number;
    mode: string;
  };
}

export class AnalysisModelResponse {
  @ApiPropertyOptional({ nullable: true, example: 'baseline-color-analysis' })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true, example: '0.1.0' })
  version!: string | null;

  @ApiProperty({
    description:
      'Whether the model had been validated against confirmed laboratory ' +
      'measurements at the time this analysis ran.',
  })
  validated!: boolean;

  @ApiPropertyOptional({ nullable: true })
  pipelineVersion!: string | null;
}

export class AnalysisResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sampleId!: string;

  @ApiProperty({ example: 'BG-2026-0042' })
  sampleCode!: string;

  @ApiProperty({ format: 'uuid' })
  sampleImageId!: string;

  @ApiProperty({ format: 'uuid' })
  laboratoryId!: string;

  @ApiProperty({
    enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REJECTED_QUALITY'],
  })
  status!: string;

  @ApiProperty({
    enum: ['REFERENCE_MATCHING', 'MODEL_INFERENCE', 'HYBRID'],
    description:
      'How this result was produced. REFERENCE_MATCHING means transparent ' +
      'colour-distance comparison with no trained model involved.',
  })
  mode!: string;

  @ApiProperty({ type: AnalysisTestMethodResponse })
  testMethod!: AnalysisTestMethodResponse;

  @ApiPropertyOptional({ type: AnalysisReferenceChartResponse, nullable: true })
  referenceChart!: AnalysisReferenceChartResponse | null;

  @ApiProperty({ type: AnalysisPredictionResponse })
  prediction!: AnalysisPredictionResponse;

  @ApiProperty({ type: AnalysisImageQualityResponse })
  imageQuality!: AnalysisImageQualityResponse;

  @ApiPropertyOptional({ type: MeasuredColorResponse, nullable: true })
  measuredColor!: MeasuredColorResponse | null;

  @ApiProperty({ type: AnalysisModelResponse })
  model!: AnalysisModelResponse;

  @ApiProperty({
    description:
      'Always false. An analysis result is an image-derived estimate and is ' +
      'never itself a confirmed measurement. Confirmation lives in ' +
      '/samples/{id}/laboratory-measurements.',
    example: false,
  })
  isConfirmedMeasurement!: boolean;

  @ApiProperty({
    description:
      'Confirmed laboratory measurements linked to this analysis. Zero means ' +
      'nothing has independently confirmed this result.',
    example: 0,
  })
  confirmedMeasurementCount!: number;

  @ApiProperty({
    type: [String],
    description:
      'Caveats recorded with this result, built from the actual validation ' +
      'state of the method, chart and model at the time it ran. Display these ' +
      'to the user — they are not boilerplate.',
    example: [
      'This is an image-based screening estimate, not a chemically confirmed measurement.',
      'Reference chart "Illustrative bromate colour ladder" is marked ILLUSTRATIVE.',
    ],
  })
  limitations!: string[];

  @ApiPropertyOptional({ nullable: true })
  errorCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  errorMessage!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  correlationId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  durationMs!: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  completedAt!: string | null;
}
