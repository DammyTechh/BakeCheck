"""
Dataset contracts shared by the builder, the trainer and the evaluator.

These are plain dataclasses rather than Pydantic models: they move between
Python functions, never over the wire. The wire contracts live in
`app/schemas/training.py`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class LabelSource(str, Enum):
    """
    Where a label's authority comes from.

    The ordering matters and is used for weighting: a number from an
    instrument is stronger evidence than a person's reading of a colour, and
    training must be able to tell them apart. Merging them would let a
    confident guess become ground truth.
    """

    LABORATORY_MEASUREMENT = "LABORATORY_MEASUREMENT"
    REFERENCE_STANDARD = "REFERENCE_STANDARD"
    TECHNICIAN_ANNOTATION = "TECHNICIAN_ANNOTATION"
    SYNTHETIC_FIXTURE = "SYNTHETIC_FIXTURE"


#: Relative weight applied during training, by label source.
#:
#: A technician annotation counts, but counts for less. These are engineering
#: defaults chosen to be conservative, not values derived from a study — they
#: are recorded with every dataset version so a later analysis can revisit
#: them.
LABEL_SOURCE_WEIGHTS: dict[LabelSource, float] = {
    LabelSource.LABORATORY_MEASUREMENT: 1.0,
    LabelSource.REFERENCE_STANDARD: 1.0,
    LabelSource.TECHNICIAN_ANNOTATION: 0.4,
    LabelSource.SYNTHETIC_FIXTURE: 0.1,
}


class Split(str, Enum):
    TRAIN = "train"
    VALIDATION = "validation"
    TEST = "test"


@dataclass
class DatasetExample:
    """
    One approved, labelled training candidate.

    Mirrors a row of `dataset_examples`. Colour features are cached on the
    row at approval time, so building a dataset never needs to re-process
    images — which also means a dataset version is reproducible even if an
    image is later archived.
    """

    id: str
    sample_id: str
    sample_image_id: str

    label_level_id: str | None
    label_text: str | None
    label_concentration: float | None
    label_unit: str | None
    label_source: LabelSource

    sample_type: str
    #: Cached colour statistics: lab_median, rgb_median, hsv_median, …
    color_features: dict[str, Any]
    quality_verdict: str | None

    #: Every example from one physical sample shares this. Splitting groups on
    #: it, so near-duplicate photographs of the same tube cannot straddle the
    #: train/test boundary.
    group_key: str
    perceptual_hash: str | None = None

    #: Optional context used for subgroup evaluation, when recorded.
    capture_device: str | None = None
    lighting_note: str | None = None

    @property
    def label(self) -> str:
        """
        The classification target.

        Prefers the reference level id, which is stable, over the display
        label, which a laboratory may rename.
        """
        return self.label_level_id or self.label_text or "UNLABELLED"

    @property
    def weight(self) -> float:
        return LABEL_SOURCE_WEIGHTS.get(self.label_source, 0.1)

    def feature_vector(self, feature_order: list[str]) -> list[float] | None:
        """
        Flatten the cached colour features into the exact order the model
        expects. Returns None when any required feature is absent, so an
        incomplete example is dropped rather than silently zero-filled.
        """
        values: list[float] = []
        for key in feature_order:
            if "." in key:
                base, index = key.rsplit(".", 1)
                source = self.color_features.get(base)
                if not isinstance(source, (list, tuple)):
                    return None
                try:
                    values.append(float(source[int(index)]))
                except (ValueError, IndexError, TypeError):
                    return None
            else:
                value = self.color_features.get(key)
                if value is None:
                    return None
                try:
                    values.append(float(value))
                except (TypeError, ValueError):
                    return None
        return values


@dataclass
class QualityIssue:
    """A reason an example was excluded, or a warning about the dataset."""

    code: str
    severity: str  # 'warning' | 'critical'
    message: str
    example_ids: list[str] = field(default_factory=list)


@dataclass
class DatasetVersion:
    """
    A frozen, reproducible snapshot of the examples used for one training run.

    `content_checksum` covers the ordered example ids and their labels, so a
    dataset that changed underneath a model is detectable rather than silent.
    """

    version: str
    test_method_id: str
    example_ids: list[str]
    split_assignment: dict[str, str]
    class_distribution: dict[str, int]
    label_source_distribution: dict[str, int]
    quality_report: dict[str, Any]
    content_checksum: str

    train_count: int
    validation_count: int
    test_count: int

    @property
    def example_count(self) -> int:
        return len(self.example_ids)

    def ids_for(self, split: Split) -> list[str]:
        return [i for i in self.example_ids if self.split_assignment.get(i) == split.value]
