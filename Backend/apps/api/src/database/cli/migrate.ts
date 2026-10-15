#!/usr/bin/env ts-node
/**
 * Migration runner.
 *
 * The SQL files in database/migrations are the source of truth for the schema
 * (the spec calls for Supabase-style SQL migrations, so there is no ORM
 * generating DDL behind your back). This runner:
 *
 *   • applies each unapplied file in filename order, inside a transaction
 *   • records the filename and a SHA-256 of its contents in schema_migrations
 *   • refuses to continue if an already-applied file has been edited, since
 *     that means the database and the repository have silently diverged
 *
 * It never drops anything on `up`. `reset` exists for local development only
 * and demands an explicit confirmation flag.
 *
 * Usage:
 *   npm run db:migrate            # apply pending migrations
 *   npm run db:migrate:status     # show applied / pending
 *   npm run db:reset -- --force   # DESTRUCTIVE, local only
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { loadDotEnv } from './load-env';

loadDotEnv();

const MIGRATIONS_DIR = resolve(__dirname, '../../../../../database/migrations');

interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedRow {
  filename: string;
  checksum: string;
  applied_at: Date;
}

function readMigrations(): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  return (
    entries
      .filter((name) => name.endsWith('.sql'))
      // Zero-padded numeric prefixes make lexical order the correct order.
      .sort((a, b) => a.localeCompare(b))
      .map((filename) => {
        const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
        return {
          filename,
          sql,
          checksum: createHash('sha256').update(sql).digest('hex'),
        };
      })
  );
}

function connect(): Client {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const useSsl = process.env.DATABASE_SSL === 'true';
  return new Client({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'breadguard-migrate',
  });
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    );
  `);
}

async function getApplied(client: Client): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename',
  );
  return new Map(rows.map((row) => [row.filename, row]));
}

/** Applied files must still hash to what the repository contains. */
function assertNoDrift(
  migrations: MigrationFile[],
  applied: Map<string, AppliedRow>,
): void {
  const drifted: string[] = [];
  for (const migration of migrations) {
    const record = applied.get(migration.filename);
    if (record && record.checksum !== migration.checksum) {
      drifted.push(migration.filename);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      `These migrations were modified after being applied:\n` +
        drifted.map((f) => `  • ${f}`).join('\n') +
        `\n\nEditing an applied migration makes the database and the repository ` +
        `disagree. Write a new migration instead. (Local dev: npm run db:reset -- --force)`,
    );
  }
}

async function up(): Promise<void> {
  const client = connect();
  await client.connect();
  try {
    await ensureLedger(client);
    const migrations = readMigrations();
    const applied = await getApplied(client);
    assertNoDrift(migrations, applied);

    const pending = migrations.filter((m) => !applied.has(m.filename));
    if (pending.length === 0) {
      console.log(`✓ Database is up to date (${applied.size} migrations applied).`);
      return;
    }

    console.log(`Applying ${pending.length} migration(s)…`);
    for (const migration of pending) {
      const started = Date.now();
      try {
        // Each file wraps itself in BEGIN/COMMIT; the ledger insert joins that
        // same implicit session so a failure leaves no partial record.
        await client.query(migration.sql);
        const duration = Date.now() - started;
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [migration.filename, migration.checksum, duration],
        );
        console.log(`  ✓ ${migration.filename} (${duration}ms)`);
      } catch (error) {
        console.error(`  ✗ ${migration.filename}`);
        console.error(`    ${(error as Error).message}`);
        throw error;
      }
    }
    console.log('✓ Migrations complete.');
  } finally {
    await client.end();
  }
}

async function status(): Promise<void> {
  const client = connect();
  await client.connect();
  try {
    await ensureLedger(client);
    const migrations = readMigrations();
    const applied = await getApplied(client);

    console.log('\nMigration status');
    console.log('─'.repeat(72));
    for (const migration of migrations) {
      const record = applied.get(migration.filename);
      if (!record) {
        console.log(`  PENDING  ${migration.filename}`);
      } else if (record.checksum !== migration.checksum) {
        console.log(`  DRIFTED  ${migration.filename}  (file changed after apply)`);
      } else {
        const when = record.applied_at.toISOString().replace('T', ' ').slice(0, 19);
        console.log(`  applied  ${migration.filename}  ${when} UTC`);
      }
    }
    console.log('─'.repeat(72));
    const pendingCount = migrations.filter((m) => !applied.has(m.filename)).length;
    console.log(`${migrations.length} total, ${pendingCount} pending\n`);
  } finally {
    await client.end();
  }
}

/**
 * Drops and recreates the public schema. Local development only — it destroys
 * every row. Guarded by an explicit flag and by a production check.
 */
async function reset(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset is refused when NODE_ENV=production');
  }
  if (!process.argv.includes('--force')) {
    throw new Error(
      'db:reset destroys all data. Re-run with --force if that is what you want:\n' +
        '  npm run db:reset -- --force',
    );
  }

  const client = connect();
  await client.connect();
  try {
    console.log('Dropping and recreating schema "public"…');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    console.log('✓ Schema reset. Run `npm run db:migrate` next.');
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  switch (command) {
    case 'up':
      await up();
      break;
    case 'status':
      await status();
      break;
    case 'reset':
      await reset();
      break;
    default:
      console.error(`Unknown command "${command}". Use: up | status | reset`);
      process.exit(1);
  }
}

main().catch((error: Error) => {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
});
