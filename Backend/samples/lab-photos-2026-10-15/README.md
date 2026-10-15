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

| File | Nearest band | ΔE (CIEDE2000) | Quality |
|---|---|---|---|
| `tube-1.jpg` | High Level | 14.09 | USABLE (0.80) |
| `tube-2.jpg` | High Level | 9.30 | USABLE (0.95) |
| `tube-3.jpg` | Very High Level | 12.54 | USABLE (0.80) |
| `tube-4.jpg` | Very High Level | 11.93 | USABLE (0.95) |

Those ΔE values are large. A match at ΔE 9–14 means "this is the closest of
the six bands", not "this is that band" — the colours sit between bands, or
outside the range the chart covers.

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
