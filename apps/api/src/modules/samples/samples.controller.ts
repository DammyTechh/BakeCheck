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
import {
  CurrentUser,
  LaboratoryScope,
  RequirePermissions,
} from '../../common/decorators';
import { AccessControlService } from '../../common/security/access-control.service';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { SamplesDocs } from '../../swagger/docs/samples.docs';
import { CreateSampleDto, ListSamplesQueryDto, UpdateSampleDto } from './dto/sample.dto';
import { PaginatedSamplesResponse, SampleResponse } from './dto/sample.response';
import { SamplesService } from './samples.service';

/**
 * Sample management.
 *
 * OpenAPI documentation lives in `src/swagger/docs/samples.docs.ts`.
 *
 * Two authorisation patterns appear here:
 *  • Routes carrying a laboratory id use @LaboratoryScope, and the guard
 *    verifies membership before the handler runs.
 *  • Routes keyed only by sample id resolve the owning laboratory first and
 *    then check access via AccessControlService.
 */
@ApiTags('Samples')
@Controller('samples')
export class SamplesController {
  constructor(
    private readonly samplesService: SamplesService,
    private readonly accessControl: AccessControlService,
  ) {}

  @Post()
  @LaboratoryScope({ source: 'body', key: 'laboratoryId' })
  @RequirePermissions(Permission.SAMPLE_CREATE)
  @SamplesDocs.create()
  async create(
    @Body() dto: CreateSampleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<SampleResponse> {
    return this.samplesService.create(dto, user, request.correlationId);
  }

  @Get()
  @LaboratoryScope({ source: 'query', key: 'laboratoryId' })
  @RequirePermissions(Permission.SAMPLE_READ)
  @SamplesDocs.list()
  async list(@Query() query: ListSamplesQueryDto): Promise<PaginatedSamplesResponse> {
    return this.samplesService.list(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.SAMPLE_READ)
  @SamplesDocs.findOne()
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SampleResponse> {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(id);
    this.accessControl.assertAccess(user, laboratoryId, Permission.SAMPLE_READ, 'Sample');
    return this.samplesService.findOne(id, laboratoryId);
  }

  @Patch(':id')
  @SamplesDocs.update()
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSampleDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<SampleResponse> {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(id);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.SAMPLE_UPDATE,
      'Sample',
    );
    return this.samplesService.update(id, laboratoryId, dto, user, request.correlationId);
  }
}
