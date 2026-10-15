import { applyDecorators } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * OpenAPI documentation for health and readiness probes.
 *
 * `/health` is unauthenticated on purpose — load balancers and container
 * orchestrators need it, and it discloses nothing beyond liveness. The
 * detailed readiness view is authenticated, because it names dependencies.
 */
export const HealthDocs = {
  liveness: () =>
    applyDecorators(
      ApiTags('Health'),
      ApiOperation({
        summary: 'Liveness probe',
        description:
          'Returns 200 whenever the process is running. Does not touch the ' +
          'database or the vision service, so it stays fast and cannot fail ' +
          'because a dependency is slow.',
      }),
      ApiOkResponse({
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            version: { type: 'string', example: '0.1.0' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      }),
    ),

  readiness: () =>
    applyDecorators(
      ApiTags('Health'),
      ApiOperation({
        summary: 'Readiness probe',
        description: [
          'Reports whether each dependency is reachable: the database, the',
          'vision service and the email provider.',
          '',
          'Returns 200 when the database is reachable, even if the vision',
          'service is not — the API can still serve samples, reference data',
          'and history without it, and failing readiness would take the whole',
          'application out of rotation for a partial outage.',
          '',
          'Returns 503 only when the database is unreachable.',
        ].join('\n'),
      }),
      ApiOkResponse({
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'] },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'boolean' },
                aiService: { type: 'boolean' },
                email: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    provider: { type: 'string', example: 'noop' },
                    reason: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      }),
    ),
};
