"""
Stage 3 — colour feature extraction.

Reduces a masked region of pixels to a set of colour statistics.

Two deliberate choices:

  • **Median, not mean.** A single specular highlight or one dark edge pixel
    shifts a mean noticeably; the median barely moves. Glass tubes guarantee
    both. The mean is still recorded, because a large gap between mean and
    median is itself evidence the region was not uniform.

  • **Statistics, not a single value.** A lone RGB triple cannot tell you
    whether the region was a clean solution colour or a mixture of tube, label
    and background. The spread (standard deviation, IQR) is what makes that
    visible, and it feeds directly into the quality assessment.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.typing import NDArray

from .conversion import rgb_to_hsv, rgb_to_lab


@dataclass
class ColorFeatures:
    """Measured colour statistics for one region."""

    rgb_median: list[float]
    rgb_mean: list[float]
    rgb_std: list[float]
    hsv_median: list[float]
    lab_median: list[float]
    lab_mean: list[float]
    lab_std: list[float]
    lab_iqr: list[float]

    saturation_mean: float
    brightness_mean: float
    contrast_score: float | None
    sharpness_score: float | None
    clipping_fraction: float

    background_lab: list[float] | None

    pixel_count: int
    masked_fraction: float
    color_space: str = "sRGB"

    extraction_config: dict = field(default_factory=dict)

    @property
    def lab_spread(self) -> float:
        """
        Overall colour spread in the region, as the norm of the per-channel
        standard deviations. Feeds the region-uniformity quality check.
        """
        return float(np.linalg.norm(self.lab_std))


def extract_features(
    region_rgb: NDArray[np.uint8],
    keep_mask: NDArray[np.bool_] | None = None,
    background_rgb: NDArray[np.uint8] | None = None,
    sharpness: float | None = None,
) -> ColorFeatures:
    """
    Compute colour statistics over the kept pixels of a region.

    `keep_mask` marks pixels to include (see roi.build_measurement_mask).
    `background_rgb` is an optional sample of the area outside the region; its
    Lab value is recorded as illumination context, not used to correct the
    measurement — correcting against an unknown surface would invent precision
    that is not there.
    """
    if region_rgb.size == 0:
        raise ValueError("Cannot extract colour features from an empty region.")

    total_pixels = int(region_rgb.shape[0] * region_rgb.shape[1])

    if keep_mask is None:
        keep_mask = np.ones(region_rgb.shape[:2], dtype=bool)

    pixels = region_rgb[keep_mask].astype(np.float64)
    if pixels.size == 0:
        pixels = region_rgb.reshape(-1, 3).astype(np.float64)

    kept_count = int(pixels.shape[0])
    masked_fraction = (
        float(1.0 - kept_count / total_pixels) if total_pixels > 0 else 0.0
    )

    # ── RGB ──────────────────────────────────────────────────────────────────
    rgb_median = np.median(pixels, axis=0)
    rgb_mean = pixels.mean(axis=0)
    rgb_std = pixels.std(axis=0)

    # ── Lab ──────────────────────────────────────────────────────────────────
    # Converted per pixel then aggregated, not aggregated then converted:
    # the sRGB transfer function is non-linear, so the two differ, and the
    # per-pixel route is the one that reflects what was actually photographed.
    lab_pixels = rgb_to_lab(pixels)
    lab_median = np.median(lab_pixels, axis=0)
    lab_mean = lab_pixels.mean(axis=0)
    lab_std = lab_pixels.std(axis=0)

    q1 = np.percentile(lab_pixels, 25, axis=0)
    q3 = np.percentile(lab_pixels, 75, axis=0)
    lab_iqr = q3 - q1

    # ── HSV ──────────────────────────────────────────────────────────────────
    hsv_pixels = rgb_to_hsv(pixels)
    # Hue is circular, so a plain median is wrong near the 0°/360° wrap.
    hue_median = _circular_median(hsv_pixels[..., 0])
    hsv_median = np.array(
        [
            hue_median,
            float(np.median(hsv_pixels[..., 1])),
            float(np.median(hsv_pixels[..., 2])),
        ]
    )

    # ── Clipping within the region ───────────────────────────────────────────
    region_flat = region_rgb.reshape(-1, 3)
    clipping = float(
        ((region_flat == 0).any(axis=-1) | (region_flat == 255).any(axis=-1)).mean()
    )

    # ── Background context ───────────────────────────────────────────────────
    background_lab: list[float] | None = None
    if background_rgb is not None and background_rgb.size > 0:
        background_pixels = background_rgb.reshape(-1, 3).astype(np.float64)
        background_median = np.median(background_pixels, axis=0)
        background_lab = [round(float(v), 4) for v in rgb_to_lab(background_median)]

    contrast = float(lab_pixels[..., 0].std()) if kept_count > 1 else None

    return ColorFeatures(
        rgb_median=[round(float(v), 3) for v in rgb_median],
        rgb_mean=[round(float(v), 3) for v in rgb_mean],
        rgb_std=[round(float(v), 3) for v in rgb_std],
        hsv_median=[round(float(v), 3) for v in hsv_median],
        lab_median=[round(float(v), 4) for v in lab_median],
        lab_mean=[round(float(v), 4) for v in lab_mean],
        lab_std=[round(float(v), 4) for v in lab_std],
        lab_iqr=[round(float(v), 4) for v in lab_iqr],
        saturation_mean=round(float(hsv_pixels[..., 1].mean()), 4),
        brightness_mean=round(float(hsv_pixels[..., 2].mean()), 4),
        contrast_score=round(contrast, 4) if contrast is not None else None,
        sharpness_score=round(sharpness, 4) if sharpness is not None else None,
        clipping_fraction=round(clipping, 5),
        background_lab=background_lab,
        pixel_count=kept_count,
        masked_fraction=round(masked_fraction, 5),
        extraction_config={
            "aggregation": "per_pixel_lab_then_median",
            "masking": "specular_clipping_iqr",
            "hue_aggregation": "circular_median",
            "color_space": "sRGB",
            "illuminant_assumed": "D65",
        },
    )


def _circular_median(hues_degrees: NDArray[np.float64]) -> float:
    """
    Median of circular (hue) data.

    A plain median of [359°, 1°, 2°] gives 2°, when the answer should be about
    0.7°. Converting to unit vectors, averaging, and converting back handles
    the wrap correctly.
    """
    if hues_degrees.size == 0:
        return 0.0

    radians = np.radians(hues_degrees)
    mean_vector = np.array([np.cos(radians).mean(), np.sin(radians).mean()])

    # A near-zero resultant means hues are spread right around the circle, so
    # no single value represents them. Fall back to the plain median rather
    # than returning an arbitrary angle.
    if np.linalg.norm(mean_vector) < 1e-9:
        return float(np.median(hues_degrees))

    return float(np.degrees(np.arctan2(mean_vector[1], mean_vector[0])) % 360.0)


def sample_background(
    rgb: NDArray[np.uint8],
    region_x: int,
    region_y: int,
    region_width: int,
    region_height: int,
    border: int = 20,
) -> NDArray[np.uint8] | None:
    """
    Sample a thin frame of pixels just outside the measured region.

    Recorded as illumination context: a strongly tinted background suggests a
    coloured light source, which bounds how far the measured colour can be
    compared against a reference captured elsewhere.
    """
    height, width = rgb.shape[:2]

    outer_x0 = max(0, region_x - border)
    outer_y0 = max(0, region_y - border)
    outer_x1 = min(width, region_x + region_width + border)
    outer_y1 = min(height, region_y + region_height + border)

    outer = rgb[outer_y0:outer_y1, outer_x0:outer_x1]
    if outer.size == 0:
        return None

    # Blank out the region itself, leaving only the surrounding frame.
    mask = np.ones(outer.shape[:2], dtype=bool)
    inner_x0 = region_x - outer_x0
    inner_y0 = region_y - outer_y0
    mask[
        inner_y0 : inner_y0 + region_height,
        inner_x0 : inner_x0 + region_width,
    ] = False

    background = outer[mask]
    return background if background.size > 0 else None
