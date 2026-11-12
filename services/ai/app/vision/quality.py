"""
Stage 4 — image-quality assessment.

Decides whether an image can support a colour measurement at all, and returns
structured warnings explaining what is wrong. The point is to tell a
technician to retake the photograph rather than to hand back a confident
answer derived from a blurry, blown-out image.

Every threshold here is an engineering heuristic chosen to be conservative,
not a validated specification. They are collected in QualityThresholds so a
laboratory can tune them against its own imaging setup, and so the values used
are recorded with each measurement.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class Verdict(str, Enum):
    USABLE = "usable"
    MARGINAL = "marginal"
    UNUSABLE = "unusable"


@dataclass
class QualityWarning:
    code: str
    severity: Severity
    message: str
    measured_value: float | None = None
    threshold: float | None = None


@dataclass
class QualityThresholds:
    """
    Tunable limits.

    These are starting points derived from general image-processing practice,
    not from a validation study on bromate test tubes. A laboratory with a
    controlled lighting rig should tighten them; one working with handheld
    phone photos in variable light may need to loosen them and accept more
    MARGINAL verdicts.
    """

    # Variance of the Laplacian over the SCALE-NORMALISED focus crop — see
    # `focus_score`. These were recalibrated against real photographs after the
    # originals (25 / 100, taken from general practice) rejected every genuine
    # lab photo as "badly out of focus".
    #
    # Calibrated on 18 sharp images — 4 real laboratory photographs at three
    # capture sizes, plus one synthetic tube per ladder colour — against 60
    # Gaussian-blurred controls (9/15/21/31 px) of the same images.
    #
    #     sharp   : min 0.0266   median 0.0532   max 0.3278
    #     blurred : max 0.0259   median 0.0026
    #
    # 0.012 rejects none of the 18 sharp images and catches 58 of 60 blurs.
    #
    # Two deliberate choices behind those numbers. The two mild 9px blurs that
    # slip through are tolerated: the measurement is the *median colour of a
    # uniform column*, and mild blur barely moves a median. Blur's real danger
    # here is to region detection — a soft image makes it harder to be sure
    # the measured area is a tube at all — and roi_confidence and
    # region_lab_std catch that independently.
    #
    # The margin between the sharpest blur and the softest sharp image is
    # narrow. Treat these as provisional: 4 tubes, one camera, one session.
    blur_critical: float = 0.012
    blur_warning: float = 0.030

    # Mean channel value, 0-255.
    underexposure_critical: float = 25.0
    underexposure_warning: float = 50.0
    overexposure_critical: float = 235.0
    overexposure_warning: float = 215.0

    # Fraction of pixels pinned at 0 or 255. Clipped pixels have lost their
    # colour information outright — no processing recovers it.
    clipping_critical: float = 0.25
    clipping_warning: float = 0.08

    # Standard deviation of luminance. Very low means a flat, featureless frame.
    contrast_critical: float = 8.0
    contrast_warning: float = 18.0

    # Fraction of near-white high-luminance pixels, indicating specular glare.
    glare_critical: float = 0.20
    glare_warning: float = 0.07

    # Spread of colour within the measured region. A wide spread means the
    # region is not a single uniform solution colour.
    region_uniformity_warning: float = 12.0
    region_uniformity_critical: float = 25.0


@dataclass
class QualityReport:
    usable: bool
    verdict: Verdict
    score: float
    warnings: list[QualityWarning] = field(default_factory=list)
    sharpness: float | None = None
    mean_brightness: float | None = None
    clipping_fraction: float | None = None
    contrast: float | None = None
    glare_fraction: float | None = None


def measure_sharpness(gray: NDArray[Any]) -> float:
    """
    Variance of the Laplacian — the standard cheap blur estimate.

    Accepts a loose NDArray because cv2.cvtColor's type stub returns a
    generic array; the runtime value is uint8 for 8-bit input.

    Raw and scale-dependent: the same scene photographed at higher resolution
    scores higher. Use `focus_score` for anything compared against a
    threshold; this stays for reporting a region's raw texture.
    """
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


#: How far outside the measured region to reach when judging focus, as a
#: fraction of its size.
FOCUS_PADDING = 0.35
#: Height every focus crop is resized to before measuring.
FOCUS_NORMAL_HEIGHT = 480


def focus_score(
    rgb: NDArray[np.uint8],
    region: tuple[int, int, int, int] | None = None,
) -> float:
    """
    How well focused the image is, measured where focus is actually visible.

    Returns high-frequency energy as a *fraction* of the crop's total
    variance, so the result answers "how much of this image's detail survived"
    rather than "how much detail is there", which is what makes it comparable
    between a pale blank and an opaque navy sample.

    Three corrections over a plain Laplacian variance of the frame, each of
    which came from a real image being judged wrongly:

    **Measure at the tube's edges, not inside it.** Laplacian variance
    measures high-frequency detail, and a correctly exposed column of uniform
    solution has almost none *by definition* — that is what a good sample
    looks like. Measuring there scores a perfect photo the same as a blurry
    one. The region is padded outward so the glass walls, the meniscus and
    the background boundary are inside the measured area; those edges are
    where being out of focus shows up.

    **Normalise for scale.** Laplacian variance grows with resolution, so the
    same tube shot on a 2 MP webcam and a 12 MP phone differ by an order of
    magnitude and no fixed threshold can hold for both. Resizing the crop to
    a constant height first cut the spread across a 0.35x-1.5x resolution
    range from roughly 10x to 2x.

    **Divide by the crop's own contrast.** Laplacian variance measures edge
    *energy*, which rises with contrast as well as with focus. A colourless
    0 ppm blank against a grey bench has little of either, so on the raw
    measure it scored 25 where a navy sample scored 1500 — and the blank was
    rejected as blurred. That is the one sample a bromate screen must be able
    to trust, since "no bromate detected" is the result people act on.

    `region` is (x, y, width, height); without it the whole frame is used,
    which is weaker — a tube occupying a fifth of a plain background has its
    variance diluted by all that empty space.
    """
    height, width = rgb.shape[:2]

    if region is not None:
        x, y, w, h = region
        pad_x, pad_y = int(w * FOCUS_PADDING), int(h * FOCUS_PADDING)
        crop = rgb[
            max(0, y - pad_y) : min(height, y + h + pad_y),
            max(0, x - pad_x) : min(width, x + w + pad_x),
        ]
    else:
        crop = rgb

    if crop.shape[0] < 2 or crop.shape[1] < 2:
        return 0.0

    # Downscale only. Enlarging a crop that is already smaller than the target
    # interpolates detail that was never captured, which *smooths* it and
    # pushes the score down — a small sharp photograph then scores like a
    # blurred one. Found by a test that resized a real photograph and watched
    # it cross the threshold in the wrong direction.
    if crop.shape[0] > FOCUS_NORMAL_HEIGHT:
        scale = FOCUS_NORMAL_HEIGHT / crop.shape[0]
        crop = cv2.resize(  # type: ignore[assignment]
            crop,
            (max(2, int(crop.shape[1] * scale)), FOCUS_NORMAL_HEIGHT),
            # INTER_AREA downsamples without the aliasing that would show up
            # as false "detail" and flatter a blurred image.
            interpolation=cv2.INTER_AREA,
        )

    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(np.float64)
    contrast = float(gray.var())
    # A perfectly flat crop has no contrast and no detail; it carries no
    # focus information either way, so report 0 rather than dividing by ~0.
    if contrast < 1e-6:
        return 0.0
    return measure_sharpness(gray) / contrast


def measure_clipping(rgb: NDArray[np.uint8]) -> float:
    """Fraction of pixels with any channel at 0 or 255."""
    at_floor = (rgb == 0).any(axis=-1)
    at_ceiling = (rgb == 255).any(axis=-1)
    return float((at_floor | at_ceiling).mean())


def measure_glare(rgb: NDArray[np.uint8]) -> float:
    """
    Fraction of pixels that look like specular reflection: very bright and
    nearly colourless. Glass tubes produce exactly this, and those pixels
    carry the light source's colour rather than the solution's.
    """
    arr = rgb.astype(np.float64)
    luminance = arr @ np.array([0.2126, 0.7152, 0.0722])
    saturation_proxy = arr.max(axis=-1) - arr.min(axis=-1)
    return float(((luminance > 240) & (saturation_proxy < 20)).mean())


def assess_quality(
    rgb: NDArray[np.uint8],
    thresholds: QualityThresholds | None = None,
    region_lab_std: float | None = None,
    roi_confidence: float | None = None,
    has_color_reference: bool = False,
    focus_region: tuple[int, int, int, int] | None = None,
) -> QualityReport:
    """
    Produce a quality verdict for an image, optionally informed by the region
    that was measured.

    `region_lab_std` is the colour spread inside the measured region. A high
    value means the region contained more than one thing — tube edge,
    background, label — so the median colour is not a solution colour.

    `has_color_reference` records whether a known colour standard appeared in
    the frame. Without one there is no way to correct for the light source, and
    that is reported as an informational warning on every image because it
    bounds how far any colour comparison can be trusted.
    """
    thresholds = thresholds or QualityThresholds()
    warnings: list[QualityWarning] = []

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    # Focus is judged on the padded, scale-normalised crop around the region;
    # exposure and colour below stay on the frame as given.
    sharpness = focus_score(rgb, focus_region)
    mean_brightness = float(gray.mean())
    contrast = float(gray.std())
    clipping = measure_clipping(rgb)
    glare = measure_glare(rgb)

    # ── Focus ────────────────────────────────────────────────────────────────
    if sharpness < thresholds.blur_critical:
        warnings.append(
            QualityWarning(
                "blur",
                Severity.CRITICAL,
                "The image is badly out of focus. Retake it with the tube in "
                "sharp focus.",
                round(sharpness, 2),
                thresholds.blur_critical,
            )
        )
    elif sharpness < thresholds.blur_warning:
        warnings.append(
            QualityWarning(
                "soft_focus",
                Severity.WARNING,
                "The image is soft. A sharper photograph would give a more "
                "reliable measurement.",
                round(sharpness, 2),
                thresholds.blur_warning,
            )
        )

    # ── Exposure ─────────────────────────────────────────────────────────────
    if mean_brightness < thresholds.underexposure_critical:
        warnings.append(
            QualityWarning(
                "severe_underexposure",
                Severity.CRITICAL,
                "The image is far too dark to measure colour. Add light and "
                "retake it.",
                round(mean_brightness, 2),
                thresholds.underexposure_critical,
            )
        )
    elif mean_brightness < thresholds.underexposure_warning:
        warnings.append(
            QualityWarning(
                "underexposure",
                Severity.WARNING,
                "The image is dark, which compresses colour differences.",
                round(mean_brightness, 2),
                thresholds.underexposure_warning,
            )
        )
    elif mean_brightness > thresholds.overexposure_critical:
        warnings.append(
            QualityWarning(
                "severe_overexposure",
                Severity.CRITICAL,
                "The image is far too bright; colour information has been lost.",
                round(mean_brightness, 2),
                thresholds.overexposure_critical,
            )
        )
    elif mean_brightness > thresholds.overexposure_warning:
        warnings.append(
            QualityWarning(
                "overexposure",
                Severity.WARNING,
                "The image is bright, which washes out colour differences.",
                round(mean_brightness, 2),
                thresholds.overexposure_warning,
            )
        )

    # ── Clipping ─────────────────────────────────────────────────────────────
    if clipping > thresholds.clipping_critical:
        warnings.append(
            QualityWarning(
                "severe_clipping",
                Severity.CRITICAL,
                f"{clipping:.0%} of pixels are fully black or fully white. "
                "Their colour cannot be recovered.",
                round(clipping, 4),
                thresholds.clipping_critical,
            )
        )
    elif clipping > thresholds.clipping_warning:
        warnings.append(
            QualityWarning(
                "color_clipping",
                Severity.WARNING,
                f"{clipping:.0%} of pixels are clipped at black or white.",
                round(clipping, 4),
                thresholds.clipping_warning,
            )
        )

    # ── Contrast ─────────────────────────────────────────────────────────────
    if contrast < thresholds.contrast_critical:
        warnings.append(
            QualityWarning(
                "very_low_contrast",
                Severity.CRITICAL,
                "The image is almost featureless; the tube cannot be "
                "distinguished from the background.",
                round(contrast, 2),
                thresholds.contrast_critical,
            )
        )
    elif contrast < thresholds.contrast_warning:
        warnings.append(
            QualityWarning(
                "low_contrast",
                Severity.WARNING,
                "Low contrast between the sample and its background.",
                round(contrast, 2),
                thresholds.contrast_warning,
            )
        )

    # ── Glare ────────────────────────────────────────────────────────────────
    if glare > thresholds.glare_critical:
        warnings.append(
            QualityWarning(
                "severe_glare",
                Severity.CRITICAL,
                "Strong reflections cover much of the image. Those pixels show "
                "the light source, not the solution.",
                round(glare, 4),
                thresholds.glare_critical,
            )
        )
    elif glare > thresholds.glare_warning:
        warnings.append(
            QualityWarning(
                "glare",
                Severity.WARNING,
                "Reflections are visible on the glass. Diffuse the lighting if "
                "possible.",
                round(glare, 4),
                thresholds.glare_warning,
            )
        )

    # ── Region uniformity ────────────────────────────────────────────────────
    if region_lab_std is not None:
        if region_lab_std > thresholds.region_uniformity_critical:
            warnings.append(
                QualityWarning(
                    "non_uniform_region",
                    Severity.CRITICAL,
                    "The measured region contains widely varying colours, so it "
                    "probably includes more than just the solution.",
                    round(region_lab_std, 2),
                    thresholds.region_uniformity_critical,
                )
            )
        elif region_lab_std > thresholds.region_uniformity_warning:
            warnings.append(
                QualityWarning(
                    "variable_region",
                    Severity.WARNING,
                    "Colour varies noticeably across the measured region.",
                    round(region_lab_std, 2),
                    thresholds.region_uniformity_warning,
                )
            )

    # ── Region confidence ────────────────────────────────────────────────────
    if roi_confidence is not None and roi_confidence < 0.4:
        warnings.append(
            QualityWarning(
                "uncertain_boundaries",
                Severity.WARNING,
                "The sample boundary could not be identified confidently. "
                "Select the region manually for a more reliable result.",
                round(roi_confidence, 3),
                0.4,
            )
        )

    # ── Colour reference ─────────────────────────────────────────────────────
    # Always reported when absent. This is the single biggest limitation on
    # comparing colours across devices and lighting, and it should not be
    # silent just because it is the normal case.
    if not has_color_reference:
        warnings.append(
            QualityWarning(
                "missing_calibration",
                Severity.INFO,
                "No colour reference was present in the frame, so the image "
                "could not be corrected for the light source. Colour values "
                "are device- and lighting-dependent.",
                None,
                None,
            )
        )

    verdict, score = _summarise(warnings)

    return QualityReport(
        usable=verdict is not Verdict.UNUSABLE,
        verdict=verdict,
        score=score,
        warnings=warnings,
        sharpness=round(sharpness, 4),
        mean_brightness=round(mean_brightness, 2),
        clipping_fraction=round(clipping, 4),
        contrast=round(contrast, 2),
        glare_fraction=round(glare, 4),
    )


def _summarise(warnings: list[QualityWarning]) -> tuple[Verdict, float]:
    """
    Reduce the warnings to a verdict and a 0-1 score.

    Any CRITICAL warning makes the image unusable — these are conditions where
    the colour information is genuinely gone, not merely degraded. The score is
    an ordinal summary for display; it is not a probability and should not be
    treated as one.
    """
    critical = sum(1 for w in warnings if w.severity is Severity.CRITICAL)
    warning = sum(1 for w in warnings if w.severity is Severity.WARNING)

    if critical > 0:
        # Several critical problems should not score the same as one.
        return Verdict.UNUSABLE, round(max(0.0, 0.25 - 0.05 * critical), 4)

    if warning >= 3:
        return Verdict.MARGINAL, 0.45
    if warning == 2:
        return Verdict.MARGINAL, 0.6
    if warning == 1:
        return Verdict.USABLE, 0.8

    return Verdict.USABLE, 0.95
