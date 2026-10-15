import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { AiDocs } from '../../swagger/docs/ai.docs';
import {
  ApproveModelDto,
  CreateTrainingJobDto,
  RollbackModelDto,
} from './dto/ai-admin.dto';
import { AiAdminService } from './ai-admin.service';

/**
 * Model lifecycle administration.
 *
 * OpenAPI documentation: src/swagger/docs/ai.docs.ts
 *
 * Training, approval and rollback are restricted to administrative roles —
 * these operations change what every future result means.
 */
@ApiTags('AI administration')
@Controller('ai')
export class AiAdminController {
  constructor(private readonly aiAdminService: AiAdminService) {}

  @Get('status')
  @RequirePermissions(Permission.MODEL_READ)
  @AiDocs.status()
  async status(@Req() request: AuthenticatedRequest) {
    return this.aiAdminService.getStatus(request.correlationId);
  }

  @Get('models')
  @RequirePermissions(Permission.MODEL_READ)
  @AiDocs.listModels()
  async listModels(
    @Query('testMethodId') testMethodId?: string,
    @Query('status') status?: string,
  ) {
    return this.aiAdminService.listModels({ testMethodId, status });
  }

  @Get('models/:id')
  @RequirePermissions(Permission.MODEL_READ)
  @AiDocs.getModel()
  async getModel(@Param('id', ParseUUIDPipe) id: string) {
    return this.aiAdminService.getModel(id);
  }

  @Post('training-jobs')
  @RequirePermissions(Permission.MODEL_TRAIN)
  @AiDocs.createTrainingJob()
  async createTrainingJob(
    @Body() dto: CreateTrainingJobDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.aiAdminService.createTrainingJob(dto, user, request.correlationId);
  }

  @Get('training-jobs/:id')
  @RequirePermissions(Permission.MODEL_READ)
  @AiDocs.getTrainingJob()
  async getTrainingJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.aiAdminService.getTrainingJob(id);
  }

  @Post('models/:id/approve')
  @RequirePermissions(Permission.MODEL_APPROVE)
  @AiDocs.approveModel()
  async approveModel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveModelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.aiAdminService.approveModel(id, dto, user, request.correlationId);
  }

  @Post('models/:id/rollback')
  @RequirePermissions(Permission.MODEL_APPROVE)
  @AiDocs.rollbackModel()
  async rollbackModel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollbackModelDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.aiAdminService.rollbackModel(id, dto, user, request.correlationId);
  }
}
