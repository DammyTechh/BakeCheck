import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../../../common/security/password.constants';

/**
 * Request DTOs.
 *
 * Validation lives on the DTO and is enforced by a global ValidationPipe with
 * `whitelist` and `forbidNonWhitelisted` enabled, so any property not declared
 * here is rejected outright. That is the mass-assignment defence: a client
 * cannot smuggle `role` or `status` into a registration request.
 */

export class RegisterDto {
  @ApiProperty({ example: 'technician@laboratory.test', maxLength: 255 })
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(255)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    description:
      'At least 12 characters. Length is the requirement; no composition rules.',
    example: 'correct-horse-battery-staple',
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  })
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Tunde Balogun', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @ApiPropertyOptional({ example: 'Analytical Technician', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  jobTitle?: string;

  @ApiPropertyOptional({
    description:
      'Join an existing laboratory by its code. Omit to register without a ' +
      'laboratory; an administrator can add you afterwards.',
    example: 'DEMO-LAB-01',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, {
    message: 'Laboratory code must be uppercase alphanumeric with - or _',
  })
  laboratoryCode?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'technician@breadguard.test' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(255)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Refresh token. Optional when the token is supplied via the HttpOnly ' +
      'refresh cookie, which is the preferred transport for browsers.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  fullName?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  jobTitle?: string;
}
