import * as argon2 from 'argon2';
import {
  ARGON2_OPTIONS,
  MIN_PASSWORD_LENGTH,
} from '../src/common/security/password.constants';
import { loadConfiguration } from '../src/config/configuration';
import {
  Permission,
  permissionsForRole,
  roleHasPermission,
  UserRole,
} from '../src/common/types/roles';

/**
 * Unit tests for the security primitives.
 *
 * These deliberately avoid a database or an HTTP server: they test the rules
 * themselves, so a failure points at the rule rather than at infrastructure.
 * The full request-level behaviour is covered by
 * infrastructure/scripts/e2e-smoke.sh, which runs against live services.
 */

describe('Password hashing', () => {
  it('uses Argon2id with OWASP-recommended parameters', () => {
    expect(ARGON2_OPTIONS.type).toBe(argon2.argon2id);
    // 19 MiB is the memory cost that makes GPU cracking expensive. Lowering
    // it to save RAM defeats the point of choosing Argon2 at all.
    expect(ARGON2_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19456);
    expect(ARGON2_OPTIONS.timeCost).toBeGreaterThanOrEqual(2);
  });

  it('produces a verifiable hash', async () => {
    const hash = await argon2.hash('correct-horse-battery-staple', ARGON2_OPTIONS);
    await expect(argon2.verify(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
    await expect(argon2.verify(hash, 'wrong-password-entirely')).resolves.toBe(false);
  });

  it('salts each hash, so identical passwords differ', async () => {
    const [first, second] = await Promise.all([
      argon2.hash('the-same-password-twice', ARGON2_OPTIONS),
      argon2.hash('the-same-password-twice', ARGON2_OPTIONS),
    ]);
    expect(first).not.toBe(second);
  });

  it('encodes its parameters in the hash, so costs can be raised later', async () => {
    const hash = await argon2.hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

    // A hash made with weaker parameters must be flagged for rehashing on
    // next successful login, not silently accepted forever.
    //
    // The weakness here is memory cost (8 MiB vs 19 MiB), which is the
    // parameter that actually governs GPU cracking resistance. timeCost is
    // not lowered because argon2 refuses any value below 2.
    const weak = await argon2.hash('a-sufficiently-long-password', {
      type: argon2.argon2id,
      memoryCost: 8192,
      timeCost: 2,
      parallelism: 1,
    });
    expect(argon2.needsRehash(weak, ARGON2_OPTIONS)).toBe(true);
    expect(argon2.needsRehash(hash, ARGON2_OPTIONS)).toBe(false);
  });

  it('requires at least 12 characters', () => {
    // Length over composition: a long passphrase beats a short string with a
    // symbol bolted on.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

describe('Role capabilities', () => {
  it('gives SUPER_ADMIN every capability', () => {
    for (const permission of Object.values(Permission)) {
      expect(roleHasPermission(UserRole.SUPER_ADMIN, permission)).toBe(true);
    }
  });

  it('lets a technician run analyses but not approve models', () => {
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.ANALYSIS_RUN)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.SAMPLE_CREATE)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.IMAGE_UPLOAD)).toBe(
      true,
    );

    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.MODEL_APPROVE)).toBe(
      false,
    );
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.MODEL_TRAIN)).toBe(
      false,
    );
  });

  it('does not let a technician confirm a measurement', () => {
    // Recording an instrument result and declaring it confirmed are different
    // authorities. Collapsing them would let one person's number become the
    // laboratory's confirmed answer unchecked.
    expect(
      roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.MEASUREMENT_CREATE),
    ).toBe(true);
    expect(
      roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.MEASUREMENT_CONFIRM),
    ).toBe(false);
  });

  it('does not let a technician approve a dataset example', () => {
    // Otherwise a technician's own opinion could become training ground truth.
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.FEEDBACK_CREATE)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.FEEDBACK_REVIEW)).toBe(
      false,
    );
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.DATASET_APPROVE)).toBe(
      false,
    );
  });

  it('does not let a technician validate reference data', () => {
    // Marking a chart VALIDATED changes what every future result may report.
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.REFERENCE_READ)).toBe(
      true,
    );
    expect(
      roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.REFERENCE_VALIDATE),
    ).toBe(false);
  });

  it('lets a reviewer confirm measurements and approve datasets', () => {
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.MEASUREMENT_CONFIRM)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.FEEDBACK_REVIEW)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.DATASET_APPROVE)).toBe(
      true,
    );
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.REFERENCE_VALIDATE)).toBe(
      true,
    );
  });

  it('does not let a reviewer train or approve models', () => {
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.MODEL_READ)).toBe(true);
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.MODEL_APPROVE)).toBe(
      false,
    );
    expect(roleHasPermission(UserRole.LAB_REVIEWER, Permission.MODEL_TRAIN)).toBe(false);
  });

  it('lets a lab admin manage models and members', () => {
    expect(roleHasPermission(UserRole.LAB_ADMIN, Permission.MODEL_APPROVE)).toBe(true);
    expect(roleHasPermission(UserRole.LAB_ADMIN, Permission.MODEL_TRAIN)).toBe(true);
    expect(roleHasPermission(UserRole.LAB_ADMIN, Permission.MEMBER_MANAGE)).toBe(true);
  });

  it('returns a copy, so a caller cannot mutate the table', () => {
    const permissions = permissionsForRole(UserRole.LAB_TECHNICIAN);
    permissions.push(Permission.MODEL_APPROVE);
    expect(roleHasPermission(UserRole.LAB_TECHNICIAN, Permission.MODEL_APPROVE)).toBe(
      false,
    );
  });
});

