#!/usr/bin/env python3
"""
Sample reference colours from a bromate test-chart illustration.

This is a *provenance tool*, not a calibration tool. It reads the colour that
a supplied chart image actually displays for each labelled step and emits JSON
for the seed script. The output is explicitly marked ILLUSTRATIVE: reading
pixels off a picture tells you what the picture looks like, nothing more. It
establishes no relationship between a colour and a real bromate concentration.

Usage:
    python3 extract_reference_colors.py INPUT.png [-o OUTPUT.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Labelled steps on the supplied chart, with the horizontal centre of each tube
# expressed as a fraction of the chart's width and the vertical band of liquid
# as fractions of its height. Fractions rather than pixels so the same geometry
# works if the chart is rescaled.
TUBE_LAYOUT = [
    {"label": "No Bromate", "concentration": 0.0, "x_frac": 0.143},
    {"label": "Trace Amount", "concentration": 0.1, "x_frac": 0.279},
    {"label": "Low Level", "concentration": 0.5, "x_frac": 0.419},
    {"label": "Moderate Level", "concentration": 1.0, "x_frac": 0.559},
    {"label": "High Level", "concentration": 5.0, "x_frac": 0.699},
    {"label": "Very High Level", "concentration": 10.0, "x_frac": 0.843},
]

# Vertical band to sample, as a fraction of chart height. Chosen to sit below
# the meniscus and above the rounded tube bottom, where the colour is flat.
Y_FRAC_TOP = 0.46
Y_FRAC_BOTTOM = 0.62
# Half-width of the sampling window, as a fraction of chart width. Narrow
# enough to stay inside the glass and miss the specular highlight on the edges.
HALF_WIDTH_FRAC = 0.022


def srgb_to_linear(channel: np.ndarray) -> np.ndarray:
    """Undo the sRGB transfer function. Required before any CIE conversion."""
    return np.where(
        channel <= 0.04045,
        channel / 12.92,
        ((channel + 0.055) / 1.055) ** 2.4,
    )


def rgb_to_lab(rgb_0_255: np.ndarray) -> tuple[float, float, float]:
    """
    Convert sRGB (0-255) to CIELAB under a D65 white point.

    Implemented here rather than pulled from a library so the seed, the AI
    service and the tests all demonstrably use the same maths.
    """
    rgb = np.asarray(rgb_0_255, dtype=np.float64) / 255.0
    linear = srgb_to_linear(rgb)

    # sRGB → XYZ (D65), IEC 61966-2-1.
    matrix = np.array(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ]
    )
    xyz = matrix @ linear

    # D65 reference white.
    white = np.array([0.95047, 1.00000, 1.08883])
    ratio = xyz / white

    epsilon = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = np.where(ratio > epsilon, np.cbrt(ratio), (kappa * ratio + 16.0) / 116.0)

    lightness = 116.0 * f[1] - 16.0
    a_star = 500.0 * (f[0] - f[1])
    b_star = 200.0 * (f[1] - f[2])
    return float(lightness), float(a_star), float(b_star)


def find_chart_bounds(image: np.ndarray) -> tuple[int, int, int, int]:
    """
    Locate the chart inside a screenshot.

    The supplied file is a phone screenshot: a light chart panel surrounded by
    black letterboxing. We find the largest run of rows whose mean brightness
    is high, which isolates the panel without hard-coding screenshot sizes.
    """
    grey = image[..., :3].mean(axis=2)
    row_is_light = grey.mean(axis=1) > 120

    best_start, best_length = 0, 0
    current_start, current_length = 0, 0
    for index, is_light in enumerate(row_is_light):
        if is_light:
            if current_length == 0:
                current_start = index
            current_length += 1
            if current_length > best_length:
                best_start, best_length = current_start, current_length
        else:
            current_length = 0

    if best_length < 50:
        # No letterboxing detected — treat the whole image as the chart.
        return 0, 0, image.shape[1], image.shape[0]

    # Trim columns the same way inside the detected row band.
    band = grey[best_start : best_start + best_length]
    col_is_light = band.mean(axis=0) > 120
    light_cols = np.flatnonzero(col_is_light)
    x0 = int(light_cols[0]) if light_cols.size else 0
    x1 = int(light_cols[-1]) + 1 if light_cols.size else image.shape[1]

    return x0, best_start, x1, best_start + best_length


def sample_tube(
    image: np.ndarray, bounds: tuple[int, int, int, int], x_frac: float
) -> dict:
    """Median colour of one tube's liquid column, with its spread."""
    x0, y0, x1, y1 = bounds
    width, height = x1 - x0, y1 - y0

    centre_x = x0 + int(round(x_frac * width))
    half = max(2, int(round(HALF_WIDTH_FRAC * width)))
    top = y0 + int(round(Y_FRAC_TOP * height))
    bottom = y0 + int(round(Y_FRAC_BOTTOM * height))

    patch = image[top:bottom, centre_x - half : centre_x + half, :3]
    if patch.size == 0:
        raise ValueError(f"Empty sampling window at x_frac={x_frac}")

    pixels = patch.reshape(-1, 3).astype(np.float64)

    # Drop the brightest 10%: glass highlights sit on top of the liquid colour
    # and would drag a plain mean towards white.
    luminance = pixels @ np.array([0.2126, 0.7152, 0.0722])
    keep = luminance <= np.percentile(luminance, 90)
    if keep.sum() >= 10:
        pixels = pixels[keep]

    rgb_median = np.median(pixels, axis=0)
    rgb_std = pixels.std(axis=0)
    lightness, a_star, b_star = rgb_to_lab(rgb_median)

    # Spread in Lab terms: convert the ±1σ RGB envelope and take the distance.
    lab_hi = rgb_to_lab(np.clip(rgb_median + rgb_std, 0, 255))
    lab_lo = rgb_to_lab(np.clip(rgb_median - rgb_std, 0, 255))
    lab_spread = float(
        np.linalg.norm(np.array(lab_hi) - np.array(lab_lo)) / 2.0
    )

    return {
        "rgb": [int(round(v)) for v in rgb_median],
        "rgb_std": [round(float(v), 2) for v in rgb_std],
        "lab": [round(lightness, 4), round(a_star, 4), round(b_star, 4)],
        "lab_std": round(lab_spread, 4),
        "roi": {
            "x": int(centre_x - half),
            "y": int(top),
            "width": int(2 * half),
            "height": int(bottom - top),
        },
        "pixels_sampled": int(pixels.shape[0]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Chart image (PNG/JPEG)")
    parser.add_argument("-o", "--output", type=Path, help="Write JSON here")
    args = parser.parse_args()

    image = np.array(Image.open(args.input).convert("RGB"))
    bounds = find_chart_bounds(image)

    levels = []
    for order, tube in enumerate(TUBE_LAYOUT):
        measurement = sample_tube(image, bounds, tube["x_frac"])
        levels.append(
            {
                "sort_order": order,
                "label": tube["label"],
                "concentration_value": tube["concentration"],
                "concentration_unit": "ppm",
                **measurement,
            }
        )

    result = {
        "source_image": args.input.name,
        "chart_bounds": {
            "x": bounds[0],
            "y": bounds[1],
            "width": bounds[2] - bounds[0],
            "height": bounds[3] - bounds[1],
        },
        "color_space": "sRGB",
        "illuminant": "D65 (assumed; the illustration carries no colour profile)",
        "validation_status": "ILLUSTRATIVE",
        "provenance_note": (
            "Colours were read from an AI-generated illustration of a bromate "
            "colour chart. They describe the picture, not a calibrated "
            "colorimetric standard, and establish no validated relationship "
            "between colour and bromate concentration in any sample matrix."
        ),
        "levels": levels,
    }

    text = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(text + "\n", encoding="utf-8")
        print(f"Wrote {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
