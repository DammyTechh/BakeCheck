import { AppConfig, CONFIG_TOKEN } from '../src/config/configuration';
import { DatabaseService } from '../src/database/database.service';
import { AiClientService } from '../src/integrations/python-ai/ai-client.service';
import {
  AiTrainingRequest,
  AiTrainingResponse,
} from '../src/integrations/python-ai/training-client.types';
import { AuditService } from '../src/modules/audit/audit.service';
import { TrainingWorkerService } from '../src/modules/ai-admin/training-worker.service';

/**
 * The training worker's governance invariants.
 *
 * `services/ai/tests/test_learning_loop.py` proves the AI service never
 * activates what it trained. This proves the same thing one layer up, where
 * the database rows are written — and where a careless `is_active = true`
 * would make the whole review chain decorative.
 *
 * The database is faked rather than real. That is deliberate: these tests are
 * about the *statements the worker issues*, and a fake lets each one be
 * asserted directly. The statements themselves are exercised against real
 * Postgres by `infrastructure/scripts/e2e-smoke.sh`, and the schema enforces
 * the same rules independently through
 * `model_versions_active_requires_approval_chk`.
 */

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

class FakeDb {
  readonly queries: RecordedQuery[] = [];
  /** Statements issued inside `transaction()`, in order. */
  readonly transactional: RecordedQuery[] = [];
  transactionCount = 0;
  /** Set true to make the transaction body throw partway through. */
  failOnInsertInto: string | null = null;

  jobs: Array<Record<string, unknown>> = [];
  examples: Array<Record<string, unknown>> = [];
  referenceLevels: Array<Record<string, unknown>> = [];

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.queries.push({ sql, params });
    return this.route<T>(sql);
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async transaction<T>(
    fn: (client: {
      query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const staged: RecordedQuery[] = [];

    const client = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        staged.push({ sql, params });
        if (this.failOnInsertInto && sql.includes(this.failOnInsertInto)) {
          throw new Error(`simulated failure inserting into ${this.failOnInsertInto}`);
        }
        return { rows: await this.route<R>(sql) };
      },
    };

    try {
      const result = await fn(client);
      // Only a committed transaction contributes rows. A rollback leaves
      // nothing behind, which is what the failure tests assert.
      this.transactional.push(...staged);
      return result;
    } catch (error) {
      throw error;
    }
  }

  private async route<T>(sql: string): Promise<T[]> {
    if (sql.includes('UPDATE training_jobs') && sql.includes("'RUNNING'")) {
      const next = this.jobs.shift();
      return (next ? [next] : []) as T[];
    }
    if (sql.includes('FROM dataset_examples')) return this.examples as T[];
    if (sql.includes('FROM reference_levels')) return this.referenceLevels as T[];
    if (sql.includes('INSERT INTO dataset_versions')) {
      return [{ id: 'dataset-version-1' }] as T[];
    }
    if (sql.includes('INSERT INTO model_versions')) {
      return [{ id: 'model-version-1' }] as T[];
    }
    return [] as T[];
  }

  /** Every statement issued, transactional or not. */
  all(): RecordedQuery[] {
    return [...this.queries, ...this.transactional];
  }

  find(fragment: string): RecordedQuery | undefined {
    return this.all().find((q) => q.sql.includes(fragment));
  }
}

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    test_method_id: 'method-1',
    laboratory_id: 'lab-1',
    requested_params: {},
    requested_by: 'user-1',
    correlation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ...overrides,
  };
}

function approvedExample(index: number) {
  return {
    id: `example-${index}`,
    sample_id: `sample-${index}`,
    sample_image_id: `image-${index}`,
    label_level_id: 'level-2',
    label_text: 'Chart patch 3 — light blue',
    label_concentration: '0.5',
    label_unit: 'ppm',
    label_source: 'LABORATORY_MEASUREMENT',
    sample_type: 'bread',
    color_features: { lab_median: [70, -10, -30] },
    quality_verdict: 'USABLE',
    group_key: `sample-${index}`,
    perceptual_hash: `hash${index}`,
    capture_device: 'phone-a',
  };
}

