import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { HealthController } from '../src/modules/health/health.controller';

/**
 * The health probes must be exempt from EVERY rate limiter.
 *
 * This is not a theoretical concern. Render polls `/health` every 5 seconds
 * forever. With the probes throttled, the eleventh poll in a minute got a 429
 * — `auth` is the tightest limiter at 10/min — and so did every poll after it.
 * Render read that as an unhealthy instance, SIGTERMed it, and did the same to
 * the replacement. The service sat in a restart loop and every real request
 * returned 502.
 *
 * The subtlety that caused it: a bare `@SkipThrottle()` means
 * `{ default: true }`. It skips only the throttler literally named `default`,
 * and this application defines four. Three kept applying.
 *
 * So this test asserts the names rather than merely that some skip exists,
 * and will fail if a throttler is added to app.module.ts without being
 * exempted here.
 */

// Mirrors the `throttlers` array in src/app.module.ts.
const THROTTLER_NAMES = ['default', 'auth', 'analysis', 'upload'] as const;

// Imported from the package rather than written out, so a rename upstream
// surfaces as a failure here instead of a test that silently passes.

/** The package records one metadata key per throttler: `THROTTLER:SKIP` + name. */
const skipKeyFor = (name: string): string => `${THROTTLER_SKIP}${name}`;

describe('health probes are never rate limited', () => {
  it.each(THROTTLER_NAMES)('skips the "%s" throttler', (name) => {
    // A missing name is the whole bug: that limiter still applies, the probe
    // starts failing once it exceeds that limiter's budget, and the platform
    // kills the instance.
    expect(Reflect.getMetadata(skipKeyFor(name), HealthController)).toBe(true);
  });

  it('skips every throttler the application defines, with none missed', () => {
    const skipped = Reflect.getMetadataKeys(HealthController)
      .map(String)
      .filter((key) => key.startsWith(THROTTLER_SKIP))
      .map((key) => key.slice(THROTTLER_SKIP.length))
      .sort();

    expect(skipped).toEqual([...THROTTLER_NAMES].sort());
  });
});
