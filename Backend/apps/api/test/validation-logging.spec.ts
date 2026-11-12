import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { ApiError, ErrorCode } from '../src/common/errors/api-error';

/**
 * A 400 must say, in the server log, what was actually wrong.
 *
 * From production, 12 November 2026:
 *
 *   WARN [ExceptionFilter] Object(5) {
 *     correlationId: '6e14402f-…', method: 'POST', path: '/api/v1/samples',
 *     status: 400, code: 'VALIDATION_FAILED' }
 *   WARN [ExceptionFilter] Request rejected
 *
 * That says a request was wrong without saying what was wrong with it, which
 * makes a 400 unactionable for whoever is on call. The response body stays
 * sanitised in production -- it names columns and constraints, and a client
 * has no business seeing them -- but the log is ours and gets the detail.
 */
describe('what a rejected request writes to the log', () => {
  const captured: Array<{ payload: Record<string, unknown>; message: string }> = [];

  const filter = (production: boolean): AllExceptionsFilter => {
    const instance = new AllExceptionsFilter({
      isProduction: production,
    } as never);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (instance as any).logger = {
      warn: (payload: Record<string, unknown>, message: string) =>
        captured.push({ payload, message }),
      error: (payload: Record<string, unknown>, message: string) =>
        captured.push({ payload, message }),
    };
    return instance;
  };

  const host = (): { host: ArgumentsHost; body: () => unknown } => {
    let sent: unknown;
    const response = {
      status: () => response,
      json: (value: unknown) => {
        sent = value;
        return response;
      },
      setHeader: () => response,
    };
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/samples',
      headers: {},
      // Set by the correlation-id middleware in the real pipeline.
      correlationId: 'test-correlation-id',
    };
    return {
      host: {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      } as unknown as ArgumentsHost,
      body: () => sent,
    };
  };

  beforeEach(() => {
    captured.length = 0;
  });

  it('logs the field-level reason for a ValidationPipe rejection', () => {
    const { host: h } = host();
    // Exactly the shape Nest's ValidationPipe throws.
    const exception = new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: [
        'sampleCode must be longer than or equal to 3 characters',
        'laboratoryId must be a UUID',
      ],
      error: 'Bad Request',
    });

    filter(true).catch(exception, h);

    expect(captured).toHaveLength(1);
    const logged = JSON.stringify(captured[0]!.payload);
    expect(logged).toContain('sampleCode');
    expect(logged).toContain('laboratoryId must be a UUID');
  });

  it('still logs the reason in production, where the response hides it', () => {
    const { host: h, body } = host();
    filter(true).catch(
      new BadRequestException({
        statusCode: 400,
        message: ['sampleType must be one of: bread, flour'],
        error: 'Bad Request',
      }),
      h,
    );

    // The log has it...
    expect(JSON.stringify(captured[0]!.payload)).toContain('sampleType');
    // ...and the client is still told only that validation failed.
    expect(JSON.stringify(body())).toContain('Request validation failed');
  });

  it('carries the correlation id, so the log line can be found from a report', () => {
    const { host: h, body } = host();
    filter(true).catch(new BadRequestException({ message: ['nope'] }), h);

    const id = (captured[0]!.payload as { correlationId: string }).correlationId;
    expect(id).toBeTruthy();
    expect(JSON.stringify(body())).toContain(id);
  });

  it('adds no details key when there is nothing to add', () => {
    const { host: h } = host();
    filter(true).catch(
      new ApiError(ErrorCode.ALREADY_EXISTS, 'Sample code already used'),
      h,
    );

    expect(captured[0]!.payload).not.toHaveProperty('details', expect.anything());
  });
});
