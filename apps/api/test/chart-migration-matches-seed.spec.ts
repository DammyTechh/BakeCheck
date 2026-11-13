import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Migration 0008 and the seed must describe the same chart.
 *
 * There are two routes to a populated reference chart and they have to agree:
 *
 *   - a fresh database runs the seed, which creates the chart and its levels;
 *   - an existing database runs migration 0008, which rewrites the levels of
 *     a chart that is already there.
 *
 * 0008 exists because the seed only runs when somebody remembers to run it,
 * and for four weeks nobody did: production kept serving a six-level chart of
 * 0, 0.1, 0.5, 1, 5 and 10 ppm under labels whose words mean 200 and 250 ppm
 * on the laboratory's real scale.
 *
 * The migration's rows were generated from the seed, so they match today. The
 * risk is a later edit to one and not the other, which would leave two
 * environments quietly disagreeing about what a colour means. This test is
 * what should fail then.
 */
const root = resolve(__dirname, '../../..');

const SEED = resolve(
  root,
  'database/seeds/reference-chart-bromate-illustrative.json',
);
const MIGRATION = resolve(
  root,
  'database/migrations/0009_reference_chart_measured_standards.sql',
);

interface SeedLevel {
  sort_order: number;
  label: string;
  concentration_value: number;
  rgb: [number, number, number];
  lab: [number, number, number];
}

const seedLevels = (): SeedLevel[] =>
  (JSON.parse(readFileSync(SEED, 'utf8')) as { levels: SeedLevel[] }).levels;

/** Pulls the VALUES tuples out of the migration's INSERT. */
const migrationLevels = (): Array<{
  sortOrder: number;
  concentration: number;
  label: string;
  rgb: [number, number, number];
}> => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = sql.slice(sql.indexOf('VALUES'), sql.indexOf(';', sql.indexOf('VALUES')));
  const rows = [...block.matchAll(/\(\s*(\d+),\s*([\d.]+),\s*'((?:[^']|'')*)',\s*(\d+),\s*(\d+),\s*(\d+),/g)];
  return rows.map((m) => ({
    sortOrder: Number(m[1]),
    concentration: Number(m[2]),
    label: m[3]!.replace(/''/g, "'"),
    rgb: [Number(m[4]), Number(m[5]), Number(m[6])] as [number, number, number],
  }));
};

describe('the latest chart migration and the seed describe the same chart', () => {
  it('parses fifteen levels out of the migration', () => {
    // Guards the parsing above: a regex that silently matched nothing would
    // make every comparison below trivially pass.
    //
    // Fifteen, not sixteen: no standard was photographed for 450 ppm, so
    // the chart has no colour that could match it. See the 450 test below.
    expect(migrationLevels()).toHaveLength(15);
  });

  it('agrees on every concentration, in order', () => {
    expect(migrationLevels().map((l) => l.concentration)).toEqual(
      seedLevels().map((l) => l.concentration_value),
    );
  });

  it('agrees on every label, in order', () => {
    expect(migrationLevels().map((l) => l.label)).toEqual(
      seedLevels().map((l) => l.label),
    );
  });

  it('agrees on every colour', () => {
    expect(migrationLevels().map((l) => l.rgb)).toEqual(
      seedLevels().map((l) => l.rgb),
    );
  });

  it('is the laboratory scale, minus the one standard not photographed', () => {
    // Typed out independently of both files.
    expect(migrationLevels().map((l) => [l.concentration, l.label])).toEqual([
      [0, 'Negative'],
      [10, 'Trace'],
      [20, 'Scanty'],
      [30, 'Very Low'],
      [40, 'Low'],
      [50, 'Mild'],
      [100, 'Moderate'],
      [150, 'Moderately High'],
      [200, 'High'],
      [250, 'Very High'],
      [300, 'Heavy'],
      [350, 'Very Heavy'],
      [400, 'Severe'],
      [500, 'Intense'],
      [1000, 'Extremely High'],
    ]);
  });

  it('omits 450 ppm rather than inventing a colour for it', () => {
    // No standard was supplied at 450. Interpolating its neighbours would
    // produce a level that looks measured and is not -- which is the exact
    // thing this chart was rebuilt to stop doing.
    expect(migrationLevels().some((l) => l.concentration === 450)).toBe(false);
  });

  it('still carries every colour it does have, in scale order', () => {
    const values = migrationLevels().map((l) => l.concentration);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('carries no concentration with a fractional part', () => {
    for (const level of migrationLevels()) {
      expect(Number.isInteger(level.concentration)).toBe(true);
    }
  });

  it('removes any level past the sixteenth', () => {
    // An environment that somehow held more levels would keep matching
    // against the extras. The migration deletes them; this is the assertion
    // that the DELETE was not dropped in a later edit.
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/DELETE FROM reference_levels/);
    expect(sql).toMatch(/sort_order\s*>\s*14/);
  });

  it('touches only the illustrative chart', () => {
    // A validated chart built from prepared standards must never be
    // overwritten by this.
    const sql = readFileSync(MIGRATION, 'utf8');
    const statements = sql
      .split(';')
      .filter((s) => /reference_levels/.test(s) && /(INSERT|DELETE)/.test(s));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toContain("validation_status = 'ILLUSTRATIVE'");
    }
  });
});
