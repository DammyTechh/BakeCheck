import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { AccessControlService } from '../../common/security/access-control.service';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission, UserRole } from '../../common/types/roles';
import { ReferenceDocs } from '../../swagger/docs/reference.docs';
import {
  CreateReferenceChartDto,
  CreateReferenceLevelDto,
  CreateTestMethodDto,
  ListReferenceChartsQueryDto,
  ListTestMethodsQueryDto,
  UpdateReferenceChartDto,
  UpdateReferenceLevelDto,
  UpdateTestMethodDto,
} from './dto/reference.dto';
import { ReferenceDataService } from './reference-data.service';
import {
  BRACKET_RULE_CONFIRMED,
  INTERPRETATION_SCALE,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_PROVENANCE,
  SCALE_UNIT,
} from './interpretation-scale';

/**
 * Test methods and reference charts.
 *
 * OpenAPI documentation: src/swagger/docs/reference.docs.ts
 *
 * Reference data may be platform-wide (no laboratory) or laboratory-owned, so
 * these routes resolve the owning laboratory per resource rather than taking
 * it from the URL.
 */
@ApiTags('Reference data')
@Controller()
export class ReferenceDataController {
  constructor(
    private readonly referenceService: ReferenceDataService,
    private readonly accessControl: AccessControlService,
  ) {}

  /**
   * Resolves the caller's effective role for a reference resource.
   *
   * Platform-wide data (laboratoryId null) is governed by the platform role;
   * laboratory-owned data by the membership role in that laboratory.
   */
  private effectiveRole(
    user: AuthenticatedUser,
    laboratoryId: string | null,
    resource: string,
  ): UserRole {
    if (laboratoryId === null) {
      if (user.role !== UserRole.SUPER_ADMIN) {
        // Platform-wide reference data is readable by all but writable only
        // by a platform administrator.
        return user.role;
      }
      return UserRole.SUPER_ADMIN;
    }
    return this.accessControl.assertLaboratoryAccess(user, laboratoryId, resource);
  }

  // ── Test methods ──────────────────────────────────────────────────────────

  @Post('test-methods')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.createMethod()
  async createMethod(
    @Body() dto: CreateTestMethodDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    if (dto.laboratoryId) {
      this.accessControl.assertAccess(
        user,
        dto.laboratoryId,
        Permission.REFERENCE_MANAGE,
        'Laboratory',
      );
    }
    return this.referenceService.createTestMethod(dto, user, request.correlationId);
  }

  /**
   * The laboratory's ppm interpretation scale.
   *
   * Static, laboratory-supplied reporting vocabulary. It takes no sample and
   * reads nothing from the database, so it needs no laboratory scoping — but
   * it stays behind authentication alongside the rest of the reference data.
   */
  @Get('reference-data/interpretation-scale')
  @RequirePermissions(Permission.REFERENCE_READ)
  @ReferenceDocs.getInterpretationScale()
  getInterpretationScale() {
    return {
      unit: SCALE_UNIT,
      provenance: SCALE_PROVENANCE,
      min: SCALE_MIN,
      max: SCALE_MAX,
      bracketRuleConfirmedByLaboratory: BRACKET_RULE_CONFIRMED,
      points: INTERPRETATION_SCALE,
      // Stated in the payload so a client cannot infer the opposite from the
      // mere presence of a ppm scale in a colour-matching product.
      appliesTo:
        'A concentration determined by a validated analytical method and ' +
        'recorded against the sample. It is not applied to image-derived ' +
        'results, which carry no concentration.',
      notAColorCalibration: true,
    };
  }

  @Get('test-methods')
  @RequirePermissions(Permission.REFERENCE_READ)
  @ReferenceDocs.listMethods()
  async listMethods(
    @Query() query: ListTestMethodsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.referenceService.listTestMethods(query, user);
  }

  @Get('test-methods/:id')
  @RequirePermissions(Permission.REFERENCE_READ)
  @ReferenceDocs.getMethod()
  async getMethod(@Param('id', ParseUUIDPipe) id: string) {
    return this.referenceService.getTestMethod(id);
  }

  @Patch('test-methods/:id')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.updateMethod()
  async updateMethod(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTestMethodDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.referenceService.resolveMethodLaboratory(id);
    const role = this.effectiveRole(user, laboratoryId, 'Test method');
    return this.referenceService.updateTestMethod(
      id,
      dto,
      user,
      role,
      request.correlationId,
    );
  }

  // ── Reference charts ──────────────────────────────────────────────────────

  @Post('reference-charts')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.createChart()
  async createChart(
    @Body() dto: CreateReferenceChartDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    if (dto.laboratoryId) {
      this.accessControl.assertAccess(
        user,
        dto.laboratoryId,
        Permission.REFERENCE_MANAGE,
        'Laboratory',
      );
    }
    const role = this.effectiveRole(user, dto.laboratoryId ?? null, 'Laboratory');
    return this.referenceService.createChart(dto, user, role, request.correlationId);
  }

  @Get('reference-charts')
  @RequirePermissions(Permission.REFERENCE_READ)
  @ReferenceDocs.listCharts()
  async listCharts(
    @Query() query: ListReferenceChartsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.referenceService.listCharts(query, user);
  }

  @Get('reference-charts/:id')
  @RequirePermissions(Permission.REFERENCE_READ)
  @ReferenceDocs.getChart()
  async getChart(@Param('id', ParseUUIDPipe) id: string) {
    return this.referenceService.getChart(id);
  }

  @Patch('reference-charts/:id')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.updateChart()
  async updateChart(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReferenceChartDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.referenceService.resolveChartLaboratory(id);
    const role = this.effectiveRole(user, laboratoryId, 'Reference chart');
    return this.referenceService.updateChart(id, dto, user, role, request.correlationId);
  }

  @Post('reference-charts/:id/levels')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.addLevel()
  async addLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReferenceLevelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.referenceService.resolveChartLaboratory(id);
    this.effectiveRole(user, laboratoryId, 'Reference chart');
    return this.referenceService.addLevel(id, dto, user, request.correlationId);
  }

  @Patch('reference-levels/:id')
  @RequirePermissions(Permission.REFERENCE_MANAGE)
  @ReferenceDocs.updateLevel()
  async updateLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReferenceLevelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.referenceService.resolveLevelLaboratory(id);
    const role = this.effectiveRole(user, laboratoryId, 'Reference level');
    return this.referenceService.updateLevel(id, dto, user, role, request.correlationId);
  }
}
