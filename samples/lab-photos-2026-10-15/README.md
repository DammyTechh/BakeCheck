# Laboratory photographs, 15 October 2026

Four photographs of developed tubes, taken by the laboratory technician and
supplied for testing. They are the first real photographs this pipeline has
processed, and they found three genuine bugs in the focus check (commit
`05b20d5`).

## What these are useful for

Exercising the real path end to end: upload → quality assessment → region
detection → colour measurement → nearest band on the reference chart. All four
pass quality assessment and match a band.

Measured on the seeded chart:

| File | Reading | Nearest level | ΔE (CIEDE2000) |
|---|---|---|---|
| `tube-1.jpg` | 500 ppm · Intense | Intense | 11.61 |
| `tube-2.jpg` | 1000 ppm · Extremely High | Extremely High | 12.54 |
| `tube-3.jpg` | 400 ppm · Severe | Severe | 9.30 |
| `tube-4.jpg` | 350 ppm · Very Heavy | Very Heavy | 7.98 |

Measured against the sixteen-level chart built from the laboratory's own
scale, 16 October 2026.

**Those ppm figures are not measurements.** The chart's concentrations are the
laboratory's; its colours are interpolated from an illustration, so each
reading means "nearest level on an illustrative ladder". ΔE 8-13 is a visible
colour difference, which says the tubes sit between levels or outside the
range the ramp covers. See `docs/prototype-limitations.md` §1b.

## What these are NOT useful for

**Training, calibration, or validation.** No concentration is known for any of
them. Nobody recorded what was in each tube, by what method, or at what
dilution, so there is no ground truth to learn from or check against.

Feeding them to the training pipeline would teach a model to reproduce
whatever the current illustrative chart already says, which is circular. The
dataset builder refuses examples without a measurement-backed label for
exactly this reason, so they cannot be used that way by accident.

## What would make them usable

For each photograph, the concentration of the solution as determined by a
validated analytical method — plus the method, the preparation and dilution,
and the measurement uncertainty. With that, each becomes a labelled example
and can carry `label_source = LABORATORY_MEASUREMENT`.

Ten to twenty of those, spanning the range, would also replace the reference
chart itself, which currently carries colours sampled from an illustration and
is marked `ILLUSTRATIVE`.

## Provenance

Supplied over chat by the laboratory technician on 15 October 2026 with the
note "use this in your model so that we can test run". No concentration,
method or preparation details accompanied them.
