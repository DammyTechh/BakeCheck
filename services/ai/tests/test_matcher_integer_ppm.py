"""
A reading is always one of the laboratory's sixteen categories, as an integer.

The chart is a reporting scale, not a continuous calibration. Its levels are
the only concentrations that exist, so the matcher must return one of them
exactly -- never a value between two, and never a decimal. "412.37 ppm" reads
as a measurement; it is not one, and the chart cannot produce it.

These tests pin that at the matcher, which is where any future interpolation
would reappear.
"""

import json
import pathlib

import numpy as np
import pytest

from app.reference_matching.matcher import ReferenceLevel, match_reference

# The laboratory's scale, 16 October 2026. Typed out here rather than read
# from the seed, so a mistake in the seed shows up as a failure instead of
# being quietly mirrored.
SCALE_PPM = [0, 10, 20, 30, 40, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 1000]

SEED = (
    pathlib.Path(__file__).resolve().parents[3]
    / "database"
    / "seeds"
    / "reference-chart-bromate-illustrative.json"
)


def _levels() -> list[ReferenceLevel]:
    chart = json.loads(SEED.read_text())
    return [
        ReferenceLevel(
            id=f"level-{level['sort_order']}",
            label=level["label"],
            concentration_value=level["concentration_value"],
            concentration_unit=level["concentration_unit"],
            sort_order=level["sort_order"],
            lab_l=level["lab"][0],
            lab_a=level["lab"][1],
            lab_b=level["lab"][2],
        )
        for level in chart["levels"]
    ]


class TestTheSeededChart:
    def test_carries_exactly_the_laboratory_scale(self) -> None:
        chart = json.loads(SEED.read_text())
        assert [l["concentration_value"] for l in chart["levels"]] == SCALE_PPM

    def test_every_concentration_is_a_whole_number(self) -> None:
        chart = json.loads(SEED.read_text())
        for level in chart["levels"]:
            value = level["concentration_value"]
            assert isinstance(value, int), f"{level['label']} is {type(value).__name__}"
            assert value == int(value)

    def test_every_level_is_in_ppm(self) -> None:
        chart = json.loads(SEED.read_text())
        assert {l["concentration_unit"] for l in chart["levels"]} == {"ppm"}


class TestEveryMatchLandsOnACategory:
    @pytest.mark.parametrize("index", range(len(SCALE_PPM)))
    def test_a_colour_taken_from_a_level_returns_that_level(self, index: int) -> None:
        levels = _levels()
        result = match_reference(levels[index].lab, levels)

        assert result is not None
        assert result.concentration_value == SCALE_PPM[index]
        assert float(result.concentration_value).is_integer()

    def test_a_colour_between_two_levels_still_returns_one_of_them(self) -> None:
        # The case interpolation existed to handle. The answer is the nearest
        # category, not a number in the gap between them.
        levels = _levels()
        midpoint = (levels[8].lab + levels[9].lab) / 2.0

        result = match_reference(midpoint, levels)

        assert result is not None
        assert result.concentration_value in (SCALE_PPM[8], SCALE_PPM[9])
        assert result.concentration_value not in range(201, 250)

    def test_a_colour_far_off_the_chart_still_returns_a_category(self) -> None:
        # Bright red is nothing like any level. The match is poor and the
        # result says so, but the concentration is still one of the sixteen.
        levels = _levels()
        result = match_reference(np.array([53.2, 80.1, 67.2]), levels)

        assert result is not None
        assert result.concentration_value in SCALE_PPM
        assert result.color_distance > 5

    @pytest.mark.parametrize(
        "lab",
        [
            np.array([95.0, -1.0, 2.0]),
            np.array([50.0, 10.0, -40.0]),
            np.array([20.0, 5.0, -30.0]),
            np.array([70.0, -15.0, -10.0]),
            np.array([5.0, 0.0, -5.0]),
        ],
    )
    def test_never_returns_a_fraction_for_any_colour(self, lab: np.ndarray) -> None:
        levels = _levels()
        result = match_reference(lab, levels)

        assert result is not None
        assert result.concentration_value in SCALE_PPM
        assert float(result.concentration_value).is_integer()


class TestInterpolationIsGone:
    def test_the_module_exposes_no_interpolation_entry_point(self) -> None:
        # The function was removed rather than left unused: it was the obvious
        # thing to reach for, and reaching for it reintroduces float readings.
        from app.reference_matching import matcher

        assert not hasattr(matcher, "interpolate_concentration")
        assert not [
            name
            for name in dir(matcher)
            if "interpolat" in name.lower() and not name.startswith("__")
        ]
