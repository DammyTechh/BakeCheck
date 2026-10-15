"""
Regression tests against real laboratory photographs.

Every other test in this suite uses generated images, which is deliberate —
a test suite should not depend on binary fixtures nobody can review in a
diff. But generated images share a flaw: they are only as realistic as the
generator, and this project's generator was wrong in a way that mattered.

The first four real photographs ever put through this pipeline were *all*
rejected as "badly out of focus". They were not. The focus check measured
Laplacian variance inside the measured region — and a correctly exposed
column of uniform solution has almost no high-frequency detail *by
definition*. The check was scoring a perfect sample the same as a blurred
one, and the synthetic fixtures had hidden it: they were given Gaussian
sensor noise precisely so the blur detector would stop firing on them, which
tuned the fixtures to the bug rather than fixing it.

So these fixtures stay, downscaled to keep the repository light (66 KB in
total). They are four tubes from one laboratory session on one camera —
nothing like a validation set — but they are real, and they are the only
images here that were not produced by the same assumptions as the code.

What the tests deliberately do NOT assert: which reference band each tube
matched, or any concentration. Nobody recorded what was in these tubes. The
matched label depends on a chart that is itself marked ILLUSTRATIVE, so
asserting a band would be asserting a chemical claim this project has no
basis for.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.core.config import Settings
from app.models.registry import ModelRegistry
from app.services.pipeline import AnalysisPipeline
from app.vision.quality import QualityThresholds, focus_score
from app.vision.roi import detect_region

from test_pipeline import build_request

PHOTO_DIR = Path(__file__).parent / "fixtures" / "lab-photos"
PHOTOS = sorted(PHOTO_DIR.glob("*.jpg"))


def load_rgb(path: Path) -> np.ndarray:
    bgr = cv2.imread(str(path))
    assert bgr is not None, f"could not read {path}"
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def region_of(rgb: np.ndarray) -> tuple[int, int, int, int]:
    r = detect_region(rgb, None)
    return (r.x, r.y, r.width, r.height)


def test_the_fixtures_are_present() -> None:
    assert len(PHOTOS) == 4, f"expected 4 lab photographs, found {len(PHOTOS)}"


class TestFocusOnRealPhotographs:
    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_a_real_photograph_is_not_called_blurred(self, path: Path) -> None:
        """
        The regression. Every one of these was rejected as badly out of focus
        by the original check.
        """
        rgb = load_rgb(path)
        score = focus_score(rgb, region_of(rgb))
        assert score >= QualityThresholds().blur_critical, (
            f"{path.name} scored {score:.1f}, below the critical threshold "
            f"{QualityThresholds().blur_critical} — a sharp photograph is "
            "being rejected again"
        )

    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_a_blurred_copy_of_it_is_rejected(self, path: Path) -> None:
        """
        The other half: loosening the threshold must not make the check
        useless. The same photograph, genuinely blurred, still has to fail.
        """
        rgb = load_rgb(path)
        blurred = cv2.GaussianBlur(rgb, (21, 21), 0)
        score = focus_score(blurred, region_of(blurred))
        assert score < QualityThresholds().blur_critical, (
            f"a 21px-blurred {path.name} scored {score:.1f} and would be "
            "accepted; the focus check no longer detects blur"
        )

    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_measuring_inside_the_tube_cannot_tell_focus_apart(
        self, path: Path
    ) -> None:
        """
        Documents the root cause rather than the fix.

        Inside the liquid column there is almost nothing to measure, so a
        sharp tube and a blurred one score within a whisker of each other and
        no threshold placed there can separate them. Padding out to the glass
        walls is what makes the two separable — which the tests above assert.
        """
        rgb = load_rgb(path)
        x, y, w, h = region_of(rgb)

        sharp_interior = focus_score(rgb[y : y + h, x : x + w], None)
        blurred = cv2.GaussianBlur(rgb, (21, 21), 0)
        blurred_interior = focus_score(blurred[y : y + h, x : x + w], None)

        padded_ratio = focus_score(rgb, region_of(rgb)) / max(
            focus_score(blurred, region_of(blurred)), 1e-9
        )
        interior_ratio = sharp_interior / max(blurred_interior, 1e-9)

        assert padded_ratio > interior_ratio, (
            f"measuring at the tube's edges separates sharp from blurred by "
            f"{padded_ratio:.1f}x, but measuring inside it only "
            f"{interior_ratio:.1f}x — the padding is not helping"
        )

    def test_the_score_survives_a_change_of_capture_resolution(self) -> None:
        """
        Laplacian variance grows with resolution, so an unnormalised score
        cannot share a threshold between a 2 MP webcam and a 12 MP phone.
        The same photograph at different sizes must stay on the same side of
        the line.
        """
        rgb = load_rgb(PHOTOS[0])
        scores = []
        for scale in (0.5, 0.75, 1.0):
            resized = cv2.resize(
                rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
            )
            scores.append(focus_score(resized, region_of(resized)))

        critical = QualityThresholds().blur_critical
        assert all(s >= critical for s in scores), (
            f"scores {[round(s, 1) for s in scores]} straddle the threshold "
            f"{critical}; the measure is still resolution-dependent"
        )
        # Spread well inside the ~10x of the raw measure this replaced.
        assert max(scores) / min(scores) < 4.0


class TestTheWholePipelineOnRealPhotographs:
    @pytest.fixture
    def pipeline(self, tmp_path) -> AnalysisPipeline:
        settings = Settings(
            AI_INTERNAL_KEY="test-internal-key-0123456789abcdef",
            AI_ARTIFACT_DIR=tmp_path / "artifacts",
        )
        return AnalysisPipeline(ModelRegistry(settings.artifact_dir), settings)

    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_a_real_photograph_completes(
        self, pipeline: AnalysisPipeline, reference_levels, path: Path
    ) -> None:
        response = pipeline.run(
            build_request(path.read_bytes(), reference_levels)
        )
        assert response.status == "completed", (
            f"{path.name} did not complete: "
            f"{[w.code for w in response.image_quality.warnings]}"
        )
        assert response.image_quality.usable
        assert response.reference_match.label is not None
        assert response.color_features is not None

    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_it_still_reports_no_concentration_and_no_confidence(
        self, pipeline: AnalysisPipeline, reference_levels, path: Path
    ) -> None:
        """
        The guarantee that matters most, now exercised on real images rather
        than generated ones. These tubes have no confirmed measurement and
        the chart is illustrative, so a number here would be invented.
        """
        response = pipeline.run(
            build_request(path.read_bytes(), reference_levels)
        )
        assert response.prediction.estimated_concentration is None
        assert response.prediction.confidence is None
        assert response.model.validated is False
        assert response.limitations

    @pytest.mark.parametrize("path", PHOTOS, ids=lambda p: p.stem)
    def test_it_reports_how_far_the_match_actually_was(
        self, pipeline: AnalysisPipeline, reference_levels, path: Path
    ) -> None:
        """
        These photographs sit 9-15 ΔE from the nearest band, which is a long
        way — the colour is *closest to* that band, not *on* it. The distance
        and the runner-up have to reach the caller, or the interface will
        present a loose match as a firm one.
        """
        response = pipeline.run(
            build_request(path.read_bytes(), reference_levels)
        )
        assert response.reference_match.color_distance is not None
        assert response.reference_match.color_distance > 0
        assert len(response.reference_match.alternatives) >= 1

    def test_the_photographs_order_the_way_they_look(
        self, pipeline: AnalysisPipeline, reference_levels
    ) -> None:
        """
        A sanity check on the measurement rather than the chemistry: these
        four tubes are visibly a dilution series, so their measured lightness
        must not be identical — if it were, the pipeline would be reporting
        the same colour for plainly different samples.
        """
        lightness = []
        for path in PHOTOS:
            response = pipeline.run(
                build_request(path.read_bytes(), reference_levels)
            )
            assert response.color_features is not None
            lightness.append(response.color_features.lab_median[0])

        assert max(lightness) - min(lightness) > 5.0, (
            f"L* values {[round(v, 1) for v in lightness]} are nearly "
            "identical for visibly different tubes"
        )


def test_no_photograph_carries_location_metadata() -> None:
    """
    These came from a technician's phone. Shipping EXIF GPS in the repository
    would publish where that laboratory is.
    """
    from PIL import Image

    for path in PHOTOS:
        exif = Image.open(path).getexif()
        assert not exif or 34853 not in exif, f"{path.name} still carries GPS EXIF"
