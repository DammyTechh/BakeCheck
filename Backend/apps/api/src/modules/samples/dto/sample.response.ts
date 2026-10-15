import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationMeta } from '../../../common/dto/pagination.dto';
import { SampleStatus } from './sample.dto';

export class SampleResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  laboratoryId!: string;

  @ApiProperty({ example: 'BG-2026-0042' })
  sampleCode!: string;

  @ApiProperty({ example: 'bread' })
  sampleType!: string;

  @ApiPropertyOptional({ nullable: true })
  productName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  batchReference?: string | null;

  @ApiPropertyOptional({ nullable: true })
  manufacturer?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  collectedAt?: string | null;

  @ApiProperty({ format: 'date-time' })
  receivedAt!: string;

  @ApiProperty({ enum: SampleStatus })
  status!: SampleStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  testMethodId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'BROMATE-COLOUR-SCREEN' })
  testMethodCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  testMethodName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Validation status of the method. DRAFT or ILLUSTRATIVE means every ' +
      'result from it is an unvalidated screening estimate.',
    example: 'DRAFT',
  })
  testMethodValidationStatus?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  technicianId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  technicianName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  preparationNotes?: string | null;

  @ApiPropertyOptional({ nullable: true })
  dilutionFactor?: number | null;

  @ApiPropertyOptional({ nullable: true })
  notes?: string | null;

  @ApiProperty({ description: 'Images uploaded against this sample.', example: 2 })
  imageCount!: number;

  @ApiProperty({ description: 'Analyses run on this sample.', example: 1 })
  analysisCount!: number;

  @ApiProperty({
    description:
      'Confirmatory laboratory measurements recorded for this sample. ' +
      'Zero means no result here has been chemically confirmed.',
    example: 0,
  })
  measurementCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PaginatedSamplesResponse {
  @ApiProperty({ type: [SampleResponse] })
  data!: SampleResponse[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}
