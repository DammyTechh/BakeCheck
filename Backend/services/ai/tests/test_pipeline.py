"""
End-to-end pipeline behaviour.

The assertions that matter here are not "does it return 200" but:

  • does it measure the colour that was actually in the tube?
  • does it refuse images it cannot measure, instead of guessing?
  • does it keep `estimated_concentration` and `confidence` null in
    prototype mode?

That last one is the single most important property in this service. A
regression that starts emitting a concentration from an illustrative chart
would be invisible in ordinary use and seriously misleading in a laboratory.
"""
from __future__ import annotations

import base64

import numpy as np
import pytest

from app.colorimetry.conversion import delta_e_2000, rgb_to_lab
from app.core.config import Settings
from app.models.registry import ModelRegistry, ReferenceMatcherModel
from app.schemas.analysis import AnalyzeRequest, ReferenceLevelInput
# Aliased: a name starting with `Test` would otherwise be collected by pytest
# as a test class, which it is not — it is a Pydantic request schema.
from app.schemas.analysis import TestMethodInput as MethodInput
from app.services.pipeline import AnalysisPipeline
from app.vision.validation import ImageValidationError

from conftest import BROMATE_LADDER_RGB, encode_png, make_tube_image


@pytest.fixture
def pipeline(tmp_path) -> AnalysisPipeline:
    settings = Settings(
        AI_INTERNAL_KEY="test-internal-key-0123456789abcdef",
        AI_ARTIFACT_DIR=tmp_path / "artifacts",
    )
    return AnalysisPipeline(ModelRegistry(settings.artifact_dir), settings)


def build_request(
    image_bytes: bytes,
    levels,
    roi: dict | None = None,
    method_status: str = "DRAFT",
) -> AnalyzeRequest:
    return AnalyzeRequest(
        imageBase64=base64.b64encode(image_bytes).decode("ascii"),
        mimeType="image/png",
        roi=roi,
        referenceLevels=[
            ReferenceLevelInput(
                id=level.id,
                label=level.label,
                concentrationValue=level.concentration_value,
                concentrationUnit=level.concentration_unit,
                sortOrder=level.sort_order,
                labL=level.lab_l,
                labA=level.lab_a,
                labB=level.lab_b,
                labStd=level.lab_std,
            )
            for level in levels
        ],
        testMethod=MethodInput(
            id="method-1",
            code="BROMATE-COLOUR-SCREEN",
            version="0.1.0-prototype",
            concentrationUnit="ppm",
            validationStatus=method_status,
        ),
        referenceChart=None,
        correlationId="11111111-2222-4333-8444-555555555555",
    )


