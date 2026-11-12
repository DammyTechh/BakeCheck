import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { AuthenticatedRequest } from '../types/request-context';

const HEADER = 'x-correlation-id';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Assigns each request a correlation id and echoes it on the response.
 *
 * The id follows the request into the AI service and into every audit_logs
 * row, so one user-visible failure can be traced across both services and the
 * database.
 *
 * An inbound header is honoured only if it is a well-formed UUID — otherwise
 * a caller could inject arbitrary text into log lines.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers[HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    const correlationId =
      candidate && UUID_PATTERN.test(candidate) ? candidate : randomUUID();

    (req as AuthenticatedRequest).correlationId = correlationId;
    res.setHeader(HEADER, correlationId);
    next();
  }
}
