# Model validation

What must hold before a model is released, and why each check exists.

## Release criteria

| Check | Floor | Rationale |
|---|---|---|
| Test-set size | ≥ 30 | Below this, every metric is noise |
| Macro F1 | ≥ 0.6 | Treats every class equally |
| Per-class support | ≥ 5 | A class with 2 examples has no measured performance |
| Evaluation exists | required | Approving without one releases a model nobody measured |

These are **floors, not a validation study**. Clearing them means a model is
not obviously unsupportable. It does not mean it is fit for laboratory use.

## Why not accuracy

Accuracy is recorded and is never the criterion.

With an imbalanced dataset — which this will be, because most samples are
negative — a model that always predicts the majority class scores well on
accuracy and is useless. If 85% of samples are "No Bromate", predicting "No
Bromate" unconditionally gives 85% accuracy and catches nothing.

Macro F1 averages per-class F1 without weighting by frequency, so a class the
model never predicts drags the score down. That is the behaviour we want from
a release gate.

## What is recorded per evaluation

- Confusion matrix
- Per-class precision, recall, F1 and **support**
- Macro and weighted F1, balanced accuracy
- Regression metrics (MAE, RMSE, R²) when predicting a concentration
- Calibration (ECE, Brier) **when there is enough data to estimate them** —
  null otherwise, rather than a number computed from too few points
- Subgroup metrics by lighting, device and sample type where feasible
- `evaluation_limitations` — plain-language caveats shown to the administrator
  before they approve

Subgroup metrics matter more than the headline. A model that performs well
overall but fails on one device has learned that device, and the aggregate
hides it.

## Calibration

A model's confidence must mean something before it is shown to anyone.

`SklearnClassifierModel` exposes `predict_proba` as `confidence` **only** when
the model was calibrated during training. An uncalibrated classifier's
probability output is not a reliable confidence, and presenting it as one
would repeat exactly the mistake this codebase exists to avoid.

In reference-matching mode `confidence` is always null — a colour distance is
a distance, and the database enforces this with a CHECK constraint.

## Approval

Approval is a human act. `is_active` cannot be set without `approved_by` and
`approved_at`, enforced by `model_versions_active_requires_approval_chk` in
migration 0005. No code path approves a model automatically, and no quantity
of new data promotes one.

### Overrides

An administrator who disagrees with the criteria may approve anyway by
supplying `overrideReason`. The override, the reason and the **specific
blockers overridden** are written to the audit log.

The point is not to make bad releases impossible — it is to make them
deliberate and attributable. A gate that cannot be overridden gets worked
around; one that records who overrode it and why does not need to be.

## Rollback

`POST /api/v1/ai/models/{id}/rollback` stands the active model down and
reactivates its predecessor, falling back to the baseline reference matcher,
which always exists and is always safe to return to.

`reason` is required and stored permanently.

**Results produced by the withdrawn model are not altered.** They keep their
recorded model name, version and validation state. History must stay honest
about what produced it — retroactively relabelling past results would destroy
the audit trail precisely when it matters most.

## Before trusting a model

The release checks are a floor. A laboratory would still need:

1. A test set from **confirmed laboratory measurements**, not technician
   annotations
2. Examples spanning the devices, lighting and matrices of actual use
3. Enough per class to estimate per-class performance, not just compute it
4. Calibration assessed on held-out data
5. Performance characterised near the concentrations that matter for a
   decision — overall accuracy says nothing about behaviour at the threshold
6. A documented statement of what the model is and is not validated for

Until that exists, reference-matching mode is the honest default, and it is
what the system ships in.
