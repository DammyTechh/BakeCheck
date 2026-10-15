/**
 * Private object storage contract.
 *
 * Laboratory images are confidential. Nothing in this interface returns a
 * permanent public URL — reads go through either a short-lived signed URL or
 * an authenticated download that streams the bytes through the API.
 */

export interface StoredObject {
  /** Opaque key. Treated as an internal identifier, never shown to users. */
  key: string;
  byteSize: number;
  contentType: string;
}

export interface StorageProvider {
  readonly name: string;

  /** Writes bytes under `key`. Overwrites if the key already exists. */
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;

  /** Reads an object back. Throws when the key is unknown. */
  get(key: string): Promise<Buffer>;

  /** Removes an object. Succeeds silently when the key does not exist. */
  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  /**
   * A time-limited URL, when the backing store supports one. Returns null for
   * drivers that cannot sign (local disk), in which case callers fall back to
   * the authenticated download endpoint.
   */
  createSignedUrl(key: string, ttlSeconds: number): Promise<string | null>;
}

export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
