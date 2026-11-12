"""
Colour conversion and CIEDE2000.

These vectors are the same ones asserted in
`apps/api/test/color-conversion.spec.ts`. Keeping both suites on an identical
set is the mechanism that proves the TypeScript and Python implementations
agree — without it, the two could drift apart and nothing would notice until a
sample matched one level in the API and a different one in the vision service.

Expected values were generated from `skimage.color.deltaE_ciede2000` (see
infrastructure/scripts/generate_ciede2000_vectors.py), not transcribed from
the Sharma paper by hand. Transcription introduced three wrong values in an
earlier draft; the cross-check is what caught them.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.colorimetry.conversion import (
    delta_e_76,
    delta_e_2000,
    lab_to_rgb,
    rgb_to_hsv,
    rgb_to_lab,
)

# (pair, lab1, lab2, expected) — inputs from Sharma, Wu & Dalal (2005) Table 1.
SHARMA_VECTORS = [
    (1, (50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
    (2, (50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
    (3, (50.0, 2.8361, -74.02), (50.0, 0.0, -82.7485), 3.4412),
    (4, (50.0, -1.3802, -84.2814), (50.0, 0.0, -82.7485), 1.0000),
    (5, (50.0, -1.1848, -84.8006), (50.0, 0.0, -82.7485), 1.0000),
    (6, (50.0, -0.9009, -85.5211), (50.0, 0.0, -82.7485), 1.0000),
    (7, (50.0, 0.0, 0.0), (50.0, -1.0, 2.0), 2.3669),
    (8, (50.0, -1.0, 2.0), (50.0, 0.0, 0.0), 2.3669),
    (9, (50.0, 2.49, -0.001), (50.0, -2.49, 0.0009), 7.1792),
    (13, (50.0, -0.001, 2.49), (50.0, 0.0009, -2.49), 4.8045),
    (15, (50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
    (17, (50.0, 2.5, 0.0), (50.0, 3.1736, 0.5854), 1.0000),
    (20, (50.0, 2.5, 0.0), (50.0, 3.2592, 0.335), 1.0000),
    (21, (60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    (23, (8.0, -0.0002, -0.0011), (8.0, -0.0003, 0.0007), 0.0018),
    (25, (22.7233, 20.0904, -46.694), (23.0331, 14.973, -42.5619), 2.0373),
    (29, (2.0776, 0.0795, -1.135), (0.9033, -0.0636, -0.5514), 0.9082),
    (33, (90.9257, -0.5406, -0.9208), (88.6381, -0.8985, -0.7239), 1.5381),
]

# The seeded bromate ladder, as sampled from the supplied illustration.
LADDER_RGB = [
    (240, 240, 240),
    (212, 236, 244),
    (120, 207, 247),
    (1, 132, 241),
    (1, 38, 156),
    (2, 5, 112),
]


class TestDeltaE2000:
    @pytest.mark.parametrize(("pair", "lab1", "lab2", "expected"), SHARMA_VECTORS)
    def test_matches_reference_implementation(self, pair, lab1, lab2, expected):
        result = delta_e_2000(np.array(lab1), np.array(lab2))
        assert result == pytest.approx(expected, abs=1e-3), f"Sharma pair {pair}"

    def test_is_symmetric(self):
        for _, lab1, lab2, _ in SHARMA_VECTORS:
            forward = delta_e_2000(np.array(lab1), np.array(lab2))
            backward = delta_e_2000(np.array(lab2), np.array(lab1))
            assert forward == pytest.approx(backward, abs=1e-10)

    def test_identical_colours_are_zero(self):
        lab = np.array([50.0, 2.5, -10.0])
        assert delta_e_2000(lab, lab) == pytest.approx(0.0, abs=1e-12)

    def test_never_negative(self):
        for _, lab1, lab2, _ in SHARMA_VECTORS:
            assert delta_e_2000(np.array(lab1), np.array(lab2)) >= 0.0

    def test_handles_hue_wraparound(self):
        """
        Hues either side of 0°/360° must be close, not maximally distant.
        A naive implementation reports a huge difference here.
        """
        near_zero = rgb_to_lab(np.array([200.0, 100.0, 101.0]))
        just_under = rgb_to_lab(np.array([200.0, 101.0, 100.0]))
        assert delta_e_2000(near_zero, just_under) < 2.0

    def test_differs_from_cie76_in_blue_region(self):
        """
        The reason CIEDE2000 is used at all: CIE76 overstates differences
        among saturated blues, which is exactly where this colour ladder
        lives. If the two agreed here, the choice would not matter.

        For the 1 ppm and 5 ppm reference colours the gap is about 32%
        (CIE76 ≈ 42.4, CIEDE2000 ≈ 32.1) — large enough that using CIE76
        would visibly change which level a borderline sample matches.
        """
        blue_a = rgb_to_lab(np.array([1.0, 132.0, 241.0]))
        blue_b = rgb_to_lab(np.array([1.0, 38.0, 156.0]))

        cie76 = delta_e_76(blue_a, blue_b)
        ciede2000 = delta_e_2000(blue_a, blue_b)

        assert cie76 > ciede2000
        assert cie76 / ciede2000 > 1.2


class TestColorConversion:
    def test_white_and_black(self):
        white = rgb_to_lab(np.array([255.0, 255.0, 255.0]))
        assert white[0] == pytest.approx(100.0, abs=0.01)
        assert white[1] == pytest.approx(0.0, abs=0.01)
        assert white[2] == pytest.approx(0.0, abs=0.01)

        black = rgb_to_lab(np.array([0.0, 0.0, 0.0]))
        assert black[0] == pytest.approx(0.0, abs=1e-9)

    def test_primaries(self):
        red = rgb_to_lab(np.array([255.0, 0.0, 0.0]))
        assert red[0] == pytest.approx(53.24, abs=0.05)
        assert red[1] == pytest.approx(80.09, abs=0.05)

        blue = rgb_to_lab(np.array([0.0, 0.0, 255.0]))
        assert blue[0] == pytest.approx(32.30, abs=0.05)
        assert blue[2] == pytest.approx(-107.86, abs=0.05)

    def test_round_trip_within_one_step(self):
        for rgb in [*LADDER_RGB, (128, 128, 128), (17, 99, 200)]:
            original = np.array(rgb, dtype=np.float64)
            restored = lab_to_rgb(rgb_to_lab(original))
            assert np.all(np.abs(restored - original) <= 1.0), rgb

    def test_vectorised_matches_scalar(self):
        """An image array must convert identically to one pixel at a time."""
        pixels = np.array(LADDER_RGB, dtype=np.float64)
        batch = rgb_to_lab(pixels)
        for index, rgb in enumerate(LADDER_RGB):
            single = rgb_to_lab(np.array(rgb, dtype=np.float64))
            assert np.allclose(batch[index], single, atol=1e-10)

    def test_ladder_is_monotonic_in_lightness(self):
        """
        A usable colour ladder must be ordered in L*. If two steps had the same
        lightness, a lightness-driven match could not tell them apart.
        """
        lightness = [rgb_to_lab(np.array(rgb, dtype=np.float64))[0] for rgb in LADDER_RGB]
        assert all(
            later < earlier for earlier, later in zip(lightness, lightness[1:], strict=False)
        ), lightness

    def test_ladder_steps_are_perceptibly_separated(self):
        for earlier, later in zip(LADDER_RGB, LADDER_RGB[1:], strict=False):
            distance = delta_e_2000(
                rgb_to_lab(np.array(earlier, dtype=np.float64)),
                rgb_to_lab(np.array(later, dtype=np.float64)),
            )
            assert distance > 2.0, f"{earlier} → {later} is only {distance:.2f} ΔE"


class TestHsv:
    def test_known_values(self):
        red = rgb_to_hsv(np.array([255.0, 0.0, 0.0]))
        assert red[0] == pytest.approx(0.0, abs=0.01)
        assert red[1] == pytest.approx(1.0, abs=0.01)
        assert red[2] == pytest.approx(1.0, abs=0.01)

        green = rgb_to_hsv(np.array([0.0, 255.0, 0.0]))
        assert green[0] == pytest.approx(120.0, abs=0.01)

        blue = rgb_to_hsv(np.array([0.0, 0.0, 255.0]))
        assert blue[0] == pytest.approx(240.0, abs=0.01)

    def test_greyscale_has_zero_saturation(self):
        grey = rgb_to_hsv(np.array([128.0, 128.0, 128.0]))
        assert grey[1] == pytest.approx(0.0, abs=1e-9)

    def test_hue_is_in_degrees_not_opencv_half_degrees(self):
        """
        OpenCV reports hue in [0, 180] for 8-bit input, which is a recurring
        source of confusion. This implementation uses [0, 360).
        """
        blue = rgb_to_hsv(np.array([0.0, 0.0, 255.0]))
        assert blue[0] > 180.0
