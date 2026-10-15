import { Controller, Get, Inject, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { Public } from '../../common/decorators';
import { DatabaseService } from '../../database/database.service';
import { AiClientService } from '../../integrations/python-ai/ai-client.service';
import { HealthDocs } from '../../swagger/docs/health.docs';
import { EmailService } from '../email/email.service';

/**
 * OpenAPI documentation: src/swagger/docs/health.docs.ts
 *
 * `version: VERSION_NEUTRAL` keeps these at `/health` and `/health/ready`.
 * Excluding them from the global prefix is not enough on its own — URI
 * versioning would still place them behind `/v1`, and an orchestrator's probe
 * should not have to track the API version.
 */
@ApiTags('Health')
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly aiClient: AiClientService,
    private readonly emailService: EmailService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('health')
  @HealthDocs.liveness()
  liveness(): Record<string, unknown> {
    // Deliberately touches nothing: a liveness probe that depends on the
    // database would take the process out of rotation during a brief database
    // blip, when the process itself is perfectly healthy.
    return {
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('health/ready')
  @HealthDocs.readiness()
  async readiness(@Res() response: Response): Promise<void> {
    const [database, aiService] = await Promise.all([
      this.db.healthCheck(),
      this.aiClient.isHealthy(),
    ]);

    const email = this.emailService.getStatus();

    // The database is the only hard dependency. Without the vision service the
    // API still serves samples, reference data and history, so a vision
    // outage degrades rather than fails — failing readiness would pull the
    // whole application out of rotation for a partial outage.
    const ready = database;

    response.status(ready ? 200 : 503).json({
      status: database && aiService ? 'ok' : 'degraded',
      checks: { database, aiService, email },
      timestamp: new Date().toISOString(),
    });
  }
}
