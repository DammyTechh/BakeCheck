#!/usr/bin/env ts-node
/**
 * Deterministic development seed.
 *
 * Creates two laboratories (two, so that cross-laboratory isolation is
 * actually exercisable), three demonstration accounts with distinct roles, one
 * test method, the illustrative bromate reference chart, and a baseline
 * reference-matching "model" entry.
 *
 * Everything here is fictional demonstration data. Passwords come from
 * SEED_*_PASSWORD environment variables, or are generated randomly and printed
 * once — they are never hard-coded in this file and never written to the repo.
 *
 * Re-running is safe: every insert is an idempotent upsert keyed on a natural
 * key, so the script converges rather than duplicating.
 *
 * Usage: npm run db:seed
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as argon2 from 'argon2';
import { Client } from 'pg';
import { loadDotEnv } from './load-env';
import { ARGON2_OPTIONS } from '../../common/security/password.constants';

loadDotEnv();

const SEEDS_DIR = resolve(__dirname, '../../../../../database/seeds');

interface ReferenceLevelSeed {
  sort_order: number;
  label: string;
  /**
   * Null for the illustrative chart. The figures it used to carry were read
   * off an illustration and sat two orders of magnitude below the range the
   * laboratory's own reporting scale covers, so they were removed rather
   * than merely flagged. A patch carries colour and ordering until the chart
   * is rebuilt from prepared standards.
   */
  concentration_value: number | null;
  concentration_unit: string;
  /** What this patch used to be called, kept for the audit trail. */
  previous_label?: string;
  rgb: [number, number, number];
  lab: [number, number, number];
  lab_std: number;
  /**
   * The region of the source image this colour was read from, when it was
   * read from one. Null for an interpolated level: the schema rejects a
   * zero-sized region, correctly, because "no region" and "a region of no
   * size" are different claims.
   */
  roi: { x: number; y: number; width: number; height: number } | null;
}

interface ReferenceChartSeed {
  source_image: string;
  illuminant: string;
  provenance_note: string;
  levels: ReferenceLevelSeed[];
}

interface DemoAccount {
  key: string;
  email: string;
  fullName: string;
  jobTitle: string;
  role: 'SUPER_ADMIN' | 'LAB_ADMIN' | 'LAB_TECHNICIAN' | 'LAB_REVIEWER';
  labCode: string;
  envVar: string;
}

/** Fictional identities. Any resemblance to real people is unintended. */
const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    key: 'admin',
    email: 'admin@breadguard.test',
    fullName: 'Amara Okafor',
    jobTitle: 'Laboratory Director',
    role: 'LAB_ADMIN',
    labCode: 'DEMO-LAB-01',
    envVar: 'SEED_ADMIN_PASSWORD',
  },
  {
    key: 'technician',
    email: 'technician@breadguard.test',
    fullName: 'Tunde Balogun',
    jobTitle: 'Analytical Technician',
    role: 'LAB_TECHNICIAN',
    labCode: 'DEMO-LAB-01',
    envVar: 'SEED_TECHNICIAN_PASSWORD',
  },
  {
    key: 'reviewer',
    email: 'reviewer@breadguard.test',
    fullName: 'Ngozi Eze',
    jobTitle: 'Quality Reviewer',
    role: 'LAB_REVIEWER',
    labCode: 'DEMO-LAB-02',
    envVar: 'SEED_REVIEWER_PASSWORD',
  },
];

const LABORATORIES = [
  {
    code: 'DEMO-LAB-01',
    name: 'Demonstration Food Safety Laboratory',
    contact_email: 'contact@demolab01.test',
    city: 'Lagos',
    country: 'NG',
  },
  {
    code: 'DEMO-LAB-02',
    name: 'Second Demonstration Laboratory',
    contact_email: 'contact@demolab02.test',
    city: 'Abuja',
    country: 'NG',
  },
];

function connect(): Client {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'breadguard-seed',
  });
}

