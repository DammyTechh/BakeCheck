import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/**
 * Validation status.
 *
 * ILLUSTRATIVE is the honest default for reference data derived from a
 * picture. VALIDATED is reserved for data traceable to prepared standards
 * measured under controlled conditions; the API refuses to set it without an
 * attributed reviewer.
 */
export enum ValidationStatus {
  DRAFT = 'DRAFT',
  ILLUSTRATIVE = 'ILLUSTRATIVE',
  REVIEWED = 'REVIEWED',
  VALIDATED = 'VALIDATED',
  ARCHIVED = 'ARCHIVED',
}

export enum ColorSource {
  IMAGE_SAMPLED = 'IMAGE_SAMPLED',
  MANUAL_ENTRY = 'MANUAL_ENTRY',
  INSTRUMENT_MEASURED = 'INSTRUMENT_MEASURED',
}

// ── Test methods ────────────────────────────────────────────────────────────

export class CreateTestMethodDto {
  @ApiPropertyOptional({
    description:
      'Owning laboratory. Omit to create a platform-wide method (SUPER_ADMIN only).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  laboratoryId?: string;

  @ApiProperty({ example: 'BROMATE-COLOUR-SCREEN', maxLength: 64 })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, {
    message: 'Code may contain letters, digits, dot, underscore and hyphen',
  })
  code!: string;

  @ApiProperty({ example: 'Colorimetric bromate screening', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description: 'What the method looks for.',
    example: 'potassium bromate (reported as BrO3-)',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  targetAnalyte!: string;

  @ApiProperty({
    description:
      'The sample matrix this method was developed for. A method validated ' +
      'for one matrix is not automatically valid for another.',
    example: 'bread crumb extract',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  applicableMatrix!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Citation or SOP reference for the procedure.',
    example: 'In-house SOP BG-SOP-04 rev 2',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  procedureReference?: string;

  @ApiPropertyOptional({
    description: 'Reagent system and reaction timing used by your laboratory.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reagentNotes?: string;

  @ApiPropertyOptional({ example: '1.0.0', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  methodVersion?: string;

  @ApiPropertyOptional({
    description:
      'Unit for every reference level under this method. Note that a ppm ' +
      'value is only meaningful alongside its matrix and preparation.',
    example: 'ppm',
    default: 'ppm',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  concentrationUnit?: string;

  @ApiPropertyOptional({
    description: 'Limit of detection, if your laboratory has established one.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  limitOfDetection?: number;

  @ApiPropertyOptional({ description: 'Limit of quantitation, if established.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  limitOfQuantitation?: number;

  @ApiPropertyOptional({
    description:
      'What has and has not been established for this method. Be specific — ' +
      'this text is surfaced with every result derived from the method.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  validationNotes?: string;
}

export class UpdateTestMethodDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  procedureReference?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reagentNotes?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  applicableMatrix?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  limitOfDetection?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  limitOfQuantitation?: number;

  @ApiPropertyOptional({
    enum: ValidationStatus,
    description:
      'Setting VALIDATED requires the `reference:validate` capability and ' +
      'records the caller as the validating reviewer.',
  })
  @IsOptional()
  @IsEnum(ValidationStatus)
  validationStatus?: ValidationStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  validationNotes?: string;

  @ApiPropertyOptional({
    description: 'Archive the method without deleting historical results.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListTestMethodsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: "Restrict to this laboratory's methods plus platform-wide ones.",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  laboratoryId?: string;

  @ApiPropertyOptional({ enum: ValidationStatus })
  @IsOptional()
  @IsEnum(ValidationStatus)
  validationStatus?: ValidationStatus;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

// ── Reference charts ────────────────────────────────────────────────────────

export class CreateReferenceChartDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  testMethodId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  laboratoryId?: string;

  @ApiProperty({ example: 'Bromate colour ladder, lot 2026-A', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Where the chart came from — vendor insert, photograph, illustration.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  source?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sourceUrl?: string;

  @ApiPropertyOptional({
    description:
      'Illuminant the colours were observed under, if known (e.g. D65). ' +
      'Without it, colour comparison across devices is unreliable.',
    example: 'D65',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  illuminant?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  captureDevice?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Stored chart image.' })
  @IsOptional()
  @IsUUID()
  chartImageId?: string;

  @ApiPropertyOptional({
    enum: ValidationStatus,
    default: ValidationStatus.ILLUSTRATIVE,
    description:
      'Defaults to ILLUSTRATIVE. Do not set VALIDATED for colours read from ' +
      'a picture — that is what ILLUSTRATIVE exists to record.',
  })
  @IsOptional()
  @IsEnum(ValidationStatus)
  validationStatus?: ValidationStatus;

  @ApiPropertyOptional({
    description: 'The chart this one replaces, when versioning.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  supersedesId?: string;

  @ApiPropertyOptional({
    description: 'Levels to create with the chart.',
    type: () => [CreateReferenceLevelDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => CreateReferenceLevelDto)
  levels?: CreateReferenceLevelDto[];
}

export class CreateReferenceLevelDto {
  @ApiProperty({ example: 'Chart patch 3 — light blue', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional({
    description: 'Nominal concentration printed on this step.',
    example: 0.5,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  concentrationValue?: number;

  @ApiPropertyOptional({ example: 'ppm', default: 'ppm' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  concentrationUnit?: string;

  @ApiProperty({ description: 'Position in the ladder, from 0.', example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder!: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255, example: 120 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbR?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255, example: 207 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbG?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255, example: 247 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbB?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 100,
    example: 79.23,
    description:
      'CIELAB lightness. The matcher uses L*a*b*, not RGB — supply these ' +
      'for a level to participate in matching. If omitted but RGB is given, ' +
      'the server converts (sRGB, D65).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  labL?: number;

  @ApiPropertyOptional({ minimum: -128, maximum: 128, example: -15.54 })
  @IsOptional()
  @IsNumber()
  @Min(-128)
  @Max(128)
  labA?: number;

  @ApiPropertyOptional({ minimum: -128, maximum: 128, example: -27.71 })
  @IsOptional()
  @IsNumber()
  @Min(-128)
  @Max(128)
  labB?: number;

  @ApiPropertyOptional({
    description: 'Observed spread across the patch; widens match tolerance.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  labStd?: number;

  @ApiPropertyOptional({ description: 'Region on the chart image this came from.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  roiX?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  roiY?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roiWidth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roiHeight?: number;

  @ApiPropertyOptional({
    enum: ColorSource,
    default: ColorSource.MANUAL_ENTRY,
    description:
      'How the colour was obtained. IMAGE_SAMPLED means it was read off a ' +
      'picture, which is not a calibrated colorimetric measurement.',
  })
  @IsOptional()
  @IsEnum(ColorSource)
  colorSource?: ColorSource;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateReferenceLevelDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  concentrationValue?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbR?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbG?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 255 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(255)
  rgbB?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  labL?: number;

  @ApiPropertyOptional({ minimum: -128, maximum: 128 })
  @IsOptional()
  @IsNumber()
  @Min(-128)
  @Max(128)
  labA?: number;

  @ApiPropertyOptional({ minimum: -128, maximum: 128 })
  @IsOptional()
  @IsNumber()
  @Min(-128)
  @Max(128)
  labB?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  labStd?: number;

  @ApiPropertyOptional({ enum: ColorSource })
  @IsOptional()
  @IsEnum(ColorSource)
  colorSource?: ColorSource;

  @ApiPropertyOptional({ enum: ValidationStatus })
  @IsOptional()
  @IsEnum(ValidationStatus)
  validationStatus?: ValidationStatus;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateReferenceChartDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  source?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  illuminant?: string;

  @ApiPropertyOptional({ enum: ValidationStatus })
  @IsOptional()
  @IsEnum(ValidationStatus)
  validationStatus?: ValidationStatus;

  @ApiPropertyOptional({
    description: 'Archive without deleting; historical results keep their link.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListReferenceChartsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  testMethodId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  laboratoryId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;
}

export class SampleChartColorDto {
  @ApiProperty({ format: 'uuid', description: 'Stored chart image to sample.' })
  @IsUUID()
  imageId!: string;

  @ApiProperty({ description: 'Region to average, in pixels.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  x!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  y!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  width!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  height!: number;
}