function succeededResponse(
  overrides: Partial<AiTrainingResponse> = {},
): AiTrainingResponse {
  return {
    status: 'succeeded',
    refusalReason: null,
    dataset: {
      version: '2026.10.12-1',
      exampleIds: ['example-0', 'example-1'],
      splitAssignment: { 'example-0': 'train', 'example-1': 'test' },
      exampleCount: 2,
      trainCount: 1,
      validationCount: 0,
      testCount: 1,
      classDistribution: { 'Chart patch 3 — light blue': 2 },
      labelSourceDistribution: { LABORATORY_MEASUREMENT: 2 },
      qualityReport: { duplicates: 0 },
      contentChecksum: 'c'.repeat(64),
    },
    model: {
      name: 'colour-classifier',
      version: '2026.10.12-1',
      modelType: 'logistic_regression',
      approved: false,
      validated: false,
      artifactChecksum: 'a'.repeat(64),
      artifactSizeBytes: 4096,
      featureOrder: ['lab_median.0'],
      classes: ['Chart patch 3 — light blue', 'Chart patch 5 — deep blue'],
      calibrated: false,
      calibrationSkippedReason: 'too few examples',
      trainingExamples: 2,
      hyperparameters: { C: 1.0 },
      limitations: ['Trained on synthetic fixtures.'],
    },
    evaluation: {
      split: 'test',
      sampleSize: 1,
      accuracy: 0.9,
      macroF1: 0.88,
      weightedF1: 0.89,
      balancedAccuracy: 0.87,
      confusionMatrix: {},
      perClassMetrics: {},
      subgroupMetrics: {},
      baselineComparison: { reference_matcher_macro_f1: 0.8 },
      expectedCalibrationError: 0.05,
      brierScore: 0.1,
      evaluationLimitations: ['Thin test split.'],
      releaseRecommendation: 'INSUFFICIENT_DATA',
      releaseBlockers: ['fewer than 5 test examples per class'],
    },
    issues: [],
    durationMs: 1234,
    correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ...overrides,
  };
}

function build(
  db: FakeDb,
  runTraining: (request: AiTrainingRequest) => Promise<AiTrainingResponse>,
) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const aiClient = { runTraining: jest.fn((req: AiTrainingRequest) => runTraining(req)) };
  const config = {
    training: { workerEnabled: true, pollIntervalMs: 15_000, timeoutMs: 600_000 },
  } as AppConfig;

  const worker = new TrainingWorkerService(
    db as unknown as DatabaseService,
    aiClient as unknown as AiClientService,
    audit as unknown as AuditService,
    config,
  );

  return { worker, audit, aiClient, config, CONFIG_TOKEN };
}

