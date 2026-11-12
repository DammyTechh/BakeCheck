import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { UserRole } from '../../../common/types/roles';

export enum LaboratoryStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  ARCHIVED = 'ARCHIVED',
}

export enum MembershipStatus {
  INVITED = 'INVITED',
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export class CreateLaboratoryDto {
  @ApiProperty({
    description: 'Unique short code. Uppercase alphanumeric with - or _.',
    example: 'LAG-CENTRAL-01',
    maxLength: 64,
  })
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, {
    message: 'Code must be uppercase alphanumeric, optionally with - or _',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  code!: string;

  @ApiProperty({ example: 'Lagos Central Food Safety Laboratory', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ format: 'email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiPropertyOptional({ example: 'NG', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  postalCode?: string;

  @ApiPropertyOptional({
    description: 'Accreditation reference, e.g. an ISO 17025 certificate number.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accreditationRef?: string;
}

export class UpdateLaboratoryDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ format: 'email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  postalCode?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accreditationRef?: string;

  @ApiPropertyOptional({
    enum: LaboratoryStatus,
    description: 'Platform administrators only.',
  })
  @IsOptional()
  @IsEnum(LaboratoryStatus)
  status?: LaboratoryStatus;
}

export class ListLaboratoriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: LaboratoryStatus })
  @IsOptional()
  @IsEnum(LaboratoryStatus)
  status?: LaboratoryStatus;
}

export class AddMemberDto {
  @ApiProperty({
    description:
      'Email of an existing account. This endpoint does not create users — ' +
      "an administrator must not be able to set another person's password.",
    format: 'email',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.LAB_TECHNICIAN })
  @IsEnum(UserRole)
  role!: UserRole;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ enum: MembershipStatus })
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;
}
