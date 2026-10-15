import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export enum SampleStatus {
  REGISTERED = 'REGISTERED',
  PREPARED = 'PREPARED',
  ANALYZED = 'ANALYZED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  CONFIRMED = 'CONFIRMED',
  REJECTED = 'REJECTED',
  ARCHIVED = 'ARCHIVED',
}

export class CreateSampleDto {
  @ApiProperty({
    description:
      'The laboratory registering this sample. Must be one the caller belongs to.',
    format: 'uuid',
  })
  @IsUUID()
  laboratoryId!: string;

  @ApiProperty({
    description: "Your laboratory's own identifier. Unique within the laboratory.",
    example: 'BG-2026-0042',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, {
    message: 'Sample code may contain letters, digits, dot, underscore, hyphen and slash',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  sampleCode!: string;

  @ApiProperty({ example: 'bread', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  sampleType!: string;

  @ApiPropertyOptional({ example: 'White sandwich loaf', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string;

  @ApiPropertyOptional({ example: 'LOT-88213', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  batchReference?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  manufacturer?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  collectedAt?: string;

  @ApiPropertyOptional({
    description: 'The test method this sample will be screened with.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  testMethodId?: string;

  @ApiPropertyOptional({
    description:
      'Preparation details recorded by your laboratory. This platform does ' +
      'not supply or validate any preparation protocol.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  preparationNotes?: string;

  @ApiPropertyOptional({
    description: 'Dilution applied during preparation, if any. Must be > 0.',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  dilutionFactor?: number;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateSampleDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  sampleType?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  productName?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  batchReference?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  manufacturer?: string;

  @ApiPropertyOptional({ enum: SampleStatus })
  @IsOptional()
  @IsEnum(SampleStatus)
  status?: SampleStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  testMethodId?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  preparationNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  dilutionFactor?: number;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class ListSamplesQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: 'Laboratory to list samples from.',
    format: 'uuid',
  })
  @IsUUID()
  laboratoryId!: string;

  @ApiPropertyOptional({
    description: 'Free-text search across sample code, product and batch.',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: SampleStatus })
  @IsOptional()
  @IsEnum(SampleStatus)
  status?: SampleStatus;

  @ApiPropertyOptional({ example: 'bread' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  sampleType?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  testMethodId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Only samples received on or after this instant.',
  })
  @IsOptional()
  @IsDateString()
  receivedFrom?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  receivedTo?: string;

  @ApiPropertyOptional({
    enum: ['createdAt', 'receivedAt', 'sampleCode', 'status'],
    default: 'createdAt',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;
}

/**
 * A rectangular region in pixel coordinates on the stored image.
 *
 * Declared before AnalyzeSampleDto on purpose: `emitDecoratorMetadata`
 * evaluates the referenced class at decoration time, so a class used in
 * another's decorators must already be initialised. Defining it afterwards
 * compiles cleanly and then throws "Cannot access before initialization" at
 * require time.
 */
export class RegionOfInterestDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  x!: number;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  y!: number;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  width!: number;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  height!: number;
}

export class AnalyzeSampleDto {
  @ApiProperty({
    description: 'The uploaded image to analyse.',
    format: 'uuid',
  })
  @IsUUID()
  imageId!: string;

  @ApiPropertyOptional({
    description:
      'Reference chart to compare against. Defaults to the active chart for ' +
      "the sample's test method.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  referenceChartId?: string;

  @ApiPropertyOptional({
    description:
      'Manually selected region of interest, in pixels on the stored image. ' +
      'Omit to let the service detect the tube automatically.',
    type: () => RegionOfInterestDto,
  })
  @IsOptional()
  @Type(() => RegionOfInterestDto)
  roi?: RegionOfInterestDto;
}
