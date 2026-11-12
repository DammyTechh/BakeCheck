"""
Model evaluation.

Produces the report an administrator reads before deciding whether to release
a model. Three things shape it:

  1. **Accuracy is computed but is never the criterion.** On an imbalanced
     screening dataset — and this one will be overwhelmingly negative — a
     model that always predicts the majority class scores well on accuracy
     and catches nothing. Macro F1 and per-class recall are what matter.

  2. **The baseline is the reference matcher.** "Better than nothing" is not
     the bar; the bar is "better than the transparent colour-distance
     calculation we already have". A trained model that cannot beat it is not
     worth the loss of inspectability.

  3. **Limitations are computed, not boilerplate.** Thin classes, small test
     sets and absent calibration each produce a specific sentence naming the
     actual numbers.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
)

from ..datasets.schemas import DatasetExample, DatasetVersion, Split
from ..reference_matching.matcher import ReferenceLevel, match_reference
from ..training.trainer import TrainingResult

logger = logging.getLogger(__name__)


#: Release criteria. Conservative floors, not a validation study.
MIN_TEST_EXAMPLES = 30
MIN_TEST_PER_CLASS = 5
MIN_MACRO_F1 = 0.6
#: A trained model must beat the transparent baseline by at least this much
#: in macro F1 to justify giving up the baseline's inspectability.
MIN_IMPROVEMENT_OVER_BASELINE = 0.02


@dataclass
class EvaluationReport:
    split: str
    sample_size: int

    accuracy: float
    macro_f1: float
    weighted_f1: float
    balanced_accuracy: float

    confusion_matrix: dict[str, Any]
    per_class_metrics: dict[str, dict[str, float]]
    subgroup_metrics: dict[str, Any]
    baseline_comparison: dict[str, Any]

    expected_calibration_error: float | None
    brier_score: float | None

    evaluation_limitations: list[str]
    release_recommendation: str  # APPROVE | REJECT | INSUFFICIENT_DATA
    release_blockers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "split": self.split,
            "sample_size": self.sample_size,
            "accuracy": self.accuracy,
            "macro_f1": self.macro_f1,
            "weighted_f1": self.weighted_f1,
            "balanced_accuracy": self.balanced_accuracy,
            "confusion_matrix": self.confusion_matrix,
            "per_class_metrics": self.per_class_metrics,
            "subgroup_metrics": self.subgroup_metrics,
            "baseline_comparison": self.baseline_comparison,
            "expected_calibration_error": self.expected_calibration_error,
            "brier_score": self.brier_score,
            "evaluation_limitations": self.evaluation_limitations,
            "release_recommendation": self.release_recommendation,
            "release_blockers": self.release_blockers,
        }


def _expected_calibration_error(
    probabilities: np.ndarray, correct: np.ndarray, bins: int = 10
) -> float:
    """
    Expected calibration error: the average gap between a model's stated
    confidence and how often it is actually right at that confidence.

    A model that says "90% sure" and is right 60% of the time has an ECE that
    exposes it. Computed over equal-width confidence bins.
    """
    confidences = probabilities.max(axis=1)
    edges = np.linspace(0.0, 1.0, bins + 1)
    error = 0.0

    for lower, upper in zip(edges[:-1], edges[1:], strict=True):
        in_bin = (confidences > lower) & (confidences <= upper)
        if not in_bin.any():
            continue
        bin_accuracy = correct[in_bin].mean()
        bin_confidence = confidences[in_bin].mean()
        error += (in_bin.mean()) * abs(bin_accuracy - bin_confidence)

    return float(error)


def _baseline_predictions(
    examples: list[DatasetExample], levels: list[ReferenceLevel]
) -> list[str | None]:
    """
    What the existing reference matcher would predict for the same examples.

    This is the comparison that matters: a trained model has to earn its place
    against the transparent calculation it would replace.
    """
    predictions: list[str | None] = []
    for example in examples:
        lab = example.color_features.get("lab_median")
        if not isinstance(lab, (list, tuple)) or len(lab) != 3:
            predictions.append(None)
            continue
        result = match_reference(np.asarray(lab, dtype=np.float64), levels)
        predictions.append(result.reference_level_id)
    return predictions


def _subgroup_metrics(
    examples: list[DatasetExample],
    truth: np.ndarray,
    predicted: np.ndarray,
) -> dict[str, Any]:
    """
    Macro F1 sliced by sample type, capture device and label source.

    A model that performs well overall but fails on one device has learned
    that device. The aggregate hides it; this surfaces it.

    Slices with fewer than five examples are reported as present but
    unmeasurable, rather than given a number that means nothing.
    """
    slices: dict[str, dict[str, Any]] = {}

    dimensions = {
        "sample_type": [e.sample_type for e in examples],
        "capture_device": [e.capture_device or "unrecorded" for e in examples],
        "label_source": [e.label_source.value for e in examples],
    }

    for dimension, values in dimensions.items():
        by_value: dict[str, dict[str, Any]] = {}
        for distinct in sorted(set(values)):
            mask = np.asarray([v == distinct for v in values])
            count = int(mask.sum())

            if count < 5:
                by_value[distinct] = {
                    "count": count,
                    "macro_f1": None,
                    "note": "too few examples to estimate performance",
                }
                continue

            by_value[distinct] = {
                "count": count,
                "macro_f1": round(
                    float(f1_score(truth[mask], predicted[mask], average="macro", zero_division=0)),
                    4,
                ),
                "accuracy": round(float(accuracy_score(truth[mask], predicted[mask])), 4),
            }
        slices[dimension] = by_value

    return slices


def evaluate_model(
    training: TrainingResult,
    dataset: DatasetVersion,
    examples_by_id: dict[str, DatasetExample],
    reference_levels: list[ReferenceLevel],
    split: Split = Split.TEST,
) -> EvaluationReport:
    """
    Evaluate a trained model on a held-out split and recommend a release
    decision.

    The recommendation is advisory. A human still has to approve, and the
    approval endpoint re-checks these same criteria server-side — the
    recommendation here is for the administrator to read, not a gate the model
    can pass on its own.
    """
    split_ids = dataset.ids_for(split)
    examples = [examples_by_id[i] for i in split_ids if i in examples_by_id]

    if not examples:
        raise ValueError(f"The {split.value} split is empty.")

    rows: list[list[float]] = []
    truth_labels: list[str] = []
    kept: list[DatasetExample] = []

    for example in examples:
        vector = example.feature_vector(training.feature_order)
        if vector is None:
            continue
        rows.append(vector)
        truth_labels.append(example.label)
        kept.append(example)

    if not rows:
        raise ValueError(
            f"No example in the {split.value} split carried the required features."
        )

    features = np.asarray(rows, dtype=np.float64)
    truth = np.asarray(truth_labels, dtype=object)
    predicted = np.asarray(training.pipeline.predict(features), dtype=object)

    # ── Headline metrics ─────────────────────────────────────────────────────
    accuracy = float(accuracy_score(truth, predicted))
    macro_f1 = float(f1_score(truth, predicted, average="macro", zero_division=0))
    weighted_f1 = float(f1_score(truth, predicted, average="weighted", zero_division=0))
    balanced = float(balanced_accuracy_score(truth, predicted))

    # ── Per class ────────────────────────────────────────────────────────────
    labels_in_order = sorted(set(truth.tolist()) | set(predicted.tolist()))
    precision, recall, f1, support = precision_recall_fscore_support(
        truth, predicted, labels=labels_in_order, zero_division=0
    )

    per_class = {
        label: {
            "precision": round(float(precision[i]), 4),
            "recall": round(float(recall[i]), 4),
            "f1": round(float(f1[i]), 4),
            "support": int(support[i]),
        }
        for i, label in enumerate(labels_in_order)
    }

    matrix = confusion_matrix(truth, predicted, labels=labels_in_order)

    # ── Calibration ──────────────────────────────────────────────────────────
    ece: float | None = None
    brier: float | None = None

    if training.calibrated and hasattr(training.pipeline, "predict_proba"):
        probabilities = training.pipeline.predict_proba(features)
        correct = (predicted == truth).astype(float)
        ece = round(_expected_calibration_error(probabilities, correct), 5)

        # Brier is defined for the binary case; for multi-class, score the
        # one-vs-rest problem of "was the top prediction right".
        try:
            top_confidence = probabilities.max(axis=1)
            brier = round(float(brier_score_loss(correct, top_confidence)), 5)
        except ValueError:
            brier = None

    # ── Baseline comparison ──────────────────────────────────────────────────
    baseline_predicted = _baseline_predictions(kept, reference_levels)
    comparable = [
        (t, b) for t, b in zip(truth_labels, baseline_predicted, strict=True) if b is not None
    ]

    if comparable and reference_levels:
        baseline_truth = np.asarray([t for t, _ in comparable], dtype=object)
        baseline_pred = np.asarray([b for _, b in comparable], dtype=object)
        baseline_macro_f1 = float(
            f1_score(baseline_truth, baseline_pred, average="macro", zero_division=0)
        )
        baseline_accuracy = float(accuracy_score(baseline_truth, baseline_pred))
        improvement = macro_f1 - baseline_macro_f1
    else:
        baseline_macro_f1 = None
        baseline_accuracy = None
        improvement = None

    baseline_comparison = {
        "baseline": "reference-matching (CIEDE2000)",
        "baseline_macro_f1": round(baseline_macro_f1, 4) if baseline_macro_f1 is not None else None,
        "baseline_accuracy": round(baseline_accuracy, 4) if baseline_accuracy is not None else None,
        "model_macro_f1": round(macro_f1, 4),
        "improvement": round(improvement, 4) if improvement is not None else None,
        "comparable_examples": len(comparable),
        "note": (
            "A trained model that does not beat transparent colour matching "
            "is not worth the loss of inspectability."
        ),
    }

    # ── Limitations and release decision ─────────────────────────────────────
    limitations: list[str] = []
    blockers: list[str] = []

    if len(kept) < MIN_TEST_EXAMPLES:
        blockers.append(
            f"the test set holds {len(kept)} examples, below the minimum of "
            f"{MIN_TEST_EXAMPLES}"
        )

    thin = [label for label, m in per_class.items() if m["support"] < MIN_TEST_PER_CLASS]
    if thin:
        blockers.append(
            f"these classes have fewer than {MIN_TEST_PER_CLASS} test examples, "
            f"so their performance is not measured: {', '.join(thin)}"
        )

    if macro_f1 < MIN_MACRO_F1:
        blockers.append(
            f"macro F1 is {macro_f1:.3f}, below the minimum of {MIN_MACRO_F1}"
        )

    if improvement is not None and improvement < MIN_IMPROVEMENT_OVER_BASELINE:
        blockers.append(
            f"macro F1 improves on the reference matcher by only "
            f"{improvement:+.3f}, below the {MIN_IMPROVEMENT_OVER_BASELINE} "
            "needed to justify replacing a transparent calculation"
        )

    if not training.calibrated:
        limitations.append(
            "This model is not calibrated, so it reports no confidence value. "
            + (training.calibration_skipped_reason or "")
        )

    if ece is not None and ece > 0.15:
        limitations.append(
            f"Expected calibration error is {ece:.3f}: the model's stated "
            "confidence does not track how often it is actually right."
        )

    # Accuracy and macro F1 diverging is the signature of an imbalanced set
    # where accuracy is flattering the model.
    if accuracy - macro_f1 > 0.2:
        limitations.append(
            f"Accuracy ({accuracy:.3f}) is well above macro F1 ({macro_f1:.3f}), "
            "which means the model performs much better on common classes than "
            "rare ones. Judge it on macro F1."
        )

    measurement_backed = sum(
        1
        for e in kept
        if e.label_source.value in ("LABORATORY_MEASUREMENT", "REFERENCE_STANDARD")
    )
    if measurement_backed < len(kept):
        limitations.append(
            f"{len(kept) - measurement_backed} of {len(kept)} test labels come "
            "from technician annotation rather than a laboratory measurement, "
            "so this score partly measures agreement with technicians."
        )

    limitations.append(
        "These metrics describe performance on this dataset only. They say "
        "nothing about devices, lighting or sample matrices not represented in it."
    )

    if blockers:
        recommendation = (
            "INSUFFICIENT_DATA"
            if any("minimum of" in b or "not measured" in b for b in blockers)
            else "REJECT"
        )
    else:
        recommendation = "APPROVE"

    logger.info(
        "Evaluated on %s: n=%d accuracy=%.3f macro_f1=%.3f recommendation=%s",
        split.value,
        len(kept),
        accuracy,
        macro_f1,
        recommendation,
    )

    return EvaluationReport(
        split=split.value,
        sample_size=len(kept),
        accuracy=round(accuracy, 4),
        macro_f1=round(macro_f1, 4),
        weighted_f1=round(weighted_f1, 4),
        balanced_accuracy=round(balanced, 4),
        confusion_matrix={
            "labels": labels_in_order,
            "matrix": matrix.tolist(),
        },
        per_class_metrics=per_class,
        subgroup_metrics=_subgroup_metrics(kept, truth, predicted),
        baseline_comparison=baseline_comparison,
        expected_calibration_error=ece,
        brier_score=brier,
        evaluation_limitations=limitations,
        release_recommendation=recommendation,
        release_blockers=blockers,
    )
