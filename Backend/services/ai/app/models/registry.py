"""
Model interface and registry.

The pipeline must work with no trained model at all, and must accept one later
without any caller changing. So inference sits behind `PredictiveModel`, and
the prototype ships `ReferenceMatcherModel` — an implementation that performs
colour-distance matching and reports itself, honestly, as unvalidated.

The rule this module exists to enforce: **a model is loaded only when it has
been approved**, and whatever is loaded always reports whether it was
validated. There is no path by which an unapproved artifact becomes the active
model.
"""
from __future__ import annotations

import hashlib
import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from ..reference_matching.matcher import MatchResult, ReferenceLevel, match_reference

logger = logging.getLogger(__name__)


@dataclass
class ModelInfo:
    name: str
    version: str
    model_type: str
    validated: bool
    dataset_version: str | None = None
    artifact_checksum: str | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    limitations: list[str] = field(default_factory=list)


@dataclass
class Prediction:
    """
    A prediction.

    `estimated_concentration` and `confidence` are None whenever the model
    cannot justify them. They are never filled with a placeholder — a reader
    must be able to tell "not determined" from "determined to be zero".
    """

    label: str | None
    reference_level_id: str | None
    estimated_concentration: float | None
    unit: str | None
    confidence: float | None
    match: MatchResult | None
    limitations: list[str] = field(default_factory=list)


class PredictiveModel(ABC):
    """Interface every model implementation satisfies."""

    @property
    @abstractmethod
    def info(self) -> ModelInfo: ...

    @abstractmethod
    def predict(
        self,
        features: dict[str, Any],
        levels: list[ReferenceLevel],
    ) -> Prediction: ...


class ReferenceMatcherModel(PredictiveModel):
    """
    The prototype's default: transparent colour-distance matching.

    Not a trained model and does not claim to be. It reports the nearest
    reference level and the perceptual distance to it, and deliberately
    returns no concentration estimate and no confidence value:

      • A **concentration** would require a validated relationship between
        colour and concentration for this method and matrix. The reference
        chart alone does not establish one.
      • A **confidence** would require a calibrated probability. A CIEDE2000
        distance is a distance, not a probability, and presenting it as one
        would be the single most misleading thing this service could do.
    """

    MODEL_NAME = "baseline-color-analysis"
    MODEL_VERSION = "0.1.0"

    @property
    def info(self) -> ModelInfo:
        return ModelInfo(
            name=self.MODEL_NAME,
            version=self.MODEL_VERSION,
            model_type="REFERENCE_MATCHER",
            validated=False,
            dataset_version=None,
            limitations=[
                "Not a trained model: computes a CIEDE2000 distance between the "
                "measured colour and each reference level.",
                "Returns no concentration estimate and no confidence value, "
                "because neither is supported by a colour distance alone.",
                "Accuracy depends entirely on the reference chart's own "
                "validity, the imaging conditions and the sample preparation.",
            ],
        )

    def predict(
        self,
        features: dict[str, Any],
        levels: list[ReferenceLevel],
    ) -> Prediction:
        lab_median = features.get("lab_median")
        if lab_median is None:
            return Prediction(
                label=None,
                reference_level_id=None,
                estimated_concentration=None,
                unit=None,
                confidence=None,
                match=None,
                limitations=["No colour measurement was available to compare."],
            )

        result = match_reference(np.asarray(lab_median, dtype=np.float64), levels)

        limitations = list(self.info.limitations)
        limitations.extend(result.notes)

        return Prediction(
            label=result.label,
            reference_level_id=result.reference_level_id,
            # Both deliberately None — see the class docstring.
            estimated_concentration=None,
            unit=result.concentration_unit,
            confidence=None,
            match=result,
            limitations=limitations,
        )


