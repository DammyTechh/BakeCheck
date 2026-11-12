import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
// sharp ships its types as named exports alongside a default export, so the
// types are imported explicitly rather than reached through a `sharp.*`
// namespace.
import type { Metadata, OutputInfo } from 'sharp';
import { AppConfig, CONFIG_TOKEN } from '../../config/configuration';
import { ApiError, ErrorCode } from '../../common/errors/api-error';

export interface ValidatedImage {
  /** Original bytes, preserved unmodified as the evidentiary record. */
  original: Buffer;
  /**
   * Normalised derivative handed to the AI service: EXIF-rotated, metadata
   * stripped, re-encoded. Never the original.
   */
  normalised: Buffer;
  mimeType: string;
  format: string;
  width: number;
  height: number;
  byteSize: number;
  /** SHA-256 of the original bytes — duplicate detection and integrity. */
  contentHash: string;
  /** Non-sensitive capture metadata retained for analysis context. */
  captureMetadata: Record<string, unknown>;
  warnings: string[];
}

/** Magic-number signatures. The declared Content-Type is never trusted. */
const SIGNATURES: Array<{
  mime: string;
  format: string;
  test: (buffer: Buffer) => boolean;
}> = [
  {
    mime: 'image/jpeg',
    format: 'jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    format: 'png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    format: 'webp',
    // 'RIFF' .... 'WEBP'
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/** Smallest image we will accept — below this there is nothing to measure. */
const MIN_DIMENSION = 64;
/** Largest single side. Guards against absurd aspect ratios. */
const MAX_DIMENSION = 20_000;

/**
 * Validates and normalises uploaded images.
 *
 * This is the primary untrusted-input boundary in the API, so the checks are
 * layered and ordered cheapest-first:
 *
 *   1. Size — reject before touching the content.
 *   2. Signature — identify the real format from magic bytes. The client's
 *      Content-Type and filename are advisory at best and hostile at worst.
 *   3. Dimensions from the header — catch decompression bombs *before*
 *      decoding, since a 100×100 PNG can expand to gigabytes of pixels.
 *   4. Full decode under a pixel cap — proves the file is a real image.
 *   5. Re-encode — produces a clean derivative with no EXIF, no colour
 *      profile surprises and no trailing appended data.
 *
 * SVG is rejected outright: it is a document format that can carry script and
 * fetch remote resources, and it has no place in a colour-measurement
 * pipeline.
 */
@Injectable()
export class ImageValidationService {
  private readonly logger = new Logger(ImageValidationService.name);

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {
    // Bound libvips' own cache so concurrent uploads cannot exhaust memory.
    sharp.cache({ memory: 64, files: 0, items: 64 });
    sharp.concurrency(2);
  }

  async validate(
    buffer: Buffer,
    declaredMimeType?: string,
    originalFilename?: string,
  ): Promise<ValidatedImage> {
    const warnings: string[] = [];

    // ── 1. Size ─────────────────────────────────────────────────────────────
    if (buffer.length === 0) {
      throw ApiError.badRequest(ErrorCode.INVALID_IMAGE, 'The uploaded file is empty');
    }
    if (buffer.length > this.config.uploads.maxBytes) {
      const limitMiB = Math.round(this.config.uploads.maxBytes / 1048576);
      throw new ApiError(
        ErrorCode.IMAGE_TOO_LARGE,
        `Image exceeds the maximum allowed size of ${limitMiB} MiB`,
        413 as never,
      );
    }

    // ── 2. Signature ────────────────────────────────────────────────────────
    const signature = SIGNATURES.find((candidate) => candidate.test(buffer));

    if (!signature) {
      // Name the SVG case specifically — it is the most common rejected
      // upload and the reason is worth explaining.
      const head = buffer.toString('utf8', 0, Math.min(256, buffer.length)).trim();
      const looksLikeSvg = head.startsWith('<?xml') || head.includes('<svg');
      throw new ApiError(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        looksLikeSvg
          ? 'SVG is not accepted. Upload a photograph as JPEG, PNG or WebP.'
          : 'Unsupported image format. Accepted: JPEG, PNG, WebP',
        415 as never,
      );
    }

    if (!this.config.uploads.allowedMimeTypes.includes(signature.mime)) {
      throw new ApiError(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        `${signature.mime} is not an accepted image type`,
        415 as never,
      );
    }

    // A mismatch is not fatal — browsers get this wrong routinely — but it is
    // worth recording, since it is also what a deliberate attempt looks like.
    if (declaredMimeType && declaredMimeType !== signature.mime) {
      warnings.push(
        `Declared content type (${declaredMimeType}) did not match the file's ` +
          `actual format (${signature.mime}); the actual format was used.`,
      );
      this.logger.warn(
        { declared: declaredMimeType, actual: signature.mime, originalFilename },
        'Content-Type mismatch on upload',
      );
    }

    // ── 3. Header dimensions, before any decode ─────────────────────────────
    let metadata: Metadata;
    try {
      metadata = await sharp(buffer, {
        // Disabled for the header read only. `metadata()` parses the header
        // and does not decode pixels, so there is no bomb risk here — and
        // letting sharp's own limit fire first would produce a generic
        // "could not be read" error instead of the explicit pixel-count
        // message below, which tells the user what is actually wrong. The
        // full decode further down keeps the real limit.
        limitInputPixels: false,
        // Multi-page input (animated WebP) is not meaningful here.
        pages: 1,
      }).metadata();
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message },
        'Image header could not be parsed',
      );
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        'The file could not be read as an image. It may be corrupt or truncated.',
      );
    }

    const { width, height } = metadata;
    if (!width || !height) {
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        'The image reports no usable dimensions',
      );
    }

    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        `The image is too small to analyse (minimum ${MIN_DIMENSION}×${MIN_DIMENSION} pixels)`,
      );
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        `Image dimensions exceed the ${MAX_DIMENSION} pixel limit on a single side`,
      );
    }

    // The explicit bomb check. sharp's limitInputPixels also enforces this,
    // but checking here produces a comprehensible error instead of a decode
    // failure.
    const pixelCount = width * height;
    if (pixelCount > this.config.uploads.maxPixels) {
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        `The image contains too many pixels (${pixelCount.toLocaleString()}); ` +
          `the limit is ${this.config.uploads.maxPixels.toLocaleString()}`,
      );
    }

    // ── 4 & 5. Decode and re-encode ─────────────────────────────────────────
    let normalised: Buffer;
    let normalisedMeta: OutputInfo;
    try {
      const pipeline = sharp(buffer, {
        limitInputPixels: this.config.uploads.maxPixels,
        pages: 1,
        // Fail on any structural problem rather than silently repairing it:
        // a file that needs repair is not one to measure colour from.
        failOn: 'warning',
      })
        // Apply EXIF orientation before anything records coordinates, so a
        // region of interest refers to the pixels the technician actually saw.
        .rotate()
        // No .withMetadata() call here, deliberately. sharp drops metadata by
        // default on output, which is exactly what we want — EXIF can carry
        // GPS coordinates and device serial numbers. Note that
        // `.withMetadata({ exif: {} })` does NOT strip EXIF; it *preserves*
        // it, which is the opposite of the intent and was a real bug here.
        // PNG for the derivative: lossless, so re-encoding introduces no
        // compression artefacts into the colour values we are about to measure.
        .png({ compressionLevel: 6, effort: 4 });

      const result = await pipeline.toBuffer({ resolveWithObject: true });
      normalised = result.data;
      normalisedMeta = result.info;
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message },
        'Image failed to decode during normalisation',
      );
      throw ApiError.badRequest(
        ErrorCode.INVALID_IMAGE,
        'The image could not be decoded. It may be corrupt, truncated, or ' +
          'use an unsupported variant of its format.',
      );
    }

    // Trailing bytes after a valid image are a classic polyglot technique.
    // The derivative is clean regardless, but it is worth flagging.
    if (metadata.size && metadata.size < buffer.length * 0.98) {
      warnings.push(
        'The file contains data after the end of the image stream; only the ' +
          'image portion was processed.',
      );
    }

    const captureMetadata = this.extractSafeMetadata(metadata);
    if (!metadata.density && !metadata.icc) {
      // Not an error: almost no phone photo carries colour management. It
      // does bound how far colour comparisons can be trusted.
      captureMetadata.colour_management = 'absent';
    }

    return {
      original: buffer,
      normalised,
      mimeType: signature.mime,
      format: signature.format,
      // Post-rotation dimensions: these match the normalised image the AI
      // service receives, so ROI coordinates line up.
      width: normalisedMeta.width,
      height: normalisedMeta.height,
      byteSize: buffer.length,
      contentHash: createHash('sha256').update(buffer).digest('hex'),
      captureMetadata,
      warnings,
    };
  }

  /**
   * Keeps metadata that helps interpret a colour measurement and discards
   * anything that identifies a place or a device. GPS, serial numbers, owner
   * names and the raw EXIF block are never retained.
   */
  private extractSafeMetadata(metadata: Metadata): Record<string, unknown> {
    return {
      format: metadata.format,
      // Pre-rotation dimensions, for reference.
      source_width: metadata.width,
      source_height: metadata.height,
      channels: metadata.channels,
      depth: metadata.depth,
      has_alpha: metadata.hasAlpha ?? false,
      orientation_applied: metadata.orientation ?? null,
      density_dpi: metadata.density ?? null,
      colour_space: metadata.space ?? null,
      has_icc_profile: Boolean(metadata.icc),
      is_progressive: metadata.isProgressive ?? false,
    };
  }
}
