"""
Shared test fixtures.

Images here are generated, not photographed: a test suite must not depend on
binary fixtures whose contents nobody can review in a diff. The generators
produce images with known, controllable properties — a known colour, a known
blur, a known exposure — which is what makes the assertions meaningful.
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

# Make `app` importable without installing the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Settings require an internal key; supply one before anything imports config.
os.environ.setdefault("AI_INTERNAL_KEY", "test-internal-key-0123456789abcdef")
os.environ.setdefault("AI_DOCS_ENABLED", "true")

from app.reference_matching.matcher import ReferenceLevel

# The seeded bromate ladder, measured from the supplied illustration by
# infrastructure/scripts/extract_reference_colors.py. Reused here so the tests
# exercise the same values the application actually ships with.
BROMATE_LADDER_RGB: list[tuple[str, float, tuple[int, int, int]]] = [
    ("No Bromate", 0.0, (240, 240, 240)),
    ("Trace Amount", 0.1, (212, 236, 244)),
    ("Low Level", 0.5, (120, 207, 247)),
    ("Moderate Level", 1.0, (1, 132, 241)),
    ("High Level", 5.0, (1, 38, 156)),
    ("Very High Level", 10.0, (2, 5, 112)),
]


def encode_png(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(array.astype(np.uint8)).save(buffer, format="PNG")
    return buffer.getvalue()


def make_tube_image(
    solution_rgb: tuple[int, int, int],
    width: int = 400,
    height: int = 700,
    # A mid-grey bench, not white. A white background is the one case where a
    # colourless 0 ppm blank genuinely cannot be measured — see
    # test_detects_colourless_tube_against_a_contrasting_background and
    # docs/prototype-limitations.md.
    background_rgb: tuple[int, int, int] = (150, 152, 158),
    add_glare: bool = True,
    blur_radius: float = 0.0,
    brightness_scale: float = 1.0,
    sensor_noise: float = 2.0,
) -> np.ndarray:
    """
    Render a synthetic test tube: a tall liquid column of a known colour on a
    plain background, with optional glass glare.

    The glare strip matters — it is what the measurement mask has to remove,
    and a test without it would not exercise that code at all.

    `sensor_noise` adds a little Gaussian grain, because a perfectly flat
    render is not a photograph and nothing downstream should be tuned against
    one.

    Noise is applied BEFORE any blur, which is the order a camera imposes:
    light passes through the optics once, so a defocused frame has defocused
    grain. The earlier version blurred first and then laid sharp grain on top,
    which is physically impossible and quietly defeated the focus check — a
    fixture at `blur_radius=12` scored the same as a sharp one, and the real
    blur detector looked fine against it right up until real photographs
    arrived. A fixture that cannot be blurred is not a test.
    """
    image = Image.new("RGB", (width, height), background_rgb)
    draw = ImageDraw.Draw(image)

    tube_width = int(width * 0.34)
    tube_x0 = (width - tube_width) // 2
    tube_x1 = tube_x0 + tube_width
    tube_y0 = int(height * 0.12)
    tube_y1 = int(height * 0.88)

    # Glass wall.
    draw.rounded_rectangle(
        [tube_x0 - 6, tube_y0 - 6, tube_x1 + 6, tube_y1 + 6],
        radius=tube_width // 3,
        fill=(228, 230, 233),
        outline=(200, 203, 208),
        width=3,
    )

    # Liquid column, filling the lower portion.
    liquid_y0 = tube_y0 + int((tube_y1 - tube_y0) * 0.22)
    draw.rounded_rectangle(
        [tube_x0, liquid_y0, tube_x1, tube_y1],
        radius=tube_width // 3,
        fill=solution_rgb,
    )

    if add_glare:
        # A narrow specular strip down the left of the glass.
        glare_x0 = tube_x0 + int(tube_width * 0.10)
        glare_x1 = tube_x0 + int(tube_width * 0.22)
        draw.rounded_rectangle(
            [glare_x0, liquid_y0 + 20, glare_x1, tube_y1 - 40],
            radius=6,
            fill=(252, 252, 253),
        )

    array = np.asarray(image, dtype=np.float64)

    if sensor_noise > 0:
        # Seeded, so the suite stays deterministic.
        rng = np.random.default_rng(seed=1234)
        array = array + rng.normal(0.0, sensor_noise, array.shape)

    # Blur last, over the grain as well as the scene — see the docstring.
    if blur_radius > 0:
        image = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
        image = image.filter(ImageFilter.GaussianBlur(radius=blur_radius))
        array = np.asarray(image, dtype=np.float64)

    if brightness_scale != 1.0:
        array = array * brightness_scale

    return np.clip(array, 0, 255).astype(np.uint8)


@pytest.fixture
def reference_levels() -> list[ReferenceLevel]:
    """The seeded bromate ladder as ReferenceLevel objects."""
    from app.colorimetry.conversion import rgb_to_lab

    levels: list[ReferenceLevel] = []
    for index, (label, concentration, rgb) in enumerate(BROMATE_LADDER_RGB):
        lab = rgb_to_lab(np.array(rgb, dtype=np.float64))
        levels.append(
            ReferenceLevel(
                id=f"level-{index}",
                label=label,
                concentration_value=concentration,
                concentration_unit="ppm",
                sort_order=index,
                lab_l=float(lab[0]),
                lab_a=float(lab[1]),
                lab_b=float(lab[2]),
                lab_std=1.0,
            )
        )
    return levels


@pytest.fixture
def clean_tube_png() -> bytes:
    """A well-exposed, in-focus tube of the 0.5 ppm reference colour."""
    return encode_png(make_tube_image((120, 207, 247)))


@pytest.fixture
def blurry_tube_png() -> bytes:
    return encode_png(make_tube_image((120, 207, 247), blur_radius=12.0))


@pytest.fixture
def dark_tube_png() -> bytes:
    return encode_png(make_tube_image((120, 207, 247), brightness_scale=0.10))


@pytest.fixture
def overexposed_tube_png() -> bytes:
    return encode_png(make_tube_image((120, 207, 247), brightness_scale=2.6))
