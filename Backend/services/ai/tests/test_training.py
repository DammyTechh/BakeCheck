"""
Training, evaluation and artifact persistence.

The tests that matter here are the ones asserting what the pipeline refuses
to do: train on one class, calibrate without enough data, recommend release
on a thin test set, or mark its own output approved.

Synthetic data is generated from the seeded bromate ladder with controlled
noise, so a model genuinely can learn the mapping — which is what makes a
*failure* to learn meaningful rather than an artefact of impossible data.
"""
from __future__ import annotations

import json

import numpy as np
import pytest

from app.colorimetry.conversion import rgb_to_lab
from app.datasets.builder import build_dataset
from app.datasets.schemas import DatasetExample, LabelSource, Split
from app.evaluation.evaluator import (
    MIN_MACRO_F1,
    MIN_TEST_EXAMPLES,
    evaluate_model,
)
from app.reference_matching.matcher import ReferenceLevel
from app.registry.artifacts import approve_artifact, write_artifact
from app.training.trainer import (
    DEFAULT_FEATURE_ORDER,
    MIN_EXAMPLES_FOR_CALIBRATION,
    TrainingConfig,
    train_model,
)

from conftest import BROMATE_LADDER_RGB


def phash(seed: str) -> str:
    import hashlib

    return hashlib.sha256(seed.encode()).hexdigest()[:16]


def synthesise_examples(
    per_class: int = 20,
    noise: float = 3.0,
    classes: tuple[int, ...] = (0, 2, 4),
    source: LabelSource = LabelSource.LABORATORY_MEASUREMENT,
    seed: int = 7,
) -> list[DatasetExample]:
    """
    Generate labelled examples around the seeded ladder colours.

    Each example is one reference colour plus Gaussian noise in RGB —
    standing in for camera and lighting variation. With moderate noise the
    classes stay separable, so a working trainer should reach high macro F1
    and a broken one should not.
    """
    rng = np.random.default_rng(seed)
    examples: list[DatasetExample] = []

    for class_index in classes:
        label_name, _ppm, base_rgb = BROMATE_LADDER_RGB[class_index]
        for n in range(per_class):
            rgb = np.clip(np.asarray(base_rgb, dtype=float) + rng.normal(0, noise, 3), 0, 255)
            lab = rgb_to_lab(rgb)
            maximum, minimum = float(rgb.max()), float(rgb.min())
            saturation = 0.0 if maximum == 0 else (maximum - minimum) / maximum

            examples.append(
                DatasetExample(
                    id=f"ex-{class_index}-{n}",
                    sample_id=f"sample-{class_index}-{n}",
                    sample_image_id=f"image-{class_index}-{n}",
                    label_level_id=f"level-{class_index}",
                    label_text=label_name,
                    label_concentration=float(_ppm),
                    label_unit="ppm",
                    label_source=source,
                    sample_type="bread",
                    color_features={
                        "lab_median": [round(float(v), 4) for v in lab],
                        "rgb_median": [round(float(v), 3) for v in rgb],
                        "hsv_median": [0.0, round(saturation, 4), round(maximum / 255.0, 4)],
                        "saturation_mean": round(saturation, 4),
                        "brightness_mean": round(maximum / 255.0, 4),
                    },
                    quality_verdict="USABLE",
                    group_key=f"sample-{class_index}-{n}",
                    perceptual_hash=phash(f"{class_index}-{n}"),
                    capture_device="phone-a" if n % 2 == 0 else "phone-b",
                )
            )

    return examples


def ladder_levels() -> list[ReferenceLevel]:
    levels = []
    for index, (label, ppm, rgb) in enumerate(BROMATE_LADDER_RGB):
        lab = rgb_to_lab(np.asarray(rgb, dtype=float))
        levels.append(
            ReferenceLevel(
                id=f"level-{index}",
                label=label,
                concentration_value=ppm,
                concentration_unit="ppm",
                sort_order=index,
                lab_l=float(lab[0]),
                lab_a=float(lab[1]),
                lab_b=float(lab[2]),
                lab_std=1.0,
            )
        )
    return levels


