import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ErrorCode } from '../../common/errors/api-error';

/**
 * Reusable error responses.
 *
 * Every endpoint returns the same error envelope, so documenting it once here
 * keeps the per-route docs focused on what is specific to that route.
 */

interface ErrorExample {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

function errorSchema(example: ErrorExample) {
  return {
    type: 'object' as const,
    properties: {
      error: {
        type: 'object' as const,
        properties: {
          code: {
            type: 'string' as const,
            enum: Object.values(ErrorCode),
            description:
              'Stable machine-readable code. Branch on this, not on `message`.',
          },
          message: { type: 'string' as const },
          details: {
            description: 'Field-level validation problems, when applicable.',
            nullable: true,
          },
          correlationId: {
            type: 'string' as const,
            format: 'uuid',
            description:
              'Echoes the x-correlation-id header. Quote this when reporting a problem.',
          },
          timestamp: { type: 'string' as const, format: 'date-time' },
          path: { type: 'string' as const },
        },
        required: ['code', 'message', 'timestamp'],
      },
    },
    example: {
      error: {
        code: example.code,
        message: example.message,
        ...(example.details !== undefined ? { details: example.details } : {}),
        correlationId: '6f1d2c3a-9b8e-4a7f-8c1d-2e3f4a5b6c7d',
        timestamp: '2026-10-11T12:34:56.789Z',
      },
    },
  };
}

export const BadRequestResponse = (
  message = 'Request validation failed',
  details: unknown = ['email must be a valid email address'],
) =>
  ApiResponse({
    status: 400,
    description: 'The request body or parameters failed validation.',
    schema: errorSchema({
      code: ErrorCode.VALIDATION_FAILED,
      message,
      details,
    }),
  });

export const UnauthorizedResponse = (
  message = 'An access token is required',
  code: ErrorCode = ErrorCode.AUTHENTICATION_REQUIRED,
) =>
  ApiResponse({
    status: 401,
    description:
      'Missing, expired, revoked or malformed credentials. Obtain a new ' +
      'access token via POST /auth/refresh.',
    schema: errorSchema({ code, message }),
  });

export const ForbiddenResponse = (message = 'Your role does not permit this operation') =>
  ApiResponse({
    status: 403,
    description:
      'Authenticated, but the role lacks the required capability. ' +
      "Note that attempting to reach another laboratory's data returns 404, " +
      'not 403, so that record existence is not disclosed.',
    schema: errorSchema({ code: ErrorCode.INSUFFICIENT_PERMISSIONS, message }),
  });

export const NotFoundResponse = (resource = 'Resource') =>
  ApiResponse({
    status: 404,
    description:
      `The ${resource.toLowerCase()} does not exist, or belongs to a laboratory ` +
      'the caller is not a member of. These two cases are deliberately ' +
      'indistinguishable.',
    schema: errorSchema({
      code: ErrorCode.NOT_FOUND,
      message: `${resource} not found`,
    }),
  });

export const ConflictResponse = (
  message = 'A record with these values already exists',
  code: ErrorCode = ErrorCode.ALREADY_EXISTS,
) =>
  ApiResponse({
    status: 409,
    description: 'The request conflicts with the current state of a resource.',
    schema: errorSchema({ code, message }),
  });

export const UnprocessableResponse = (
  message: string,
  code: ErrorCode = ErrorCode.INSUFFICIENT_DATA,
) =>
  ApiResponse({
    status: 422,
    description:
      'The request was well-formed but cannot be fulfilled given the ' +
      'current data — for example, an image too poor to analyse, or a ' +
      'reference chart with no usable colour values.',
    schema: errorSchema({ code, message }),
  });

export const PayloadTooLargeResponse = () =>
  ApiResponse({
    status: 413,
    description: 'The uploaded file exceeds MAX_UPLOAD_BYTES (10 MiB by default).',
    schema: errorSchema({
      code: ErrorCode.IMAGE_TOO_LARGE,
      message: 'Image exceeds the maximum allowed size of 10 MiB',
    }),
  });

export const UnsupportedMediaTypeResponse = () =>
  ApiResponse({
    status: 415,
    description:
      'The file is not a supported image. Only JPEG, PNG and WebP are ' +
      'accepted; the type is determined by inspecting the file signature, ' +
      'not by trusting the declared Content-Type or the filename.',
    schema: errorSchema({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      message: 'Unsupported image format. Accepted: JPEG, PNG, WebP',
    }),
  });

export const TooManyRequestsResponse = () =>
  ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded. Authentication and analysis endpoints carry ' +
      'tighter limits than the rest of the API.',
    schema: errorSchema({
      code: ErrorCode.RATE_LIMITED,
      message: 'Too many requests. Please retry shortly.',
    }),
  });

export const AiServiceUnavailableResponse = () =>
  ApiResponse({
    status: 503,
    description:
      'The internal computer-vision service could not be reached or did not ' +
      'respond in time. The analysis record is persisted with status FAILED ' +
      'and can be retried.',
    schema: errorSchema({
      code: ErrorCode.AI_SERVICE_UNAVAILABLE,
      message: 'The analysis service is temporarily unavailable',
    }),
  });

/** The error set that applies to essentially every authenticated route. */
export const StandardAuthErrors = () =>
  applyDecorators(UnauthorizedResponse(), ForbiddenResponse(), TooManyRequestsResponse());
