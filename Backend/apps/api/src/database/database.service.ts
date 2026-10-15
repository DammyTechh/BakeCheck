import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppConfig, CONFIG_TOKEN } from '../config/configuration';

/** Identity propagated to Postgres so RLS policies can evaluate. */
export interface RlsContext {
  userId: string;
  role: string;
}

/**
 * Thin, typed wrapper over a `pg` connection pool.
 *
 * Every method parameterises its SQL — no string interpolation of user input
 * anywhere in this codebase. `withRlsContext` sets the GUCs that the policies
 * in migration 0006 read, inside a transaction, using `SET LOCAL` so the
 * setting is discarded when the transaction ends and cannot leak to the next
 * borrower of the pooled connection.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool!: Pool;

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.pool = new Pool({
      connectionString: this.config.database.url,
      max: this.config.database.poolMax,
      // Supabase's pooler and Render's managed Postgres both terminate TLS
      // with certificates that are not in Node's default trust store.
      ssl: this.config.database.ssl ? { rejectUnauthorized: false } : undefined,
      // A runaway query must not hold a pooled connection open forever.
      statement_timeout: this.config.database.statementTimeoutMs,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'breadguard-api',
    });

    // An idle-client error (server restart, network blip) would otherwise be
    // an unhandled 'error' event and crash the process.
    this.pool.on('error', (error) => {
      this.logger.error({ err: error.message }, 'Idle Postgres client emitted an error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  /** Raw pool access, for health checks and the migration runner. */
  getPool(): Pool {
    return this.pool;
  }

  /**
   * Runs a parameterised query outside any RLS context.
   *
   * Used for authentication (which must read `users` before an identity
   * exists) and for internal bookkeeping. Laboratory scoping for these calls
   * is enforced in the query text and the service-layer guards.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const started = Date.now();
    try {
      const result = await this.pool.query<T>(text, params as unknown[]);
      return result.rows;
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed > 1000) {
        // Log the statement shape, never the parameters: they may hold
        // password hashes, tokens, or personal data.
        this.logger.warn({ durationMs: elapsed, sql: text.slice(0, 120) }, 'Slow query');
      }
    }
  }

  /** Convenience: exactly one row, or null. */
  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * Runs `fn` inside a transaction, rolling back on any thrown error.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        this.logger.error({ err: (rollbackError as Error).message }, 'Rollback failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` inside a transaction with the RLS GUCs set for `context`.
   *
   * `set_config(..., true)` is the function form of `SET LOCAL`: the value is
   * scoped to this transaction, so a pooled connection can never carry one
   * user's identity into another user's request. The values are passed as bind
   * parameters, so an identity string can never be injected into the SET.
   */
  async withRlsContext<T>(
    context: RlsContext,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_user_id',
        context.userId,
      ]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_user_role',
        context.role,
      ]);
      return fn(client);
    });
  }

  /** True when the database answers a trivial query. Used by /health. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
