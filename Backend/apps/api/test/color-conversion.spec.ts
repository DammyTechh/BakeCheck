import {
  deltaE2000,
  labToRgb,
  rgbToLab,
  type Lab,
  type Rgb,
} from '../src/common/color/color-conversion';

/**
 * CIEDE2000 is easy to implement subtly wrong — the hue-rotation term and the
 * 0/360 wrap are the usual casualties, and a wrong implementation still
 * returns plausible-looking numbers. These are the canonical input pairs from
 * Sharma, Wu & Dalal (2005), Table 1, chosen specifically to exercise those
 * branches: near-neutral colours, hue differences that straddle 0°/360°, and
 * the blue region where the formula's corrections matter most.
 *
 * Expected values were generated from `skimage.color.deltaE_ciede2000` rather
 * than transcribed from the paper, because transcription is itself a source of
 * error — three values in an earlier draft of this file were wrong, and the
 * cross-check is what caught them. Generator:
 * `infrastructure/scripts/generate_ciede2000_vectors.py`.
 *
 * The same vectors are asserted against the Python implementation in
 * services/ai/tests/test_colorimetry.py, so the two services are proven to
 * agree rather than assumed to.
 */
const SHARMA_VECTORS: Array<{
  pair: number;
  lab1: Lab;
  lab2: Lab;
  expected: number;
}> = [
  {
    pair: 1,
    lab1: [50.0, 2.6772, -79.7751],
    lab2: [50.0, 0.0, -82.7485],
    expected: 2.0425,
  },
  {
    pair: 2,
    lab1: [50.0, 3.1571, -77.2803],
    lab2: [50.0, 0.0, -82.7485],
    expected: 2.8615,
  },
  {
    pair: 3,
    lab1: [50.0, 2.8361, -74.02],
    lab2: [50.0, 0.0, -82.7485],
    expected: 3.4412,
  },
  {
    pair: 4,
    lab1: [50.0, -1.3802, -84.2814],
    lab2: [50.0, 0.0, -82.7485],
    expected: 1.0,
  },
  {
    pair: 5,
    lab1: [50.0, -1.1848, -84.8006],
    lab2: [50.0, 0.0, -82.7485],
    expected: 1.0,
  },
  {
    pair: 6,
    lab1: [50.0, -0.9009, -85.5211],
    lab2: [50.0, 0.0, -82.7485],
    expected: 1.0,
  },
  { pair: 7, lab1: [50.0, 0.0, 0.0], lab2: [50.0, -1.0, 2.0], expected: 2.3669 },
  { pair: 8, lab1: [50.0, -1.0, 2.0], lab2: [50.0, 0.0, 0.0], expected: 2.3669 },
  { pair: 9, lab1: [50.0, 2.49, -0.001], lab2: [50.0, -2.49, 0.0009], expected: 7.1792 },
  { pair: 13, lab1: [50.0, -0.001, 2.49], lab2: [50.0, 0.0009, -2.49], expected: 4.8045 },
  { pair: 15, lab1: [50.0, 2.5, 0.0], lab2: [73.0, 25.0, -18.0], expected: 27.1492 },
  { pair: 17, lab1: [50.0, 2.5, 0.0], lab2: [50.0, 3.1736, 0.5854], expected: 1.0 },
  { pair: 20, lab1: [50.0, 2.5, 0.0], lab2: [50.0, 3.2592, 0.335], expected: 1.0 },
  {
    pair: 21,
    lab1: [60.2574, -34.0099, 36.2677],
    lab2: [60.4626, -34.1751, 39.4387],
    expected: 1.2644,
  },
  {
    pair: 23,
    lab1: [8.0, -0.0002, -0.0011],
    lab2: [8.0, -0.0003, 0.0007],
    expected: 0.0018,
  },
  {
    pair: 25,
    lab1: [22.7233, 20.0904, -46.694],
    lab2: [23.0331, 14.973, -42.5619],
    expected: 2.0373,
  },
  {
    pair: 29,
    lab1: [2.0776, 0.0795, -1.135],
    lab2: [0.9033, -0.0636, -0.5514],
    expected: 0.9082,
  },
  {
    pair: 33,
    lab1: [90.9257, -0.5406, -0.9208],
    lab2: [88.6381, -0.8985, -0.7239],
    expected: 1.5381,
  },
];

