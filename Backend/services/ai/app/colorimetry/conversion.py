"""
Colour-space conversion and perceptual distance.

Mirrors `apps/api/src/common/color/color-conversion.ts`. The duplication is
deliberate: the API needs to convert a manually entered RGB value without a
round trip to this service, and this service needs to convert measured pixels
without a round trip to the API. Both are verified against the same CIEDE2000
test vectors (see tests/test_colorimetry.py), so they are proven to agree
rather than assumed to.

Everything assumes sRGB primaries and a D65 white point, which is what
consumer cameras and screens produce. That assumption is itself a limitation:
without a colour-managed capture path, two devices photographing the same tube
will not report the same Lab value. See docs/ai-methodology.md.
"""
from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

# D65 white point, 2° standard observer.
D65_WHITE = np.array([0.95047, 1.00000, 1.08883], dtype=np.float64)

# CIE standard constants (CIE 15:2004).
EPSILON = 216.0 / 24389.0
KAPPA = 24389.0 / 27.0

# IEC 61966-2-1 sRGB → XYZ matrix (D65).
SRGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)

XYZ_TO_SRGB = np.array(
    [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ],
    dtype=np.float64,
)


def srgb_to_linear(channel: NDArray[np.float64]) -> NDArray[np.float64]:
    """Undo the sRGB transfer function. Input in [0, 1]."""
    return np.where(
        channel <= 0.04045,
        channel / 12.92,
        np.power((channel + 0.055) / 1.055, 2.4),
    )


def linear_to_srgb(channel: NDArray[np.float64]) -> NDArray[np.float64]:
    """Apply the sRGB transfer function. Output in [0, 1]."""
    return np.where(
        channel <= 0.0031308,
        channel * 12.92,
        1.055 * np.power(np.clip(channel, 0.0, None), 1.0 / 2.4) - 0.055,
    )


def rgb_to_xyz(rgb: NDArray[np.float64]) -> NDArray[np.float64]:
    """
    sRGB (0-255) → CIE XYZ.

    Accepts a single colour of shape (3,) or an array of shape (..., 3), so the
    same function serves both a reference patch and a whole image region.
    """
    normalised = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = srgb_to_linear(normalised)
    return linear @ SRGB_TO_XYZ.T


def xyz_to_lab(xyz: NDArray[np.float64]) -> NDArray[np.float64]:
    """CIE XYZ → CIELAB under D65."""
    ratio = np.asarray(xyz, dtype=np.float64) / D65_WHITE
    f = np.where(
        ratio > EPSILON,
        np.cbrt(np.clip(ratio, 0.0, None)),
        (KAPPA * ratio + 16.0) / 116.0,
    )

    lightness = 116.0 * f[..., 1] - 16.0
    a_star = 500.0 * (f[..., 0] - f[..., 1])
    b_star = 200.0 * (f[..., 1] - f[..., 2])

    return np.stack([lightness, a_star, b_star], axis=-1)


def rgb_to_lab(rgb: NDArray[np.float64]) -> NDArray[np.float64]:
    """sRGB (0-255) → CIELAB. The conversion used for every measurement."""
    return xyz_to_lab(rgb_to_xyz(rgb))


def lab_to_xyz(lab: NDArray[np.float64]) -> NDArray[np.float64]:
    """CIELAB → CIE XYZ under D65."""
    lab = np.asarray(lab, dtype=np.float64)
    lightness = lab[..., 0]
    a_star = lab[..., 1]
    b_star = lab[..., 2]

    fy = (lightness + 16.0) / 116.0
    fx = a_star / 500.0 + fy
    fz = fy - b_star / 200.0

    def inverse_f(value: NDArray[np.float64]) -> NDArray[np.float64]:
        cubed = np.power(value, 3)
        return np.where(cubed > EPSILON, cubed, (116.0 * value - 16.0) / KAPPA)

    x = inverse_f(fx)
    y = np.where(
        lightness > KAPPA * EPSILON,
        np.power((lightness + 16.0) / 116.0, 3),
        lightness / KAPPA,
    )
    z = inverse_f(fz)

    return np.stack([x, y, z], axis=-1) * D65_WHITE


def lab_to_rgb(lab: NDArray[np.float64]) -> NDArray[np.float64]:
    """CIELAB → sRGB (0-255), clipped to the displayable gamut."""
    xyz = lab_to_xyz(lab)
    linear = xyz @ XYZ_TO_SRGB.T
    srgb = linear_to_srgb(linear)
    return np.clip(srgb * 255.0, 0, 255)


