"""
The analysis pipeline — the six stages, assembled.

Stage order and rationale:

  1. decode and validate    — refuse unusable input early
  2. detect the region      — measure the solution, not the photograph
  3. extract colour         — robust statistics, not one RGB average
  4. assess quality         — informed by what the region actually contained
  5. match the reference    — transparent, inspectable colour distance
  6. model inference        — through a replaceable interface

Quality assessment runs *after* region extraction, not before, because the
most informative quality signal is how uniform the measured region was — and
that cannot be known until the region has been measured.

When quality comes back unusable the pipeline stops at `rejected_quality` and
returns the measurement without a prediction. Forcing a classification out of
an image whose colour information is gone is precisely the failure mode this
service is built to avoid.
"""
from __future__ import annotations

import math

import base64
import binascii
import logging
import time
import uuid

import cv2

from ..colorimetry.extraction import extract_features, sample_background
from ..core.config import PIPELINE_VERSION, Settings
from ..models.registry import ModelRegistry, Prediction
from ..reference_matching.matcher import ReferenceLevel
from ..schemas.analysis import (
    AnalyzeRequest,
    AnalyzeResponse,
    ColorFeaturesOut,
    ImageQualityOut,
    ModelInfoOut,
    PredictionOut,
    QualityWarningOut,
    ReferenceCandidateOut,
    ReferenceMatchOut,
    RoiOut,
)
from ..vision.quality import (
    QualityThresholds,
    Verdict,
    assess_quality,
    measure_sharpness,
)
from ..vision.roi import build_measurement_mask, detect_region
from ..vision.validation import ImageValidationError, decode_image

logger = logging.getLogger(__name__)


def _expected_hue_from_chart(levels) -> tuple[float, float] | None:
    """
    The hue the developed solution should be, taken from the chart itself.

    Returned as (centre, tolerance) in CIELAB degrees, so the region
    detector can look for the colour this assay actually produces instead of
    for whatever happens to be the most saturated thing in the photograph.

    Derived rather than hardcoded: a chart for a different analyte would
    hand back its own hue without a code change. Achromatic levels -- the
    0 ppm blank especially -- are excluded, because they have no hue to
    contribute and averaging them in would drag the centre toward nothing.

    None when the chart has too few chromatic levels to be worth trusting;
    the detector then falls back to its older strategies.
    """
    angles = []
    for level in levels:
        a = float(level.lab_a)
        b = float(level.lab_b)
        if math.hypot(a, b) < 15.0:
            continue
        angles.append(math.degrees(math.atan2(b, a)))
    if len(angles) < 3:
        return None

    # Circular mean: hue wraps, so averaging the numbers directly would put
    # the centre on the opposite side of the wheel for a hue near 180.
    mean_x = sum(math.cos(math.radians(t)) for t in angles) / len(angles)
    mean_y = sum(math.sin(math.radians(t)) for t in angles) / len(angles)
    centre = math.degrees(math.atan2(mean_y, mean_x))

    spread = max(
        abs(((t - centre + 180.0) % 360.0) - 180.0) for t in angles
    )
    # Room for the spread the chart already shows, plus the variation
    # between one photograph and the next. Capped so the window cannot
    # widen until it admits skin tones on the far side of the wheel.
    return centre, min(max(spread * 1.5, 25.0), 60.0)



