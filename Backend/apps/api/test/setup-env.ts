/**
 * Test environment defaults.
 *
 * Loaded by jest before any test file. Values here are fake and exist only so
 * the configuration schema validates; no test reaches a real external service.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://breadguard:devpassword@127.0.0.1:5432/breadguard_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-different-and-32-chars-long';
process.env.AI_SERVICE_URL = 'http://127.0.0.1:8099';
process.env.AI_SERVICE_INTERNAL_KEY = 'test-internal-key-0123456789abcdef';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = './.storage-test';
process.env.EMAIL_DRIVER = 'noop';

// Nest's Logger writes straight to stdout and ignores LOG_LEVEL, which buries
// a real assertion failure under service chatter. Services under test still
// call the logger; it just goes nowhere.
import { Logger } from '@nestjs/common';
Logger.overrideLogger(false);
