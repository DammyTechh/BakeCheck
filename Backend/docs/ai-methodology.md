# AI methodology

What the vision pipeline does, why each choice was made, and what none of it
establishes.

---

## The pipeline

```
1. Decode and validate   reject unusable input early, with an actionable reason
2. Detect the region     measure the solution, not the photograph
3. Extract colour        robust statistics, not one RGB average
4. Assess quality        informed by what the region actually contained
5. Match the reference   transparent, inspectable colour distance
6. Model inference       through a replaceable interface
```

Quality assessment runs **after** region extraction, not before. The most
informative quality signal is how uniform the measured region was — and that
cannot be known until the region has been measured. A wide colour spread means
the region contained more than the solution: tube edge, label, background.

---

## Stage 1 — Decoding

Pillow under explicit limits, rather than handing bytes to OpenCV. Pillow
surfaces malformed input as an exception; OpenCV returns a partially decoded
array, which would produce a colour measurement that looks valid and is not.

EXIF rotation is applied **before** anything records coordinates, so a region
of interest refers to the same pixels the technician saw.

---

## Stage 2 — Region of interest

Three strategies, in order:

1. **`MANUAL_SELECTION`** — the operator drew a box. Always wins. A human
   looking at the tube beats any heuristic.
2. **`AUTO_TUBE_DETECTION`** — two passes:
   - *saturation*: a coloured liquid column is more saturated than a bench or
     a sheet of paper, and saturation is far less sensitive to exposure
     differences than lightness;
   - *background contrast*: for a colourless blank, which the saturation pass
     cannot see at all. Finds what differs from the frame border in CIELAB.
3. **`CENTER_FALLBACK`** — a central crop, reported with confidence 0.2 and an
   `uncertain_boundaries` warning. It does not pretend to have found a tube.

Detected boxes are inset to clear the glass wall and the meniscus, which are
the two places most likely to contaminate the colour.

### Masking inside the region

Removed before measurement:

- **specular highlights** — bright and nearly colourless; these show the light
  source, not the solution;
- **clipped pixels** — colour information is gone and no processing recovers
  it;
- **lightness outliers** by IQR — catches tube edges and bubbles that survived
  the inset.

If masking would remove almost everything, it gives up and keeps all pixels. A
measurement over the whole region with a warning is more useful than no
measurement.

---

## Stage 3 — Colour extraction

**Median, not mean.** A single specular highlight shifts a mean noticeably;
the median barely moves. Glass tubes guarantee highlights. The mean is still
recorded — a large gap between mean and median is itself evidence that the
region was not uniform.

**Statistics, not a single value.** A lone RGB triple cannot tell you whether
the region was a clean solution colour or a mixture. The spread (σ, IQR) is
what makes that visible, and it feeds the quality assessment.

**Per-pixel conversion, then aggregation.** The sRGB transfer function is
non-linear, so converting each pixel to Lab and taking the median differs from
taking the median RGB and converting once. The per-pixel route reflects what
was actually photographed.

**Circular median for hue.** A plain median of 359°, 1°, 2° gives 2°; the
answer is about 0.7°. Hue is converted to unit vectors, averaged, and
converted back.

---

## Stage 4 — Quality assessment

| Check | Signal | Why it matters |
|---|---|---|
| Blur | Variance of Laplacian | Smears colour across boundaries |
| Exposure | Mean channel value | Compresses or destroys colour differences |
| Clipping | Fraction at 0 or 255 | Colour information is unrecoverable |
| Contrast | σ of luminance | Tube indistinguishable from background |
| Glare | Bright, low-chroma fraction | Those pixels show the lamp |
| Region uniformity | Lab spread in the region | Region contained more than solution |
| Calibration | Colour reference present? | **Always reported when absent** |

Any `CRITICAL` warning makes the image unusable, and the pipeline stops at
`rejected_quality` — returning the measurement with **no prediction**. Forcing
a classification out of an image whose colour information is gone is precisely
the failure this service is built to avoid.

> Every threshold is a conservative engineering heuristic, **not** a validated
> specification. They live in `QualityThresholds` so a laboratory can tune
> them, and the values used are recorded with each measurement.

---

## Stage 5 — Reference matching

