import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Static guard against SQL injection.
 *
 * Several services build a dynamic `SET` or `WHERE` clause, so some SQL is
 * assembled by string concatenation. That is safe *only* because every
 * interpolated fragment is server-controlled: a column name from a hardcoded
 * map, a placeholder index, or a pre-built fragment list. Values always
 * travel as bind parameters.
 *
 * Eyeballing that invariant does not scale, and a future change could break
 * it without any test failing. This extracts the SQL actually passed to the
 * query helpers and asserts every `${…}` inside it matches a known-safe
 * shape.
 *
 * It deliberately parses the *call sites* rather than grepping for SQL
 * keywords: prose such as "Join the laboratory" or "the limit is 10" would
 * otherwise be mistaken for SQL and bury the real signal in false positives.
 *
 * If this fails, do not extend the allowlist without confirming the new
 * expression genuinely cannot carry request data.
 */

const SRC_ROOT = join(__dirname, '..', 'src');

/**
 * Interpolations that are safe by construction:
 *
 * - `params.length` arithmetic → produces `$1`, `$2`… placeholder indices
 * - `where` → joined from literal filter fragments built in the same function
 * - `updates.join(…)` / `filters.join(…)` → joined from literal fragments
 * - `column` → a key from a hardcoded column map in the same function
 * - `orderBy` → produced by buildOrderBy(), which whitelists column names
 * - `this.selectClause` → a literal class field
 */
const SAFE_INTERPOLATIONS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^params\.length(\s*-\s*\d+)?$/, why: 'placeholder index' },
  { pattern: /^where$/, why: 'joined literal filter fragments' },
  { pattern: /^updates\.join\(.*\)$/, why: 'joined literal SET fragments' },
  { pattern: /^filters\.join\(.*\)$/, why: 'joined literal WHERE fragments' },
  { pattern: /^column$/, why: 'key from a hardcoded column map' },
  { pattern: /^orderBy$/, why: 'from buildOrderBy(), which whitelists columns' },
  { pattern: /^this\.selectClause$/, why: 'literal class field' },
  {
    // The inline conditional form:
    //   ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    //
    // The [^}] capture stops at the inner closing brace, so the expression
    // seen here ends mid-way at `')`. `where` is an array of literal
    // fragments built in the same function — the same safe construction,
    // written inline rather than hoisted to a variable.
    pattern: /^where\.length\s*\?\s*`WHERE\s+\$\{where\.join\([^)]*\)$/,
    why: 'conditional WHERE from joined literal fragments',
  },
];

function collectSourceFiles(): string[] {
  return globSync('**/*.ts', { cwd: SRC_ROOT })
    .filter((p) => !p.endsWith('.spec.ts'))
    .map((p) => join(SRC_ROOT, p));
}

interface QueryCall {
  file: string;
  line: number;
  sql: string;
  /** Everything after the SQL template literal, i.e. the params argument. */
  rest: string;
}

/**
 * Extracts every `db.query` / `db.queryOne` / `client.query` call whose first
 * argument is a template literal, by scanning forward from the opening paren
 * and tracking backtick boundaries.
 */
function extractQueryCalls(file: string): QueryCall[] {
  const contents = readFileSync(file, 'utf8');
  const calls: QueryCall[] = [];
  const callPattern = /\.(query|queryOne)\s*(<[\s\S]*?>)?\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(contents)) !== null) {
    let cursor = match.index + match[0].length;

    // Skip whitespace to the first argument.
    while (cursor < contents.length && /\s/.test(contents[cursor])) cursor += 1;
    // Only template-literal SQL is of interest here.
    if (contents[cursor] !== '`') continue;

    const sqlStart = cursor;
    cursor += 1;
    let depth = 0;

    // Walk to the closing backtick, stepping over nested ${ } which may
    // themselves contain backticks.
    while (cursor < contents.length) {
      const ch = contents[cursor];
      if (ch === '\\') {
        cursor += 2;
        continue;
      }
      if (ch === '$' && contents[cursor + 1] === '{') {
        depth += 1;
        cursor += 2;
        continue;
      }
      if (ch === '}' && depth > 0) {
        depth -= 1;
        cursor += 1;
        continue;
      }
      if (ch === '`' && depth === 0) break;
      cursor += 1;
    }

    const sql = contents.slice(sqlStart, cursor + 1);
    // The params argument, up to a reasonable lookahead.
    const rest = contents.slice(cursor + 1, cursor + 400);
    const line = contents.slice(0, sqlStart).split('\n').length;

    calls.push({ file: relative(SRC_ROOT, file), line, sql, rest });
  }

  return calls;
}

function allQueryCalls(): QueryCall[] {
  return collectSourceFiles().flatMap(extractQueryCalls);
}

describe('SQL construction safety', () => {
  it('finds the query call sites to inspect', () => {
    // A guard on the guard: if the extractor silently stops matching, the
    // other assertions would pass vacuously.
    expect(allQueryCalls().length).toBeGreaterThan(40);
  });

  it('interpolates only server-controlled fragments into SQL', () => {
    const offenders: string[] = [];

    for (const call of allQueryCalls()) {
      for (const interpolation of call.sql.matchAll(/\$\{([^}]+)\}/g)) {
        const expression = interpolation[1].trim();
        if (SAFE_INTERPOLATIONS.some(({ pattern }) => pattern.test(expression))) {
          continue;
        }
        offenders.push(`${call.file}:${call.line}  \${${expression}}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never splices a value directly into a comparison', () => {
    // The shape that would actually be exploitable: a value interpolated
    // into a comparison rather than bound, e.g. WHERE email = '${email}'.
    const dangerous = /(WHERE|AND|OR|SET)\s+[a-z_."]+\s*(=|LIKE|ILIKE|<|>|<>)\s*'?\$\{/i;
    const offenders: string[] = [];

    for (const call of allQueryCalls()) {
      // `${column} = $n` is the safe inverse shape and is covered above.
      if (dangerous.test(call.sql)) {
        offenders.push(`${call.file}:${call.line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('passes bind parameters whenever a query uses placeholders', () => {
    const offenders: string[] = [];

    for (const call of allQueryCalls()) {
      // Placeholders written literally as `$1`, not the `$${…}` form that
      // builds an index dynamically.
      const usesPlaceholder = /\$\d/.test(call.sql);
      if (!usesPlaceholder) continue;

      // A params argument follows the template literal as `, params` or `, [`.
      const hasParams = /^\s*,\s*\S/.test(call.rest);
      if (!hasParams) {
        offenders.push(`${call.file}:${call.line}  uses $n but passes no params`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
