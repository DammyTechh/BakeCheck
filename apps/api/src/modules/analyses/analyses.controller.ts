import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { AccessControlService } from '../../common/security/access-control.service';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { AnalysesDocs } from '../../swagger/docs/analyses.docs';
import { AnalyzeSampleDto } from '../samples/dto/sample.dto';
import { SamplesService } from '../samples/samples.service';
import { AnalysesService } from './analyses.service';
import { AnalysisResponse } from './dto/analysis.response';

/** OpenAPI documentation: src/swagger/docs/analyses.docs.ts */
@ApiTags('Analyses')
@Controller()
export class AnalysesController {
  constructor(
    private readonly analysesService: AnalysesService,
    private readonly samplesService: SamplesService,
    private readonly accessControl: AccessControlService,
  ) {}

  @Post('samples/:id/analyze')
  @RequirePermissions(Permission.ANALYSIS_RUN)
  // Each analysis is CPU-heavy in the vision service, so this is throttled
  // well below the global rate.
  @Throttle({ analysis: { limit: 20, ttl: 60_000 } })
  @AnalysesDocs.analyze()
  async analyze(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @Body() dto: AnalyzeSampleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AnalysisResponse> {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.ANALYSIS_RUN,
      'Sample',
    );

    return this.analysesService.analyze(
      sampleId,
      laboratoryId,
      dto,
      user,
      request.correlationId,
    );
  }

  @Get('analyses/:id')
  @RequirePermissions(Permission.ANALYSIS_READ)
  @AnalysesDocs.findOne()
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AnalysisResponse> {
    const laboratoryId = await this.analysesService.resolveLaboratoryId(id);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.ANALYSIS_READ,
      'Analysis',
    );
    return this.analysesService.findOne(id, laboratoryId);
  }

  @Get('samples/:id/results')
  @RequirePermissions(Permission.ANALYSIS_READ)
  @AnalysesDocs.listForSample()
  async listForSample(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AnalysisResponse[]> {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.ANALYSIS_READ,
      'Sample',
    );
    return this.analysesService.listForSample(sampleId, laboratoryId);
  }
}
