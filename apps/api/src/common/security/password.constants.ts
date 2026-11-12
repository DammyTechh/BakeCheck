import * as argon2 from 'argon2';

/**
 * Argon2id parameters, kept in one place so the seed script, the auth service
 * and the tests cannot drift apart.
 *
 * Chosen against the OWASP Password Storage Cheat Sheet's Argon2id guidance:
 * 19 MiB of memory, 2 iterations, parallelism 1. The memory cost is what makes
 * GPU cracking expensive; lowering it to save RAM defeats the point of using
 * Argon2 at all.
 *
 * These parameters are encoded in the resulting hash string, so raising them
 * later does not invalidate existing hashes — argon2.verify reads each hash's
 * own parameters. Use `argon2.needsRehash` on successful login to migrate
 * users forward gradually.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Minimum password length. Length beats composition rules: a long passphrase
 * is stronger and more memorable than a short string with a symbol bolted on,
 * so there is deliberately no "must contain a special character" rule here.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
