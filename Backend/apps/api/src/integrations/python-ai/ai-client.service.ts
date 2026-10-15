import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import {
  AnalyzeImageRequest,
  AnalyzeImageResponse,
  AiServiceStatus,
} from './ai-client.types';
import {
  AiApproveModelRequest,
  AiApproveModelResponse,
  AiTrainingRequest,
  AiTrainingResponse,
} from './training-client.types';

/**
 * Client for the internal Python computer-vision service.
 *
 * The service is not publicly routable; this is the only thing that talks to
 * it. Every request carries:
 *
 *   • `x-internal-key` — a shared secret proving the caller is this API.
 *   • `x-correlation-id` — so one user request can be traced across both
 *     services and the audit log.
 *
 * Failure handling is deliberately conservative. Image analysis is not
 * idempotent in cost (it is CPU-heavy), so retries are bounded and only
 * attempted for errors that are plausibly transient: connection failures and
 * 5xx responses. A timeout is NOT retried — the service is probably still
 * working on the first request, and piling on makes an overloaded service
 * worse.
 *
 * A semaphore caps in-flight requests so a burst of uploads cannot exhaust
 * the Python service's worker pool.
 */
@Injectable()
export class AiClientService {
  private readonly logger = new Logger(AiClientService.name);

  /** Simple counting semaphore. */
  private inFlight = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.config.aiService.maxConcurrency) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    this.inFlight += 1;
  }

  private releaseSlot(): void {
    this.inFlight -= 1;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private headers(correlationId: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-internal-key': this.config.aiService.internalKey,
      'x-correlation-id': correlationId,
    };
  }

  /**
   * Runs the vision pipeline on one image.
   *
   * Throws ApiError on transport failure. A *successful* call that rejects the
   * image on quality grounds is not an error — it returns a response with
   * status `rejected_quality`, which the caller persists like any other result.
   */
  async analyzeImage(request: AnalyzeImageRequest): Promise<AnalyzeImageResponse> {
    await this.acquireSlot();
    const started = Date.now();

    try {
      const response = await this.requestWithRetry<AnalyzeImageResponse>(
        '/internal/v1/analyze',
        request,
        request.correlationId,
      );

      this.logger.log(
        {
          correlationId: request.correlationId,
          status: response.status,
          mode: response.mode,
          durationMs: Date.now() - started,
          qualityVerdict: response.imageQuality?.verdict,
        },
        'AI analysis completed',
      );

      return response;
    } finally {
      this.releaseSlot();
    }
  }

  /** Liveness and active-model report, for GET /api/v1/ai/status. */
  async getStatus(correlationId: string): Promise<AiServiceStatus> {
    const controller = new AbortController();
    // Status is a health probe; it gets a tight timeout of its own so a slow
    // AI service cannot stall the dashboard.
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`${this.config.aiService.url}/internal/v1/status`, {
        method: 'GET',
        headers: this.headers(correlationId),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw ApiError.serviceUnavailable(
          ErrorCode.AI_SERVICE_UNAVAILABLE,
          `The analysis service responded ${response.status}`,
        );
      }

      return (await response.json()) as AiServiceStatus;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.serviceUnavailable(
        ErrorCode.AI_SERVICE_UNAVAILABLE,
        'The analysis service is unreachable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Runs a training job.
   *
   * Given its own, much longer timeout: training on a few hundred examples
   * takes tens of seconds, where an analysis takes under a second. Reusing
   * the analysis timeout would abort every real training run.
   *
   * No retries. Training is expensive, not idempotent in cost, and a second
   * attempt against a service already working on the first would make an
   * overloaded instance worse. A failure is reported, and the operator
   * decides whether to re-queue.
   */
  async runTraining(
    request: AiTrainingRequest,
    timeoutMs = 600_000,
  ): Promise<AiTrainingResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const response = await fetch(`${this.config.aiService.url}/internal/v1/train`, {
        method: 'POST',
        headers: this.headers(request.correlationId),
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (response.status === 409) {
        throw ApiError.conflict(
          ErrorCode.CONFLICTING_STATE,
          'A training job is already running. Wait for it to finish before ' +
            'starting another.',
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        this.logger.error(
          {
            correlationId: request.correlationId,
            status: response.status,
            detail: detail.slice(0, 500),
          },
          'Training request rejected by the AI service',
        );
        throw ApiError.badGateway(
          ErrorCode.AI_SERVICE_ERROR,
          `The analysis service responded ${response.status} to a training request`,
        );
      }

      const result = (await response.json()) as AiTrainingResponse;

      this.logger.log(
        {
          correlationId: request.correlationId,
          status: result.status,
          durationMs: Date.now() - started,
          macroF1: result.evaluation?.macroF1,
          recommendation: result.evaluation?.releaseRecommendation,
        },
        'Training job completed',
      );

      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;

      const aborted = (error as Error).name === 'AbortError';
      if (aborted) {
        this.logger.error(
          { correlationId: request.correlationId, timeoutMs },
          'Training exceeded its time budget',
        );
        throw ApiError.serviceUnavailable(
          ErrorCode.AI_SERVICE_TIMEOUT,
          `Training exceeded ${Math.round(timeoutMs / 1000)}s. The job may still ` +
            'be running on the analysis service.',
        );
      }

      throw ApiError.serviceUnavailable(
        ErrorCode.AI_SERVICE_UNAVAILABLE,
        'The analysis service is unreachable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Marks a trained artifact approved and loads it as the active model.
   *
   * Called only after a human with the `model:approve` capability has made
   * the decision and the API has re-checked the release criteria. This is
   * the mechanical half: flip the flag, verify the checksum, load.
   */
  async approveModel(request: AiApproveModelRequest): Promise<AiApproveModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(
        `${this.config.aiService.url}/internal/v1/models/approve`,
        {
          method: 'POST',
          headers: this.headers(request.correlationId),
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );

      if (response.status === 404) {
        throw ApiError.notFound('Model artifact');
      }

      if (response.status === 409) {
        // The artifact changed since it was written: corrupt, or swapped.
        const detail = await response.text().catch(() => '');
        throw ApiError.conflict(
          ErrorCode.CONFLICTING_STATE,
          'The model artifact failed its integrity check and was not loaded. ' +
            detail.slice(0, 200),
        );
      }

      if (!response.ok) {
        throw ApiError.badGateway(
          ErrorCode.AI_SERVICE_ERROR,
          `The analysis service responded ${response.status} to an approval request`,
        );
      }

      return (await response.json()) as AiApproveModelResponse;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.serviceUnavailable(
        ErrorCode.AI_SERVICE_UNAVAILABLE,
        'The analysis service is unreachable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Reverts the AI service to the transparent reference matcher.
   *
   * Never throws: this is the rollback path, and it must work even when
   * something else is broken. A failure is logged and reported as `false`
   * so the caller can tell the operator the database was updated but the
   * service was not.
   */
  async resetToBaseline(correlationId: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(
        `${this.config.aiService.url}/internal/v1/models/reset`,
        {
          method: 'POST',
          headers: this.headers(correlationId),
          signal: controller.signal,
        },
      );
      return response.ok;
    } catch (error) {
      this.logger.error(
        { correlationId, err: (error as Error).message },
        'Could not reset the AI service to its baseline model',
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** True when the service answers its health endpoint. Never throws. */
  async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.config.aiService.url}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestWithRetry<T>(
    path: string,
    body: unknown,
    correlationId: string,
  ): Promise<T> {
    const url = `${this.config.aiService.url}${path}`;
    const maxAttempts = this.config.aiService.maxRetries + 1;
    let lastError: ApiError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.aiService.timeoutMs,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.headers(correlationId),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          return (await response.json()) as T;
        }

        // 4xx means we sent something the service will reject every time.
        // Retrying is pointless and hides the real problem.
        if (response.status >= 400 && response.status < 500) {
          const detail = await response.text().catch(() => '');
          this.logger.error(
            {
              correlationId,
              status: response.status,
              detail: detail.slice(0, 500),
            },
            'AI service rejected the request',
          );

          if (response.status === 401 || response.status === 403) {
            // Misconfiguration, not a user error. Do not leak which.
            throw ApiError.internal(
              'The analysis service rejected this request. Check that ' +
                'AI_SERVICE_INTERNAL_KEY matches on both services.',
            );
          }
          if (response.status === 422) {
            throw ApiError.unprocessable(
              ErrorCode.IMAGE_QUALITY_INSUFFICIENT,
              'The analysis service could not process this image or reference data',
            );
          }
          throw ApiError.badGateway(
            ErrorCode.AI_SERVICE_ERROR,
            'The analysis service rejected the request',
          );
        }

        // 5xx — plausibly transient, worth one more go.
        lastError = ApiError.badGateway(
          ErrorCode.AI_SERVICE_ERROR,
          `The analysis service responded ${response.status}`,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;

        const aborted = (error as Error).name === 'AbortError';
        if (aborted) {
          // Not retried: the service is likely still processing attempt 1.
          this.logger.error(
            { correlationId, timeoutMs: this.config.aiService.timeoutMs },
            'AI service request timed out',
          );
          throw ApiError.serviceUnavailable(
            ErrorCode.AI_SERVICE_TIMEOUT,
            'The analysis took too long. Try a smaller image, or retry shortly.',
          );
        }

        lastError = ApiError.serviceUnavailable(
          ErrorCode.AI_SERVICE_UNAVAILABLE,
          'The analysis service is unreachable',
        );
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < maxAttempts) {
        // Exponential backoff with jitter, so simultaneous failures do not
        // retry in lockstep.
        const backoff = 250 * 2 ** (attempt - 1) + Math.random() * 200;
        this.logger.warn(
          { correlationId, attempt, maxAttempts, backoffMs: Math.round(backoff) },
          'Retrying AI service request',
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw (
      lastError ??
      ApiError.serviceUnavailable(
        ErrorCode.AI_SERVICE_UNAVAILABLE,
        'The analysis service is unavailable',
      )
    );
  }
}
