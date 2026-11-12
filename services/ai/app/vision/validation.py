"""
Stage 1 — image decoding and validation.

Runs before anything measures a pixel. The job is to reject input that cannot
support a colour measurement, and to do so with a reason the technician can
act on ("the image is out of focus") rather than a generic failure.

Decoding is done with Pillow under explicit limits rather than handing bytes
straight to OpenCV, because Pillow surfaces malformed input as an exception
instead of returning a partially decoded array.
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageOps, UnidentifiedImageError

# Pillow's own decompression-bomb guard. Set explicitly rather than relying on
# the library default, which changes between versions.
Image.MAX_IMAGE_PIXELS = 50_000_000

SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}

MIN_DIMENSION = 64
MAX_DIMENSION = 20_000


class ImageValidationError(ValueError):
    """Raised when input cannot be used at all. Carries a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class DecodedImage:
    """A decoded, orientation-corrected RGB image plus what we know about it."""

    rgb: NDArray[np.uint8]
    """Shape (H, W, 3), uint8, sRGB, EXIF rotation already applied."""

    width: int
    height: int
    source_format: str
    had_alpha: bool
    orientation_applied: int | None
    warnings: list[str] = field(default_factory=list)

    @property
    def pixel_count(self) -> int:
        return self.width * self.height


def decode_image(data: bytes, max_pixels: int = 50_000_000) -> DecodedImage:
    """
    Decode image bytes into an RGB array.

    Raises ImageValidationError for anything unusable. Never returns a
    partially decoded result — a half-decoded image would produce a colour
    measurement that looks valid and is not.
    """
    if not data:
        raise ImageValidationError("empty_input", "No image data was supplied.")

    try:
        buffer = io.BytesIO(data)
        with Image.open(buffer) as probe:
            source_format = (probe.format or "UNKNOWN").upper()

            if source_format not in SUPPORTED_FORMATS:
                raise ImageValidationError(
                    "unsupported_format",
                    f"{source_format} is not supported. Use JPEG, PNG or WebP.",
                )

            width, height = probe.size
            if width * height > max_pixels:
                raise ImageValidationError(
                    "too_many_pixels",
                    f"The image has {width * height:,} pixels, above the "
                    f"{max_pixels:,} limit.",
                )

            # verify() checks structural integrity but consumes the file
            # object, so the image must be reopened afterwards to read pixels.
            probe.verify()

        buffer.seek(0)
        with Image.open(buffer) as opened:
            image: Image.Image = opened
            had_alpha = image.mode in ("RGBA", "LA", "PA")
            orientation = _exif_orientation(image)

            # Apply EXIF rotation before anything records coordinates, so a
            # region of interest refers to the same pixels the user saw.
            image = ImageOps.exif_transpose(image)

            if image.mode != "RGB":
                # Alpha is composited onto white rather than dropped: dropping
                # it would let transparent pixels read as pure black and drag
                # the median colour down.
                if had_alpha:
                    background = Image.new("RGB", image.size, (255, 255, 255))
                    background.paste(image, mask=image.split()[-1])
                    image = background
                else:
                    image = image.convert("RGB")

            rgb = np.asarray(image, dtype=np.uint8)

    except ImageValidationError:
        raise
    except UnidentifiedImageError as exc:
        raise ImageValidationError(
            "undecodable",
            "The file could not be read as an image.",
        ) from exc
    except Image.DecompressionBombError as exc:
        raise ImageValidationError(
            "decompression_bomb",
            "The image expands to an unreasonable size and was rejected.",
        ) from exc
    except OSError as exc:
        # Pillow raises OSError for truncated files.
        raise ImageValidationError(
            "corrupt_image",
            "The image appears to be corrupt or truncated.",
        ) from exc

    height, width = rgb.shape[:2]

    if width < MIN_DIMENSION or height < MIN_DIMENSION:
        raise ImageValidationError(
            "too_small",
            f"The image is {width}×{height}; at least "
            f"{MIN_DIMENSION}×{MIN_DIMENSION} is needed.",
        )
    if width > MAX_DIMENSION or height > MAX_DIMENSION:
        raise ImageValidationError(
            "too_large",
            f"A single side exceeds the {MAX_DIMENSION} pixel limit.",
        )

    warnings: list[str] = []
    if had_alpha:
        warnings.append(
            "The image had an alpha channel; it was composited onto white "
            "before measurement."
        )

    return DecodedImage(
        rgb=rgb,
        width=width,
        height=height,
        source_format=source_format,
        had_alpha=had_alpha,
        orientation_applied=orientation,
        warnings=warnings,
    )


def _exif_orientation(image: Image.Image) -> int | None:
    """Read the EXIF orientation tag (0x0112), if present."""
    try:
        exif = image.getexif()
        return exif.get(0x0112) if exif else None
    except Exception:
        return None
