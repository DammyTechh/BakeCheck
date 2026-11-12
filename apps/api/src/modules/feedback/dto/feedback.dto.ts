import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RegionOfInterestDto } from '../../samples/dto/sample.dto';

export enum QualityOpinion {
  USABLE = 'USABLE',
  MARGINAL = 'MARGINAL',
  UNUSABLE = 'UNUSABLE',
}

export enum ReviewDecision {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum ConfirmationStatus {
  PRELIMINARY = 'PRELIMINARY',
  CONFIRMED = 'CONFIRMED',
  DISPUTED = 'DISPUTED',
  WITHDRAWN = 'WITHDRAWN',
}

/**
 * Technician feedback on a screening result.
 *
 * This records an informed human reading of a colour. It is deliberately a
 * different shape from CreateMeasurementDto: there is no field here for a
 * concentration, because a technician looking at a tube is not measuring one.
 */
export class CreateFeedbackDto {
  @ApiPropertyOptional({
    description:
      'The reference level you believe is correct. Omit to accept the ' +
      "pipeline's own match.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  correctedLevelId?: string;

  @ApiPropertyOptional({
    description: 'A corrected region of interest, when the automatic one was wrong.',
    type: () => RegionOfInterestDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RegionOfInterestDto)
  roi?: RegionOfInterestDto;

  @ApiPropertyOptional({
    description: 'Why the result was corrected or flagged.',
    example: 'Glare on the tube pulled the measurement towards a lighter level.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  feedbackReason?: string;

  @ApiPropertyOptional({
    enum: QualityOpinion,
    description: 'Your own judgement of whether the image was good enough.',
  })
  @IsOptional()
  @IsEnum(QualityOpinion)
  qualityOpinion?: QualityOpinion;

  @ApiPropertyOptional({
    description: 'Flag this prediction as unreliable.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  flaggedUnreliable?: boolean;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Submit this annotation for reviewer approval. Approval is what makes ' +
      'it eligible for a training dataset; without it the annotation is ' +
      'recorded but never trained on.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  submitForReview?: boolean;
}

export class ReviewFeedbackDto {
  @ApiProperty({ enum: ReviewDecision })
  @IsEnum(ReviewDecision)
  decision!: ReviewDecision;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

/**
 * A confirmatory measurement from an analytical instrument.
 *
 * Separate from feedback on purpose. This is the only input to the system
 * that may be described as a confirmed concentration, and it carries the
 * provenance that claim requires: the method used, the instrument, the
 * uncertainty and the detection limit.
 */
export class CreateMeasurementDto {
  @ApiPropertyOptional({
    description: 'The screening result this measurement confirms or refutes.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  analysisId?: string;

  @ApiProperty({
    description:
      'The analytical method actually used. Free text — a confirmatory ' +
      "technique need not be one of this platform's configured test methods.",
    example: 'IC-ICP-MS',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  measurementMethod!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  instrument?: string;

  @ApiPropertyOptional({
    description:
      'The measured concentration. Omit only when belowDetectionLimit is true.',
    example: 0.42,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  concentrationValue?: number;

  @ApiProperty({ example: 'ppm', maxLength: 32 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  concentrationUnit!: string;

  @ApiPropertyOptional({
    description: 'Reported measurement uncertainty, in the same unit.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  uncertainty?: number;

  @ApiPropertyOptional({
    description: 'Detection limit for this run, in the same unit.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  detectionLimit?: number;

  @ApiPropertyOptional({
    description:
      'True when the analyte was not detected. Recorded explicitly rather ' +
      'than as a concentration of zero, which would be a different claim.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  belowDetectionLimit?: boolean;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  measuredAt!: string;

  @ApiPropertyOptional({
    enum: ConfirmationStatus,
    default: ConfirmationStatus.PRELIMINARY,
    description:
      'CONFIRMED requires the measurement:confirm capability and records you ' +
      'as the reviewer.',
  })
  @IsOptional()
  @IsEnum(ConfirmationStatus)
  confirmationStatus?: ConfirmationStatus;

  @ApiPropertyOptional({
    description: 'Where the result came from — internal run, external lab.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  provenance?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  certificateRef?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