class SklearnClassifierModel(PredictiveModel):
    """
    A trained scikit-learn classifier over engineered colour features.

    Loaded only from an artifact that the registry has verified. Reports
    `validated` from the metadata stored with the artifact at approval time —
    it does not decide for itself that it is trustworthy.

    `predict_proba` is exposed as `confidence` only when the model was
    calibrated during training. An uncalibrated classifier's probability
    output is not a reliable confidence, and presenting it as one would repeat
    exactly the mistake this codebase is built to avoid.
    """

    def __init__(
        self,
        pipeline: Any,
        metadata: dict[str, Any],
        artifact_checksum: str,
    ) -> None:
        self._pipeline = pipeline
        self._metadata = metadata
        self._checksum = artifact_checksum
        self._feature_order: list[str] = metadata.get("feature_order", [])
        self._calibrated: bool = bool(metadata.get("calibrated", False))

    @property
    def info(self) -> ModelInfo:
        limitations = list(self._metadata.get("limitations", []))
        if not self._calibrated:
            limitations.append(
                "This model was not calibrated, so its probability outputs are "
                "not reported as confidence values."
            )
        return ModelInfo(
            name=self._metadata.get("name", "sklearn-classifier"),
            version=self._metadata.get("version", "0.0.0"),
            model_type="SKLEARN_CLASSIFIER",
            validated=bool(self._metadata.get("validated", False)),
            dataset_version=self._metadata.get("dataset_version"),
            artifact_checksum=self._checksum,
            metrics=self._metadata.get("metrics", {}),
            limitations=limitations,
        )

    def predict(
        self,
        features: dict[str, Any],
        levels: list[ReferenceLevel],
    ) -> Prediction:
        vector = self._build_vector(features)
        if vector is None:
            return Prediction(
                label=None,
                reference_level_id=None,
                estimated_concentration=None,
                unit=None,
                confidence=None,
                match=None,
                limitations=["The measurement lacked features this model requires."],
            )

        predicted_label = str(self._pipeline.predict(vector)[0])

        confidence: float | None = None
        if self._calibrated and hasattr(self._pipeline, "predict_proba"):
            probabilities = self._pipeline.predict_proba(vector)[0]
            confidence = round(float(np.max(probabilities)), 5)

        level = next(
            (lv for lv in levels if lv.id == predicted_label or lv.label == predicted_label),
            None,
        )

        # Always run the reference match too: it gives the reviewer an
        # independent, inspectable number to sanity-check the model against.
        match = None
        if features.get("lab_median") is not None:
            match = match_reference(
                np.asarray(features["lab_median"], dtype=np.float64), levels
            )

        return Prediction(
            label=level.label if level else predicted_label,
            reference_level_id=level.id if level else None,
            estimated_concentration=None,
            unit=level.concentration_unit if level else None,
            confidence=confidence,
            match=match,
            limitations=list(self.info.limitations),
        )

    def _build_vector(self, features: dict[str, Any]) -> np.ndarray | None:
        """Assemble the feature vector in the exact order used at training."""
        values: list[float] = []
        for key in self._feature_order:
            if "." in key:
                base, index = key.rsplit(".", 1)
                source = features.get(base)
                if source is None or not isinstance(source, (list, tuple)):
                    return None
                try:
                    values.append(float(source[int(index)]))
                except (ValueError, IndexError):
                    return None
            else:
                value = features.get(key)
                if value is None:
                    return None
                values.append(float(value))

        return np.array(values, dtype=np.float64).reshape(1, -1)


class ModelRegistry:
    """
    Loads and serves the active model.

    Falls back to ReferenceMatcherModel whenever no approved artifact is
    available — which is the normal state of this system until a laboratory
    has produced enough confirmed measurements to train on.

    Artifact integrity is checked against the checksum recorded at approval.
    A mismatch is refused rather than loaded: an artifact that does not match
    its record is either corrupt or has been swapped.
    """

    def __init__(self, artifact_dir: Path) -> None:
        self.artifact_dir = artifact_dir
        self._active: PredictiveModel = ReferenceMatcherModel()
        self._fallback = ReferenceMatcherModel()

    @property
    def active(self) -> PredictiveModel:
        return self._active

    def reset_to_baseline(self) -> None:
        """Revert to transparent reference matching."""
        self._active = self._fallback
        logger.info("Active model reset to the reference matcher baseline.")

    def load_model(self, name: str, version: str, expected_checksum: str | None = None) -> bool:
        """
        Load an approved model artifact and make it active.

        Returns False (keeping the current model) on any problem. A failure to
        load must never leave the service with no model or a partially loaded
        one.
        """
        artifact_path = self.artifact_dir / name / version / "model.joblib"
        metadata_path = self.artifact_dir / name / version / "metadata.json"

        if not artifact_path.exists() or not metadata_path.exists():
            logger.warning(
                "Model artifact not found for %s v%s; keeping the current model.",
                name,
                version,
            )
            return False

        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.exception("Could not read metadata for %s v%s", name, version)
            return False

        # A model may only become active if it was explicitly approved.
        if not metadata.get("approved", False):
            logger.error(
                "Refusing to load %s v%s: the artifact is not marked approved.",
                name,
                version,
            )
            return False

        checksum = _sha256_file(artifact_path)
        recorded = expected_checksum or metadata.get("artifact_checksum")
        if recorded and checksum != recorded:
            logger.error(
                "Refusing to load %s v%s: artifact checksum mismatch "
                "(expected %s, found %s).",
                name,
                version,
                recorded,
                checksum,
            )
            return False

        try:
            import joblib  # imported lazily: unused in the default path

            pipeline = joblib.load(artifact_path)
        except Exception:
            logger.exception("Failed to load the model artifact for %s v%s", name, version)
            return False

        self._active = SklearnClassifierModel(pipeline, metadata, checksum)
        logger.info(
            "Loaded model %s v%s (validated=%s)",
            name,
            version,
            metadata.get("validated", False),
        )
        return True

    def list_available(self) -> list[dict[str, Any]]:
        """Enumerate artifacts on disk, including unapproved ones."""
        available: list[dict[str, Any]] = [
            {
                "name": self._fallback.info.name,
                "version": self._fallback.info.version,
                "validated": False,
                "approved": True,
                "model_type": "REFERENCE_MATCHER",
            }
        ]

        if not self.artifact_dir.exists():
            return available

        for metadata_path in sorted(self.artifact_dir.glob("*/*/metadata.json")):
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            available.append(
                {
                    "name": metadata.get("name", metadata_path.parent.parent.name),
                    "version": metadata.get("version", metadata_path.parent.name),
                    "validated": bool(metadata.get("validated", False)),
                    "approved": bool(metadata.get("approved", False)),
                    "model_type": metadata.get("model_type", "SKLEARN_CLASSIFIER"),
                }
            )

        return available


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()
