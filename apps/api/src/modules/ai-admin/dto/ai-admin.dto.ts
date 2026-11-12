import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum ModelType {
  SKLEARN_CLASSIFIER = 'SKLEARN_CLASSIFIER',
  SKLEARN_REGRESSOR = 'SKLEARN_REGRESSOR',
}

export class CreateTrainingJobDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  testMethodId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  laboratoryId?: string;

  @ApiPropertyOptional({
    enum: ModelType,
    default: ModelType.SKLEARN_CLASSIFIER,
    description:
      'Classification predicts a reference level; regression predicts a ' +
      'concentration and requires measurement-backed labels.',
  })
  @IsOptional()
  @IsEnum(ModelType)
  modelType?: ModelType;

  @ApiPropertyOptional({
    minimum: 0.1,
    maximum: 0.4,
    default: 0.2,
    description: 'Fraction of examples held out for the test split.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(0.4)
  testSplit?: number;

  @ApiPropertyOptional({ minimum: 0.1, maximum: 0.4, default: 0.2 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(0.4)
  validationSplit?: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ApproveModelDto {
  @ApiPropertyOptional({
    description: 'Notes recorded with the approval decision.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Required to approve a model whose evaluation does not meet the ' +
      'release criteria. The override and its reason are written to the ' +
      'audit log — this is a deliberate, attributable decision, not a bypass.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  overrideReason?: string;
}

export class RollbackModelDto {
  @ApiProperty({
    description: 'Why this model is being withdrawn. Recorded permanently.',
    example: 'Systematically over-predicting the 5 ppm level on tablet cameras.',
    maxLength: 2000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Model version to activate instead. Defaults to the version this one ' +
      'replaced, or the baseline reference matcher.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  targetVersionId?: string;
}