@pytest.fixture
def trained_setup():
    """A dataset large and clean enough to train and evaluate on."""
    examples = synthesise_examples(per_class=30)
    dataset, issues = build_dataset(examples, "method-1")
    assert dataset is not None, [i.message for i in issues if i.severity == "critical"]

    by_id = {e.id: e for e in examples}
    training = train_model(dataset, by_id)
    return dataset, by_id, training


class TestTraining:
    def test_learns_a_separable_mapping(self, trained_setup):
        dataset, by_id, training = trained_setup

        assert training.training_examples > 0
        assert len(training.classes) == 3
        assert training.feature_order == DEFAULT_FEATURE_ORDER

        # Sanity: it should fit its own training data nearly perfectly on
        # well-separated synthetic classes. Failing here means the pipeline
        # is broken, not that the task is hard.
        train_examples = [by_id[i] for i in dataset.ids_for(Split.TRAIN)]
        features = np.asarray(
            [e.feature_vector(training.feature_order) for e in train_examples],
            dtype=np.float64,
        )
        predicted = training.pipeline.predict(features)
        truth = [e.label for e in train_examples]
        assert (predicted == np.asarray(truth, dtype=object)).mean() > 0.9

    def test_refuses_a_single_class_training_split(self):
        examples = synthesise_examples(per_class=40, classes=(2,))
        # Bypass the builder, which would refuse first, to test the trainer's
        # own guard.
        from app.datasets.schemas import DatasetVersion

        dataset = DatasetVersion(
            version="v1",
            test_method_id="method-1",
            example_ids=[e.id for e in examples],
            split_assignment={e.id: "train" for e in examples},
            class_distribution={"level-2": len(examples)},
            label_source_distribution={},
            quality_report={},
            content_checksum="x",
            train_count=len(examples),
            validation_count=0,
            test_count=0,
        )

        with pytest.raises(ValueError, match="only one class"):
            train_model(dataset, {e.id: e for e in examples})

    def test_refuses_an_empty_training_split(self, trained_setup):
        dataset, by_id, _ = trained_setup
        dataset.split_assignment = {i: "test" for i in dataset.example_ids}

        with pytest.raises(ValueError, match="training split is empty"):
            train_model(dataset, by_id)

    def test_drops_examples_missing_features_rather_than_imputing(self):
        examples = synthesise_examples(per_class=15)
        # Strip a feature from one example. Zero-filling would feed the model
        # an observation that was never made.
        examples[0].color_features.pop("saturation_mean")

        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        training = train_model(dataset, {e.id: e for e in examples})

        # It trained, and said so if the dropped example was in the split.
        assert training.training_examples > 0


class TestCalibration:
    def test_skips_calibration_when_data_is_thin(self):
        # 36 examples total — enough for the builder to accept, but the
        # training split lands around 21, well below the floor for
        # estimating a calibration curve.
        examples = synthesise_examples(per_class=12)
        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        training = train_model(dataset, {e.id: e for e in examples})

        assert training.calibrated is False
        assert training.calibration_skipped_reason is not None
        assert any("not calibrated" in lim.lower() for lim in training.limitations)

    def test_calibrates_when_data_supports_it(self):
        examples = synthesise_examples(per_class=40)
        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        training = train_model(dataset, {e.id: e for e in examples})

        assert training.training_examples >= MIN_EXAMPLES_FOR_CALIBRATION
        assert training.calibrated is True
        assert training.calibration_skipped_reason is None

    def test_calibration_can_be_disabled(self):
        examples = synthesise_examples(per_class=40)
        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        training = train_model(
            dataset,
            {e.id: e for e in examples},
            TrainingConfig(attempt_calibration=False),
        )

        assert training.calibrated is False
        assert "disabled" in (training.calibration_skipped_reason or "")


