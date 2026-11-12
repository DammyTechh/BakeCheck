"""
Stage 2 — region-of-interest detection.

Finds the liquid column inside a test tube. This matters more than it sounds:
a photograph of a test tube is mostly *not* solution — it is background, glass,
labels, the rack, the technician's hand. Measuring the whole frame would
produce a colour that is a weighted average of all of it.

Three strategies, in order of preference:

  1. MANUAL_SELECTION — the operator drew a box. Always wins; a human looking
     at the tube is better than any heuristic here.
  2. AUTO_TUBE_DETECTION — find a vertical, roughly rectangular region whose
     colour differs from the background.
  3. CENTER_FALLBACK — a central crop, reported with low confidence.

The fallback never pretends to have found a tube. It returns
CENTER_FALLBACK with a low confidence so the caller can warn the user.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import cv2
import numpy as np
from numpy.typing import NDArray


class RoiMode(str, Enum):
    AUTO = "AUTO_TUBE_DETECTION"
    MANUAL = "MANUAL_SELECTION"
    FALLBACK = "CENTER_FALLBACK"


@dataclass
class Region:
    x: int
    y: int
    width: int
    height: int
    mode: RoiMode
    confidence: float | None

    def clamp(self, image_width: int, image_height: int) -> Region:
        """Keep the region inside the image, preserving at least one pixel."""
        x = max(0, min(self.x, image_width - 1))
        y = max(0, min(self.y, image_height - 1))
        width = max(1, min(self.width, image_width - x))
        height = max(1, min(self.height, image_height - y))
        return Region(x, y, width, height, self.mode, self.confidence)

    def extract(self, rgb: NDArray[np.uint8]) -> NDArray[np.uint8]:
        return rgb[self.y : self.y + self.height, self.x : self.x + self.width]


def detect_region(
    rgb: NDArray[np.uint8],
    manual: dict | None = None,
) -> Region:
    """Resolve the region to measure, trying each strategy in turn."""
    height, width = rgb.shape[:2]

    if manual:
        return Region(
            x=int(manual["x"]),
            y=int(manual["y"]),
            width=int(manual["width"]),
            height=int(manual["height"]),
            mode=RoiMode.MANUAL,
            confidence=1.0,
        ).clamp(width, height)

    # Saturation first: it is the most reliable signal when the solution is
    # coloured, which is the common case.
    detected = _detect_tube(rgb)

    # A colourless solution (a 0 ppm blank) has almost no saturation, so the
    # first strategy cannot see it at all. Fall back to finding whatever
    # differs from the dominant background colour, which still picks up the
    # glass and the liquid column by lightness alone.
    if detected is None:
        detected = _detect_tube_by_background_contrast(rgb)

    if detected is not None:
        return detected.clamp(width, height)

    return _centre_fallback(width, height)


def _detect_tube(rgb: NDArray[np.uint8]) -> Region | None:
    """
    Look for a tall, narrow region of saturated colour against a plainer
    background.

    Works on saturation rather than brightness: a test tube of coloured
    solution is more saturated than a lab bench, a white background or a sheet
    of paper, and saturation is far less sensitive to the exposure differences
    between one photograph and the next than lightness is.

    Returns None when nothing convincing is found — the caller then falls back
    rather than accepting a bad guess.
    """
    height, width = rgb.shape[:2]

    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    saturation = hsv[..., 1]
    value = hsv[..., 2]

    # Otsu picks the saturation threshold from this image's own histogram,
    # rather than a fixed constant that would only suit one lighting setup.
    _, mask = cv2.threshold(saturation, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Drop near-black and blown-out pixels: both have unreliable hue, and both
    # are common at tube edges.
    mask[(value < 25) | (value > 250)] = 0

    # Close small gaps (glare speckles inside the liquid), then erode away
    # thin fringes at the glass boundary.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    image_area = float(width * height)
    best: tuple[float, Region] | None = None

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = float(w * h)

        # Reject specks and anything that fills the frame — neither is a tube.
        area_fraction = area / image_area
        if area_fraction < 0.01 or area_fraction > 0.90:
            continue

        aspect = h / max(w, 1)
        # A tube's liquid column is taller than it is wide. Allow a generous
        # range: tubes get photographed at an angle and partially filled.
        if aspect < 0.8:
            continue

        # How much of the bounding box the contour actually fills. A real
        # liquid column is close to a filled rectangle; a ragged background
        # blob is not.
        fill_ratio = cv2.contourArea(contour) / max(area, 1.0)
        if fill_ratio < 0.55:
            continue

        # Prefer well-filled, plausibly proportioned, reasonably large regions.
        aspect_score = min(aspect / 3.0, 1.0)
        score = fill_ratio * 0.5 + aspect_score * 0.3 + min(area_fraction * 2, 1.0) * 0.2

        if best is None or score > best[0]:
            # Inset the box to stay clear of the glass wall and the meniscus,
            # which are the two places most likely to contaminate the colour.
            inset_x = max(1, int(w * 0.18))
            inset_y = max(1, int(h * 0.12))
            best = (
                score,
                Region(
                    x=x + inset_x,
                    y=y + inset_y,
                    width=max(1, w - 2 * inset_x),
                    height=max(1, h - 2 * inset_y),
                    mode=RoiMode.AUTO,
                    confidence=round(min(score, 1.0), 3),
                ),
            )

    if best is None:
        return None

    # Below this the detection is not worth more than the central fallback.
    if best[0] < 0.35:
        return None

    return best[1]


def _detect_tube_by_background_contrast(rgb: NDArray[np.uint8]) -> Region | None:
    """
    Find a tube that differs from the background in *lightness* rather than
    saturation.

    Needed for colourless solutions — a 0 ppm blank is a legitimate and
    important measurement, and the saturation-based detector is blind to it.
    Here the dominant colour around the frame border is taken as the
    background, and pixels far from it in CIELAB are treated as foreground.

    Deliberately runs second: when the solution *is* coloured, the saturation
    route gives a tighter region, because this one also picks up the glass.
    """
    height, width = rgb.shape[:2]

    # Estimate the background from the frame border, which is the part least
    # likely to contain the tube.
    border = max(4, min(width, height) // 20)
    border_pixels = np.concatenate(
        [
            rgb[:border].reshape(-1, 3),
            rgb[-border:].reshape(-1, 3),
            rgb[:, :border].reshape(-1, 3),
            rgb[:, -border:].reshape(-1, 3),
        ]
    ).astype(np.float64)

    if border_pixels.size == 0:
        return None

    background = np.median(border_pixels, axis=0)

    # Distance from the background, in a perceptually sensible space. Lab via
    # OpenCV is enough here — this is a segmentation threshold, not a
    # measurement, so the precision of our own converter is not needed.
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float64)
    background_lab = cv2.cvtColor(
        background.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB
    ).astype(np.float64).reshape(3)

    distance = np.linalg.norm(lab - background_lab, axis=-1)

    # Otsu on the distance map, so the threshold adapts to the image rather
    # than being a constant that suits only one lighting setup.
    # cv2.normalize accepts dst=None at runtime; its type stub has no
    # overload for it, so the result is annotated explicitly.
    normalised: NDArray[np.uint8] = cv2.normalize(  # type: ignore[call-overload]
        distance, None, 0, 255, cv2.NORM_MINMAX
    ).astype(np.uint8)
    _, mask = cv2.threshold(normalised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    image_area = float(width * height)
    best: tuple[float, Region] | None = None

    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area_fraction = (w * h) / image_area

        if area_fraction < 0.02 or area_fraction > 0.95:
            continue

        aspect = h / max(w, 1)
        if aspect < 0.8:
            continue

        fill_ratio = cv2.contourArea(contour) / max(float(w * h), 1.0)
        if fill_ratio < 0.5:
            continue

        score = fill_ratio * 0.5 + min(aspect / 3.0, 1.0) * 0.3 + min(area_fraction * 2, 1.0) * 0.2

        if best is None or score > best[0]:
            # A larger inset than the saturation route: this contour includes
            # the glass wall, so more must be trimmed to reach the liquid.
            inset_x = max(2, int(w * 0.26))
            # Trim the top harder — the upper part of a tube is usually air.
            inset_top = max(2, int(h * 0.34))
            inset_bottom = max(2, int(h * 0.10))

            region_height = h - inset_top - inset_bottom
            if region_height < 8:
                continue

            best = (
                score,
                Region(
                    x=x + inset_x,
                    y=y + inset_top,
                    width=max(1, w - 2 * inset_x),
                    height=region_height,
                    mode=RoiMode.AUTO,
                    # Capped below the saturation route's confidence: this
                    # strategy is the weaker signal and should be reported as
                    # such.
                    confidence=round(min(score, 1.0) * 0.7, 3),
                ),
            )

    if best is None or best[0] < 0.35:
        return None

    return best[1]


def _centre_fallback(width: int, height: int) -> Region:
    """
    A central crop, when detection fails.

    Reported with low confidence and its own mode so the caller can tell the
    user that no tube was found and a manual selection would be better.
    """
    box_width = max(1, int(width * 0.25))
    box_height = max(1, int(height * 0.35))
    return Region(
        x=(width - box_width) // 2,
        y=(height - box_height) // 2,
        width=box_width,
        height=box_height,
        mode=RoiMode.FALLBACK,
        confidence=0.2,
    )


def build_measurement_mask(region_rgb: NDArray[np.uint8]) -> NDArray[np.bool_]:
    """
    Mask out pixels inside the region that should not contribute to the colour.

    Removes:
      • specular highlights — bright and nearly colourless, these show the
        light source rather than the solution;
      • fully clipped pixels, whose colour is unrecoverable;
      • statistical outliers in lightness, which catches tube edges and
        bubbles that survived the inset.

    Returns a boolean mask of pixels to KEEP. If masking would remove almost
    everything, it gives up and keeps all pixels — a measurement over the whole
    region with a warning is more useful than no measurement at all.
    """
    arr = region_rgb.astype(np.float64)

    luminance = arr @ np.array([0.2126, 0.7152, 0.0722])
    chroma_range = arr.max(axis=-1) - arr.min(axis=-1)

    keep = np.ones(region_rgb.shape[:2], dtype=bool)

    # Specular highlights.
    keep &= ~((luminance > 235) & (chroma_range < 25))

    # Clipped pixels.
    keep &= ~(region_rgb == 0).all(axis=-1)
    keep &= ~(region_rgb == 255).all(axis=-1)

    # Lightness outliers, via the interquartile range. Robust to the skewed
    # distributions that glare and shadows produce.
    if keep.sum() > 50:
        kept_luminance = luminance[keep]
        q1, q3 = np.percentile(kept_luminance, [25, 75])
        iqr = q3 - q1
        if iqr > 1e-6:
            lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            keep &= (luminance >= lower) & (luminance <= upper)

    # Never mask away the measurement entirely.
    if keep.sum() < max(25, 0.1 * keep.size):
        return np.ones(region_rgb.shape[:2], dtype=bool)

    return keep
