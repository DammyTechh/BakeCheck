import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { AccessControlService } from '../../common/security/access-control.service';
import {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../../common/types/request-context';
import { Permission } from '../../common/types/roles';
import { UploadedFile as UploadedFileType } from '../../common/types/uploaded-file';
import { ImagesDocs } from '../../swagger/docs/images.docs';
import { SamplesService } from '../samples/samples.service';
import { ImagesService } from './images.service';

/** Multer's own limits. Content validation happens in ImageValidationService. */
const UPLOAD_LIMITS = {
  fileSize: 10 * 1024 * 1024,
  files: 1,
  fields: 5,
  parts: 10,
};

/**
 * Image upload and retrieval.
 *
 * OpenAPI documentation: src/swagger/docs/images.docs.ts
 *
 * Upload routes are mounted under /samples/:id/images because an image only
 * means anything in the context of the sample it was taken of.
 */
@ApiTags('Images')
@Controller()
export class ImagesController {
  constructor(
    private readonly imagesService: ImagesService,
    private readonly samplesService: SamplesService,
    private readonly accessControl: AccessControlService,
  ) {}

  @Post('samples/:id/images')
  @RequirePermissions(Permission.IMAGE_UPLOAD)
  // Tighter than the global limit: each upload is bytes over the wire plus a
  // full image decode.
  @Throttle({ upload: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: UPLOAD_LIMITS }))
  @ImagesDocs.upload()
  async upload(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @UploadedFile() file: UploadedFileType | undefined,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
    @Query('source') source?: string,
  ) {
    if (!file) {
      throw ApiError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'No file was uploaded. Send the image as multipart form data under ' +
          'the field name "file".',
      );
    }

    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    this.accessControl.assertAccess(
      user,
      laboratoryId,
      Permission.IMAGE_UPLOAD,
      'Sample',
    );

    return this.imagesService.upload({
      sampleId,
      laboratoryId,
      buffer: file.buffer,
      // Advisory only; the real type comes from the file signature.
      declaredMimeType: file.mimetype,
      originalFilename: file.originalname,
      source: source === 'CAMERA' ? 'CAMERA' : 'UPLOAD',
      actor: user,
      correlationId: request.correlationId,
    });
  }

  @Get('samples/:id/images')
  @RequirePermissions(Permission.SAMPLE_READ)
  @ImagesDocs.list()
  async list(
    @Param('id', ParseUUIDPipe) sampleId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const laboratoryId = await this.samplesService.resolveLaboratoryId(sampleId);
    this.accessControl.assertAccess(user, laboratoryId, Permission.SAMPLE_READ, 'Sample');
    return this.imagesService.listForSample(sampleId, laboratoryId);
  }

  @Get('images/:imageId')
  @RequirePermissions(Permission.SAMPLE_READ)
  @ImagesDocs.download()
  async download(
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
    @Query('mode') mode?: string,
  ): Promise<void> {
    const image = await this.imagesService.findOne(imageId);
    this.accessControl.assertAccess(
      user,
      image.laboratory_id,
      Permission.SAMPLE_READ,
      'Image',
    );

    const access = await this.imagesService.getAccess(
      imageId,
      user,
      request.correlationId,
    );

    if (access.kind === 'signed-url') {
      if (mode === 'json') {
        response.json({
          url: access.url,
          expiresInSeconds: access.expiresInSeconds,
        });
        return;
      }
      response.redirect(302, access.url);
      return;
    }

    // Streamed through the API. Content-Disposition is `inline` so a browser
    // can render it, and nosniff prevents the browser second-guessing the
    // declared type.
    response.setHeader('Content-Type', access.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(access.filename)}"`,
    );
    // Private: this is confidential laboratory data and must not be cached by
    // a shared proxy.
    response.setHeader('Cache-Control', 'private, max-age=300, no-transform');
    response.send(access.buffer);
  }
}
