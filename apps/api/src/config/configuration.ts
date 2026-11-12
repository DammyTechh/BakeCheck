import { z } from 'zod';

/**
 * Centralised, validated configuration.
 *
 * The schema is strict on purpose: the process refuses to boot with a missing
 * or malformed secret rather than starting in a half-configured state and
 * failing later under load. Production adds extra assertions (see
 * `assertProductionSafety`) that catch the classic deployment mistakes —
 * dev secrets left in place, wildcard CORS, insecure cookies.
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** Strings we refuse to accept as real secrets. */
const PLACEHOLDER_SECRET_PATTERNS = [
  /^replace-with/i,
  /^change-me/i,
  /^changeme/i,
  /^secret$/i,
  /^password$/i,
  /^test$/i,
  /^xxx/i,
];

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const intString = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ── HTTP ──────────────────────────────────────────────────────────────────
  API_PORT: intString(1, 65535).default(3000),
  API_GLOBAL_PREFIX: z.string().default('api'),
  TRUST_PROXY: booleanString.default('false'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres URL'),
  DATABASE_SSL: booleanString.default('false'),
  DATABASE_POOL_MAX: intString(1, 100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: intString(1000, 120000).default(15000),

  // ── Auth ──────────────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: intString(60, 86400).default(900),
  JWT_REFRESH_TTL: intString(3600, 31536000).default(1209600),
  REFRESH_COOKIE_NAME: z.string().default('bg_rt'),
  REFRESH_COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanString.default('false'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // ── Swagger ───────────────────────────────────────────────────────────────
  SWAGGER_ENABLED: booleanString.default('true'),
  SWAGGER_PATH: z.string().default('api/docs'),

  // ── Uploads ───────────────────────────────────────────────────────────────
  MAX_UPLOAD_BYTES: intString(1024, 104857600).default(10485760),
  MAX_IMAGE_PIXELS: intString(10000, 500000000).default(50000000),
  ALLOWED_IMAGE_MIME: z.string().default('image/jpeg,image/png,image/webp'),

  // ── Storage ───────────────────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('sample-images'),
  SIGNED_URL_TTL_SECONDS: intString(30, 3600).default(300),

  // ── Rate limiting ─────────────────────────────────────────────────────────
  RATE_LIMIT_WINDOW_MS: intString(1000, 3600000).default(60000),
  RATE_LIMIT_MAX: intString(1, 10000).default(120),
  AUTH_RATE_LIMIT_MAX: intString(1, 1000).default(10),
  ANALYSIS_RATE_LIMIT_MAX: intString(1, 1000).default(20),

  // ── Training worker ───────────────────────────────────────────────────────
  // The worker polls for queued training jobs. Disabled in environments that
  // should never train (a read-only replica, say).
  TRAINING_WORKER_ENABLED: booleanString.default('true'),
  TRAINING_POLL_INTERVAL_MS: intString(5000, 3600000).default(15000),
  // Training on a few hundred examples takes tens of seconds; the analysis
  // timeout would abort every real run.
  TRAINING_TIMEOUT_MS: intString(30000, 3600000).default(600000),

  // ── Python AI service ─────────────────────────────────────────────────────
  AI_SERVICE_URL: z.string().url(),
  AI_SERVICE_INTERNAL_KEY: z
    .string()
    .min(16, 'AI_SERVICE_INTERNAL_KEY must be >= 16 chars'),
  AI_SERVICE_TIMEOUT_MS: intString(1000, 300000).default(30000),
  AI_SERVICE_MAX_RETRIES: intString(0, 5).default(2),
  AI_SERVICE_MAX_CONCURRENCY: intString(1, 64).default(4),

  // ── Email ─────────────────────────────────────────────────────────────────
  EMAIL_DRIVER: z.enum(['noop', 'resend']).default('noop'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('BreadGuard AI <no-reply@example.test>'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  isProduction: boolean;
  isTest: boolean;
  logLevel: Env['LOG_LEVEL'];
  http: {
    port: number;
    globalPrefix: string;
    trustProxy: boolean;
    corsOrigins: string[];
  };
  database: {
    url: string;
    ssl: boolean;
    poolMax: number;
    statementTimeoutMs: number;
  };
  auth: {
    accessSecret: string;
    refreshSecret: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    refreshCookieName: string;
    refreshCookieDomain?: string;
    cookieSecure: boolean;
    cookieSameSite: 'lax' | 'strict' | 'none';
  };
  swagger: { enabled: boolean; path: string };
  uploads: {
    maxBytes: number;
    maxPixels: number;
    allowedMimeTypes: string[];
  };
  storage: {
    driver: 'local' | 'supabase';
    localDir: string;
    supabaseUrl?: string;
    supabaseServiceRoleKey?: string;
    bucket: string;
    signedUrlTtlSeconds: number;
  };
  rateLimit: {
    windowMs: number;
    max: number;
    authMax: number;
    analysisMax: number;
  };
  aiService: {
    url: string;
    internalKey: string;
    timeoutMs: number;
    maxRetries: number;
    maxConcurrency: number;
  };
  training: {
    workerEnabled: boolean;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  email: {
    driver: 'noop' | 'resend';
    resendApiKey?: string;
    from: string;
    appBaseUrl: string;
  };
}

/**
 * Checks that only matter once real traffic is involved. Running these in
 * development would make local setup needlessly painful, so they are gated on
 * NODE_ENV=production — but there they are fatal.
 */
function assertProductionSafety(env: Env): void {
  const problems: string[] = [];

  const looksPlaceholder = (value: string): boolean =>
    PLACEHOLDER_SECRET_PATTERNS.some((pattern) => pattern.test(value));

  if (looksPlaceholder(env.JWT_ACCESS_SECRET)) {
    problems.push('JWT_ACCESS_SECRET still holds a placeholder value');
  }
  if (looksPlaceholder(env.JWT_REFRESH_SECRET)) {
    problems.push('JWT_REFRESH_SECRET still holds a placeholder value');
  }
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ, otherwise a ' +
        'refresh token can be replayed as an access token',
    );
  }
  if (looksPlaceholder(env.AI_SERVICE_INTERNAL_KEY)) {
    problems.push('AI_SERVICE_INTERNAL_KEY still holds a placeholder value');
  }
  if (!env.COOKIE_SECURE) {
    problems.push('COOKIE_SECURE must be true in production');
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    problems.push('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }

  const origins = csv(env.CORS_ORIGINS);
  if (origins.length === 0) {
    problems.push('CORS_ORIGINS must list at least one origin in production');
  }
  if (origins.includes('*')) {
    problems.push('CORS_ORIGINS must not contain a wildcard in production');
  }
  for (const origin of origins) {
    if (origin.startsWith('http://') && !origin.startsWith('http://localhost')) {
      problems.push(`CORS origin "${origin}" must use HTTPS in production`);
    }
  }

  if (env.STORAGE_DRIVER === 'supabase') {
    if (!env.SUPABASE_URL)
      problems.push('SUPABASE_URL is required when STORAGE_DRIVER=supabase');
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      problems.push('SUPABASE_SERVICE_ROLE_KEY is required when STORAGE_DRIVER=supabase');
    }
  }
  if (env.EMAIL_DRIVER === 'resend' && !env.RESEND_API_KEY) {
    problems.push('RESEND_API_KEY is required when EMAIL_DRIVER=resend');
  }
  // Loopback by IP is as local as `localhost`. Matching only the hostname
  // string flagged `127.0.0.1` as remote, which pushes someone into setting
  // DATABASE_SSL=true against a server that is not listening for TLS.
  const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
  const databaseHost = (() => {
    try {
      return new URL(env.DATABASE_URL).hostname;
    } catch {
      // Unparseable URLs are caught by the schema; treat as remote here.
      return '';
    }
  })();
  const databaseIsLocal = LOOPBACK_HOSTS.includes(databaseHost);

  if (!env.DATABASE_SSL && !databaseIsLocal) {
    problems.push(
      `DATABASE_SSL should be true for a remote database (host "${databaseHost}")`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n` +
        problems.map((p) => `  • ${p}`).join('\n'),
    );
  }
}

/** Parses `process.env` into the typed config object. Throws on any problem. */
export function loadConfiguration(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    assertProductionSafety(env);
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    logLevel: env.LOG_LEVEL,
    http: {
      port: env.API_PORT,
      globalPrefix: env.API_GLOBAL_PREFIX,
      trustProxy: env.TRUST_PROXY,
      corsOrigins: csv(env.CORS_ORIGINS),
    },
    database: {
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    auth: {
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      accessTtlSeconds: env.JWT_ACCESS_TTL,
      refreshTtlSeconds: env.JWT_REFRESH_TTL,
      refreshCookieName: env.REFRESH_COOKIE_NAME,
      refreshCookieDomain: env.REFRESH_COOKIE_DOMAIN || undefined,
      cookieSecure: env.COOKIE_SECURE,
      cookieSameSite: env.COOKIE_SAMESITE,
    },
    swagger: { enabled: env.SWAGGER_ENABLED, path: env.SWAGGER_PATH },
    uploads: {
      maxBytes: env.MAX_UPLOAD_BYTES,
      maxPixels: env.MAX_IMAGE_PIXELS,
      allowedMimeTypes: csv(env.ALLOWED_IMAGE_MIME),
    },
    storage: {
      driver: env.STORAGE_DRIVER,
      localDir: env.STORAGE_LOCAL_DIR,
      supabaseUrl: env.SUPABASE_URL,
      supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: env.SUPABASE_STORAGE_BUCKET,
      signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
      analysisMax: env.ANALYSIS_RATE_LIMIT_MAX,
    },
    aiService: {
      url: env.AI_SERVICE_URL.replace(/\/+$/, ''),
      internalKey: env.AI_SERVICE_INTERNAL_KEY,
      timeoutMs: env.AI_SERVICE_TIMEOUT_MS,
      maxRetries: env.AI_SERVICE_MAX_RETRIES,
      maxConcurrency: env.AI_SERVICE_MAX_CONCURRENCY,
    },
    training: {
      workerEnabled: env.TRAINING_WORKER_ENABLED,
      pollIntervalMs: env.TRAINING_POLL_INTERVAL_MS,
      timeoutMs: env.TRAINING_TIMEOUT_MS,
    },
    email: {
      driver: env.EMAIL_DRIVER,
      resendApiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      appBaseUrl: env.APP_BASE_URL,
    },
  };
}

export const CONFIG_TOKEN = 'APP_CONFIG';
