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
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { LaboratoriesDocs } from '../../swagger/docs/laboratories.docs';
import {
  AddMemberDto,
  CreateLaboratoryDto,
  ListLaboratoriesQueryDto,
  UpdateLaboratoryDto,
  UpdateMemberDto,
} from './dto/laboratory.dto';
import { LaboratoriesService } from './laboratories.service';

/** OpenAPI documentation: src/swagger/docs/laboratories.docs.ts */
@ApiTags('Laboratories')
@Controller('laboratories')
export class LaboratoriesController {
  constructor(private readonly laboratoriesService: LaboratoriesService) {}

  @Post()
  @LaboratoriesDocs.create()
  async create(
    @Body() dto: CreateLaboratoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.laboratoriesService.create(dto, user, request.correlationId);
  }

  @Get()
  @LaboratoriesDocs.list()
  async list(
    @Query() query: ListLaboratoriesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.laboratoriesService.list(query, user);
  }

  @Get(':id')
  @LaboratoryScope({ source: 'param', key: 'id' })
  @RequirePermissions(Permission.LAB_READ)
  @LaboratoriesDocs.findOne()
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.laboratoriesService.findOne(id);
  }

  @Patch(':id')
  @LaboratoryScope({ source: 'param', key: 'id' })
  @RequirePermissions(Permission.LAB_UPDATE)
  @LaboratoriesDocs.update()
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLaboratoryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.laboratoriesService.update(id, dto, user, request.correlationId);
  }

  @Get(':id/members')
  @LaboratoryScope({ source: 'param', key: 'id' })
  @RequirePermissions(Permission.MEMBER_READ)
  @LaboratoriesDocs.listMembers()
  async listMembers(@Param('id', ParseUUIDPipe) id: string) {
    return this.laboratoriesService.listMembers(id);
  }

  @Post(':id/members')
  @LaboratoryScope({ source: 'param', key: 'id' })
  @RequirePermissions(Permission.MEMBER_MANAGE)
  @LaboratoriesDocs.addMember()
  async addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.laboratoriesService.addMember(id, dto, user, request.correlationId);
  }

  @Patch(':id/members/:userId')
  @LaboratoryScope({ source: 'param', key: 'id' })
  @RequirePermissions(Permission.MEMBER_MANAGE)
  @LaboratoriesDocs.updateMember()
  async updateMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.laboratoriesService.updateMember(
      id,
      userId,
      dto,
      user,
      request.correlationId,
    );
  }
}
