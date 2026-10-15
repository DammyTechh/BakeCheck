"""
Stage 5 — reference comparison.

Compares a measured colour against the levels of a reference chart and reports
the closest, with its distance and the runners-up.

What this is: a transparent, inspectable colour-distance calculation. Every
number can be traced back to two CIELAB values and one published formula.

What this is **not**: a measurement of concentration. The output names the
reference level whose colour is perceptually nearest. Whether that level's
printed concentration has anything to do with this sample depends entirely on
the method, the preparation, the calibration and the imaging conditions —
none of which this function can see. The caller is responsible for presenting
the result as a screening estimate; this module never returns a concentration
as though it had measured one.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..colorimetry.conversion import delta_e_2000, describe_distance


@dataclass
class ReferenceLevel:
    """One labelled step of a reference chart."""

    id: str
    label: str
    concentration_value: float | None
    concentration_unit: str
    sort_order: int
    lab_l: float
    lab_a: float
    lab_b: float
    lab_std: float | None = None

    @property
    def lab(self) -> np.ndarray:
        return np.array([self.lab_l, self.lab_a, self.lab_b], dtype=np.float64)


@dataclass
class MatchCandidate:
    reference_level_id: str
    label: str
    concentration_value: float | None
    color_distance: float


@dataclass
class MatchResult:
    reference_level_id: str | None
    label: str | None
    concentration_value: float | None
    concentration_unit: str | None
    color_distance: float | None
    alternatives: list[MatchCandidate]
    out_of_range: bool
    """True when the measured colour sits beyond either end of the ladder."""

    ambiguous: bool
    """True when two levels are nearly equidistant — the match is a coin toss."""

    distance_description: str | None
    notes: list[str]


# Above this CIEDE2000 distance, the nearest level is not a meaningful match —
# the measured colour simply is not on this chart. Chosen as a conservative
# engineering default, not a validated threshold.
MAX_PLAUSIBLE_DISTANCE = 25.0

# When the two nearest levels differ by less than this, the choice between
# them is not supported by the measurement.
AMBIGUITY_MARGIN = 2.0


def match_reference(
    measured_lab: np.ndarray,
    levels: list[ReferenceLevel],
    max_alternatives: int = 3,
) -> MatchResult:
    """
    Find the reference level perceptually closest to `measured_lab`.

    Returns every candidate's distance, not just the winner, so a reviewer can
    see how clear-cut the match was. A result where the top two levels differ
    by 0.3 ΔE deserves very different treatment from one where they differ
    by 15.
    """
    if not levels:
        return MatchResult(
            reference_level_id=None,
            label=None,
            concentration_value=None,
            concentration_unit=None,
            color_distance=None,
            alternatives=[],
            out_of_range=False,
            ambiguous=False,
            distance_description=None,
            notes=["No reference levels were supplied, so no comparison was made."],
        )

    measured = np.asarray(measured_lab, dtype=np.float64).reshape(3)
    notes: list[str] = []

    scored = sorted(
        (
            (delta_e_2000(measured, level.lab), level)
            for level in levels
        ),
        key=lambda pair: pair[0],
    )

    best_distance, best_level = scored[0]

    alternatives = [
        MatchCandidate(
            reference_level_id=level.id,
            label=level.label,
            concentration_value=level.concentration_value,
            color_distance=round(distance, 4),
        )
        for distance, level in scored[1 : 1 + max_alternatives]
    ]

    # ── Ambiguity ────────────────────────────────────────────────────────────
    ambiguous = False
    if len(scored) > 1:
        runner_up_distance = scored[1][0]
        if runner_up_distance - best_distance < AMBIGUITY_MARGIN:
            ambiguous = True
            notes.append(
                f'"{best_level.label}" and "{scored[1][1].label}" are nearly '
                f"equidistant from the measured colour "
                f"(ΔE {best_distance:.2f} vs {runner_up_distance:.2f}). The "
                "match between them is not supported by this measurement."
            )

    # ── Out of range ─────────────────────────────────────────────────────────
    out_of_range = _is_outside_ladder(measured, levels)
    if out_of_range:
        notes.append(
            "The measured colour lies beyond the ends of this reference "
            "chart, so the closest level is an extrapolation rather than an "
            "interpolation."
        )

    if best_distance > MAX_PLAUSIBLE_DISTANCE:
        notes.append(
            f"The nearest reference level is {best_distance:.1f} ΔE away, which "
            "is a large perceptual difference. The measured colour may not "
            "correspond to this chart at all — check that the correct test "
            "method and chart were selected, and that the region measured was "
            "the solution."
        )

    # The matched level's printed concentration is returned, clearly labelled
    # as belonging to the reference level. It is never presented as a measured
    # concentration for the sample; see the module docstring.
    return MatchResult(
        reference_level_id=best_level.id,
        label=best_level.label,
        concentration_value=best_level.concentration_value,
        concentration_unit=best_level.concentration_unit,
        color_distance=round(best_distance, 4),
        alternatives=alternatives,
        out_of_range=out_of_range,
        ambiguous=ambiguous,
        distance_description=describe_distance(best_distance),
        notes=notes,
    )


def _is_outside_ladder(
    measured: np.ndarray,
    levels: list[ReferenceLevel],
) -> bool:
    """
    Decide whether the measured colour sits beyond the ends of the ladder.

    A colour ladder is a path through Lab space, ordered by concentration. The
    test projects the measured colour onto the line through the two endpoint
    colours: a projection parameter outside [0, 1], by a clear margin, means
    the sample is lighter than the lightest standard or darker than the
    darkest — in which case the nearest level is an extrapolation.

    Using the endpoints rather than per-axis bounds keeps this meaningful for
    ladders that are not monotonic in a*/b*, which the seeded bromate chart is
    not.
    """
    if len(levels) < 2:
        return False

    ordered = sorted(levels, key=lambda level: level.sort_order)
    start = ordered[0].lab
    end = ordered[-1].lab

    axis = end - start
    axis_length_sq = float(axis @ axis)
    if axis_length_sq < 1e-9:
        return False

    # Scalar projection of the measured colour onto the ladder axis.
    t = float((measured - start) @ axis) / axis_length_sq

    # A 10% margin beyond each end, so a sample marginally outside the
    # endpoints is not flagged on measurement noise alone.
    return t < -0.10 or t > 1.10


def interpolate_concentration(
    measured_lab: np.ndarray,
    levels: list[ReferenceLevel],
) -> float | None:
    """
    Estimate a concentration by interpolating between the two nearest levels.

    **This is not called by the prototype pipeline.** It exists because the
    infrastructure for it is required, and because the moment a laboratory
    produces a validated chart with calibrated colours, this becomes the right
    function to use.

    It returns None unless the measured colour genuinely sits between two
    levels along the ladder, so it cannot manufacture a number by
    extrapolating past the ends.

    A caller must not present this value as a measurement unless the method,
    the chart and the model have all been validated — the colour-to-
    concentration relationship it assumes (locally linear in Lab) is an
    assumption about the chemistry, not a fact this code can establish.
    """
    if len(levels) < 2:
        return None

    with_concentration = [
        level for level in levels if level.concentration_value is not None
    ]
    if len(with_concentration) < 2:
        return None

    measured = np.asarray(measured_lab, dtype=np.float64).reshape(3)
    ordered = sorted(with_concentration, key=lambda level: level.sort_order)

    best: tuple[float, float] | None = None  # (distance to segment, estimate)

    for lower, upper in zip(ordered, ordered[1:], strict=False):
        segment = upper.lab - lower.lab
        segment_length_sq = float(segment @ segment)
        if segment_length_sq < 1e-9:
            continue

        t = float((measured - lower.lab) @ segment) / segment_length_sq
        if not 0.0 <= t <= 1.0:
            continue

        projected = lower.lab + t * segment
        distance = float(np.linalg.norm(measured - projected))

        # Bound to local floats before arithmetic. The list comprehension
        # above already filtered out None concentrations, but that fact is
        # invisible to the type checker — and if the filter is ever loosened,
        # this would silently become a TypeError at runtime rather than a
        # caught error here.
        lower_value = lower.concentration_value
        upper_value = upper.concentration_value
        if lower_value is None or upper_value is None:
            continue

        estimate = lower_value + t * (upper_value - lower_value)

        if best is None or distance < best[0]:
            best = (distance, float(estimate))

    return round(best[1], 6) if best is not None else None
