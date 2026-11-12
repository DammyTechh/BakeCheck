#!/usr/bin/env python3
"""
Generate CIEDE2000 test vectors from an independent implementation.

Both the Node API and the Python AI service implement CIEDE2000 themselves
(neither can call the other for a single colour comparison). Two independent
implementations need a shared, trustworthy oracle, and transcribing expected
values out of the Sharma paper by hand is a known source of error — three
values in an earlier draft of the TypeScript test were wrong, and only the
cross-check caught it.

So the expected values come from `skimage.color.deltaE_ciede2000`, a widely
used third-party implementation, rather than from manual transcription. The
*inputs* are the canonical pairs from Sharma, Wu & Dalal (2005), Table 1,
chosen to exercise the formula's awkward branches: near-neutral colours,
hue differences straddling 0°/360°, and the blue region.

Usage:
    pip install scikit-image numpy
    python3 generate_ciede2000_vectors.py --format ts
    python3 generate_ciede2000_vectors.py --format py
"""
from __future__ import annotations

import argparse
import sys

try:
    import numpy as np
    from skimage.color import deltaE_ciede2000
except ImportError:  # pragma: no cover - tooling guard
    sys.exit(
        "This script needs scikit-image and numpy:\n"
        "    pip install scikit-image numpy"
    )

# Sharma, Wu & Dalal (2005), Table 1 — input pairs only.
SHARMA_PAIRS: list[tuple[int, list[float], list[float]]] = [
    (1, [50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]),
    (2, [50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485]),
    (3, [50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485]),
    (4, [50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485]),
    (5, [50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485]),
    (6, [50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485]),
    (7, [50.0, 0.0, 0.0], [50.0, -1.0, 2.0]),
    (8, [50.0, -1.0, 2.0], [50.0, 0.0, 0.0]),
    (9, [50.0, 2.49, -0.001], [50.0, -2.49, 0.0009]),
    (13, [50.0, -0.001, 2.49], [50.0, 0.0009, -2.49]),
    (15, [50.0, 2.5, 0.0], [73.0, 25.0, -18.0]),
    (17, [50.0, 2.5, 0.0], [50.0, 3.1736, 0.5854]),
    (20, [50.0, 2.5, 0.0], [50.0, 3.2592, 0.335]),
    (21, [60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387]),
    (23, [8.0, -0.0002, -0.0011], [8.0, -0.0003, 0.0007]),
    (25, [22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619]),
    (29, [2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514]),
    (33, [90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239]),
]


def compute(lab1: list[float], lab2: list[float]) -> float:
    return float(deltaE_ciede2000(np.array([lab1]), np.array([lab2]))[0])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--format",
        choices=["ts", "py"],
        default="ts",
        help="Output as a TypeScript array or a Python list.",
    )
    args = parser.parse_args()

    if args.format == "ts":
        for pair, lab1, lab2 in SHARMA_PAIRS:
            expected = compute(lab1, lab2)
            print(
                f"  {{ pair: {pair}, lab1: {lab1}, lab2: {lab2}, "
                f"expected: {expected:.4f} }},"
            )
    else:
        for pair, lab1, lab2 in SHARMA_PAIRS:
            expected = compute(lab1, lab2)
            print(f"    ({pair}, {tuple(lab1)}, {tuple(lab2)}, {expected:.4f}),")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
