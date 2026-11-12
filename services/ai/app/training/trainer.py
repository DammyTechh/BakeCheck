"""
Model training.

A deliberately small, inspectable pipeline: standardise the engineered colour
features, then fit a classifier whose decision a chemist could in principle
follow. No neural network — on the data volumes this system will realistically
have (tens to low hundreds of labelled examples), one would overfit and its
confidence would be meaningless.

Two decisions here are load-bearing:

  * **Sample weighting by label source.** A technician's reading counts, but
    counts for less than an instrument measurement. The weights travel with
    the dataset version so the trade-off is visible later.

  * **Calibration is conditional.** `predict_proba` on an uncalibrated
    classifier is not a probability, and presenting it as a confidence would
    be the single most misleading thing this service could do. Calibration is
    attempted only when there is enough held-out data to estimate it, and the
    result records whether it succeeded.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ..datasets.schemas import DatasetExample, DatasetVersion, Split

logger = logging.getLogger(__name__)


#: The engineered colour features, in a fixed order.
#:
#: Order is part of the model contract: a vector assembled differently at
#: inference time than at training time produces confident nonsense. It is
#: stored in the artifact metadata and re-read when the model is loaded.
DEFAULT_FEATURE_ORDER: list[str] = [
    "lab_median.0",  # L* — lightness, the dominant signal in a colour ladder
    "lab_median.1",  # a* — green/red
    "lab_median.2",  # b* — blue/yellow
    "rgb_median.0",
    "rgb_median.1",
    "rgb_median.2",
    "hsv_median.1",  # saturation
    "hsv_median.2",  # value
    "saturation_mean",
    "brightness_mean",
]

#: Below this many training examples, cross-validated calibration cannot be
#: estimated — the folds become too small to mean anything.
MIN_EXAMPLES_FOR_CALIBRATION = 50
#: Calibration also needs enough examples in every class.
MIN_PER_CLASS_FOR_CALIBRATION = 10


@dataclass
class TrainingConfig:
    model_type: str = "logistic_regression"  # or 'random_forest'
    feature_order: list[str] = field(default_factory=lambda: list(DEFAULT_FEATURE_ORDER))
    random_state: int = 20261011
    #: Weight examples by label source. Disable only for a diagnostic run.
    use_sample_weights: bool = True
    #: Attempt probability calibration when the data supports it.
    attempt_calibration: bool = True
    max_iterations: int = 2000


@dataclass
class TrainingResult:
    pipeline: Pipeline
    feature_order: list[str]
    classes: list[str]
    calibrated: bool
    calibration_skipped_reason: str | None
    training_examples: int
    model_type: str
    hyperparameters: dict[str, Any]
    #: Honest statements about what this model is and is not.
    limitations: list[str]


def _assemble_matrix(
    examples: list[DatasetExample], feature_order: list[str]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """
    Build the feature matrix, labels and sample weights.

    Examples missing any required feature are dropped rather than imputed:
    filling in a measurement that was never taken would feed the model a
    fabricated observation.
    """
    rows: list[list[float]] = []
    labels: list[str] = []
    weights: list[float] = []
    dropped: list[str] = []

    for example in examples:
        vector = example.feature_vector(feature_order)
        if vector is None:
            dropped.append(example.id)
            continue
        rows.append(vector)
        labels.append(example.label)
        weights.append(example.weight)

    if not rows:
        raise ValueError(
            "No example carried the complete feature set required for training."
        )

    return (
        np.asarray(rows, dtype=np.float64),
        np.asarray(labels, dtype=object),
        np.asarray(weights, dtype=np.float64),
        dropped,
    )


def _build_estimator(config: TrainingConfig):
    """
    The classifier itself.

    Logistic regression is the default: its coefficients are readable, it is
    well behaved on small samples, and its probabilities are closer to
    calibrated out of the box than a tree ensemble's. Random forest is offered
    for datasets with obvious non-linear structure.
    """
    if config.model_type == "random_forest":
        return RandomForestClassifier(
            n_estimators=200,
            # Shallow on purpose: a deep forest on 50 examples memorises them.
            max_depth=6,
            min_samples_leaf=2,
            class_weight="balanced",
            random_state=config.random_state,
            n_jobs=1,
        )

    return LogisticRegression(
        max_iter=config.max_iterations,
        # Balanced class weights, because a bromate screening set is
        # overwhelmingly negative and an unweighted fit would simply learn to
        # predict the majority class.
        class_weight="balanced",
        # No `multi_class` argument: scikit-learn removed it in 1.9 and now
        # infers multinomial vs one-vs-rest from the data, which is what the
        # old "auto" did anyway.
        random_state=config.random_state,
    )


def _can_calibrate(
    labels: np.ndarray, config: TrainingConfig
) -> tuple[bool, str | None]:
    """Whether there is enough data to estimate calibration honestly."""
    if not config.attempt_calibration:
        return False, "calibration was disabled for this run"

    if len(labels) < MIN_EXAMPLES_FOR_CALIBRATION:
        return False, (
            f"only {len(labels)} training examples; at least "
            f"{MIN_EXAMPLES_FOR_CALIBRATION} are needed to estimate calibration"
        )

    _, counts = np.unique(labels, return_counts=True)
    if counts.min() < MIN_PER_CLASS_FOR_CALIBRATION:
        return False, (
            f"the smallest class has {int(counts.min())} examples; at least "
            f"{MIN_PER_CLASS_FOR_CALIBRATION} per class are needed to "
            "estimate calibration"
        )

    return True, None


def train_model(
    dataset: DatasetVersion,
    examples_by_id: dict[str, DatasetExample],
    config: TrainingConfig | None = None,
) -> TrainingResult:
    """
    Fit a model on the dataset's training split.

    Only the training split is touched. The validation split tunes nothing in
    this baseline (there are no hyperparameters worth tuning at this scale),
    and the test split is never seen until evaluation — which is what makes
    the test score mean anything.
    """
    config = config or TrainingConfig()

    train_ids = dataset.ids_for(Split.TRAIN)
    train_examples = [examples_by_id[i] for i in train_ids if i in examples_by_id]

    if not train_examples:
        raise ValueError("The dataset's training split is empty.")

    features, labels, weights, dropped = _assemble_matrix(
        train_examples, config.feature_order
    )

    distinct = sorted(set(labels.tolist()))
    if len(distinct) < 2:
        raise ValueError(
            f"The training split contains only one class ({distinct[0]}). "
            "A classifier needs at least two to discriminate between."
        )

    estimator = _build_estimator(config)
    calibrate, skip_reason = _can_calibrate(labels, config)

    limitations: list[str] = []

    if calibrate:
        # Calibrate on cross-validated folds of the training data. `cv=3`
        # rather than the default 5: with ~50 examples, five folds leave too
        # few per fold for the calibration curve to be stable.
        model = CalibratedClassifierCV(estimator, method="sigmoid", cv=3)
    else:
        model = estimator
        limitations.append(
            f"This model was not calibrated ({skip_reason}), so it reports no "
            "confidence value. Its raw probability output is not a reliable "
            "measure of certainty."
        )

    pipeline = Pipeline(
        [
            # Lab and RGB live on very different scales; without
            # standardisation the regression is dominated by whichever
            # happens to have the larger numbers.
            ("scale", StandardScaler()),
            ("classify", model),
        ]
    )

    if config.use_sample_weights:
        # Route the weights to the final step. Pipeline requires the
        # `<step>__` prefix for nested parameters.
        pipeline.fit(features, labels, classify__sample_weight=weights)
    else:
        pipeline.fit(features, labels)
        limitations.append(
            "Sample weighting was disabled, so technician annotations were "
            "treated as equivalent to laboratory measurements."
        )

    if dropped:
        limitations.append(
            f"{len(dropped)} training example(s) were dropped for missing "
            "features."
        )

    # The caveat that applies to every model this system will produce for the
    # foreseeable future.
    measurement_backed = sum(
        1
        for e in train_examples
        if e.label_source.value in ("LABORATORY_MEASUREMENT", "REFERENCE_STANDARD")
    )
    limitations.append(
        f"Trained on {len(train_examples)} examples, of which "
        f"{measurement_backed} are backed by a laboratory measurement. "
        "Performance outside the devices, lighting and sample matrices "
        "represented in that set is unknown."
    )

    logger.info(
        "Trained %s on %d examples across %d classes (calibrated=%s)",
        config.model_type,
        len(train_examples),
        len(distinct),
        calibrate,
    )

    return TrainingResult(
        pipeline=pipeline,
        feature_order=list(config.feature_order),
        classes=distinct,
        calibrated=calibrate,
        calibration_skipped_reason=skip_reason,
        training_examples=len(train_examples),
        model_type=config.model_type,
        hyperparameters={
            "model_type": config.model_type,
            "random_state": config.random_state,
            "use_sample_weights": config.use_sample_weights,
            "class_weight": "balanced",
            "calibration_method": "sigmoid" if calibrate else None,
            "calibration_folds": 3 if calibrate else None,
            "max_iterations": config.max_iterations,
            "feature_count": len(config.feature_order),
        },
        limitations=limitations,
    )
