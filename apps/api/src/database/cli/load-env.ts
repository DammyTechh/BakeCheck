import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader for the standalone CLI scripts (migrate, seed).
 *
 * The Nest application gets its environment through @nestjs/config, which uses
 * `dotenv`. These scripts run outside the Nest context, so they need their own
 * loader — and it has to agree with dotenv, because the two read the same
 * file. An earlier version of this did not, with real consequences:
 *
 *   • It did not strip inline comments, so `JWT_ACCESS_TTL=900  # 15 min`
 *     became the literal string `900  # 15 min`. Every commented value in
 *     `.env.example` — which is most of them — was corrupted for the CLIs
 *     while working correctly for the API.
 *
 *   • On a duplicate key it kept the *first* occurrence; dotenv keeps the
 *     *last*. A file defining `DATABASE_URL` twice therefore pointed the API
 *     at one database and `migrate`/`seed` at another, silently. That is a
 *     migration applied to the wrong server with no error anywhere.
 *
 * So the parsing rules below deliberately mirror dotenv's:
 *   - unquoted values end at the first `#`, then are trimmed
 *   - a matched pair of surrounding quotes is stripped and protects `#`
 *   - an unterminated quote is treated as a literal character
 *   - within one file, a later assignment overwrites an earlier one
 *
 * Two rules are ours rather than dotenv's, and both are intentional:
 *   - a value already in `process.env` always wins, which is what lets CI and
 *     Render/Vercel inject real configuration over committed defaults
 *   - an earlier file in `paths` wins over a later one, so a per-app
 *     `apps/api/.env` overrides the repository-root `.env`
 */

interface ParsedFile {
  values: Map<string, string>;
  /** Keys assigned more than once, in first-seen order. */
  duplicates: string[];
}

/** Parses one .env file body with dotenv-compatible semantics. */
export function parseDotEnv(contents: string): ParsedFile {
  const values = new Map<string, string>();
  const seenTwice = new Set<string>();

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    let value = line.slice(separator + 1).trim();

    const quote = value[0];
    const isQuoted =
      (quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote);

    if (isQuoted) {
      // Quotes protect the contents, `#` included.
      value = value.slice(1, -1);
    } else {
      // Unquoted: everything from the first `#` is a comment.
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }

    if (values.has(key)) seenTwice.add(key);
    // Last assignment wins, matching dotenv.
    values.set(key, value);
  }

  return { values, duplicates: [...seenTwice] };
}

export function loadDotEnv(paths: string[] = ['.env', '../../.env']): void {
  for (const relative of paths) {
    const path = resolve(process.cwd(), relative);
    if (!existsSync(path)) continue;

    const { values, duplicates } = parseDotEnv(readFileSync(path, 'utf8'));

    if (duplicates.length > 0) {
      // Loud on purpose. A duplicated DATABASE_URL is the difference between
      // migrating the database you meant and migrating a different one, and
      // nothing downstream can detect it.
      console.warn(
        `\n  Warning: ${path} assigns these keys more than once: ` +
          `${duplicates.join(', ')}.\n` +
          `  The last assignment wins. If that is not what you intended, ` +
          `comment out the others.\n`,
      );
    }

    for (const [key, value] of values) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
