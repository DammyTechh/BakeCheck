import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { DatabaseService } from '../../database/database.service';
import { ApiError } from '../../common/errors/api-error';
import { AuthenticatedUser } from '../../common/types/request-context';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../../integrations/storage/storage.types';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ImageValidationService } from './image-validation.service';

export interface UploadedImageResult {
  id: string;
  sampleId: string;
  laboratoryId: string;
  originalFilename: string | null;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  contentHash: string;
  source: string;
  /** True when an identical image was already uploaded to this laboratory. */
  duplicateOf: string | null;
  warnings: string[];
  createdAt: string;
}

interface ImageRow {
  id: string;
  sample_id: string | null;
  laboratory_id: string;
  storage_key: string;
  original_filename: string | null;
  mime_type: string;
  byte_size: string;
  width: number | null;
  height: number | null;
  content_hash: string;
  source: string;
  derived_from_id: string | null;
  capture_metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * Image intake and retrieval.
 *
 * Storage layout:
 *   laboratories/<labId>/samples/<sampleId>/<imageId>/original.<ext>
 *   laboratories/<labId>/samples/<sampleId>/<imageId>/normalised.png
 *
 * The original is kept byte-for-byte as the evidentiary record. The
 * normalised derivative (EXIF-rotated, metadata-stripped, re-encoded) is what
 * the AI service analyses, so measurements always refer to a known-clean
 * image whose pixel coordinates match the stored dimensions.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly validation: ImageValidationService,
    private readonly auditService: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async upload(params: {
    sampleId: string;
    laboratoryId: string;
    buffer: Buffer;
    declaredMimeType?: string;
    originalFilename?: string;
    source: 'UPLOAD' | 'CAMERA';
    actor: AuthenticatedUser;
    correlationId?: string;
  }): Promise<UploadedImageResult> {
    const validated = await this.validation
      .validate(params.buffer, params.declaredMimeType, params.originalFilename)
      .catch(async (error) => {
        // Record rejected uploads: a burst of them is a useful signal, and an
        // operator needs to see why a technician's photo keeps failing.
        await this.auditService.record({
          actorUserId: params.actor.id,
          actorEmail: params.actor.email,
          laboratoryId: params.laboratoryId,
          action: AuditAction.IMAGE_REJECTED,
          resourceType: 'sample',
          resourceId: params.sampleId,
          outcome: 'FAILURE',
          correlationId: params.correlationId,
          metadata: {
            reason: error instanceof ApiError ? error.code : 'unknown',
            declaredMimeType: params.declaredMimeType,
            byteSize: params.buffer.length,
          },
        });
        throw error;
      });

    // Duplicate detection is informational, not a rejection: the same photo
    // may legitimately be re-uploaded against a different sample.
    const duplicate = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM sample_images
        WHERE laboratory_id = $1 AND content_hash = $2
        ORDER BY created_at ASC LIMIT 1`,
      [params.laboratoryId, validated.contentHash],
    );

    const imageId = randomUUID();
    const extension = validated.format === 'jpeg' ? 'jpg' : validated.format;
    const prefix = `laboratories/${params.laboratoryId}/samples/${params.sampleId}/${imageId}`;
    const originalKey = `${prefix}/original.${extension}`;
    const normalisedKey = `${prefix}/normalised.png`;

    await this.storage.put(originalKey, validated.original, validated.mimeType);
    await this.storage.put(normalisedKey, validated.normalised, 'image/png');

    const warnings = [...validated.warnings];
    if (duplicate) {
      warnings.push('An identical image has already been uploaded to this laboratory.');
    }

    try {
      const row = await this.db.queryOne<{ id: string; created_at: Date }>(
        `INSERT INTO sample_images (
           id, sample_id, laboratory_id, storage_key, storage_driver,
           original_filename, mime_type, byte_size, width, height,
           content_hash, source, capture_metadata, uploaded_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::image_source,$13,$14)
         RETURNING id, created_at`,
        [
          imageId,
          params.sampleId,
          params.laboratoryId,
          originalKey,
          this.storage.name,
          // Keep only the basename, and only a bounded length: a filename is
          // attacker-controlled text that ends up in listings and logs.
          this.sanitiseFilename(params.originalFilename),
          validated.mimeType,
          validated.byteSize,
          validated.width,
          validated.height,
          validated.contentHash,
          params.source,
          JSON.stringify({
            ...validated.captureMetadata,
            normalised_key: normalisedKey,
          }),
          params.actor.id,
        ],
      );

      if (!row) throw ApiError.internal('Failed to record the uploaded image');

      await this.auditService.record({
        actorUserId: params.actor.id,
        actorEmail: params.actor.email,
        laboratoryId: params.laboratoryId,
        action: AuditAction.IMAGE_UPLOAD,
        resourceType: 'sample_image',
        resourceId: imageId,
        correlationId: params.correlationId,
        metadata: {
          sampleId: params.sampleId,
          mimeType: validated.mimeType,
          byteSize: validated.byteSize,
          dimensions: `${validated.width}x${validated.height}`,
          source: params.source,
          duplicateOf: duplicate?.id ?? null,
        },
      });

      return {
        id: imageId,
        sampleId: params.sampleId,
        laboratoryId: params.laboratoryId,
        originalFilename: this.sanitiseFilename(params.originalFilename),
        mimeType: validated.mimeType,
        byteSize: validated.byteSize,
        width: validated.width,
        height: validated.height,
        contentHash: validated.contentHash,
        source: params.source,
        duplicateOf: duplicate?.id ?? null,
        warnings,
        createdAt: row.created_at.toISOString(),
      };
    } catch (error) {
      // The row failed but the bytes are already stored. Clean up, otherwise
      // the bucket accumulates objects nothing references.
      await this.storage.delete(originalKey).catch(() => undefined);
      await this.storage.delete(normalisedKey).catch(() => undefined);
      throw error;
    }
  }

  async findOne(imageId: string): Promise<ImageRow> {
    const row = await this.db.queryOne<ImageRow>(
      `SELECT id, sample_id, laboratory_id, storage_key, original_filename,
              mime_type, byte_size, width, height, content_hash, source,
              derived_from_id, capture_metadata, created_at
         FROM sample_images WHERE id = $1`,
      [imageId],
    );
    if (!row) throw ApiError.notFound('Image');
    return row;
  }

  async listForSample(
    sampleId: string,
    laboratoryId: string,
  ): Promise<Array<Omit<UploadedImageResult, 'warnings' | 'duplicateOf'>>> {
    const rows = await this.db.query<ImageRow>(
      `SELECT id, sample_id, laboratory_id, storage_key, original_filename,
              mime_type, byte_size, width, height, content_hash, source,
              derived_from_id, capture_metadata, created_at
         FROM sample_images
        WHERE sample_id = $1 AND laboratory_id = $2
        ORDER BY created_at DESC`,
      [sampleId, laboratoryId],
    );

    return rows.map((row) => ({
      id: row.id,
      sampleId: row.sample_id!,
      laboratoryId: row.laboratory_id,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      width: row.width ?? 0,
      height: row.height ?? 0,
      contentHash: row.content_hash,
      source: row.source,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** Returns the normalised derivative — what the AI service measures. */
  async getNormalisedBytes(imageId: string): Promise<Buffer> {
    const row = await this.findOne(imageId);
    const normalisedKey = (row.capture_metadata as { normalised_key?: string })
      ?.normalised_key;

    if (normalisedKey && (await this.storage.exists(normalisedKey))) {
      return this.storage.get(normalisedKey);
    }

    // Older rows, or a derivative that went missing: fall back to the
    // original. Analysis still works; the record just loses the guarantee
    // that EXIF rotation was pre-applied.
    this.logger.warn(
      { imageId },
      'Normalised derivative missing; falling back to the original image',
    );
    return this.storage.get(row.storage_key);
  }

  /**
   * Access for an authorised viewer.
   *
   * Prefers a short-lived signed URL when the driver can issue one, so the API
   * does not proxy large binaries. Falls back to a streamed download through
   * the authenticated endpoint. Either way there is no permanent public URL.
   */
  async getAccess(
    imageId: string,
    actor: AuthenticatedUser,
    correlationId?: string,
  ): Promise<
    | { kind: 'signed-url'; url: string; expiresInSeconds: number }
    | { kind: 'bytes'; buffer: Buffer; mimeType: string; filename: string }
  > {
    const row = await this.findOne(imageId);

    await this.auditService.record({
      actorUserId: actor.id,
      actorEmail: actor.email,
      laboratoryId: row.laboratory_id,
      action: AuditAction.IMAGE_DOWNLOAD,
      resourceType: 'sample_image',
      resourceId: imageId,
      correlationId,
    });

    const ttl = this.config.storage.signedUrlTtlSeconds;
    const signedUrl = await this.storage.createSignedUrl(row.storage_key, ttl);

    if (signedUrl) {
      return { kind: 'signed-url', url: signedUrl, expiresInSeconds: ttl };
    }

    return {
      kind: 'bytes',
      buffer: await this.storage.get(row.storage_key),
      mimeType: row.mime_type,
      filename: row.original_filename ?? `${imageId}.${row.mime_type.split('/')[1]}`,
    };
  }

  /**
   * Keeps a filename only as a display label: basename only, no path
   * separators, no control characters, bounded length.
   */
  private sanitiseFilename(filename?: string): string | null {
    if (!filename) return null;
    const base = filename.split(/[/\\]/).pop() ?? '';
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 255) : null;
  }
}