class TestHappyPath:
    def test_measures_the_colour_that_was_in_the_tube(self, pipeline, reference_levels):
        """
        A tube filled with the 0.5 ppm reference colour must measure close to
        that colour. This is the core correctness claim of the whole service.
        """
        target_rgb = (120, 207, 247)
        image = encode_png(make_tube_image(target_rgb))

        response = pipeline.run(build_request(image, reference_levels))

        assert response.status == "completed"
        assert response.color_features is not None

        measured_lab = np.array(response.color_features.lab_median)
        expected_lab = rgb_to_lab(np.array(target_rgb, dtype=np.float64))

        # Rendering, PNG encoding and masking introduce a little drift; a few
        # ΔE is expected, a large gap would mean the wrong pixels were measured.
        assert delta_e_2000(measured_lab, expected_lab) < 5.0

    def test_matches_the_correct_reference_level(self, pipeline, reference_levels):
        """Each ladder colour must match its own level, not a neighbour."""
        for index, (label, _, rgb) in enumerate(BROMATE_LADDER_RGB):
            image = encode_png(make_tube_image(rgb))
            response = pipeline.run(build_request(image, reference_levels))

            assert response.status == "completed", label
            assert response.reference_match.label == label, (
                f"{label} matched {response.reference_match.label} instead"
            )
            assert response.reference_match.reference_level_id == f"level-{index}"

    def test_finds_the_tube_automatically(self, pipeline, reference_levels):
        image = encode_png(make_tube_image((1, 132, 241)))
        response = pipeline.run(build_request(image, reference_levels))

        assert response.roi.mode == "AUTO_TUBE_DETECTION"
        assert response.roi.confidence is not None and response.roi.confidence > 0.3
        # The region must be a real subset of the frame, not the whole image.
        assert response.roi.width < 400
        assert response.roi.height < 700

    def test_detects_a_colourless_tube(self, pipeline, reference_levels):
        """
        A 0 ppm blank has almost no saturation, so the primary (saturation-
        based) detector cannot see it. The background-contrast fallback must
        pick it up — a blank is a legitimate and important measurement, not an
        edge case to shrug at.
        """
        image = encode_png(make_tube_image((240, 240, 240)))
        response = pipeline.run(build_request(image, reference_levels))

        assert response.roi.mode == "AUTO_TUBE_DETECTION"
        assert response.reference_match.label == "Chart patch 1 — near-white"

    def test_colourless_tube_on_white_is_rejected_not_guessed(
        self, pipeline, reference_levels
    ):
        """
        A colourless solution photographed against a white background is
        genuinely unmeasurable — there is almost no contrast between tube and
        background. The correct behaviour is to refuse, not to return a
        confident "Chart patch 1 — near-white" that happens to be right by luck.

        This is a documented limitation; see docs/prototype-limitations.md.
        """
        image = encode_png(
            make_tube_image((240, 240, 240), background_rgb=(243, 243, 245))
        )
        response = pipeline.run(build_request(image, reference_levels))

        assert response.status == "rejected_quality"
        assert response.prediction.label is None
        codes = {w.code for w in response.image_quality.warnings}
        assert {"very_low_contrast", "low_contrast", "severe_overexposure"} & codes

    def test_manual_roi_is_honoured(self, pipeline, reference_levels):
        image = encode_png(make_tube_image((1, 132, 241)))
        roi = {"x": 150, "y": 300, "width": 100, "height": 200}

        response = pipeline.run(build_request(image, reference_levels, roi=roi))

        assert response.roi.mode == "MANUAL_SELECTION"
        assert (response.roi.x, response.roi.y) == (150, 300)
        assert (response.roi.width, response.roi.height) == (100, 200)
        assert response.roi.confidence == 1.0

    def test_masks_out_glare(self, pipeline, reference_levels):
        """
        The synthetic tube has a near-white glare strip. If it were included,
        the measured colour would be pulled towards white and the match would
        land on a lighter level.
        """
        target_rgb = (1, 132, 241)
        with_glare = encode_png(make_tube_image(target_rgb, add_glare=True))

        response = pipeline.run(build_request(with_glare, reference_levels))

        assert response.color_features is not None
        # Some pixels must have been discarded.
        assert response.color_features.masked_fraction > 0.0
        assert response.reference_match.label == "Chart patch 4 — mid blue"


class TestScientificHonesty:
    """
    These guard the claims the system makes about its own output. A failure
    here is not a cosmetic bug.
    """

    def test_never_estimates_a_concentration_in_prototype_mode(
        self, pipeline, reference_levels
    ):
        for _, _, rgb in BROMATE_LADDER_RGB:
            image = encode_png(make_tube_image(rgb))
            response = pipeline.run(build_request(image, reference_levels))
            assert response.prediction.estimated_concentration is None

    def test_never_reports_confidence_in_reference_matching_mode(
        self, pipeline, reference_levels
    ):
        """A colour distance is not a probability and must not be dressed as one."""
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(build_request(image, reference_levels))

        assert response.mode == "reference_matching"
        assert response.prediction.confidence is None

    def test_reports_the_model_as_unvalidated(self, pipeline, reference_levels):
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(build_request(image, reference_levels))

        assert response.model.validated is False
        assert response.model.model_type == "REFERENCE_MATCHER"

    def test_always_returns_limitations(self, pipeline, reference_levels):
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(build_request(image, reference_levels))

        assert len(response.limitations) > 0
        assert any("not a trained model" in lim.lower() for lim in response.limitations)

    def test_surfaces_unvalidated_method_status(self, pipeline, reference_levels):
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(
            build_request(image, reference_levels, method_status="DRAFT")
        )

        assert any("DRAFT" in lim for lim in response.limitations)

    def test_always_warns_about_missing_colour_calibration(
        self, pipeline, reference_levels
    ):
        """
        No colour reference in frame is the normal case, and it is the biggest
        limit on cross-device comparison. It must never be silent.
        """
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(build_request(image, reference_levels))

        codes = {w.code for w in response.image_quality.warnings}
        assert "missing_calibration" in codes

    def test_reports_ambiguity_when_two_levels_are_equidistant(
        self, pipeline, reference_levels
    ):
        """
        A colour midway between two reference steps must be flagged, not
        silently assigned to whichever happens to be marginally nearer.
        """
        midpoint = tuple(
            int((a + b) / 2)
            for a, b in zip(BROMATE_LADDER_RGB[2][2], BROMATE_LADDER_RGB[3][2], strict=True)
        )
        image = encode_png(make_tube_image(midpoint))  # type: ignore[arg-type]

        response = pipeline.run(build_request(image, reference_levels))

        # Either flagged ambiguous, or far enough from both to be out of range —
        # what must not happen is a clean, confident match.
        assert response.reference_match.ambiguous or response.reference_match.color_distance > 5