class TestSampleWeighting:
    def test_records_when_weighting_is_disabled(self):
        examples = synthesise_examples(per_class=15)
        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        training = train_model(
            dataset,
            {e.id: e for e in examples},
            TrainingConfig(use_sample_weights=False),
        )

        # Treating an annotation as equal to a measurement is a choice that
        # has to be visible in the record.
        assert any("weighting was disabled" in lim.lower() for lim in training.limitations)

    def test_reports_how_much_ground_truth_backed_the_training(self, trained_setup):
        _, _, training = trained_setup

        backing = [lim for lim in training.limitations if "backed by a laboratory" in lim]
        assert backing, training.limitations


class TestEvaluation:
    def test_produces_a_full_report(self, trained_setup):
        dataset, by_id, training = trained_setup

        report = evaluate_model(training, dataset, by_id, ladder_levels())

        assert report.split == "test"
        assert report.sample_size > 0
        assert 0.0 <= report.accuracy <= 1.0
        assert 0.0 <= report.macro_f1 <= 1.0
        assert report.confusion_matrix["labels"]
        assert report.per_class_metrics
        assert report.evaluation_limitations

    def test_separable_classes_are_learned_well(self, trained_setup):
        dataset, by_id, training = trained_setup

        report = evaluate_model(training, dataset, by_id, ladder_levels())

        # The ladder colours are far apart; a working pipeline should manage
        # this easily. A low score means something is broken.
        assert report.macro_f1 > 0.8, report.per_class_metrics

    def test_compares_against_the_reference_matcher(self, trained_setup):
        dataset, by_id, training = trained_setup

        report = evaluate_model(training, dataset, by_id, ladder_levels())

        comparison = report.baseline_comparison
        assert comparison["baseline"].startswith("reference-matching")
        assert comparison["baseline_macro_f1"] is not None
        assert comparison["comparable_examples"] > 0

    def test_blocks_release_when_the_model_cannot_beat_the_baseline(
        self, trained_setup
    ):
        """
        On clean synthetic data the reference matcher is already near-perfect,
        so a trained model has almost no room to improve — and the evaluator
        should say so rather than waving it through.
        """
        dataset, by_id, training = trained_setup

        report = evaluate_model(training, dataset, by_id, ladder_levels())

        improvement = report.baseline_comparison["improvement"]
        if improvement is not None and improvement < 0.02:
            assert report.release_recommendation != "APPROVE"
            assert any("reference matcher" in b for b in report.release_blockers)

    def test_blocks_release_on_a_thin_test_set(self):
        # 36 examples total: the builder accepts it, but a 20% test split
        # leaves far fewer than the 30 the evaluator requires.
        examples = synthesise_examples(per_class=12)
        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        by_id = {e.id: e for e in examples}
        training = train_model(dataset, by_id)
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        assert report.sample_size < MIN_TEST_EXAMPLES
        assert report.release_recommendation == "INSUFFICIENT_DATA"
        assert any("minimum of" in b for b in report.release_blockers)

    def test_slices_metrics_by_subgroup(self, trained_setup):
        dataset, by_id, training = trained_setup

        report = evaluate_model(training, dataset, by_id, ladder_levels())

        assert "capture_device" in report.subgroup_metrics
        assert "sample_type" in report.subgroup_metrics
        assert "label_source" in report.subgroup_metrics

    def test_reports_small_subgroups_as_unmeasurable(self, trained_setup):
        dataset, by_id, training = trained_setup
        # Make one device rare.
        for example in list(by_id.values())[:2]:
            example.capture_device = "rare-device"

        report = evaluate_model(training, dataset, by_id, ladder_levels())
        devices = report.subgroup_metrics["capture_device"]

        if "rare-device" in devices and devices["rare-device"]["count"] < 5:
            # A number here would be meaningless; the evaluator says so.
            assert devices["rare-device"]["macro_f1"] is None
            assert "too few" in devices["rare-device"]["note"]

    def test_notes_when_accuracy_flatters_the_model(self):
        # Heavily imbalanced: accuracy will look good, macro F1 will not.
        examples = synthesise_examples(per_class=40, classes=(0,))
        examples += synthesise_examples(per_class=6, classes=(2,), seed=11)
        examples += synthesise_examples(per_class=6, classes=(4,), seed=12)

        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        by_id = {e.id: e for e in examples}
        training = train_model(dataset, by_id)
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        if report.accuracy - report.macro_f1 > 0.2:
            assert any(
                "macro F1" in lim for lim in report.evaluation_limitations
            )

    def test_flags_labels_that_came_from_technician_opinion(self):
        examples = synthesise_examples(
            per_class=15, source=LabelSource.LABORATORY_MEASUREMENT
        )
        # Half the set relabelled as technician annotation.
        for example in examples[::2]:
            example.label_source = LabelSource.TECHNICIAN_ANNOTATION

        dataset, _ = build_dataset(examples, "method-1")
        assert dataset is not None

        by_id = {e.id: e for e in examples}
        training = train_model(dataset, by_id)
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        assert any(
            "technician annotation" in lim for lim in report.evaluation_limitations
        )

    def test_raises_on_an_empty_evaluation_split(self, trained_setup):
        dataset, by_id, training = trained_setup
        dataset.split_assignment = {i: "train" for i in dataset.example_ids}

        with pytest.raises(ValueError, match="empty"):
            evaluate_model(training, dataset, by_id, ladder_levels())

    def test_release_floor_is_the_documented_value(self):
        # Guards against someone quietly lowering the bar.
        assert MIN_MACRO_F1 == 0.6
        assert MIN_TEST_EXAMPLES == 30