describe('TrainingWorkerService', () => {
  describe('claiming work', () => {
    it('claims a job with FOR UPDATE SKIP LOCKED so two instances cannot take the same one', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      const claim = db.find('UPDATE training_jobs');
      expect(claim).toBeDefined();
      expect(claim!.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(claim!.sql).toContain("status = 'QUEUED'");
      // Oldest first, so a queue cannot starve its own head.
      expect(claim!.sql).toContain('ORDER BY created_at');
    });

    it('does nothing when no job is queued', async () => {
      const db = new FakeDb();
      const { worker, aiClient } = build(db, async () => succeededResponse());

      await expect(worker.tick()).resolves.toBe(false);
      expect(aiClient.runTraining).not.toHaveBeenCalled();
    });

    it('runs one job at a time, so overlapping polls cannot double-train', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob({ id: 'job-1' }), queuedJob({ id: 'job-2' })];
      db.examples = [approvedExample(0)];

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const { worker, aiClient } = build(db, async () => {
        await gate;
        return succeededResponse();
      });

      const first = worker.tick();
      // Second poll arrives while the first is still inside the AI call.
      const second = await worker.tick();
      expect(second).toBe(false);

      release();
      await first;
      expect(aiClient.runTraining).toHaveBeenCalledTimes(1);
    });
  });

  describe('which examples are eligible', () => {
    it('loads only examples that were approved, authorised and not excluded', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      const select = db.find('FROM dataset_examples');
      expect(select).toBeDefined();
      // The entire governance story is this WHERE clause. An uploaded image
      // nobody reviewed must be invisible to training.
      expect(select!.sql).toContain("de.review_status = 'APPROVED'");
      expect(select!.sql).toContain('de.usage_authorized');
      expect(select!.sql).toContain('NOT de.excluded');
      expect(select!.params).toEqual(['method-1']);
    });

    it('fails the job rather than training on nothing when no example qualifies', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [];
      const { worker, aiClient, audit } = build(db, async () => succeededResponse());

      await worker.tick();

      expect(aiClient.runTraining).not.toHaveBeenCalled();

      const failure = db.all().find((q) => q.sql.includes("status = 'FAILED'"));
      expect(failure).toBeDefined();
      expect(failure!.params).toContain('NO_APPROVED_EXAMPLES');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'model.training_failed' }),
      );
    });

    it('scores the baseline from the active chart only', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      const select = db.find('FROM reference_levels');
      expect(select).toBeDefined();
      expect(select!.sql).toContain('rc.is_active');
      expect(select!.sql).toContain('rl.lab_l IS NOT NULL');
    });
  });

  describe('what a successful run writes', () => {
    it('never activates the model it just trained', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0), approvedExample(1)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      const insert = db.find('INSERT INTO model_versions');
      expect(insert).toBeDefined();
      // The two claims that make a model usable, both denied here.
      expect(insert!.sql).toContain("'TRAINED'");
      expect(insert!.sql).toContain('false');
      expect(insert!.sql).not.toContain('is_active,is_active');
      expect(insert!.sql).not.toMatch(/is_active\s*=\s*true/);
      expect(insert!.sql).not.toContain("'RELEASED'");
      // Approval is a separate, human act; the worker supplies no approver.
      expect(insert!.sql).not.toContain('approved_by');
    });

    it('writes the dataset, the model and the evaluation in one transaction', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      expect(db.transactionCount).toBe(1);
      const transactional = db.transactional.map((q) => q.sql);
      expect(transactional.some((s) => s.includes('INSERT INTO dataset_versions'))).toBe(
        true,
      );
      expect(transactional.some((s) => s.includes('INSERT INTO model_versions'))).toBe(
        true,
      );
      expect(transactional.some((s) => s.includes('INSERT INTO model_evaluations'))).toBe(
        true,
      );
    });

    it('leaves no model row behind when the evaluation cannot be written', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      db.failOnInsertInto = 'INSERT INTO model_evaluations';
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      // A model without its evaluation would be unapprovable but still
      // present, and would read as a candidate nobody had assessed.
      expect(db.find('INSERT INTO model_versions')).toBeUndefined();
      const failure = db.all().find((q) => q.sql.includes("status = 'FAILED'"));
      expect(failure).toBeDefined();
      expect(failure!.params).toContain('WORKER_ERROR');
    });

    it('records the release blockers rather than only the headline metric', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker, audit } = build(db, async () => succeededResponse());

      await worker.tick();

      const evaluation = db.find('INSERT INTO model_evaluations');
      const limitations = evaluation!.params.find(
        (p) => typeof p === 'string' && p.includes('Release blocker'),
      );
      expect(limitations).toBeDefined();

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'model.training_completed',
          metadata: expect.objectContaining({
            activated: false,
            recommendation: 'INSUFFICIENT_DATA',
            blockers: ['fewer than 5 test examples per class'],
          }),
        }),
      );
    });

    it('persists a model the evaluator recommends rejecting, still inactive', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const response = succeededResponse();
      response.evaluation!.releaseRecommendation = 'REJECT';
      response.evaluation!.releaseBlockers = ['worse than the reference matcher'];
      const { worker } = build(db, async () => response);

      await worker.tick();

      // Recorded, not discarded: a rejected candidate is evidence about the
      // dataset, and hiding it would let the same attempt repeat unnoticed.
      const insert = db.find('INSERT INTO model_versions');
      expect(insert).toBeDefined();
      expect(insert!.sql).toContain("'TRAINED'");
      expect(insert!.params).toEqual(
        expect.arrayContaining([expect.stringContaining('Recommendation: REJECT')]),
      );
    });

    it('marks the job succeeded and awaiting approval', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () => succeededResponse());

      await worker.tick();

      const completion = db
        .all()
        .find(
          (q) =>
            q.sql.includes('UPDATE training_jobs') &&
            q.sql.includes("status = 'SUCCEEDED'") &&
            q.sql.includes('model_version_id'),
        );
      expect(completion).toBeDefined();
      const progress = completion!.params.find(
        (p) => typeof p === 'string' && p.includes('awaiting_approval'),
      ) as string;
      expect(JSON.parse(progress).awaiting_approval).toBe(true);
    });
  });

  describe('a dataset that cannot support training', () => {
    it('completes the job rather than failing it, and produces no model', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker, audit } = build(db, async () =>
        succeededResponse({
          status: 'refused',
          refusalReason:
            'Only 1 example is backed by a laboratory measurement; at least 30 are needed.',
          dataset: null,
          model: null,
          evaluation: null,
          issues: [
            {
              code: 'insufficient_examples',
              severity: 'critical',
              message: 'Too few examples to train on.',
              affectedCount: 1,
            },
          ],
        }),
      );

      await worker.tick();

      // "Not enough data yet" is the expected state of this system for a
      // long time. Recording it as a failure would make the queue look broken.
      const update = db
        .all()
        .find(
          (q) =>
            q.sql.includes('UPDATE training_jobs') &&
            q.sql.includes("status = 'SUCCEEDED'"),
        );
      expect(update).toBeDefined();
      expect(update!.params).toContain(
        'Only 1 example is backed by a laboratory measurement; at least 30 are needed.',
      );

      expect(db.find('INSERT INTO model_versions')).toBeUndefined();
      expect(db.find('INSERT INTO dataset_versions')).toBeUndefined();

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'model.training_refused',
          metadata: expect.objectContaining({
            criticalIssues: ['insufficient_examples'],
          }),
        }),
      );
    });
  });

  describe('failure handling', () => {
    it('records a failed AI response without inventing a model', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker } = build(db, async () =>
        succeededResponse({
          status: 'failed',
          refusalReason: 'the trainer raised',
          dataset: null,
          model: null,
          evaluation: null,
        }),
      );

      await worker.tick();

      expect(db.find('INSERT INTO model_versions')).toBeUndefined();
      const failure = db.all().find((q) => q.sql.includes("status = 'FAILED'"));
      expect(failure!.params).toContain('TRAINING_FAILED');
      expect(failure!.params).toContain('the trainer raised');
    });

    it('records a thrown AI client error as a failure and does not retry', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker, aiClient } = build(db, async () => {
        throw new Error('AI service unreachable');
      });

      await worker.tick();

      // Retrying automatically would hide a real data problem behind
      // repeated expensive runs.
      expect(aiClient.runTraining).toHaveBeenCalledTimes(1);
      const failure = db.all().find((q) => q.sql.includes("status = 'FAILED'"));
      expect(failure!.params).toContain('WORKER_ERROR');
      expect(failure!.params).toContain('AI service unreachable');
    });

    it('survives a database error during claiming without throwing', async () => {
      const db = new FakeDb();
      jest.spyOn(db, 'query').mockRejectedValueOnce(new Error('connection lost'));
      const { worker } = build(db, async () => succeededResponse());

      await expect(worker.tick()).resolves.toBe(false);
    });

    it('becomes pollable again after a failed cycle', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob({ id: 'job-1' }), queuedJob({ id: 'job-2' })];
      db.examples = [approvedExample(0)];

      let attempt = 0;
      const { worker } = build(db, async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient');
        return succeededResponse();
      });

      await worker.tick();
      await worker.tick();

      expect(attempt).toBe(2);
      expect(db.find('INSERT INTO model_versions')).toBeDefined();
    });
  });

  describe('request assembly', () => {
    it('passes the configured timeout rather than the analysis default', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      const { worker, aiClient } = build(db, async () => succeededResponse());

      await worker.tick();

      expect(aiClient.runTraining).toHaveBeenCalledWith(expect.anything(), 600_000);
    });

    it('asks for no model version, so the service assigns one', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      let captured: AiTrainingRequest | null = null;
      const { worker } = build(db, async (request) => {
        captured = request;
        return succeededResponse();
      });

      await worker.tick();

      expect(captured!.modelVersion).toBeNull();
      expect(captured!.testMethodId).toBe('method-1');
      expect(captured!.correlationId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    });

    it('honours the requested model type and split parameters', async () => {
      const db = new FakeDb();
      db.jobs = [
        queuedJob({
          requested_params: {
            modelType: 'SKLEARN_REGRESSOR',
            testSplit: 0.25,
            validationSplit: 0.15,
            splitSeed: 99,
            modelName: 'bromate-colour',
          },
        }),
      ];
      db.examples = [approvedExample(0)];
      let captured: AiTrainingRequest | null = null;
      const { worker } = build(db, async (request) => {
        captured = request;
        return succeededResponse();
      });

      await worker.tick();

      expect(captured!.modelType).toBe('random_forest');
      expect(captured!.testFraction).toBe(0.25);
      expect(captured!.validationFraction).toBe(0.15);
      expect(captured!.splitSeed).toBe(99);
      expect(captured!.modelName).toBe('bromate-colour');
    });

    it('sends cached colour features rather than image references', async () => {
      const db = new FakeDb();
      db.jobs = [queuedJob()];
      db.examples = [approvedExample(0)];
      let captured: AiTrainingRequest | null = null;
      const { worker } = build(db, async (request) => {
        captured = request;
        return succeededResponse();
      });

      await worker.tick();

      const example = captured!.examples[0];
      // Training reads cached statistics, so a dataset stays reproducible
      // even after an image is archived or deleted.
      expect(example.colorFeatures).toEqual({ lab_median: [70, -10, -30] });
      expect(example.labelConcentration).toBe(0.5);
      expect(example.labelSource).toBe('LABORATORY_MEASUREMENT');
      expect(example.groupKey).toBe('sample-0');
      expect(example).not.toHaveProperty('imageBase64');
      expect(example).not.toHaveProperty('storageKey');
    });
  });

  describe('lifecycle', () => {
    it('does not start twice', async () => {
      const db = new FakeDb();
      const { worker } = build(db, async () => succeededResponse());
      const spy = jest.spyOn(global, 'setInterval');

      worker.start(60_000);
      worker.start(60_000);
      expect(spy).toHaveBeenCalledTimes(1);

      worker.onModuleDestroy();
      spy.mockRestore();
    });

    it('does not start again after shutdown', () => {
      const db = new FakeDb();
      const { worker } = build(db, async () => succeededResponse());

      worker.onModuleDestroy();
      const spy = jest.spyOn(global, 'setInterval');
      worker.start(60_000);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
