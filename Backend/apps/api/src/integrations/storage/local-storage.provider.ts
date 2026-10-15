import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { StorageProvider, StoredObject } from './storage.types';

/**
 * Filesystem-backed storage for local development.
 *
 * Suitable for a developer machine and for Docker Compose. It is NOT suitable
 * for Render or any platform with an ephemeral filesystem — containers there
 * are replaced on every deploy and the files go with them. Use the Supabase
 * driver in production; see docs/deployment.md.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /**
   * Resolves a key to an absolute path and refuses anything that escapes the
   * storage root. Keys are generated server-side, but this check means a bug
   * that lets one through from a request cannot become a path traversal.
   */
  private resolveKey(key: string): string {
    if (!key || key.includes('\0')) {
      throw ApiError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid storage key');
    }

    const candidate = resolve(join(this.root, normalize(key)));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      this.logger.error({ key }, 'Rejected storage key outside the root');
      throw ApiError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid storage key');
    }
    return candidate;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    // Owner-only permissions: these are confidential laboratory images.
    await writeFile(path, body, { mode: 0o600 });
    return { key, byteSize: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const path = this.resolveKey(key);
    try {
      return await readFile(path);
    } catch {
      throw ApiError.notFound('Image');
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolveKey(key);
    try {
      await unlink(path);
    } catch {
      // Deleting something already gone is not a failure.
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Local disk cannot issue signed URLs. Returning null makes callers use the
   * authenticated download endpoint, which is the correct behaviour here.
   */
  async createSignedUrl(): Promise<string | null> {
    return null;
  }
}
