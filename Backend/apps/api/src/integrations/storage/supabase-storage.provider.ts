import { Injectable, Logger } from '@nestjs/common';
import { ApiError, ErrorCode } from '../../common/errors/api-error';
import { StorageProvider, StoredObject } from './storage.types';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Supabase Storage driver, over the REST API.
 *
 * Uses the service-role key, which bypasses storage RLS — so this class runs
 * only on the server and the key is never exposed to a browser. The bucket is
 * expected to be **private**; reads are served through short-lived signed URLs
 * rather than public object URLs.
 *
 * Implemented with `fetch` rather than @supabase/supabase-js: this needs four
 * operations, and the SDK would add a large dependency surface to keep patched
 * for no gain.
 */
@Injectable()
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = 'supabase';
  private readonly logger = new Logger(SupabaseStorageProvider.name);

  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    if (!baseUrl || !serviceRoleKey) {
      throw new Error(
        'SupabaseStorageProvider requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
      );
    }
  }

  private endpoint(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/storage/v1/${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
      ...extra,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const response = await this.request(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': contentType,
          // Replace rather than fail if the key somehow already exists.
          'x-upsert': 'true',
        }),
        body: new Uint8Array(body),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        { status: response.status, detail: detail.slice(0, 300) },
        'Supabase storage upload failed',
      );
      throw new ApiError(
        ErrorCode.STORAGE_ERROR,
        'Failed to store the image',
        502 as never,
      );
    }

    return { key, byteSize: body.byteLength, contentType };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      { method: 'GET', headers: this.headers() },
    );

    if (!response.ok) {
      if (response.status === 404) throw ApiError.notFound('Image');
      this.logger.error({ status: response.status }, 'Supabase storage read failed');
      throw new ApiError(
        ErrorCode.STORAGE_ERROR,
        'Failed to read the image',
        502 as never,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      { method: 'DELETE', headers: this.headers() },
    );
    if (!response.ok && response.status !== 404) {
      this.logger.warn(
        { status: response.status, key },
        'Supabase storage delete failed',
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.request(
      this.endpoint(`object/info/${this.bucket}/${encodeURI(key)}`),
      { method: 'GET', headers: this.headers() },
    );
    return response.ok;
  }

  /**
   * Issues a signed URL valid for `ttlSeconds`. This is how authorised users
   * read confidential images without the API proxying every byte.
   */
  async createSignedUrl(key: string, ttlSeconds: number): Promise<string | null> {
    const response = await this.request(
      this.endpoint(`object/sign/${this.bucket}/${encodeURI(key)}`),
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: ttlSeconds }),
      },
    );

    if (!response.ok) {
      this.logger.warn(
        { status: response.status },
        'Supabase signed URL creation failed; falling back to proxied download',
      );
      return null;
    }

    const body = (await response.json()) as { signedURL?: string };
    if (!body.signedURL) return null;

    // Supabase returns a path relative to /storage/v1.
    return `${this.baseUrl.replace(/\/+$/, '')}/storage/v1${body.signedURL}`;
  }
}
