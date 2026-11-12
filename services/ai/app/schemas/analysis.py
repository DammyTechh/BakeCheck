"""
Request and response schemas for the internal analysis API.

Mirrors `apps/api/src/integrations/python-ai/ai-client.types.ts`. Field names
are camelCase on the wire (the Node client's convention) with snake_case
Python attributes, bridged by `alias_generator`.

Optional numeric fields default to None and are serialised as null. That is
load-bearing: a reader must be able to distinguish "the pipeline could not
determine this" from "the pipeline determined this to be zero".
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def to_camel(value: str) -> str:
    head, *rest = value.split("_")
    return head + "".join(word.capitalize() for word in rest)


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",  # reject unknown fields rather than ignoring them
    )


# ── Request ──────────────────────────────────────────────────────────────────


class RegionOfInterest(CamelModel):
    x: int = Field(ge=0, le=100_000)
    y: int = Field(ge=0, le=100_000)
    width: int = Field(gt=0, le=100_000)
    height: int = Field(gt=0, le=100_000)


class ReferenceLevelInput(CamelModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    concentration_value: float | None = Field(default=None, ge=0)
    concentration_unit: str = Field(default="ppm", max_length=32)
    sort_order: int = Field(ge=0, le=1000)
    lab_l: float = Field(ge=0, le=100)
    lab_a: float = Field(ge=-128, le=128)
    lab_b: float = Field(ge=-128, le=128)
    lab_std: float | None = Field(default=None, ge=0)


class TestMethodInput(CamelModel):
    id: str = Field(max_length=64)
    code: str = Field(max_length=64)
    version: str = Field(max_length=40)
    concentration_unit: str = Field(default="ppm", max_length=32)
    validation_status: str = Field(max_length=32)


class ReferenceChartInput(CamelModel):
    id: str = Field(max_length=64)
    version: int = Field(ge=1)
    validation_status: str = Field(max_length=32)


class AnalyzeRequest(CamelModel):
    image_base64: str = Field(min_length=1)
    mime_type: str = Field(default="image/png", max_length=64)
    roi: RegionOfInterest | None = None
    reference_levels: list[ReferenceLevelInput] = Field(default_factory=list, max_length=64)
    test_method: TestMethodInput
    reference_chart: ReferenceChartInput | None = None
    correlation_id: str = Field(max_length=64)

    @field_validator("image_base64")
    @classmethod
    def _bound_payload(cls, value: str) -> str:
        # ~56 MiB of base64 ≈ 42 MiB of image. The Node API enforces a much
        # tighter limit; this is a backstop against a malformed internal call.
        if len(value) > 56_000_000:
            raise ValueError("Image payload is too large.")
        return value


# ── Response ─────────────────────────────────────────────────────────────────


class QualityWarningOut(CamelModel):
    code: str
    severity: Literal["info", "warning", "critical"]
    message: str
    measured_value: float | None = None
    threshold: float | None = None


class ImageQualityOut(CamelModel):
    usable: bool
    verdict: Literal["usable", "marginal", "unusable"]
    score: float = Field(ge=0, le=1)
    warnings: list[QualityWarningOut] = Field(default_factory=list)
    sharpness: float | None = None
    mean_brightness: float | None = None
    clipping_fraction: float | None = None
    contrast: float | None = None


class ColorFeaturesOut(CamelModel):
    rgb_median: list[float]
    rgb_mean: list[float]
    rgb_std: list[float]
    hsv_median: list[float]
    lab_median: list[float]
    lab_mean: list[float]
    lab_std: list[float]
    lab_iqr: list[float]
    saturation_mean: float
    brightness_mean: float
    contrast_score: float | None = None
    sharpness_score: float | None = None
    clipping_fraction: float
    background_lab: list[float] | None = None
    pixel_count: int
    masked_fraction: float
    color_space: str = "sRGB"


class RoiOut(CamelModel):
    x: int
    y: int
    width: int
    height: int
    mode: Literal["AUTO_TUBE_DETECTION", "MANUAL_SELECTION", "CENTER_FALLBACK"]
    confidence: float | None = None


class ReferenceCandidateOut(CamelModel):
    reference_level_id: str
    label: str
    concentration_value: float | None = None
    color_distance: float


class ReferenceMatchOut(CamelModel):
    reference_level_id: str | None = None
    label: str | None = None
    color_distance: float | None = None
    alternatives: list[ReferenceCandidateOut] = Field(default_factory=list)
    out_of_range: bool = False
    ambiguous: bool = False


class PredictionOut(CamelModel):
    label: str | None = None
    estimated_concentration: float | None = None
    """Null unless a validated model supports a numeric estimate."""

    unit: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    """Null in reference-matching mode: a colour distance is not a probability."""


class ModelInfoOut(CamelModel):
    name: str
    version: str
    validated: bool
    model_type: str
    dataset_version: str | None = None


class AnalyzeResponse(CamelModel):
    analysis_id: str
    status: Literal["completed", "rejected_quality", "failed"]
    mode: Literal["reference_matching", "model_inference", "hybrid"]
    image_quality: ImageQualityOut
    color_features: ColorFeaturesOut | None = None
    roi: RoiOut
    prediction: PredictionOut
    reference_match: ReferenceMatchOut
    model: ModelInfoOut
    limitations: list[str] = Field(default_factory=list)
    pipeline_version: str
    processing_ms: int
    correlation_id: str


class ServiceStatusOut(CamelModel):
    status: Literal["ok", "degraded"]
    pipeline_version: str
    active_model: ModelInfoOut | None = None
    available_models: list[dict] = Field(default_factory=list)
    mode: Literal["reference_matching", "model_inference", "hybrid"]
    uptime_seconds: float
