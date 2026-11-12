import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../../common/types/roles';

/** Response shapes. These are what the Swagger schemas are generated from. */

export class LaboratoryMembershipResponse {
  @ApiProperty({ format: 'uuid' })
  laboratoryId!: string;

  @ApiProperty({ example: 'DEMO-LAB-01' })
  laboratoryCode!: string;

  @ApiProperty({ example: 'Demonstration Food Safety Laboratory' })
  laboratoryName!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.LAB_TECHNICIAN })
  role!: UserRole;
}

export class UserProfileResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'technician@breadguard.test' })
  email!: string;

  @ApiProperty({ example: 'Tunde Balogun' })
  fullName!: string;

  @ApiPropertyOptional({ example: 'Analytical Technician', nullable: true })
  jobTitle?: string | null;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty({ example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ type: [LaboratoryMembershipResponse] })
  memberships!: LaboratoryMembershipResponse[];

  @ApiProperty({
    description: "Capabilities granted by this user's role.",
    example: ['sample:read', 'analysis:run'],
  })
  permissions!: string[];

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  lastLoginAt?: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class AuthTokensResponse {
  @ApiProperty({ description: 'Short-lived JWT for the Authorization header.' })
  accessToken!: string;

  @ApiProperty({
    description:
      'Also set as an HttpOnly cookie. Browser clients should rely on the ' +
      'cookie and ignore this field; it exists for non-browser clients.',
  })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime, seconds.' })
  expiresIn!: number;

  @ApiProperty({ type: () => UserProfileResponse })
  user!: UserProfileResponse;
}

export class MessageResponse {
  @ApiProperty({ example: 'Signed out' })
  message!: string;
}