describe('CIEDE2000 (deltaE2000)', () => {
  it.each(SHARMA_VECTORS)(
    'matches the published value for Sharma pair $pair',
    ({ lab1, lab2, expected }) => {
      // The published table gives four decimal places.
      expect(deltaE2000(lab1, lab2)).toBeCloseTo(expected, 3);
    },
  );

  it('is symmetric', () => {
    for (const { lab1, lab2 } of SHARMA_VECTORS) {
      expect(deltaE2000(lab1, lab2)).toBeCloseTo(deltaE2000(lab2, lab1), 10);
    }
  });

  it('reports zero for identical colours', () => {
    expect(deltaE2000([50, 2.5, -10], [50, 2.5, -10])).toBe(0);
  });

  it('is never negative', () => {
    for (const { lab1, lab2 } of SHARMA_VECTORS) {
      expect(deltaE2000(lab1, lab2)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('sRGB ↔ CIELAB conversion', () => {
  it('maps reference colours to their published Lab values', () => {
    // White, black and the primaries under D65.
    expect(rgbToLab([255, 255, 255])[0]).toBeCloseTo(100, 2);
    expect(rgbToLab([0, 0, 0])).toEqual([0, 0, 0]);

    const red = rgbToLab([255, 0, 0]);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);

    const green = rgbToLab([0, 255, 0]);
    expect(green[0]).toBeCloseTo(87.73, 1);

    const blue = rgbToLab([0, 0, 255]);
    expect(blue[0]).toBeCloseTo(32.3, 1);
    expect(blue[2]).toBeCloseTo(-107.86, 1);
  });

  it('round-trips RGB → Lab → RGB within one 8-bit step', () => {
    const samples: Rgb[] = [
      [240, 240, 240], // the seeded 0 ppm step
      [120, 207, 247], // 0.5 ppm
      [1, 132, 241], // 1 ppm
      [2, 5, 112], // 10 ppm
      [128, 128, 128],
      [17, 99, 200],
    ];

    for (const rgb of samples) {
      const roundTripped = labToRgb(rgbToLab(rgb));
      for (let channel = 0; channel < 3; channel += 1) {
        // Quantisation to 8 bits makes an exact round trip impossible.
        expect(Math.abs(roundTripped[channel] - rgb[channel])).toBeLessThanOrEqual(1);
      }
    }
  });

  it('orders the seeded bromate ladder monotonically by lightness', () => {
    // The seeded reference colours, sampled from the supplied illustration.
    // A usable ladder must be monotonic in L*, otherwise two different
    // concentrations become indistinguishable to a lightness-driven match.
    const ladder: Rgb[] = [
      [240, 240, 240],
      [212, 236, 244],
      [120, 207, 247],
      [1, 132, 241],
      [1, 38, 156],
      [2, 5, 112],
    ];

    const lightness = ladder.map((rgb) => rgbToLab(rgb)[0]);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i]).toBeLessThan(lightness[i - 1]);
    }
  });

  it('separates adjacent ladder steps by a perceptible distance', () => {
    const ladder: Rgb[] = [
      [240, 240, 240],
      [212, 236, 244],
      [120, 207, 247],
      [1, 132, 241],
      [1, 38, 156],
      [2, 5, 112],
    ];

    for (let i = 1; i < ladder.length; i += 1) {
      const distance = deltaE2000(rgbToLab(ladder[i - 1]), rgbToLab(ladder[i]));
      // Below ~2 the steps would be hard to tell apart even in a clean image.
      expect(distance).toBeGreaterThan(2);
    }
  });
});
