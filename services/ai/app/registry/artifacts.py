"""
Model artifact persistence.

Writes a trained pipeline and its metadata to disk in the layout the registry
expects, and refuses to mark anything approved. Approval is a human act
performed through the API; this module only ever writes `approved: false`.

Layout:

    <artifact_dir>/<name>/<version>/model.joblib
    <artifact_dir>/<name>/<version>/metadata.json

The metadata carries everything needed to load the model correctly and to
judge whether it should be trusted: the feature order, whether it was
calibrated, the dataset it came from, its evaluation summary, and its
limitations.
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib

from ..datasets.schemas import DatasetVersion
from ..evaluation.evaluator import EvaluationReport
from ..training.trainer import TrainingResult

logger = logging.getLogger(__name__)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_artifact(
    artifact_dir: Path,
    name: str,
    version: str,
    training: TrainingResult,
    evaluation: EvaluationReport,
    dataset: DatasetVersion,
) -> dict[str, Any]:
    """
    Persist a trained model and return its metadata.

    The artifact is always written with `approved: false` and
    `validated: false`. The registry refuses to load an unapproved artifact,
    so a freshly trained model cannot become active by appearing on disk —
    it has to be approved through the API by a person with the authority.
    """
    target = artifact_dir / name / version
    target.mkdir(parents=True, exist_ok=True)

    model_path = target / "model.joblib"
    joblib.dump(training.pipeline, model_path, compress=3)
    checksum = _sha256_file(model_path)

    metadata: dict[str, Any] = {
        "name": name,
        "version": version,
        "model_type": "SKLEARN_CLASSIFIER",
        "created_at": datetime.now(UTC).isoformat(),
        # Never true at write time. Only the approval endpoint flips these,
        # and only after a human decision.
        "approved": False,
        "validated": False,
        "artifact_checksum": checksum,
        "artifact_size_bytes": model_path.stat().st_size,
        # The model contract. A vector assembled in a different order at
        # inference time produces confident nonsense, so this is read back
        # when the model is loaded rather than assumed.
        "feature_order": training.feature_order,
        "classes": training.classes,
        "calibrated": training.calibrated,
        "calibration_skipped_reason": training.calibration_skipped_reason,
        "dataset_version": dataset.version,
        "dataset_checksum": dataset.content_checksum,
        "dataset_example_count": dataset.example_count,
        "training_examples": training.training_examples,
        "hyperparameters": training.hyperparameters,
        "metrics": {
            "accuracy": evaluation.accuracy,
            "macro_f1": evaluation.macro_f1,
            "weighted_f1": evaluation.weighted_f1,
            "balanced_accuracy": evaluation.balanced_accuracy,
            "expected_calibration_error": evaluation.expected_calibration_error,
            "test_sample_size": evaluation.sample_size,
        },
        "release_recommendation": evaluation.release_recommendation,
        "release_blockers": evaluation.release_blockers,
        # Training limitations plus evaluation limitations: everything an
        # administrator should read before approving.
        "limitations": training.limitations + evaluation.evaluation_limitations,
    }

    metadata_path = target / "metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    # The full evaluation report lives beside the model rather than inside the
    # metadata: it is large, and nothing in the load path needs it.
    report_path = target / "evaluation.json"
    report_path.write_text(
        json.dumps(evaluation.to_dict(), indent=2) + "\n", encoding="utf-8"
    )

    dataset_path = target / "dataset.json"
    dataset_path.write_text(json.dumps(asdict(dataset), indent=2) + "\n", encoding="utf-8")

    logger.info(
        "Wrote artifact %s v%s (%d bytes, checksum %s…, approved=false)",
        name,
        version,
        metadata["artifact_size_bytes"],
        checksum[:12],
    )

    return metadata


def approve_artifact(
    artifact_dir: Path,
    name: str,
    version: str,
    approved_by: str,
    validated: bool = False,
) -> dict[str, Any]:
    """
    Mark an artifact approved so the registry will load it.

    Separate from `write_artifact` on purpose: writing and approving are
    different acts by different parties. `validated` stays false unless an
    administrator explicitly asserts the model has been validated against
    confirmed measurements — approving a model for use is not the same as
    certifying it scientifically.
    """
    metadata_path = artifact_dir / name / version / "metadata.json"
    if not metadata_path.exists():
        raise FileNotFoundError(f"No artifact metadata at {metadata_path}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    # Re-verify the checksum: an artifact that changed since it was written
    # is either corrupt or was swapped, and approving it blind would defeat
    # the integrity check the registry performs on load.
    model_path = artifact_dir / name / version / "model.joblib"
    actual = _sha256_file(model_path)
    if actual != metadata.get("artifact_checksum"):
        raise ValueError(
            f"Artifact checksum mismatch for {name} v{version}: the file has "
            "changed since it was written and will not be approved."
        )

    metadata["approved"] = True
    metadata["validated"] = bool(validated)
    metadata["approved_by"] = approved_by
    metadata["approved_at"] = datetime.now(UTC).isoformat()

    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    logger.info(
        "Approved artifact %s v%s by %s (validated=%s)",
        name,
        version,
        approved_by,
        validated,
    )

    return metadata
