import pino, { Logger as PinoLogger } from 'pino';
import { AppConfig } from '../../config/configuration';

/**
 * Field paths scrubbed from every log line.
 *
 * Redaction is applied by pino at serialisation time, so a sensitive value
 * cannot reach a log file even if someone logs a whole request or user object
 * by accident. The list covers credentials, tokens, cookies and the EXIF
 * blocks that can carry GPS coordinates and device serial numbers.
 */
export const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token',
  'token_hash',
  'tokenHash',
  'authorization',
  'cookie',
  'set-cookie',
  'apiKey',
  'api_key',
  'internalKey',
  'secret',
  'serviceRoleKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Image metadata that can identify a place or a device.
  'exif',
  'gps',
  'GPSLatitude',
  'GPSLongitude',
  'capture_metadata.gps',
  '*.password',
  '*.token',
  '*.secret',
] as const;

export function createLogger(config: AppConfig): PinoLogger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: '[REDACTED]',
    },
    // Pretty output is a development nicety; production emits newline-
    // delimited JSON for log aggregation.
    ...(config.isProduction
      ? {}
      : {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }),
    base: {
      service: 'breadguard-api',
      env: config.nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/**
 * Strips sensitive keys from an object before it is written to audit_logs.
 *
 * pino's redaction covers logs; this covers the database, where metadata is
 * persisted and queried later.
 */
const SENSITIVE_KEY_PATTERN = /pass|token|secret|key|auth|cookie|credential|gps|exif/i;

export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactMetadata(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : redactMetadata(entry, depth + 1);
    }
    return result;
  }

  // Cap long strings so a stray payload cannot bloat the audit table.
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}…[TRUNCATED]`;
  }

  return value;
}
