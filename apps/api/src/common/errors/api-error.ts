import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable error codes.
 *
 * Clients branch on these rather than on message text, so messages can be
 * reworded without breaking anything. Codes are grouped by concern.
 */
export enum ErrorCode {
  // 400
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_IMAGE = 'INVALID_IMAGE',
  IMAGE_TOO_LARGE = 'IMAGE_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  MALFORMED_REQUEST = 'MALFORMED_REQUEST',

  // 401
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  TOKEN_REUSED = 'TOKEN_REUSED',
  AUTHENTICATION_REQUIRED = 'AUTHENTICATION_REQUIRED',

  // 403
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  LABORATORY_ACCESS_DENIED = 'LABORATORY_ACCESS_DENIED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',

  // 404
  NOT_FOUND = 'NOT_FOUND',

  // 409
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  CONFLICTING_STATE = 'CONFLICTING_STATE',

  // 422
  INSUFFICIENT_DATA = 'INSUFFICIENT_DATA',
  IMAGE_QUALITY_INSUFFICIENT = 'IMAGE_QUALITY_INSUFFICIENT',
  REFERENCE_DATA_INCOMPLETE = 'REFERENCE_DATA_INCOMPLETE',

  // 429
  RATE_LIMITED = 'RATE_LIMITED',

  // 500 / 502 / 503
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  AI_SERVICE_UNAVAILABLE = 'AI_SERVICE_UNAVAILABLE',
  AI_SERVICE_TIMEOUT = 'AI_SERVICE_TIMEOUT',
  AI_SERVICE_ERROR = 'AI_SERVICE_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level problems, for form display. */
    details?: unknown;
    correlationId?: string;
    timestamp: string;
    path?: string;
  };
}

/**
 * Every error the API raises deliberately is an ApiError, which guarantees a
 * consistent response shape. Anything else that escapes is caught by the
 * global filter and reported as INTERNAL_ERROR with its details suppressed.
 */
export class ApiError extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(code: ErrorCode, message: string, details?: unknown): ApiError {
    return new ApiError(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(code: ErrorCode, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(code: ErrorCode, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(resource: string): ApiError {
    // Deliberately uniform: a caller must not be able to tell "does not exist"
    // from "exists in another laboratory". That distinction would leak the
    // existence of other laboratories' records.
    return new ApiError(
      ErrorCode.NOT_FOUND,
      `${resource} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  static conflict(code: ErrorCode, message: string, details?: unknown): ApiError {
    return new ApiError(code, message, HttpStatus.CONFLICT, details);
  }

  static unprocessable(code: ErrorCode, message: string, details?: unknown): ApiError {
    return new ApiError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  static internal(message = 'An unexpected error occurred'): ApiError {
    return new ApiError(
      ErrorCode.INTERNAL_ERROR,
      message,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  static badGateway(code: ErrorCode, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.BAD_GATEWAY);
  }

  static serviceUnavailable(code: ErrorCode, message: string): ApiError {
    return new ApiError(code, message, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
