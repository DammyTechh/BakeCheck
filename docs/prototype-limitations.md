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

The chart's six patches **carry no concentration figures at all**, and are
named for their colour — "Chart patch 5 — deep blue" — rather than for a
level. Both of those were changed on 16 October 2026, and the reason is worth
reading before anyone presents a result.

**What would fix this**: prepare standards of known concentration using your
validated method, photograph or measure them under controlled conditions, and
enter those values as a chart marked `VALIDATED`.

---

## 1a. The chart IS the laboratory's scale

On 16 October 2026 the laboratory supplied its reporting scale: sixteen
points from 0 ("Negative") to 1000 ("Extremely High"). The reference chart is
now built from exactly those sixteen points -- same ppm values, same wording.

There is one vocabulary, not two. A chart level *is* a point on the scale, and
`test/interpretation-scale.spec.ts` fails if the seed and the scale drift
apart.

This replaced an arrangement that was actively dangerous. The chart had been
built from an illustration with its own figures (0-10 ppm) and its own labels
-- "High Level" at 5 ppm, "Very High Level" at 10. Those are the laboratory's
words for 200 and 250 ppm. All four real tube photographs matched those two
levels, so the screen said "Very High Level" for a tube the chart numbered at
10 ppm, and anyone reading that against the scale would infer 250. A 25x
overstatement assembled from two artefacts that were each labelled correctly.

## 1b. The colours are now measured. The photography is not controlled.

On 13 November 2026 the laboratory photographed fifteen prepared standards of
known concentration, and the chart is rebuilt from them. Every colour is now
measured from a real tube at a real concentration — the thing the chart had
been missing since it was built.

It is still `ILLUSTRATIVE`, and the reason is the photography:

- the fifteen shots were taken at different times, by different hands, under
  different light, with **no grey card or colour reference in any frame**;
- each was white balanced against the sheet of paper behind the tube, which
  is a partial correction and not a calibration.

That is measurable, and is left visible rather than smoothed away:

- **four steps are non-monotonic** — 200, 250, 350 and 500 ppm each
  photographed *lighter* than the level below them;
- **three adjacent pairs sit within ΔE2000 5**, close to indistinguishable:
  20/30 (3.6), 50/100 (2.4), 400/500 (4.8).

Both track the shooting conditions, not the dilution series.

**450 ppm is not on the chart.** No standard was supplied for it. The scale
still defines "Very Severe" for a measured 450 ppm, but no colour can match
it, and interpolating its neighbours would produce a level that looks
measured and is not.

**To make this `VALIDATED`:** re-photograph all sixteen standards in one
session, one camera, fixed lighting, grey card in every frame.

---

## 1c. What the system refuses to report, and why

Running all fifteen standards back through the live pipeline is the only
honest test of the chart, and the first run failed badly: **1 of 10 correct**,
with a blank 0 ppm tube reported as "Extremely High".

The cause was not the chart. The region detector thresholded on *saturation*,
and in these photographs the most saturated things are the technician's
hands, a yellow sleeve and a purple checked shirt. It found the liquid in
**none** of them — it either grabbed one of those or fell through to a centre
crop, which on these photographs is the white paper behind the tube. The
pipeline measured paper and the screen reported a band for it.

Three changes:

1. **The detector looks for the hue the chart says the assay produces**,
   derived from the chart's own levels rather than hardcoded, so a chart for
   a different analyte brings its own. It now finds the liquid in 14 of 15.
2. **No tube found, no reading.** A `CENTER_FALLBACK` region means the
   middle of the frame was measured, which may be background. The band and
   its distance are shown; the ppm is withheld.
3. **No close level, no reading.** `MAX_PLAUSIBLE_DISTANCE` was 25 ΔE —
   wider than most of the chart. A blank matched 1000 ppm at 15.2 ΔE and read
   "Extremely High". It is now 12, above the gaps between levels that
   genuinely crowd together and below the distance at which a colour is
   simply somewhere else.

After those changes, across all fifteen standards:

| | |
|---|---|
| exact level | 9 |
| adjacent level | 4 |
| correctly withheld | 2 (0 ppm at ΔE 15.2, 500 ppm at ΔE 23.0) |
| **wrong and confident** | **0** |

The four adjacent misses are in the regions the chart itself cannot separate
(§1b). A reading there carries a limitation naming both levels.

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
