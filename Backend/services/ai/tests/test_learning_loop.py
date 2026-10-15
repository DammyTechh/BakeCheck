"""
The complete learning loop, end to end.

Every other test in this suite checks one stage. This file checks the join
between them, because that is where the honesty guarantees are easiest to
lose: each stage can be individually correct while the chain still lets an
unapproved model serve a result.

The chain under test:

    approved examples
      → run_training()        writes an UNAPPROVED artifact
      → registry refuses it   mode stays `reference_matching`
      → approve_artifact()    a human act, recorded
      → registry loads it     mode becomes `model_inference`
      → reset_to_baseline()   mode returns to `reference_matching`

The single most important assertion in this file is
`test_an_unapproved_model_cannot_serve_a_result`: training its own model is
exactly the point at which a system is tempted to start using it.
"""
from __future__ import annotations

import base64
import json
import shutil

import pytest

from app.core.config import Settings
from app.models.registry import (
    ModelRegistry,
    ReferenceMatcherModel,
    SklearnClassifierModel,
)
from app.registry.artifacts import approve_artifact
from app.schemas.analysis import AnalyzeRequest, ReferenceLevelInput
from app.schemas.analysis import TestMethodInput as MethodInput
from app.schemas.training import DatasetExampleInput, TrainingRequest
from app.services.pipeline import AnalysisPipeline
from app.services.training_service import run_training

from conftest import BROMATE_LADDER_RGB, encode_png, make_tube_image
from test_training import ladder_levels, synthesise_examples

CORRELATION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def training_request(**overrides) -> TrainingRequest:
    """A request built from the same synthetic ladder the trainer tests use."""
    examples = overrides.pop("examples", None) or synthesise_examples(per_class=30)

    payload = dict(
        test_method_id="method-1",
        model_name="colour-classifier",
        model_version=None,
        examples=[
            DatasetExampleInput(
                id=e.id,
                sample_id=e.sample_id,
                sample_image_id=e.sample_image_id,
                label_level_id=e.label_level_id,
                label_text=e.label_text,
                label_concentration=e.label_concentration,
                label_unit=e.label_unit,
                label_source=e.label_source.value,
                sample_type=e.sample_type,
                color_features=e.color_features,
                quality_verdict=e.quality_verdict,
                group_key=e.group_key,
                perceptual_hash=e.perceptual_hash,
                capture_device=e.capture_device,
                lighting_note=None,
            )
            for e in examples
        ],
        reference_levels=[
            ReferenceLevelInput(
                id=level.id,
                label=level.label,
                concentrationValue=level.concentration_value,
                concentrationUnit=level.concentration_unit,
                sortOrder=level.sort_order,
                labL=level.lab_l,
                labA=level.lab_a,
                labB=level.lab_b,
                labStd=level.lab_std,
            )
            for level in ladder_levels()
        ],
        correlation_id=CORRELATION_ID,
    )
    payload.update(overrides)
    return TrainingRequest(**payload)


def analysis_request(image_bytes: bytes, levels) -> AnalyzeRequest:
    return AnalyzeRequest(
        imageBase64=base64.b64encode(image_bytes).decode("ascii"),
        mimeType="image/png",
        roi=None,
        referenceLevels=[
            ReferenceLevelInput(
                id=level.id,
                label=level.label,
                concentrationValue=level.concentration_value,
                concentrationUnit=level.concentration_unit,
                sortOrder=level.sort_order,
                labL=level.lab_l,
                labA=level.lab_a,
                labB=level.lab_b,
                labStd=level.lab_std,
            )
            for level in levels
        ],
        testMethod=MethodInput(
            id="method-1",
            code="BROMATE-COLOUR-SCREEN",
            version="0.1.0-prototype",
            concentrationUnit="ppm",
            validationStatus="DRAFT",
        ),
        referenceChart=None,
        correlationId=CORRELATION_ID,
    )


@pytest.fixture
def loop(tmp_path):
    """A trained-but-unapproved artifact plus the pipeline that would serve it."""
    artifact_dir = tmp_path / "artifacts"
    result = run_training(training_request(), artifact_dir)

    assert result.status == "succeeded", result.refusal_reason
    assert result.model is not None

    settings = Settings(
        AI_INTERNAL_KEY="test-internal-key-0123456789abcdef",
        AI_ARTIFACT_DIR=artifact_dir,
    )
    registry = ModelRegistry(artifact_dir)
    pipeline = AnalysisPipeline(registry, settings)

    return result, registry, pipeline, artifact_dir


