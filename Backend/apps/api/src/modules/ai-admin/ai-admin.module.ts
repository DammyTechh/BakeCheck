import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { AiAdminController } from './ai-admin.controller';
import { AiAdminService } from './ai-admin.service';
import { TrainingWorkerService } from './training-worker.service';

@Module({
  controllers: [AiAdminController],
  providers: [AiAdminService, TrainingWorkerService],
  exports: [AiAdminService, TrainingWorkerService],
})
export class AiAdminModule implements OnApplicationBootstrap {
  constructor(
    private readonly worker: TrainingWorkerService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    // Not started under test: a background poller would race the test
    // database and make failures non-deterministic. Tests drive `tick()`
    // directly instead.
    if (this.config.isTest) return;
    if (!this.config.training.workerEnabled) return;

    this.worker.start(this.config.training.pollIntervalMs);
  }
}