class TestQualityRejection:
    def test_rejects_a_badly_blurred_image(self, pipeline, reference_levels, blurry_tube_png):
        response = pipeline.run(build_request(blurry_tube_png, reference_levels))

        codes = {w.code for w in response.image_quality.warnings}
        assert "blur" in codes or "soft_focus" in codes

    def test_rejects_a_severely_underexposed_image(
        self, pipeline, reference_levels, dark_tube_png
    ):
        response = pipeline.run(build_request(dark_tube_png, reference_levels))

        assert response.status == "rejected_quality"
        assert response.image_quality.usable is False
        assert response.prediction.label is None
        codes = {w.code for w in response.image_quality.warnings}
        assert "severe_underexposure" in codes

    def test_rejects_a_severely_overexposed_image(
        self, pipeline, reference_levels, overexposed_tube_png
    ):
        response = pipeline.run(build_request(overexposed_tube_png, reference_levels))

        codes = {w.code for w in response.image_quality.warnings}
        assert {"severe_overexposure", "severe_clipping"} & codes

    def test_a_rejected_image_still_returns_its_measurement(
        self, pipeline, reference_levels, dark_tube_png
    ):
        """
        Rejection withholds the prediction, not the data. The measurement is
        still useful evidence and is still recorded.
        """
        response = pipeline.run(build_request(dark_tube_png, reference_levels))

        assert response.status == "rejected_quality"
        assert response.color_features is not None
        assert response.color_features.pixel_count > 0

    def test_rejection_explains_itself(self, pipeline, reference_levels, dark_tube_png):
        response = pipeline.run(build_request(dark_tube_png, reference_levels))
        assert any(
            "image quality was insufficient" in lim.lower()
            for lim in response.limitations
        )


class TestMalformedInput:
    def test_rejects_non_base64(self, pipeline, reference_levels):
        request = build_request(b"x", reference_levels)
        request.image_base64 = "this is not base64!!!"

        with pytest.raises(ImageValidationError) as exc:
            pipeline.run(request)
        assert exc.value.code == "invalid_base64"

    def test_rejects_a_non_image_payload(self, pipeline, reference_levels):
        with pytest.raises(ImageValidationError):
            pipeline.run(build_request(b"not an image at all, just text", reference_levels))

    def test_rejects_a_truncated_png(self, pipeline, reference_levels):
        full = encode_png(make_tube_image((120, 207, 247)))
        with pytest.raises(ImageValidationError):
            pipeline.run(build_request(full[: len(full) // 3], reference_levels))

    def test_rejects_an_image_below_the_minimum_size(self, pipeline, reference_levels):
        tiny = encode_png(np.full((20, 20, 3), 128, dtype=np.uint8))
        with pytest.raises(ImageValidationError) as exc:
            pipeline.run(build_request(tiny, reference_levels))
        assert exc.value.code == "too_small"

    def test_works_with_no_reference_levels(self, pipeline):
        """
        No chart configured must not crash — it must return the measurement
        with no match and say why.
        """
        image = encode_png(make_tube_image((120, 207, 247)))
        response = pipeline.run(build_request(image, []))

        assert response.color_features is not None
        assert response.reference_match.reference_level_id is None
        assert response.prediction.label is None


class TestReferenceMatcherModel:
    def test_reports_itself_as_not_a_trained_model(self):
        info = ReferenceMatcherModel().info
        assert info.validated is False
        assert info.model_type == "REFERENCE_MATCHER"
        assert len(info.limitations) >= 3

    def test_registry_defaults_to_the_baseline(self, tmp_path):
        registry = ModelRegistry(tmp_path / "artifacts")
        assert registry.active.info.model_type == "REFERENCE_MATCHER"
        assert registry.active.info.validated is False

    def test_registry_refuses_a_missing_artifact(self, tmp_path):
        registry = ModelRegistry(tmp_path / "artifacts")
        assert registry.load_model("nonexistent", "1.0.0") is False
        # The active model must be unchanged after a failed load.
        assert registry.active.info.model_type == "REFERENCE_MATCHER"
