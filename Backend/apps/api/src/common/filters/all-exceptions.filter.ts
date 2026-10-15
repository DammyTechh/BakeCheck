import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { ApiError, ApiErrorBody, ErrorCode } from '../errors/api-error';

/** Postgres error codes we translate into meaningful HTTP responses. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_NOT_NULL_VIOLATION = '23502';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/**
 * Terminal error handler.
 *
 * Two jobs: emit one consistent body shape, and make sure nothing sensitive
 * escapes. Stack traces, SQL text and driver details are logged server-side
 * and never serialised to the client in production.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request as Request & { correlationId?: string }).correlationId;

    const { status, code, message, details, logAsError } = this.normalise(exception);

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        ...(correlationId ? { correlationId } : {}),
        timestamp: new Date().toISOString(),
        path: request.originalUrl,
      },
    };

    // The correlation ID is echoed so a user can quote it in a bug report and
    // an operator can find the matching server-side log line.
    const logContext = {
      correlationId,
      method: request.method,
      path: request.originalUrl,
      status,
      code,
    };

    if (logAsError) {
      this.logger.error(
        { ...logContext, err: this.describe(exception) },
        'Request failed',
      );
    } else {
      this.logger.warn(logContext, 'Request rejected');
    }

    response.status(status).json(body);
  }

  /** Maps any thrown value onto our response contract. */
  private normalise(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    logAsError: boolean;
  } {
    if (exception instanceof ApiError) {
      const payload = exception.getResponse() as {
        code: ErrorCode;
        message: string;
        details?: unknown;
      };
      const status = exception.getStatus();
      return {
        status,
        code: payload.code,
        message: payload.message,
        details: payload.details,
        logAsError: status >= 500,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      // Nest's ValidationPipe puts an array of messages here.
      const details =
        typeof payload === 'object' && payload !== null && 'message' in payload
          ? (payload as { message: unknown }).message
          : undefined;

      return {
        status,
        code: this.codeForStatus(status),
        message:
          status === HttpStatus.BAD_REQUEST
            ? 'Request validation failed'
            : exception.message,
        details: Array.isArray(details) ? details : undefined,
        logAsError: status >= 500,
      };
    }

    const pg = exception as PostgresError;
    if (pg?.code && typeof pg.code === 'string') {
      const mapped = this.mapPostgresError(pg);
      if (mapped) return mapped;
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      // Never surface the underlying message: it may contain SQL, file paths
      // or connection strings.
      message: 'An unexpected error occurred',
      logAsError: true,
    };
  }

  private mapPostgresError(error: PostgresError): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: unknown;
    logAsError: boolean;
  } | null {
    switch (error.code) {
      case PG_UNIQUE_VIOLATION:
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.ALREADY_EXISTS,
          message: 'A record with these values already exists',
          // The constraint name is a schema detail but a useful one for
          // clients, and it reveals nothing about other users' data.
          details: this.config.isProduction
            ? undefined
            : { constraint: error.constraint },
          logAsError: false,
        };
      case PG_FOREIGN_KEY_VIOLATION:
        return {
          status: HttpStatus.BAD_REQUEST,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'A referenced record does not exist',
          details: this.config.isProduction
            ? undefined
            : { constraint: error.constraint },
          logAsError: false,
        };
      case PG_CHECK_VIOLATION:
      case PG_NOT_NULL_VIOLATION:
        return {
          status: HttpStatus.BAD_REQUEST,
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The request violates a data integrity rule',
          details: this.config.isProduction
            ? undefined
            : { constraint: error.constraint },
          logAsError: false,
        };
      case PG_INSUFFICIENT_PRIVILEGE:
        // An RLS policy refused the row. Report it as a not-found so the
        // caller cannot probe for records in other laboratories.
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.NOT_FOUND,
          message: 'Resource not found',
          logAsError: false,
        };
      default:
        return null;
    }
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.AUTHENTICATION_REQUIRED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.INSUFFICIENT_PERMISSIONS;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.ALREADY_EXISTS;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.IMAGE_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ErrorCode.UNSUPPORTED_MEDIA_TYPE;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.VALIDATION_FAILED;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST;
    }
  }

  /** Server-side log detail. Stack is included outside production only. */
  private describe(exception: unknown): Record<string, unknown> {
    if (exception instanceof Error) {
      return {
        name: exception.name,
        message: exception.message,
        ...(this.config.isProduction ? {} : { stack: exception.stack }),
      };
    }
    return { value: String(exception) };
  }
}
