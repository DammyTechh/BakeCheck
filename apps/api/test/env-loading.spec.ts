import * as dotenv from 'dotenv';
import { parseDotEnv } from '../src/database/cli/load-env';

/**
 * The CLI .env loader must agree with dotenv.
 *
 * `migrate` and `seed` run outside the Nest context and use our own parser,
 * while the API uses @nestjs/config, which uses dotenv. They read the *same
 * file*, so any disagreement between them is a configuration bug that no
 * other test can see — the API and the CLIs simply behave differently.
 *
 * Two real failures motivated this suite, both found in a user's own .env:
 *
 *   1. Inline comments were not stripped, so `JWT_ACCESS_TTL=900  # 15 min`
 *      parsed as the literal string `900  # 15 min` for the CLIs and as `900`
 *      for the API. Most values in `.env.example` carry an inline comment.
 *
 *   2. On a duplicated key our parser kept the first and dotenv kept the last.
 *      A file with two `DATABASE_URL` lines pointed `migrate` at localhost and
 *      the API at a hosted database, with no error from either.
 *
 * Each case below is asserted against dotenv's actual output rather than a
 * hardcoded expectation, so this stays true if dotenv's behaviour changes.
 */

const CASES: Array<[name: string, body: string]> = [
  ['a plain value', 'A=value'],
  ['an inline comment after whitespace', 'A=900              # seconds (15 min)'],
  ['an inline comment with no whitespace', 'A=plain#nocomment'],
  ['several hashes', 'A=val # one # two'],
  ['a double-quoted value containing a hash', 'A="quoted # hash"'],
  ['a single-quoted value containing a hash', "A='single # hash'"],
  ['an unterminated quote', 'A="unterminated'],
  ['trailing whitespace', 'A=trailing     '],
  ['an empty value', 'A='],
  ['an empty value with a comment', 'A=   # nothing here'],
  ['a value containing an equals sign', 'A=key=value=more'],
  ['a base64 value ending in padding', 'A=nXxCF3dFNSCfza34iykqrJF7zXVcLHdszddU4P3QET4='],
  ['a base64 value with a trailing comment', 'A=abc123== # must match the other key'],
  ['a URL with a port and path', 'A=postgresql://u:p@host:5432/db'],
  ['a value containing an at sign', 'A=Software@2026'],
  ['a duplicated key', 'A=first\nA=second'],
  ['a duplicated key where the second is empty', 'A=first\nA='],
  ['a commented-out line between assignments', 'A=one\n# A=two\nA=three'],
  ['indented keys', '   A=indented'],
  ['a blank line and a comment line', '\n# comment\nA=value\n'],
];

describe('CLI .env parsing matches dotenv', () => {
  it.each(CASES)('%s', (_name, body) => {
    const theirs = dotenv.parse(body);
    const ours = parseDotEnv(body).values;

    expect(ours.get('A')).toBe(theirs.A);
  });

  it('agrees with dotenv across a realistic multi-key file', () => {
    // Shaped like .env.example: inline comments on most lines.
    const body = [
      'NODE_ENV=development',
      'LOG_LEVEL=debug',
      'POSTGRES_PORT=5432',
      'DATABASE_SSL=false',
      'STORAGE_DRIVER=local            # local | supabase',
      'STORAGE_LOCAL_DIR=./.storage    # used when STORAGE_DRIVER=local',
      'JWT_ACCESS_TTL=900              # seconds (15 min)',
      'JWT_REFRESH_TTL=1209600         # seconds (14 days)',
      'COOKIE_SECURE=false             # MUST be true in production (HTTPS)',
      'COOKIE_SAMESITE=lax             # none required for cross-site',
      'SWAGGER_ENABLED=true            # set false in production',
      'MAX_UPLOAD_BYTES=10485760       # 10 MiB',
      'EMAIL_DRIVER=noop               # noop | resend',
      'AI_INTERNAL_KEY=abc123==        # must equal AI_SERVICE_INTERNAL_KEY',
    ].join('\n');

    const theirs = dotenv.parse(body);
    const ours = parseDotEnv(body).values;

    expect(Object.keys(theirs).sort()).toEqual([...ours.keys()].sort());
    for (const [key, value] of Object.entries(theirs)) {
      expect(ours.get(key)).toBe(value);
    }

    // Spot-check the ones that were actually broken.
    expect(ours.get('JWT_ACCESS_TTL')).toBe('900');
    expect(ours.get('STORAGE_DRIVER')).toBe('local');
    expect(ours.get('AI_INTERNAL_KEY')).toBe('abc123==');
  });

  it('keeps the last of a duplicated key, as dotenv does', () => {
    const body =
      'DATABASE_URL=postgresql://breadguard:pw@localhost:5432/breadguard\n' +
      'DATABASE_URL=postgresql://postgres.ref:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

    const theirs = dotenv.parse(body);
    const { values } = parseDotEnv(body);

    expect(values.get('DATABASE_URL')).toBe(theirs.DATABASE_URL);
    // The specific regression: the CLI must not pick localhost while the API
    // picks the hosted database.
    expect(new URL(values.get('DATABASE_URL')!).hostname).toBe(
      'aws-0-eu-west-1.pooler.supabase.com',
    );
  });

  it('reports a duplicated key so it cannot pass unnoticed', () => {
    const { duplicates } = parseDotEnv('DATABASE_URL=a\nFOO=1\nDATABASE_URL=b');
    expect(duplicates).toEqual(['DATABASE_URL']);
  });

  it('reports nothing for a file without duplicates', () => {
    expect(parseDotEnv('A=1\nB=2\n# A=3').duplicates).toEqual([]);
  });
});