class AnalysisPipeline:
    def __init__(self, registry: ModelRegistry, settings: Settings) -> None:
        self.registry = registry
        self.settings = settings
        self.thresholds = QualityThresholds()

    def run(self, request: AnalyzeRequest) -> AnalyzeResponse:
        started = time.perf_counter()
        analysis_id = str(uuid.uuid4())

        # ── Stage 1: decode ──────────────────────────────────────────────────
        try:
            raw = base64.b64decode(request.image_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ImageValidationError(
                "invalid_base64", "The image payload is not valid base64."
            ) from exc

        if len(raw) > self.settings.max_image_bytes:
            raise ImageValidationError(
                "too_large",
                f"The image is {len(raw):,} bytes, above the "
                f"{self.settings.max_image_bytes:,} limit.",
            )

        decoded = decode_image(raw, max_pixels=self.settings.max_image_pixels)

        # ── Stage 2: region of interest ──────────────────────────────────────
        manual_roi = request.roi.model_dump() if request.roi else None
        expected_hue = _expected_hue_from_chart(request.reference_levels)
        region = detect_region(decoded.rgb, manual_roi, expected_hue)
        region_pixels = region.extract(decoded.rgb)

        if region_pixels.size == 0:
            raise ImageValidationError(
                "empty_region",
                "The selected region contains no pixels.",
            )

        # ── Stage 3: colour extraction ───────────────────────────────────────
        keep_mask = build_measurement_mask(region_pixels)
        background = sample_background(
            decoded.rgb, region.x, region.y, region.width, region.height
        )

        region_gray = cv2.cvtColor(region_pixels, cv2.COLOR_RGB2GRAY)
        region_sharpness = measure_sharpness(region_gray)

        features = extract_features(
            region_pixels,
            keep_mask=keep_mask,
            background_rgb=background,
            sharpness=region_sharpness,
        )

        # ── Stage 4: quality, informed by the measured region ────────────────
        quality = assess_quality(
            decoded.rgb,
            thresholds=self.thresholds,
            region_lab_std=features.lab_spread,
            roi_confidence=region.confidence,
            has_color_reference=False,
            # Judge focus around the tube rather than inside it: a clean
            # column of solution is featureless by nature, and measuring
            # there rejected every real laboratory photograph as blurred.
            focus_region=(region.x, region.y, region.width, region.height),
        )

        limitations: list[str] = list(decoded.warnings)

        # ── Stages 5 & 6: matching and inference ─────────────────────────────
        model = self.registry.active
        model_info = model.info

        if quality.verdict is Verdict.UNUSABLE:
            # Stop here. Returning the measurement without a prediction is more
            # useful — and more honest — than a classification the image
            # cannot support.
            limitations.append(
                "No prediction was produced: image quality was insufficient for "
                "reliable colour analysis. Capture a better image and retry."
            )
            prediction = Prediction(
                label=None,
                reference_level_id=None,
                estimated_concentration=None,
                unit=None,
                confidence=None,
                match=None,
                limitations=[],
            )
            status: str = "rejected_quality"
        else:
            levels = [
                ReferenceLevel(
                    id=level.id,
                    label=level.label,
                    concentration_value=level.concentration_value,
                    concentration_unit=level.concentration_unit,
                    sort_order=level.sort_order,
                    lab_l=level.lab_l,
                    lab_a=level.lab_a,
                    lab_b=level.lab_b,
                    lab_std=level.lab_std,
                )
                for level in request.reference_levels
            ]

            prediction = model.predict(
                {
                    "lab_median": features.lab_median,
                    "lab_mean": features.lab_mean,
                    "lab_std": features.lab_std,
                    "rgb_median": features.rgb_median,
                    "hsv_median": features.hsv_median,
                    "saturation_mean": features.saturation_mean,
                    "brightness_mean": features.brightness_mean,
                },
                levels,
            )
            limitations.extend(prediction.limitations)
            status = "completed"

        # Context the reviewer needs in order to weigh the result at all.
        if request.test_method.validation_status != "VALIDATED":
            limitations.append(
                f"Test method {request.test_method.code} has validation status "
                f"{request.test_method.validation_status}."
            )
        if request.reference_chart and request.reference_chart.validation_status != "VALIDATED":
            limitations.append(
                "The reference chart used is not a validated reference "
                f"(status: {request.reference_chart.validation_status})."
            )

        match = prediction.match
        mode = (
            "reference_matching"
            if model_info.model_type == "REFERENCE_MATCHER"
            else "model_inference"
        )

        processing_ms = int((time.perf_counter() - started) * 1000)

        logger.info(
            "analysis=%s status=%s mode=%s verdict=%s roi=%s ms=%d correlation=%s",
            analysis_id,
            status,
            mode,
            quality.verdict.value,
            region.mode.value,
            processing_ms,
            request.correlation_id,
        )

        return AnalyzeResponse(
            analysis_id=analysis_id,
            status=status,  # type: ignore[arg-type]
            mode=mode,  # type: ignore[arg-type]
            image_quality=ImageQualityOut(
                usable=quality.usable,
                verdict=quality.verdict.value,
                score=quality.score,
                warnings=[
                    QualityWarningOut(
                        code=w.code,
                        severity=w.severity.value,
                        message=w.message,
                        measured_value=w.measured_value,
                        threshold=w.threshold,
                    )
                    for w in quality.warnings
                ],
                sharpness=quality.sharpness,
                mean_brightness=quality.mean_brightness,
                clipping_fraction=quality.clipping_fraction,
                contrast=quality.contrast,
            ),
            color_features=ColorFeaturesOut(
                rgb_median=features.rgb_median,
                rgb_mean=features.rgb_mean,
                rgb_std=features.rgb_std,
                hsv_median=features.hsv_median,
                lab_median=features.lab_median,
                lab_mean=features.lab_mean,
                lab_std=features.lab_std,
                lab_iqr=features.lab_iqr,
                saturation_mean=features.saturation_mean,
                brightness_mean=features.brightness_mean,
                contrast_score=features.contrast_score,
                sharpness_score=features.sharpness_score,
                clipping_fraction=features.clipping_fraction,
                background_lab=features.background_lab,
                pixel_count=features.pixel_count,
                masked_fraction=features.masked_fraction,
                color_space=features.color_space,
            ),
            roi=RoiOut(
                x=region.x,
                y=region.y,
                width=region.width,
                height=region.height,
                mode=region.mode.value,
                confidence=region.confidence,
            ),
            prediction=PredictionOut(
                label=prediction.label,
                estimated_concentration=prediction.estimated_concentration,
                unit=prediction.unit,
                confidence=prediction.confidence,
            ),
            reference_match=ReferenceMatchOut(
                reference_level_id=match.reference_level_id if match else None,
                label=match.label if match else None,
                color_distance=match.color_distance if match else None,
                alternatives=[
                    ReferenceCandidateOut(
                        reference_level_id=candidate.reference_level_id,
                        label=candidate.label,
                        concentration_value=candidate.concentration_value,
                        color_distance=candidate.color_distance,
                    )
                    for candidate in (match.alternatives if match else [])
                ],
                out_of_range=match.out_of_range if match else False,
                ambiguous=match.ambiguous if match else False,
            ),
            model=ModelInfoOut(
                name=model_info.name,
                version=model_info.version,
                validated=model_info.validated,
                model_type=model_info.model_type,
                dataset_version=model_info.dataset_version,
            ),
            limitations=list(dict.fromkeys(limitations)),
            pipeline_version=PIPELINE_VERSION,
            processing_ms=processing_ms,
            correlation_id=request.correlation_id,
        )
