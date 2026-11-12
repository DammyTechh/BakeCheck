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
      // Supabase answers a missing bucket with
      // {"statusCode":"500","error":"Internal","message":"Internal Server
      // Error"} -- which names neither the bucket nor the cause. Log what we
      // actually sent, so the next person does not have to guess.
      this.logger.error(
        {
          status: response.status,
          bucket: this.bucket,
          key,
          baseUrl: this.baseUrl,
          detail: detail.slice(0, 300),
          hint:
            response.status >= 500
              ? `Supabase returned a server error. The usual cause is that ` +
                `the bucket "${this.bucket}" does not exist in the project ` +
                `at ${this.baseUrl}. Check GET /health/ready, which reports ` +
                `this directly.`
              : undefined,
        },
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

  /**
   * Confirms the bucket exists and the key is accepted, writing nothing.
   *
   * `GET /bucket/{name}` is the cheapest call that distinguishes the three
   * ways this goes wrong, which the upload endpoint cannot: it answers 404
   * when the bucket is missing, 401/403 when the key is wrong, and 200 when
   * both are fine. An upload against a missing bucket answers
   * `{"statusCode":"500","error":"Internal"}`, which says none of that.
   */
  async check(): Promise<{ ok: boolean; reason: string | null }> {
    let response: Response;
    try {
      response = await this.request(this.endpoint(`bucket/${this.bucket}`), {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason:
          `Could not reach Supabase at ${this.baseUrl} (${message}). Check ` +
          'SUPABASE_URL is the project URL, with no trailing path.',
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        reason:
          `The bucket "${this.bucket}" does not exist in this Supabase ` +
          'project. Create it under Storage → New bucket, keep it PRIVATE, ' +
          'and make the name match SUPABASE_STORAGE_BUCKET exactly.',
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason:
          'Supabase rejected the credentials. SUPABASE_SERVICE_ROLE_KEY must ' +
          'be the service_role key (not the anon key) for the project at ' +
          `${this.baseUrl}, and must not have been rotated since it was set.`,
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        reason:
          `Supabase answered ${response.status} for bucket "${this.bucket}": ` +
          detail.slice(0, 200),
      };
    }

    // A public bucket would let anyone with a URL read laboratory images.
    const body = (await response.json().catch(() => null)) as {
      public?: boolean;
    } | null;
    if (body?.public === true) {
      return {
        ok: false,
        reason:
          `The bucket "${this.bucket}" is PUBLIC. Laboratory images must not ` +
          'be world-readable; set it to private in Supabase.',
      };
    }

    return { ok: true, reason: null };
  }
}