class TestTrainingProducesACandidateNotAModel:
    def test_a_successful_run_writes_an_unapproved_artifact(self, loop):
        result, _registry, _pipeline, artifact_dir = loop

        assert result.model.approved is False
        assert result.model.validated is False

        metadata = json.loads(
            (
                artifact_dir
                / result.model.name
                / result.model.version
                / "metadata.json"
            ).read_text()
        )
        # Belt and braces: the claim on the wire and the claim on disk must
        # agree, because the registry trusts the file, not the response.
        assert metadata["approved"] is False
        assert metadata["validated"] is False

    def test_an_unapproved_model_cannot_serve_a_result(self, loop, reference_levels):
        """
        The load-bearing assertion of this file.

        A freshly trained model exists on disk and the registry knows where
        it is. Asking the registry to load it must still fail, and the
        pipeline must still answer in `reference_matching` mode — a mode
        whose output carries no confidence and no model-derived claim.
        """
        result, registry, pipeline, _artifact_dir = loop

        loaded = registry.load_model(result.model.name, result.model.version)
        assert loaded is False
        assert isinstance(registry.active, ReferenceMatcherModel)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        response = pipeline.run(analysis_request(image, reference_levels))

        assert response.mode == "reference_matching"
        assert response.prediction.confidence is None
        assert response.model.model_type == "REFERENCE_MATCHER"

    def test_training_never_activates_what_it_trained(self, loop):
        """The registry a training run shares a process with is untouched by it."""
        _result, registry, _pipeline, _artifact_dir = loop
        assert isinstance(registry.active, ReferenceMatcherModel)


class TestApprovalIsWhatChangesTheMode:
    def test_approval_flips_the_pipeline_to_model_inference(
        self, loop, reference_levels
    ):
        """
        The end of the loop: a human approves, and only then does the system
        start answering from the trained model.
        """
        result, registry, pipeline, artifact_dir = loop

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        before = pipeline.run(analysis_request(image, reference_levels))
        assert before.mode == "reference_matching"

        approve_artifact(
            artifact_dir,
            result.model.name,
            result.model.version,
            approved_by="reviewer-1",
        )
        assert registry.load_model(result.model.name, result.model.version) is True
        assert isinstance(registry.active, SklearnClassifierModel)

        after = pipeline.run(analysis_request(image, reference_levels))

        assert after.mode == "model_inference"
        # A model inference does carry a probability, which reference
        # matching deliberately does not.
        assert after.prediction.confidence is not None
        assert 0.0 <= after.prediction.confidence <= 1.0
        assert after.model.name == result.model.name
        assert after.model.version == result.model.version

    def test_the_reference_match_is_still_reported_alongside_the_model(
        self, loop, reference_levels
    ):
        """
        Model inference adds a prediction; it does not replace the
        transparent measurement. A reviewer has to be able to see both and
        notice when they disagree.
        """
        result, registry, pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )
        registry.load_model(result.model.name, result.model.version)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        response = pipeline.run(analysis_request(image, reference_levels))

        assert response.mode == "model_inference"
        assert response.reference_match is not None
        assert response.reference_match.label is not None
        assert response.reference_match.color_distance is not None
        assert response.color_features is not None

    def test_approval_for_use_does_not_assert_scientific_validation(
        self, loop, reference_levels
    ):
        """
        `approved` and `validated` are separate claims. Approving a model to
        run must not make the service start reporting it as validated, which
        is what unlocks a numeric concentration.
        """
        result, registry, pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )
        registry.load_model(result.model.name, result.model.version)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        response = pipeline.run(analysis_request(image, reference_levels))

        assert response.model.validated is False
        assert response.prediction.estimated_concentration is None

    def test_an_unvalidated_model_still_carries_its_limitations(
        self, loop, reference_levels
    ):
        result, registry, pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )
        registry.load_model(result.model.name, result.model.version)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        response = pipeline.run(analysis_request(image, reference_levels))

        assert response.limitations, "a model-inference result must state its limits"


class TestTheLoopIsReversible:
    def test_reset_returns_the_pipeline_to_reference_matching(
        self, loop, reference_levels
    ):
        """
        Rollback has to be a real operation, not a database flag. If a
        released model turns out to be wrong, the service must be able to
        return to the transparent calculation in one call.
        """
        result, registry, pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )
        registry.load_model(result.model.name, result.model.version)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        assert pipeline.run(analysis_request(image, reference_levels)).mode == (
            "model_inference"
        )

        registry.reset_to_baseline()

        rolled_back = pipeline.run(analysis_request(image, reference_levels))
        assert rolled_back.mode == "reference_matching"
        assert rolled_back.prediction.confidence is None

    def test_a_tampered_artifact_is_refused_even_after_approval(self, loop):
        """
        Approval records a checksum. If the file changes afterwards — corrupt
        disk, swapped artifact — the registry must refuse it rather than load
        whatever is now there under an approved model's name.
        """
        result, registry, _pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )

        model_path = (
            artifact_dir / result.model.name / result.model.version / "model.joblib"
        )
        model_path.write_bytes(model_path.read_bytes() + b"\x00tampered")

        assert registry.load_model(result.model.name, result.model.version) is False
        assert isinstance(registry.active, ReferenceMatcherModel)

    def test_a_missing_artifact_leaves_the_active_model_alone(self, loop):
        """A failed load must never leave the service with no model at all."""
        result, registry, _pipeline, artifact_dir = loop
        approve_artifact(
            artifact_dir, result.model.name, result.model.version, "reviewer-1"
        )
        registry.load_model(result.model.name, result.model.version)
        assert isinstance(registry.active, SklearnClassifierModel)

        shutil.rmtree(artifact_dir / result.model.name / result.model.version)

        assert registry.load_model(result.model.name, result.model.version) is False
        # Still serving the previously loaded model, not None.
        assert isinstance(registry.active, SklearnClassifierModel)


