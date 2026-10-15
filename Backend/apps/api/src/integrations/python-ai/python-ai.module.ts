import { Global, Module } from '@nestjs/common';
import { AiClientService } from './ai-client.service';

/**
 * The only route from the public API to the internal Python service.
 *
 * Global so the analyses and AI-admin modules share one instance — and
 * therefore one concurrency semaphore. Two instances would each permit
 * AI_SERVICE_MAX_CONCURRENCY in-flight requests, doubling the intended cap.
 */
@Global()
@Module({
  providers: [AiClientService],
  exports: [AiClientService],
})
export class PythonAiModule {}
