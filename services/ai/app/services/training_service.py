"""
Training orchestration.

Ties the four stages together — build, train, evaluate, persist — and
translates between the wire contract and the internal dataclasses.

The one rule this module enforces above all: **a refusal is a successful
outcome, not an error.** When the dataset cannot support training, the
response comes back `status: "refused"` with the reasons, HTTP 200. The
caller records it as a completed job that produced no model. Raising an
exception would make "we don't have enough data yet" look like a bug.
"""
from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from pathlib import Path

from ..datasets.builder import build_dataset
from ..datasets.schemas import DatasetExample, LabelSource
from ..evaluation.evaluator import evaluate_model
from ..reference_matching.matcher import ReferenceLevel
from ..registry.artifacts import write_artifact
from ..schemas.training import (
    DatasetExampleInput,
    DatasetVersionOut,
    EvaluationOut,
    QualityIssueOut,
    TrainedModelOut,
    TrainingRequest,
    TrainingResponse,
)
from ..training.trainer import TrainingConfig, train_model

logger = logging.getLogger(__name__)


def _to_example(payload: DatasetExampleInput) -> DatasetExample:
    return DatasetExample(
        id=payload.id,
        sample_id=payload.sample_id,
        sample_image_id=payload.sample_image_id,
        label_level_id=payload.label_level_id,
        label_text=payload.label_text,
        label_concentration=payload.label_concentration,
        label_unit=payload.label_unit,
        label_source=LabelSource(payload.label_source),
        sample_type=payload.sample_type,
        color_features=payload.color_features,
        quality_verdict=payload.quality_verdict,
        group_key=payload.group_key,
        perceptual_hash=payload.perceptual_hash,
        capture_device=payload.capture_device,
        lighting_note=payload.lighting_note,
    )


def run_training(request: TrainingRequest, artifact_dir: Path) -> TrainingResponse:
    """
    Run one training job end to end.

    Returns a response in every case. The three outcomes:

      * `succeeded` — a model was trained, evaluated and written to disk as
        **unapproved**. Nothing is active until a human approves it.
      * `refused` — the dataset could not support training. The issues
        explain why, in terms an administrator can act on.
      * `failed` — something went wrong during training itself.
    """
    started = time.perf_counter()

    def elapsed() -> int:
        return int((time.perf_counter() - started) * 1000)

    examples = [_to_example(e) for e in request.examples]

    # ── Stage 1: build the dataset ───────────────────────────────────────────
    dataset, issues = build_dataset(
        examples,
        test_method_id=request.test_method_id,
        test_fraction=request.test_fraction,
        validation_fraction=request.validation_fraction,
        seed=request.split_seed,
    )

    issue_payload = [
        QualityIssueOut(
            code=i.code,
            severity=i.severity,  # type: ignore[arg-type]
            message=i.message,
            affected_count=len(i.example_ids),
        )
        for i in issues
    ]

    if dataset is None:
        blockers = [i for i in issues if i.severity == "critical"]
        reason = "; ".join(i.message for i in blockers) or "The dataset was unusable."

        logger.info(
            "Training refused for method %s: %s | correlation=%s",
            request.test_method_id,
            ", ".join(i.code for i in blockers),
            request.correlation_id,
        )

        # Not an error. "Not enough data yet" is the expected state of this
        # system for a long time, and it should read as such.
        return TrainingResponse(
            status="refused",
            refusal_reason=reason,
            issues=issue_payload,
            duration_ms=elapsed(),
            correlation_id=request.correlation_id,
        )

    by_id = {e.id: e for e in examples}

    # ── Stage 2: train ───────────────────────────────────────────────────────
    try:
        training = train_model(
            dataset,
            by_id,
            TrainingConfig(
                model_type=request.model_type,
                random_state=request.split_seed,
            ),
        )
    except ValueError as exc:
        logger.warning(
            "Training failed for method %s: %s | correlation=%s",
            request.test_method_id,
            exc,
            request.correlation_id,
        )
        return TrainingResponse(
            status="failed",
            refusal_reason=str(exc),
            issues=issue_payload,
            duration_ms=elapsed(),
            correlation_id=request.correlation_id,
        )

    # ── Stage 3: evaluate against the held-out test split ────────────────────
    levels = [
        ReferenceLevel(
            id=level.id,
            label=level.label,
            concentration_value=level.concentration_value,
            concentration_unit=level.concentration_unit,
            sort_order=level.sort_order,
            lab_l=level.lab_l,
            lab_a=level.lab_a,
            lab_b=level.lab_b,
            lab_std=level.lab_std,
        )
        for level in request.reference_levels
    ]

    try:
        evaluation = evaluate_model(training, dataset, by_id, levels)
    except ValueError as exc:
        return TrainingResponse(
            status="failed",
            refusal_reason=f"Evaluation failed: {exc}",
            issues=issue_payload,
            duration_ms=elapsed(),
            correlation_id=request.correlation_id,
        )

    # ── Stage 4: persist the artifact, unapproved ────────────────────────────
    version = request.model_version or datetime.now(UTC).strftime(
        "%Y.%m.%d-%H%M%S"
    )

    metadata = write_artifact(
        artifact_dir,
        request.model_name,
        version,
        training,
        evaluation,
        dataset,
    )

    logger.info(
        "Training succeeded for method %s: %s v%s macro_f1=%.3f recommendation=%s "
        "| correlation=%s",
        request.test_method_id,
        request.model_name,
        version,
        evaluation.macro_f1,
        evaluation.release_recommendation,
        request.correlation_id,
    )

    return TrainingResponse(
        status="succeeded",
        dataset=DatasetVersionOut(
            version=dataset.version,
            example_ids=dataset.example_ids,
            split_assignment=dataset.split_assignment,
            example_count=dataset.example_count,
            train_count=dataset.train_count,
            validation_count=dataset.validation_count,
            test_count=dataset.test_count,
            class_distribution=dataset.class_distribution,
            label_source_distribution=dataset.label_source_distribution,
            quality_report=dataset.quality_report,
            content_checksum=dataset.content_checksum,
        ),
        model=TrainedModelOut(
            name=request.model_name,
            version=version,
            model_type=metadata["model_type"],
            approved=False,
            validated=False,
            artifact_checksum=metadata["artifact_checksum"],
            artifact_size_bytes=metadata["artifact_size_bytes"],
            feature_order=training.feature_order,
            classes=training.classes,
            calibrated=training.calibrated,
            calibration_skipped_reason=training.calibration_skipped_reason,
            training_examples=training.training_examples,
            hyperparameters=training.hyperparameters,
            limitations=training.limitations,
        ),
        evaluation=EvaluationOut(
            split=evaluation.split,
            sample_size=evaluation.sample_size,
            accuracy=evaluation.accuracy,
            macro_f1=evaluation.macro_f1,
            weighted_f1=evaluation.weighted_f1,
            balanced_accuracy=evaluation.balanced_accuracy,
            confusion_matrix=evaluation.confusion_matrix,
            per_class_metrics=evaluation.per_class_metrics,
            subgroup_metrics=evaluation.subgroup_metrics,
            baseline_comparison=evaluation.baseline_comparison,
            expected_calibration_error=evaluation.expected_calibration_error,
            brier_score=evaluation.brier_score,
            evaluation_limitations=evaluation.evaluation_limitations,
            release_recommendation=evaluation.release_recommendation,  # type: ignore[arg-type]
            release_blockers=evaluation.release_blockers,
        ),
        issues=issue_payload,
        duration_ms=elapsed(),
        correlation_id=request.correlation_id,
    )