class TestTheLoopRefusesRatherThanShipsThinData:
    def test_a_thin_dataset_refuses_and_writes_no_artifact(self, tmp_path):
        """
        "Not enough data yet" is the expected state of this system for a long
        time, and it has to be a clean outcome: no artifact, no model, and
        reasons an administrator can act on.
        """
        artifact_dir = tmp_path / "artifacts"
        result = run_training(
            training_request(examples=synthesise_examples(per_class=3)),
            artifact_dir,
        )

        assert result.status == "refused"
        assert result.model is None
        assert result.refusal_reason
        assert any(issue.severity == "critical" for issue in result.issues)
        # Nothing on disk means nothing approvable, by construction.
        assert not artifact_dir.exists() or not any(artifact_dir.rglob("*.joblib"))

    def test_a_refusal_leaves_the_pipeline_on_the_baseline(
        self, tmp_path, reference_levels
    ):
        artifact_dir = tmp_path / "artifacts"
        run_training(
            training_request(examples=synthesise_examples(per_class=3)),
            artifact_dir,
        )

        settings = Settings(
            AI_INTERNAL_KEY="test-internal-key-0123456789abcdef",
            AI_ARTIFACT_DIR=artifact_dir,
        )
        pipeline = AnalysisPipeline(ModelRegistry(artifact_dir), settings)

        image = encode_png(make_tube_image(BROMATE_LADDER_RGB[2][2]))
        response = pipeline.run(analysis_request(image, reference_levels))

        assert response.mode == "reference_matching"
        assert response.prediction.confidence is None

    def test_a_dataset_of_opinions_alone_is_refused(self, tmp_path):
        """
        Training on technician annotations with no measured ground truth
        would produce a model that has learned what people guessed. The
        builder refuses it, and so the loop never reaches an artifact.
        """
        from app.datasets.schemas import LabelSource

        result = run_training(
            training_request(
                examples=synthesise_examples(
                    per_class=30, source=LabelSource.TECHNICIAN_ANNOTATION
                )
            ),
            tmp_path / "artifacts",
        )

        assert result.status == "refused"
        assert "no_measured_ground_truth" in {i.code for i in result.issues}


class TestTheRunIsReproducibleAndAuditable:
    def test_the_same_examples_and_seed_produce_the_same_dataset(self, tmp_path):
        """
        A dataset version has to be reconstructible, or an evaluation cannot
        be re-checked later. Same examples, same seed, same checksum.
        """
        first = run_training(training_request(), tmp_path / "a")
        second = run_training(training_request(), tmp_path / "b")

        assert first.dataset is not None and second.dataset is not None
        assert first.dataset.content_checksum == second.dataset.content_checksum
        assert first.dataset.split_assignment == second.dataset.split_assignment

    def test_a_different_seed_produces_a_different_split(self, tmp_path):
        first = run_training(training_request(split_seed=1), tmp_path / "a")
        second = run_training(training_request(split_seed=2), tmp_path / "b")

        assert first.dataset is not None and second.dataset is not None
        assert first.dataset.split_assignment != second.dataset.split_assignment

    def test_the_run_reports_what_would_block_release(self, loop):
        """
        A macro F1 on its own is not a release decision. The evaluation has
        to say whether it beat the baseline and what still stands in the way.
        """
        result, _registry, _pipeline, _artifact_dir = loop

        assert result.evaluation is not None
        assert result.evaluation.release_recommendation in {
            "APPROVE",
            "REJECT",
            "INSUFFICIENT_DATA",
        }
        assert "reference_matcher" in json.dumps(
            result.evaluation.baseline_comparison
        ) or "baseline" in json.dumps(result.evaluation.baseline_comparison)

        if result.evaluation.release_recommendation != "APPROVE":
            assert result.evaluation.release_blockers, (
                "a non-approval must say what blocked it"
            )

    def test_the_artifact_records_the_dataset_it_came_from(self, loop):
        result, _registry, _pipeline, artifact_dir = loop

        metadata = json.loads(
            (
                artifact_dir
                / result.model.name
                / result.model.version
                / "metadata.json"
            ).read_text()
        )

        assert metadata.get("dataset_version") == result.dataset.version
        assert metadata["artifact_checksum"] == result.model.artifact_checksum
        assert metadata["feature_order"] == result.model.feature_order
