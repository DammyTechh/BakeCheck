"""
Wire contracts for the internal training endpoints.

The Node API owns the data: it reads `dataset_examples` from Postgres and
sends them here as plain values. The AI service never touches the database —
it receives examples, builds a dataset, trains, evaluates, and returns a
report for the API to persist.

That split keeps all authorisation in one place. This service has no idea
which laboratory an example belongs to, and does not need to.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import Field, field_validator

from .analysis import CamelModel, ReferenceLevelInput


class DatasetExampleInput(CamelModel):
    """One approved training candidate, as the API reads it from the database."""

    id: str = Field(max_length=64)
    sample_id: str = Field(max_length=64)
    sample_image_id: str = Field(max_length=64)

    label_level_id: str | None = Field(default=None, max_length=64)
    label_text: str | None = Field(default=None, max_length=200)
    label_concentration: float | None = Field(default=None, ge=0)
    label_unit: str | None = Field(default=None, max_length=32)
    label_source: Literal[
        "LABORATORY_MEASUREMENT",
        "REFERENCE_STANDARD",
        "TECHNICIAN_ANNOTATION",
        "SYNTHETIC_FIXTURE",
    ]

    sample_type: str = Field(max_length=80)
    #: Cached colour statistics from the original analysis. Training never
    #: re-processes images, so a dataset stays reproducible even if an image
    #: is later archived.
    color_features: dict[str, Any] = Field(default_factory=dict)
    quality_verdict: str | None = Field(default=None, max_length=32)

    #: Groups every example from one physical sample. Splitting keys on this.
    group_key: str = Field(max_length=200)
    perceptual_hash: str | None = Field(default=None, max_length=64)

    capture_device: str | None = Field(default=None, max_length=200)
    lighting_note: str | None = Field(default=None, max_length=200)


class TrainingRequest(CamelModel):
    test_method_id: str = Field(max_length=64)
    model_name: str = Field(default="colour-classifier", max_length=120)
    model_version: str | None = Field(default=None, max_length=40)

    examples: list[DatasetExampleInput] = Field(default_factory=list, max_length=20_000)
    #: Needed to score the reference matcher as a baseline — a trained model
    #: has to beat the transparent calculation to be worth releasing.
    reference_levels: list[ReferenceLevelInput] = Field(
        default_factory=list, max_length=64
    )

    model_type: Literal["logistic_regression", "random_forest"] = "logistic_regression"
    test_fraction: float = Field(default=0.2, ge=0.1, le=0.4)
    validation_fraction: float = Field(default=0.2, ge=0.1, le=0.4)
    #: Fixed by default so a run is reproducible.
    split_seed: int = Field(default=20261011, ge=0)

    correlation_id: str = Field(max_length=64)

    @field_validator("validation_fraction")
    @classmethod
    def _leave_room_for_training(cls, value: float, info) -> float:
        test = info.data.get("test_fraction", 0.2)
        if value + test > 0.6:
            raise ValueError(
                "test_fraction and validation_fraction together must leave at "
                "least 40% of the data for training."
            )
        return value


class QualityIssueOut(CamelModel):
    code: str
    severity: Literal["warning", "critical"]
    message: str
    affected_count: int = 0


class DatasetVersionOut(CamelModel):
    version: str
    example_ids: list[str]
    split_assignment: dict[str, str]
    example_count: int
    train_count: int
    validation_count: int
    test_count: int
    class_distribution: dict[str, int]
    label_source_distribution: dict[str, int]
    quality_report: dict[str, Any]
    content_checksum: str


class EvaluationOut(CamelModel):
    split: str
    sample_size: int
    accuracy: float
    macro_f1: float
    weighted_f1: float
    balanced_accuracy: float
    confusion_matrix: dict[str, Any]
    per_class_metrics: dict[str, Any]
    subgroup_metrics: dict[str, Any]
    baseline_comparison: dict[str, Any]
    expected_calibration_error: float | None = None
    brier_score: float | None = None
    evaluation_limitations: list[str] = Field(default_factory=list)
    release_recommendation: Literal["APPROVE", "REJECT", "INSUFFICIENT_DATA"]
    release_blockers: list[str] = Field(default_factory=list)


class TrainedModelOut(CamelModel):
    name: str
    version: str
    model_type: str
    #: Always false from a training run. Only a human approval sets it.
    approved: bool = False
    validated: bool = False
    artifact_checksum: str
    artifact_size_bytes: int
    feature_order: list[str]
    classes: list[str]
    calibrated: bool
    calibration_skipped_reason: str | None = None
    training_examples: int
    hyperparameters: dict[str, Any]
    limitations: list[str] = Field(default_factory=list)


class TrainingResponse(CamelModel):
    status: Literal["succeeded", "refused", "failed"]
    #: Populated when status is 'refused': why the dataset was unusable.
    refusal_reason: str | None = None

    dataset: DatasetVersionOut | None = None
    model: TrainedModelOut | None = None
    evaluation: EvaluationOut | None = None
    issues: list[QualityIssueOut] = Field(default_factory=list)

    duration_ms: int
    correlation_id: str


class ApproveModelRequest(CamelModel):
    name: str = Field(max_length=120)
    version: str = Field(max_length=40)
    approved_by: str = Field(max_length=64)
    #: Asserting scientific validation is a separate, stronger claim than
    #: approving a model for use. Defaults to false.
    validated: bool = False
    correlation_id: str = Field(max_length=64)


class ApproveModelResponse(CamelModel):
    name: str
    version: str
    approved: bool
    validated: bool
    loaded: bool
    """Whether the registry successfully made this the active model."""

    message: str