**CIEDE2000, not Euclidean distance in Lab (CIE76).**

Lab is not perceptually uniform in practice. CIE76 overstates differences
among saturated blues — exactly where a bromate ladder lives. For the seeded
1 ppm and 5 ppm colours, CIE76 reports ≈42.4 against CIEDE2000's ≈32.1, a 32%
gap. Using CIE76 would systematically distort which level a borderline sample
matches.

The implementation follows Sharma, Wu & Dalal (2005) including the
hue-rotation term, and is verified against 18 published vectors in **both**
languages.

Returned with every match:

- the closest level and its distance
- the runners-up, with their distances — a result where the top two differ by
  0.3 ΔE deserves very different treatment from one where they differ by 15
- `ambiguous` when the top two are within 2.0 ΔE
- `outOfRange` when the colour sits beyond the ends of the ladder

### Out-of-range detection

The measured colour is projected onto the line between the first and last
levels. A projection parameter outside [-0.1, 1.1] means it is lighter than
the lightest standard or darker than the darkest, so the nearest level is an
extrapolation.

Using the endpoints rather than per-axis bounds keeps this meaningful for
ladders that are not monotonic in a*/b* — the seeded bromate chart is
monotonic in L* but not in a*.

---

## Stage 6 — Model inference

A replaceable `PredictiveModel` interface. The prototype ships
`ReferenceMatcherModel`, which is **not a trained model** and says so.

It returns `estimatedConcentration: null` and `confidence: null`, because:

- a **concentration** would require a validated colour-to-concentration
  relationship for this method and matrix. A reference chart does not
  establish one.
- a **confidence** would require a calibrated probability. A CIEDE2000
  distance is a distance.

`SklearnClassifierModel` exists for when validated data arrives. It exposes
`predict_proba` as `confidence` **only** when the model was calibrated during
training — an uncalibrated classifier's probability output is not a reliable
confidence, and presenting it as one would repeat the exact mistake this
codebase is built to avoid.

### Why scikit-learn and not a neural network

A neural network trained on the data volumes this system will realistically
have — tens to low hundreds of labelled examples — would overfit, and its
confidence would be meaningless. Engineered colour features plus a transparent
classifier is both more honest and more inspectable: every input to the
decision is a number a chemist can read.

Training a network on six chart illustrations and presenting it as a detector
would be indefensible, and the architecture makes it hard to do by accident.

---

## Learning pipeline

Nothing becomes training data on its own.

```
upload → analysis → annotation → submitted → reviewed by SOMEONE ELSE
       → dataset_example (approved, authorised, not excluded)
       → dataset_version (frozen, checksummed, leakage-checked)
       → training → evaluation → HUMAN APPROVAL → release
```

Controls at each step:

- **Self-approval is blocked.** A reviewer cannot approve their own
  annotation. Checked on user id, not role.
- **Label provenance is tracked.** `label_source` distinguishes
  `TECHNICIAN_ANNOTATION` from `LABORATORY_MEASUREMENT`. Training can weight
  and filter on it.
- **Splits group by sample.** `group_key` keeps near-duplicate images of the
  same physical tube on one side of the train/test boundary — otherwise the
  score is inflated by leakage.
- **Datasets are frozen.** `dataset_versions` stores the ordered example ids
  and a content checksum, so a training run is reproducible.
- **Approval is human.** `is_active` cannot be set without `approved_by` — a
  database CHECK constraint, not just application code.

### Release criteria

| Check | Floor | Why |
|---|---|---|
| Test-set size | ≥ 30 | Below this the estimate is noise |
| Macro F1 | ≥ 0.6 | **Not accuracy** |
| Per-class support | ≥ 5 | A class with 2 examples has no measured performance |

Accuracy is recorded but is never the criterion. On an imbalanced dataset a
model that always predicts the majority class scores well on accuracy and is
useless.

An administrator may override with `overrideReason`, which is written to the
audit log alongside the specific blockers. The point is that the decision is
deliberate and attributable, not that it is impossible.

---

## What none of this establishes

Read `prototype-limitations.md`. In short: the pipeline measures colour
correctly and matches it transparently. Whether a colour *means* a
concentration depends on chemistry, calibration and imaging conditions that
live outside this software.
