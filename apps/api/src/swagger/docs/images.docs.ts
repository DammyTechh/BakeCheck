import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
} from '@nestjs/swagger';
import {
  BadRequestResponse,
  ForbiddenResponse,
  NotFoundResponse,
  PayloadTooLargeResponse,
  TooManyRequestsResponse,
  UnauthorizedResponse,
  UnsupportedMediaTypeResponse,
} from '../shared/responses';

/**
 * OpenAPI documentation for image upload and retrieval.
 *
 * ## Upload handling
 *
 * Uploads are validated on the server, not merely in the browser. In order:
 * size, then file signature (magic bytes), then header dimensions, then a
 * full decode under a pixel cap, then a re-encode.
 *
 * The declared `Content-Type` and the filename are **not trusted** — the
 * format is determined by inspecting the bytes. SVG is rejected outright: it
 * is a document format that can carry script and fetch remote resources, and
 * it has no place in a colour-measurement pipeline.
 *
 * ## Two stored copies
 *
 * - the **original**, byte-for-byte, as the evidentiary record;
 * - a **normalised derivative** — EXIF rotation applied, metadata stripped,
 *   re-encoded as PNG — which is what the vision service measures. Rotation
 *   is applied before anything records coordinates, so a region of interest
 *   refers to the same pixels the technician saw.
 *
 * EXIF is stripped from the derivative: it can carry GPS coordinates and
 * device serial numbers that have no business travelling with a sample image.
 *
 * ## Access
 *
 * There is no permanent public URL. Reads go through a short-lived signed URL
 * when the storage driver can issue one, and otherwise stream through this
 * authenticated endpoint.
 */
export const ImagesDocs = {
  upload: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiConsumes('multipart/form-data'),
      ApiOperation({
        summary: 'Upload a sample image',
        description: [
          'Accepts one image as multipart form data under the field `file`.',
          '',
          '**Accepted formats**: JPEG, PNG, WebP, determined from the file',
          'signature rather than the declared content type.',
          '',
          '**Size limit**: `MAX_UPLOAD_BYTES`, 10 MiB by default.',
          '',
          '**Source**: pass `source=CAMERA` for a live capture or',
          '`source=UPLOAD` for a file chosen from the device. Recorded with',
          'the image, because capture conditions differ between the two and',
          'that matters when interpreting a colour.',
          '',
          '**Duplicates** are detected by SHA-256 and reported in `duplicateOf`,',
          'but not rejected: the same photograph may legitimately be uploaded',
          'against a different sample.',
          '',
          'Requires the `image:upload` capability.',
        ].join('\n'),
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiQuery({
        name: 'source',
        required: false,
        enum: ['UPLOAD', 'CAMERA'],
        description: 'How the image was obtained. Defaults to UPLOAD.',
      }),
      ApiCreatedResponse({
        description: 'Image stored. `warnings` may carry non-fatal observations.',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            sampleId: { type: 'string', format: 'uuid' },
            mimeType: { type: 'string', example: 'image/jpeg' },
            byteSize: { type: 'integer', example: 2458112 },
            width: { type: 'integer', example: 3024 },
            height: { type: 'integer', example: 4032 },
            contentHash: {
              type: 'string',
              description: 'SHA-256 of the original bytes.',
            },
            source: { type: 'string', enum: ['UPLOAD', 'CAMERA'] },
            duplicateOf: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description: 'An earlier image in this laboratory with identical bytes.',
            },
            warnings: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      }),
      BadRequestResponse('The file could not be read as an image.', undefined),
      UnauthorizedResponse(),
      ForbiddenResponse('This operation requires: image:upload'),
      NotFoundResponse('Sample'),
      PayloadTooLargeResponse(),
      UnsupportedMediaTypeResponse(),
      TooManyRequestsResponse(),
    ),

  list: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiOperation({
        summary: "List a sample's images",
        description:
          'Image metadata for one sample, newest first. Does not return the ' +
          'bytes — use the download endpoint for those.',
      }),
      ApiParam({ name: 'id', description: 'Sample id', format: 'uuid' }),
      ApiOkResponse({ description: 'Image metadata.' }),
      UnauthorizedResponse(),
      NotFoundResponse('Sample'),
    ),

  download: () =>
    applyDecorators(
      ApiBearerAuth(),
      ApiProduces('image/jpeg', 'image/png', 'image/webp', 'application/json'),
      ApiOperation({
        summary: 'Retrieve an image',
        description: [
          'Returns the original image to an authorised member of the owning',
          'laboratory. Every access is written to the audit log.',
          '',
          '**Two response shapes**, depending on the storage driver:',
          '',
          '- Object storage that can sign URLs → `302` to a short-lived signed',
          '  URL (300 seconds by default), so the API does not proxy the bytes.',
          '- Otherwise → `200` with the image streamed directly.',
          '',
          'Pass `?mode=json` to always receive a JSON body containing the URL',
          'rather than a redirect, which is easier to handle in a fetch client.',
          '',
          'No permanent public URL exists for any laboratory image.',
        ].join('\n'),
      }),
      ApiParam({ name: 'imageId', format: 'uuid' }),
      ApiQuery({
        name: 'mode',
        required: false,
        enum: ['redirect', 'json'],
        description: 'Return a redirect (default) or a JSON body with the URL.',
      }),
      ApiOkResponse({
        description: 'The image bytes, or a JSON body with a signed URL.',
      }),
      UnauthorizedResponse(),
      NotFoundResponse('Image'),
    ),
};
