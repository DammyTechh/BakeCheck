/**
 * Colour conversion and perceptual distance.
 *
 * Deliberately duplicated between here and the Python service
 * (`services/ai/app/colorimetry/conversion.py`), with a shared test vector set
 * so the two implementations are proven to agree. The alternative — one side
 * calling the other — would mean the API could not convert a manually entered
 * RGB value without a round trip to the vision service.
 *
 * All conversions assume sRGB primaries and a D65 white point, which is what
 * consumer cameras and screens produce. That assumption is itself a
 * limitation: without a colour-managed capture path, two devices photographing
 * the same tube will not report the same Lab value.
 */

export type Rgb = [number, number, number];
export type Lab = [number, number, number];
export type Xyz = [number, number, number];

/** D65 white point, 2° observer. */
const D65: Xyz = [0.95047, 1.0, 1.08883];

/** CIE standard constants. */
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

/** sRGB → linear RGB (undo the transfer function). */
function srgbToLinear(channel: number): number {
  const normalised = channel / 255;
  return normalised <= 0.04045
    ? normalised / 12.92
    : ((normalised + 0.055) / 1.055) ** 2.4;
}

/** linear RGB → sRGB. */
function linearToSrgb(channel: number): number {
  const value =
    channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

export function rgbToXyz(rgb: Rgb): Xyz {
  const [r, g, b] = rgb.map(srgbToLinear) as Rgb;
  // IEC 61966-2-1 sRGB → XYZ matrix (D65).
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

export function xyzToLab(xyz: Xyz): Lab {
  const f = xyz.map((value, index) => {
    const ratio = value / D65[index];
    return ratio > EPSILON ? Math.cbrt(ratio) : (KAPPA * ratio + 16) / 116;
  });

  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function rgbToLab(rgb: Rgb): Lab {
  return xyzToLab(rgbToXyz(rgb));
}

export function labToXyz(lab: Lab): Xyz {
  const [l, a, b] = lab;
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;

  const inverse = (f: number): number =>
    f ** 3 > EPSILON ? f ** 3 : (116 * f - 16) / KAPPA;

  const yr = l > KAPPA * EPSILON ? ((l + 16) / 116) ** 3 : l / KAPPA;

  return [inverse(fx) * D65[0], yr * D65[1], inverse(fz) * D65[2]];
}

export function labToRgb(lab: Lab): Rgb {
  const [x, y, z] = labToXyz(lab);
  // Inverse of the sRGB matrix above.
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

/**
 * CIEDE2000 colour difference.
 *
 * Used instead of plain Euclidean distance in Lab (CIE76) because Lab is not
 * perceptually uniform in practice — CIE76 badly overstates differences in
 * saturated blues, which is precisely the region this bromate ladder occupies.
 * Getting that wrong would systematically distort which reference level a
 * sample matches.
 *
 * Implementation follows Sharma, Wu & Dalal (2005), "The CIEDE2000
 * Color-Difference Formula", including the hue-rotation term.
 */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;

  const deg = (rad: number): number => (rad * 180) / Math.PI;
  const rad = (degrees: number): number => (degrees * Math.PI) / 180;

  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (c1 + c2) / 2;

  // G compensates a* for the lower chroma region.
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));

  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;

  const c1Prime = Math.sqrt(a1Prime * a1Prime + b1 * b1);
  const c2Prime = Math.sqrt(a2Prime * a2Prime + b2 * b2);

  const h1Prime =
    a1Prime === 0 && b1 === 0 ? 0 : (deg(Math.atan2(b1, a1Prime)) + 360) % 360;
  const h2Prime =
    a2Prime === 0 && b2 === 0 ? 0 : (deg(Math.atan2(b2, a2Prime)) + 360) % 360;

  const deltaLPrime = l2 - l1;
  const deltaCPrime = c2Prime - c1Prime;

  let deltahPrime: number;
  if (c1Prime * c2Prime === 0) {
    deltahPrime = 0;
  } else if (Math.abs(h2Prime - h1Prime) <= 180) {
    deltahPrime = h2Prime - h1Prime;
  } else if (h2Prime - h1Prime > 180) {
    deltahPrime = h2Prime - h1Prime - 360;
  } else {
    deltahPrime = h2Prime - h1Prime + 360;
  }

  const deltaHPrime = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(rad(deltahPrime) / 2);

  const lBarPrime = (l1 + l2) / 2;
  const cBarPrime = (c1Prime + c2Prime) / 2;

  let hBarPrime: number;
  if (c1Prime * c2Prime === 0) {
    hBarPrime = h1Prime + h2Prime;
  } else if (Math.abs(h1Prime - h2Prime) <= 180) {
    hBarPrime = (h1Prime + h2Prime) / 2;
  } else if (h1Prime + h2Prime < 360) {
    hBarPrime = (h1Prime + h2Prime + 360) / 2;
  } else {
    hBarPrime = (h1Prime + h2Prime - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos(rad(hBarPrime - 30)) +
    0.24 * Math.cos(rad(2 * hBarPrime)) +
    0.32 * Math.cos(rad(3 * hBarPrime + 6)) -
    0.2 * Math.cos(rad(4 * hBarPrime - 63));

  const deltaTheta = 30 * Math.exp(-(((hBarPrime - 275) / 25) ** 2));
  const cBarPrime7 = cBarPrime ** 7;
  const rc = 2 * Math.sqrt(cBarPrime7 / (cBarPrime7 + 25 ** 7));
  const rt = -rc * Math.sin(rad(2 * deltaTheta));

  const lBarPrimeMinus50Sq = (lBarPrime - 50) ** 2;
  const sl = 1 + (0.015 * lBarPrimeMinus50Sq) / Math.sqrt(20 + lBarPrimeMinus50Sq);
  const sc = 1 + 0.045 * cBarPrime;
  const sh = 1 + 0.015 * cBarPrime * t;

  // Weighting factors kL = kC = kH = 1 (reference conditions).
  const termL = deltaLPrime / sl;
  const termC = deltaCPrime / sc;
  const termH = deltaHPrime / sh;

  return Math.sqrt(termL * termL + termC * termC + termH * termH + rt * termC * termH);
}

/** Euclidean distance in Lab (CIE76). Retained for comparison and tests. */
export function deltaE76(lab1: Lab, lab2: Lab): number {
  return Math.sqrt(
    (lab2[0] - lab1[0]) ** 2 + (lab2[1] - lab1[1]) ** 2 + (lab2[2] - lab1[2]) ** 2,
  );
}

/**
 * Rough interpretation of a CIEDE2000 value, for display alongside a match.
 * These bands are a readability aid, not a scientific threshold.
 */
export function describeDistance(deltaE: number): string {
  if (deltaE < 1) return 'indistinguishable to the human eye';
  if (deltaE < 2) return 'very close';
  if (deltaE < 5) return 'close';
  if (deltaE < 10) return 'noticeably different';
  return 'clearly different';
}