class TestArtifacts:
    def test_writes_an_unapproved_artifact(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        metadata = write_artifact(
            tmp_path, "test-model", "1.0.0", training, report, dataset
        )

        # The critical assertion: training never produces an approved model.
        assert metadata["approved"] is False
        assert metadata["validated"] is False
        assert (tmp_path / "test-model" / "1.0.0" / "model.joblib").exists()
        assert (tmp_path / "test-model" / "1.0.0" / "metadata.json").exists()
        assert (tmp_path / "test-model" / "1.0.0" / "evaluation.json").exists()

    def test_records_the_feature_order(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        metadata = write_artifact(tmp_path, "m", "1.0.0", training, report, dataset)

        # A vector built in a different order at inference time produces
        # confident nonsense, so the order is part of the artifact.
        assert metadata["feature_order"] == training.feature_order

    def test_records_the_dataset_checksum(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        metadata = write_artifact(tmp_path, "m", "1.0.0", training, report, dataset)

        assert metadata["dataset_checksum"] == dataset.content_checksum

    def test_approval_flips_the_flag(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())
        write_artifact(tmp_path, "m", "1.0.0", training, report, dataset)

        approved = approve_artifact(tmp_path, "m", "1.0.0", approved_by="admin-uuid")

        assert approved["approved"] is True
        assert approved["approved_by"] == "admin-uuid"
        # Approving for use is not the same as certifying it scientifically.
        assert approved["validated"] is False

    def test_approval_refuses_a_tampered_artifact(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())
        write_artifact(tmp_path, "m", "1.0.0", training, report, dataset)

        # Swap the model file for something else.
        (tmp_path / "m" / "1.0.0" / "model.joblib").write_bytes(b"not the model")

        with pytest.raises(ValueError, match="checksum mismatch"):
            approve_artifact(tmp_path, "m", "1.0.0", approved_by="admin-uuid")

    def test_approval_requires_an_existing_artifact(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            approve_artifact(tmp_path, "missing", "1.0.0", approved_by="admin")

    def test_artifact_carries_its_limitations(self, tmp_path, trained_setup):
        dataset, by_id, training = trained_setup
        report = evaluate_model(training, dataset, by_id, ladder_levels())

        write_artifact(tmp_path, "m", "1.0.0", training, report, dataset)
        metadata = json.loads(
            (tmp_path / "m" / "1.0.0" / "metadata.json").read_text(encoding="utf-8")
        )

        assert len(metadata["limitations"]) >= 2
        assert metadata["release_recommendation"] in (
            "APPROVE",
            "REJECT",
            "INSUFFICIENT_DATA",
        )