describe('Configuration validation', () => {
  const baseEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    AI_SERVICE_URL: 'http://localhost:8000',
    AI_SERVICE_INTERNAL_KEY: 'c'.repeat(32),
  };

  it('accepts a valid development environment', () => {
    expect(() => loadConfiguration(baseEnv as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      loadConfiguration({
        ...baseEnv,
        JWT_ACCESS_SECRET: 'too-short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects a missing database URL', () => {
    const { DATABASE_URL: _removed, ...withoutDb } = baseEnv;
    expect(() => loadConfiguration(withoutDb as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it('parses the CORS allowlist into a trimmed array', () => {
    const config = loadConfiguration({
      ...baseEnv,
      CORS_ORIGINS: 'https://a.test, https://b.test ,',
    } as NodeJS.ProcessEnv);
    expect(config.http.corsOrigins).toEqual(['https://a.test', 'https://b.test']);
  });

  describe('production safety checks', () => {
    const prodEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://app.example.test',
      DATABASE_SSL: 'true',
      DATABASE_URL: 'postgresql://user:pass@db.example.test:5432/db',
    };

    it('accepts a correctly configured production environment', () => {
      expect(() => loadConfiguration(prodEnv as NodeJS.ProcessEnv)).not.toThrow();
    });

    it('refuses a placeholder secret', () => {
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          JWT_ACCESS_SECRET: 'replace-with-openssl-rand-base64-48',
        } as NodeJS.ProcessEnv),
      ).toThrow(/placeholder/);
    });

    it('refuses identical access and refresh secrets', () => {
      // Otherwise a refresh token could be replayed as an access token.
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          JWT_REFRESH_SECRET: prodEnv.JWT_ACCESS_SECRET,
        } as NodeJS.ProcessEnv),
      ).toThrow(/must differ/);
    });

    it('refuses insecure cookies', () => {
      expect(() =>
        loadConfiguration({ ...prodEnv, COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv),
      ).toThrow(/COOKIE_SECURE must be true/);
    });

    it('refuses a wildcard CORS origin', () => {
      expect(() =>
        loadConfiguration({ ...prodEnv, CORS_ORIGINS: '*' } as NodeJS.ProcessEnv),
      ).toThrow(/wildcard/);
    });

    it('refuses a plain-HTTP CORS origin', () => {
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          CORS_ORIGINS: 'http://app.example.test',
        } as NodeJS.ProcessEnv),
      ).toThrow(/HTTPS/);
    });

    it('refuses Supabase storage without its credentials', () => {
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          STORAGE_DRIVER: 'supabase',
        } as NodeJS.ProcessEnv),
      ).toThrow(/SUPABASE_URL/);
    });

    it('refuses the Resend driver without an API key', () => {
      expect(() =>
        loadConfiguration({ ...prodEnv, EMAIL_DRIVER: 'resend' } as NodeJS.ProcessEnv),
      ).toThrow(/RESEND_API_KEY/);
    });

    it('requires SSL for a remote database', () => {
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          DATABASE_SSL: 'false',
        } as NodeJS.ProcessEnv),
      ).toThrow(/DATABASE_SSL should be true/);
    });

    it.each([
      ['localhost', 'postgresql://user:pass@localhost:5432/db'],
      ['127.0.0.1', 'postgresql://user:pass@127.0.0.1:5432/db'],
      ['IPv6 loopback', 'postgresql://user:pass@[::1]:5432/db'],
    ])('treats %s as local and does not demand SSL', (_label, url) => {
      // Matching only the literal string "localhost" flagged 127.0.0.1 as
      // remote, which pushes an operator into enabling TLS against a server
      // that is not listening for it.
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          DATABASE_SSL: 'false',
          DATABASE_URL: url,
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });

    it('does not treat a hostname merely containing "localhost" as local', () => {
      // `includes('localhost')` would have passed this. It is a real remote
      // host that happens to share a substring.
      expect(() =>
        loadConfiguration({
          ...prodEnv,
          DATABASE_SSL: 'false',
          DATABASE_URL: 'postgresql://user:pass@localhost.attacker.test:5432/db',
        } as NodeJS.ProcessEnv),
      ).toThrow(/DATABASE_SSL should be true/);
    });

    it('does not apply production checks in development', () => {
      // Local setup must not be made painful by production-only rules.
      expect(() =>
        loadConfiguration({
          ...baseEnv,
          NODE_ENV: 'development',
          COOKIE_SECURE: 'false',
          CORS_ORIGINS: 'http://localhost:5173',
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });
  });
});
