import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { AccessControlService } from '../../common/security/access-control.service';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { FeedbackDocs } from '../../swagger/docs/feedback.docs';
import { SamplesService } from '../samples/samples.service';
import {
  CreateFeedbackDto,
  CreateMeasurementDto,
  ReviewFeedbackDto,
} from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

/** OpenAPI documentation: src/swagger/docs/feedback.docs.ts */
@ApiTags('Feedback and measurements')
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedbackService: FeedbackService,
    private readonly samplesService: SamplesService,
    private readonly accessControl: AccessControlService,
  ) {}

  @Post('analyses/:id/feedback')
  @RequirePermissions(Permission.FEEDBACK_CREATE)
  @FeedbackDocs.create()
  async createFeedback(
    @Param('id', ParseUUIDPipe) analysisId: string,
    @Body() dto: CreateFeedbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.feedbackService.resolveAnalysisLaboratory(analysisId);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.FEEDBACK_CREATE,
      'Analysis',
    );
    return this.feedbackService.createFeedback(
      analysisId,
      dto,
      user,
      request.correlationId,
    );
  }

  @Get('analyses/:id/feedback')
  @RequirePermissions(Permission.ANALYSIS_READ)
  @FeedbackDocs.list()
  async listFeedback(
    @Param('id', ParseUUIDPipe) analysisId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const laboratoryId = await this.feedbackService.resolveAnalysisLaboratory(analysisId);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.ANALYSIS_READ,
      'Analysis',
    );
    return this.feedbackService.listForAnalysis(analysisId, laboratoryId);
  }

  @Post('feedback/:id/review')
  @FeedbackDocs.review()
  async reviewFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewFeedbackDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.feedbackService.resolveAnnotationLaboratory(id);
    const role = this.accessControl.assertLaboratoryAccess(
      user,
      laboratoryId,
      'Feedback',
    );
    return this.feedbackService.reviewFeedback(
      id,
      dto,
      user,
      role,
      request.correlationId,
    );
  }

  @Post('samples/:id/laboratory-measurements')
  @RequirePermissions(Permission.MEASUREMENT_CREATE)
  @FeedbackDocs.createMeasurement()
  async createMeasurement(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @Body() dto: CreateMeasurementDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    const role = this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.MEASUREMENT_CREATE,
      'Sample',
    );
    return this.feedbackService.createMeasurement(
      sampleId,
      dto,
      user,
      role,
      request.correlationId,
    );
  }

  @Get('samples/:id/laboratory-measurements')
  @RequirePermissions(Permission.SAMPLE_READ)
  @FeedbackDocs.listMeasurements()
  async listMeasurements(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    this.accessControl.assertAccess(user, laboratoryId, Permission.SAMPLE_READ, 'Sample');
    return this.feedbackService.listMeasurementsForSample(sampleId, laboratoryId);
  }
}