def delta_e_2000(lab1: NDArray[np.float64], lab2: NDArray[np.float64]) -> float:
    """
    CIEDE2000 colour difference between two CIELAB colours.

    Used instead of Euclidean distance in Lab (CIE76) because Lab is not
    perceptually uniform in practice. CIE76 badly overstates differences among
    saturated blues — exactly the region a bromate colour ladder occupies — so
    using it would systematically distort which reference level a sample
    matches.

    Follows Sharma, Wu & Dalal (2005), including the hue-rotation term R_T,
    with weighting factors k_L = k_C = k_H = 1.
    """
    lab1 = np.asarray(lab1, dtype=np.float64).reshape(3)
    lab2 = np.asarray(lab2, dtype=np.float64).reshape(3)

    l1, a1, b1 = lab1
    l2, a2, b2 = lab2

    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    c_bar = (c1 + c2) / 2.0

    # G boosts a* in the low-chroma region, where Lab's non-uniformity is worst.
    c_bar_7 = c_bar**7
    g = 0.5 * (1.0 - np.sqrt(c_bar_7 / (c_bar_7 + 25.0**7)))

    a1_prime = (1.0 + g) * a1
    a2_prime = (1.0 + g) * a2

    c1_prime = np.hypot(a1_prime, b1)
    c2_prime = np.hypot(a2_prime, b2)

    # atan2(0, 0) is defined as 0 here, per the standard.
    h1_prime = 0.0 if (a1_prime == 0 and b1 == 0) else np.degrees(np.arctan2(b1, a1_prime)) % 360.0
    h2_prime = 0.0 if (a2_prime == 0 and b2 == 0) else np.degrees(np.arctan2(b2, a2_prime)) % 360.0

    delta_l_prime = l2 - l1
    delta_c_prime = c2_prime - c1_prime

    # The 0°/360° wrap: the shorter way round the hue circle.
    if c1_prime * c2_prime == 0:
        delta_h_prime_deg = 0.0
    elif abs(h2_prime - h1_prime) <= 180.0:
        delta_h_prime_deg = h2_prime - h1_prime
    elif h2_prime - h1_prime > 180.0:
        delta_h_prime_deg = h2_prime - h1_prime - 360.0
    else:
        delta_h_prime_deg = h2_prime - h1_prime + 360.0

    delta_h_prime = (
        2.0 * np.sqrt(c1_prime * c2_prime) * np.sin(np.radians(delta_h_prime_deg) / 2.0)
    )

    l_bar_prime = (l1 + l2) / 2.0
    c_bar_prime = (c1_prime + c2_prime) / 2.0

    if c1_prime * c2_prime == 0:
        h_bar_prime = h1_prime + h2_prime
    elif abs(h1_prime - h2_prime) <= 180.0:
        h_bar_prime = (h1_prime + h2_prime) / 2.0
    elif h1_prime + h2_prime < 360.0:
        h_bar_prime = (h1_prime + h2_prime + 360.0) / 2.0
    else:
        h_bar_prime = (h1_prime + h2_prime - 360.0) / 2.0

    t = (
        1.0
        - 0.17 * np.cos(np.radians(h_bar_prime - 30.0))
        + 0.24 * np.cos(np.radians(2.0 * h_bar_prime))
        + 0.32 * np.cos(np.radians(3.0 * h_bar_prime + 6.0))
        - 0.20 * np.cos(np.radians(4.0 * h_bar_prime - 63.0))
    )

    delta_theta = 30.0 * np.exp(-(((h_bar_prime - 275.0) / 25.0) ** 2))
    c_bar_prime_7 = c_bar_prime**7
    r_c = 2.0 * np.sqrt(c_bar_prime_7 / (c_bar_prime_7 + 25.0**7))
    r_t = -r_c * np.sin(np.radians(2.0 * delta_theta))

    l_offset_sq = (l_bar_prime - 50.0) ** 2
    s_l = 1.0 + (0.015 * l_offset_sq) / np.sqrt(20.0 + l_offset_sq)
    s_c = 1.0 + 0.045 * c_bar_prime
    s_h = 1.0 + 0.015 * c_bar_prime * t

    term_l = delta_l_prime / s_l
    term_c = delta_c_prime / s_c
    term_h = delta_h_prime / s_h

    return float(
        np.sqrt(term_l**2 + term_c**2 + term_h**2 + r_t * term_c * term_h)
    )


def delta_e_76(lab1: NDArray[np.float64], lab2: NDArray[np.float64]) -> float:
    """Euclidean distance in CIELAB (CIE76). Kept for comparison and tests."""
    first = np.asarray(lab1, dtype=np.float64)
    second = np.asarray(lab2, dtype=np.float64)
    return float(np.linalg.norm(first - second))


def rgb_to_hsv(rgb: NDArray[np.float64]) -> NDArray[np.float64]:
    """
    sRGB (0-255) → HSV with H in [0, 360), S and V in [0, 1].

    Implemented here rather than via cv2.cvtColor so the output ranges are
    explicit and consistent with what is stored in the database; OpenCV uses
    H in [0, 180] for 8-bit input, which is a recurring source of confusion.
    """
    arr = np.asarray(rgb, dtype=np.float64) / 255.0
    maximum = arr.max(axis=-1)
    minimum = arr.min(axis=-1)
    delta = maximum - minimum

    hue = np.zeros_like(maximum)
    mask = delta > 1e-12

    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

    red_max = mask & (maximum == r)
    green_max = mask & (maximum == g) & ~red_max
    blue_max = mask & (maximum == b) & ~red_max & ~green_max

    with np.errstate(divide="ignore", invalid="ignore"):
        hue = np.where(red_max, 60.0 * (((g - b) / delta) % 6.0), hue)
        hue = np.where(green_max, 60.0 * (((b - r) / delta) + 2.0), hue)
        hue = np.where(blue_max, 60.0 * (((r - g) / delta) + 4.0), hue)

    saturation = np.where(maximum > 1e-12, delta / maximum, 0.0)

    return np.stack([hue % 360.0, saturation, maximum], axis=-1)


def describe_distance(delta_e: float) -> str:
    """
    Plain-language band for a CIEDE2000 value.

    A readability aid for the UI, not a scientific threshold. Do not use these
    bands to decide whether a match is acceptable.
    """
    if delta_e < 1.0:
        return "indistinguishable to the human eye"
    if delta_e < 2.0:
        return "very close"
    if delta_e < 5.0:
        return "close"
    if delta_e < 10.0:
        return "noticeably different"
    return "clearly different"