/** URL-safe random password, used when no SEED_*_PASSWORD is provided. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demonstration accounts with NODE_ENV=production.');
  }

  const chartSeed: ReferenceChartSeed = JSON.parse(
    readFileSync(resolve(SEEDS_DIR, 'reference-chart-bromate-illustrative.json'), 'utf8'),
  );

  const client = connect();
  await client.connect();

  // Issued passwords, printed once at the end.
  const issued: Array<{
    email: string;
    password: string;
    role: string;
    generated: boolean;
  }> = [];

  try {
    await client.query('BEGIN');

    // ── Laboratories ────────────────────────────────────────────────────────
    const labIds = new Map<string, string>();
    for (const lab of LABORATORIES) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO laboratories (code, name, contact_email, city, country, status)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name,
               contact_email = EXCLUDED.contact_email
         RETURNING id`,
        [lab.code, lab.name, lab.contact_email, lab.city, lab.country],
      );
      labIds.set(lab.code, rows[0].id);
    }
    console.log(`✓ ${LABORATORIES.length} laboratories`);

    // ── Users + memberships ─────────────────────────────────────────────────
    const userIds = new Map<string, string>();
    for (const account of DEMO_ACCOUNTS) {
      const fromEnv = process.env[account.envVar];
      const password = fromEnv && fromEnv.length > 0 ? fromEnv : generatePassword();
      const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name, job_title, role, status)
         VALUES ($1, $2, $3, $4, $5::user_role, 'ACTIVE')
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               full_name     = EXCLUDED.full_name,
               job_title     = EXCLUDED.job_title,
               role          = EXCLUDED.role,
               status        = 'ACTIVE',
               -- Rotating the password invalidates any outstanding tokens.
               token_version = users.token_version + 1
         RETURNING id`,
        [account.email, passwordHash, account.fullName, account.jobTitle, account.role],
      );
      const userId = rows[0].id;
      userIds.set(account.key, userId);

      await client.query(
        `INSERT INTO laboratory_memberships (laboratory_id, user_id, role, status, accepted_at)
         VALUES ($1, $2, $3::user_role, 'ACTIVE', now())
         ON CONFLICT (laboratory_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, status = 'ACTIVE'`,
        [labIds.get(account.labCode), userId, account.role],
      );

      issued.push({
        email: account.email,
        password,
        role: account.role,
        generated: !fromEnv,
      });
    }
    console.log(`✓ ${DEMO_ACCOUNTS.length} demonstration accounts`);

    const adminId = userIds.get('admin')!;
    const lab01 = labIds.get('DEMO-LAB-01')!;

    // ── Test method ─────────────────────────────────────────────────────────
    // DRAFT, not VALIDATED: this platform supplies no chemistry. The reagent,
    // preparation protocol and thresholds must come from the laboratory's own
    // validated SOP before any result here means anything.
    const { rows: methodRows } = await client.query<{ id: string }>(
      `INSERT INTO test_methods (
         laboratory_id, code, name, target_analyte, description,
         procedure_reference, applicable_matrix, reagent_notes,
         method_version, concentration_unit, validation_status,
         validation_notes, is_active, created_by
       )
       VALUES (
         NULL, $1, $2, $3, $4, $5, $6, $7, $8, 'ppm', 'DRAFT', $9, true, $10
       )
       ON CONFLICT (code, method_version) WHERE laboratory_id IS NULL
       DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         validation_notes = EXCLUDED.validation_notes
       RETURNING id`,
      [
        'BROMATE-COLOUR-SCREEN',
        'Colorimetric bromate screening (prototype)',
        'potassium bromate (reported as BrO3-)',
        'Placeholder method definition for the prototype workflow. The ' +
          'laboratory must replace the procedure reference, reagent notes and ' +
          'matrix with its own validated method before results are used for ' +
          'any decision.',
        'NOT SET — supply your laboratory SOP reference',
        'bread or flour extract (to be specified by the laboratory)',
        'NOT SET — supply the reagent system and reaction timing used',
        '0.1.0-prototype',
        'No analytical validation has been performed for this method in this ' +
          'system. No limit of detection, limit of quantitation, calibration ' +
          'curve or measurement uncertainty has been established. Results are ' +
          'screening estimates only.',
        adminId,
      ],
    );
    const methodId = methodRows[0].id;
    console.log('✓ test method (DRAFT — no analytical validation)');

    // ── Reference chart ─────────────────────────────────────────────────────
    const { rows: chartRows } = await client.query<{ id: string }>(
      `INSERT INTO reference_charts (
         test_method_id, laboratory_id, name, description, source,
         illuminant, capture_device, version, validation_status,
         is_active, metadata, created_by
       )
       VALUES ($1, NULL, $2, $3, $4, $5, $6, 1, 'ILLUSTRATIVE', true, $7, $8)
       ON CONFLICT (test_method_id, name, version) DO UPDATE
         SET description = EXCLUDED.description,
             metadata    = EXCLUDED.metadata
       RETURNING id`,
      [
        methodId,
        'Illustrative bromate colour ladder',
        chartSeed.provenance_note,
        `AI-generated illustration (${chartSeed.source_image})`,
        chartSeed.illuminant,
        'unknown — synthetic image, no capture device',
        JSON.stringify({
          source_image: chartSeed.source_image,
          extraction_tool: 'infrastructure/scripts/extract_reference_colors.py',
          not_a_calibration: true,
        }),
        adminId,
      ],
    );
    const chartId = chartRows[0].id;

    // ── Reference levels ────────────────────────────────────────────────────
    for (const level of chartSeed.levels) {
      await client.query(
        `INSERT INTO reference_levels (
           reference_chart_id, label, concentration_value, concentration_unit,
           sort_order, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b, lab_std,
           roi_x, roi_y, roi_width, roi_height,
           color_source, validation_status, notes
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 'MANUAL_ENTRY','ILLUSTRATIVE',$17)
         ON CONFLICT (reference_chart_id, sort_order) DO UPDATE
           SET label = EXCLUDED.label,
               concentration_value = EXCLUDED.concentration_value,
               rgb_r = EXCLUDED.rgb_r, rgb_g = EXCLUDED.rgb_g, rgb_b = EXCLUDED.rgb_b,
               lab_l = EXCLUDED.lab_l, lab_a = EXCLUDED.lab_a, lab_b = EXCLUDED.lab_b,
               lab_std = EXCLUDED.lab_std`,
        [
          chartId,
          level.label,
          level.concentration_value,
          level.concentration_unit,
          level.sort_order,
          level.rgb[0],
          level.rgb[1],
          level.rgb[2],
          level.lab[0],
          level.lab[1],
          level.lab[2],
          level.lab_std,
          level.roi?.x ?? null,
          level.roi?.y ?? null,
          level.roi?.width ?? null,
          level.roi?.height ?? null,
          'Colour read from an illustration, not measured from a prepared standard.',
        ],
      );
    }
    console.log(
      `✓ reference chart with ${chartSeed.levels.length} levels (ILLUSTRATIVE)`,
    );

    // ── Baseline model entry ────────────────────────────────────────────────
    // The reference matcher is not a trained model. It is registered so that
    // every analysis can cite a model_version row, and it is explicitly marked
    // unvalidated with no dataset behind it.
    await client.query(
      `INSERT INTO model_versions (
         test_method_id, name, version, model_type, status, is_active,
         approved_by, approved_at, released_at, limitations, notes, created_by
       )
       VALUES ($1, $2, $3, 'REFERENCE_MATCHER', 'RELEASED', true,
               $4, now(), now(), $5, $6, $4)
       ON CONFLICT (name, version) DO UPDATE
         SET limitations = EXCLUDED.limitations,
             notes       = EXCLUDED.notes`,
      [
        methodId,
        'baseline-color-analysis',
        '0.1.0',
        adminId,
        JSON.stringify([
          'Not a trained model. Computes a CIEDE2000 distance between the ' +
            'measured region colour and each reference level.',
          'The reference levels come from an illustration and are not a ' +
            'calibrated colorimetric standard.',
          'Produces no concentration estimate and no confidence value.',
          'Not validated against any chemically confirmed measurement.',
        ]),
        'Transparent baseline used while no approved trained model exists.',
      ],
    );
    console.log('✓ baseline reference-matching model entry');

    // ── Demonstration samples ───────────────────────────────────────────────
    // Clearly marked as seed fixtures so the dashboard has something real to
    // read without inventing analytics.
    const demoSamples = [
      { code: 'DEMO-S-0001', type: 'bread', product: 'White sandwich loaf' },
      { code: 'DEMO-S-0002', type: 'flour', product: 'Bread flour, 50kg sack' },
      { code: 'DEMO-S-0003', type: 'bread', product: 'Wholemeal loaf' },
    ];
    for (const sample of demoSamples) {
      await client.query(
        `INSERT INTO samples (
           laboratory_id, sample_code, sample_type, product_name,
           technician_id, test_method_id, status, notes, created_by, metadata
         )
         VALUES ($1,$2,$3,$4,$5,$6,'REGISTERED',$7,$5,$8)
         ON CONFLICT (laboratory_id, sample_code) DO NOTHING`,
        [
          lab01,
          sample.code,
          sample.type,
          sample.product,
          userIds.get('technician'),
          methodId,
          'Seeded demonstration fixture — not a real sample.',
          JSON.stringify({ seed_fixture: true }),
        ],
      );
    }
    console.log(`✓ ${demoSamples.length} demonstration samples (fixtures)`);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }

  // ── Credential report ─────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(74));
  console.log('DEMONSTRATION ACCOUNTS — local development only');
  console.log('─'.repeat(74));
  for (const account of issued) {
    console.log(`  ${account.role.padEnd(16)} ${account.email}`);
    console.log(
      `  ${''.padEnd(16)} password: ${account.password}` +
        (account.generated ? '  (generated — shown once)' : '  (from environment)'),
    );
  }
  console.log('─'.repeat(74));
  console.log(
    'Generated passwords are not stored anywhere in readable form. Set\n' +
      'SEED_ADMIN_PASSWORD / SEED_TECHNICIAN_PASSWORD / SEED_REVIEWER_PASSWORD\n' +
      'in your .env to choose them yourself and make this repeatable.\n',
  );
  console.log(
    'Note: the seeded test method is DRAFT and the reference chart is\n' +
      'ILLUSTRATIVE. The API will label every result from them as an\n' +
      'unvalidated screening estimate.\n',
  );
}

main().catch((error: Error) => {
  console.error(`\n✗ Seed failed: ${error.message}\n`);
  process.exit(1);
});
