# Prototype limitations

**Read this before using BreadGuard AI with real samples.**

This document states plainly what the system has been shown to do, what it has
not, and what would have to be true before any of its output could support a
laboratory decision.

---

## The one-sentence version

The system measures the colour of a photograph and names the nearest step on a
colour chart. It does not measure a concentration, and nothing in it
establishes that the chart's labels mean anything for your samples.

---

## 1. The shipped reference chart is an illustration

The seeded reference data was extracted from an **AI-generated illustration**
of a bromate colour chart — the image carries a "Made with AI" watermark. The
extraction is honest about itself: see
`infrastructure/scripts/extract_reference_colors.py`, which records the source
image and marks every level `ILLUSTRATIVE`.

Reading pixels off a picture tells you what the picture looks like. It
establishes:

- ❌ no relationship between colour and bromate concentration
- ❌ no relationship valid for any particular sample matrix
- ❌ no calibration, in any sense of the word

The six labelled steps (0, 0.1, 0.5, 1, 5, 10 ppm) are **interface examples**.
They demonstrate what a configured chart looks like. They are not a standard.

**What would fix this**: prepare standards of known concentration using your
validated method, photograph or measure them under controlled conditions, and
enter those values as a chart marked `VALIDATED`.

---

## 2. No chemistry is supplied

The system has no opinion about:

- which reagent produces the colour
- how the sample should be extracted or diluted
- how long the reaction should develop before photographing
- what concentration would be of regulatory concern

The seeded test method records these as `NOT SET` rather than inventing them.
`procedureReference` and `reagentNotes` are free-text fields for *your* SOP.

A colour measured from a reaction you have not characterised is a number
without a meaning.

---

## 3. No predictive model has been validated

The active model is `baseline-color-analysis`, which is **not a trained
model**. It computes a CIEDE2000 distance between the measured colour and each
reference level and reports the nearest.

It deliberately returns:

- `estimatedConcentration: null` — a concentration would require a validated
  colour-to-concentration relationship, which does not exist here
- `confidence: null` — a colour distance is a distance, not a probability.
  Presenting one as the other would be the single most misleading thing this
  service could do

This is enforced by a database CHECK constraint
(`analysis_mode_confidence_chk` in migration 0005), not only by application
code, so no code path can route around it.

---

## 4. Colour measurement is device- and lighting-dependent

This is the deepest limitation, and it does not go away with better software.

Without a known colour reference in the frame, there is no way to correct for
the light source. The same tube photographed:

- under tungsten light versus daylight
- on two different phones
- with automatic white balance making different decisions

will produce **different** CIELAB values. The pipeline reports this as an
informational `missing_calibration` warning on **every** image where no colour
reference was present — it is the normal case, and it is never silent.

**What would reduce this**: include a known colour standard in every frame and
correct against it; or use a controlled imaging rig with fixed lighting; or
both.

---

## 5. Known failure modes

These are verified in the test suite, not hypothesised.

### A colourless solution against a white background cannot be measured

A 0 ppm blank is nearly the same colour as a white background. Contrast drops
to near zero, and there is no reliable way to tell the tube from what is
behind it.

The system **refuses** rather than guessing — it returns
`status: REJECTED_QUALITY`. That is the correct behaviour: a confident "No
Bromate" that happened to be right by luck is worse than an honest refusal.

Verified by `test_colourless_tube_on_white_is_rejected_not_guessed`.

**Mitigation**: photograph against a contrasting background. A mid-grey bench
works.

### Automatic tube detection has two strategies and both can fail

1. **Saturation-based** — finds a coloured liquid column. Blind to colourless
   solutions.
2. **Background-contrast** — finds anything differing from the frame border.
   Catches the blank, but also picks up the glass, so it insets further and
   reports lower confidence.

When both fail, the pipeline falls back to a **central crop** reported as
`CENTER_FALLBACK` with confidence 0.2, and raises an
`uncertain_boundaries` warning. It does not pretend to have found a tube.

**Mitigation**: supply a manual region of interest. A human looking at the
tube beats any heuristic here, which is why `MANUAL_SELECTION` always wins.

### Ambiguous matches are flagged, not resolved

When two reference levels sit within 2.0 ΔE of the measurement, the match
between them is not supported by the data. The result carries
`ambiguous: true` and a note naming both candidates.

### Out-of-range colours are extrapolations

When the measured colour falls beyond the ends of the ladder, `outOfRange` is
set. The nearest level is then an extrapolation, not an interpolation, and
should be treated accordingly.

---

## 6. What the system *has* been shown to do

Verified, not claimed:

| Property | How |
|---|---|
| CIEDE2000 is implemented correctly | 18 published test vectors, cross-checked against scikit-image, asserted in **both** TypeScript and Python |
| The two implementations agree | Same vectors, both suites |
| It measures the colour that is in the tube | Synthetic tubes of known colour measure within 5 ΔE |
| It matches the right level | All six ladder colours match their own level |
| It masks glare | Measurements hold with a specular strip present |
| It refuses unusable images | Blur, under/overexposure, clipping, low contrast |
| It never emits a concentration in prototype mode | Asserted across every ladder colour |
| Laboratories are isolated | Cross-laboratory reads return 404 |
| Uploads are validated on content | Text-as-PNG, SVG, truncated and bomb images all rejected |
| EXIF is stripped from derivatives | Asserted on the derivative's metadata |

---

## 7. Before this is used for real decisions

A laboratory would need to:

1. **Define the method.** Reagent, preparation, dilution, reaction timing,
   matrix. Record it against the test method and move it off `DRAFT`.
2. **Build a real reference chart.** Prepared standards of known
   concentration, measured under controlled conditions, entered as
   `VALIDATED` with an attributed reviewer.
3. **Establish performance.** Limit of detection, limit of quantitation,
   measurement uncertainty, and the matrix the method is valid for.
4. **Control the imaging.** Fixed lighting, or a colour reference in frame.
5. **Collect ground truth.** Confirmed measurements from a validated
   analytical method — not technician opinion. The system tracks these
   separately for exactly this reason.
6. **Validate any model** against that ground truth before approving it. The
   release checks (macro F1, per-class support, test-set size) are a floor,
   not a validation study.

Until then, the system is a workflow and a measurement tool, operating in a
mode that is explicit about being unvalidated.

---

## 8. How the system communicates its own limits

Rather than relying on a disclaimer nobody reads, the constraints are
structural:

- `analysis_results.mode` is **stored**, so a reference-matching result can
  never later be read as model inference.
- `model_validated` is denormalised at write time, capturing whether the model
  was validated *then*, not now.
- `limitations` is assembled per result from the actual validation state of
  the method, chart and model.
- `isConfirmedMeasurement` is always `false` on an analysis.
- Confirmed concentrations live in a **separate table** with their own method,
  uncertainty and provenance.
- A technician can record a measurement but cannot mark it confirmed.
- A reviewer cannot approve their own annotation.

The intent is that the honest answer is the one the system makes easiest to
produce.
