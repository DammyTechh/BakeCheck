"""
Dataset construction.

The assertions that matter are the refusals. A dataset builder that happily
produces a dataset from eight images of one tube, all labelled by the same
technician, is worse than no builder at all — it manufactures a number that
looks like performance.

Leakage is the headline case: `test_no_group_ever_spans_two_splits` is the
property the entire test score depends on.
"""
from __future__ import annotations

import pytest

from app.datasets.builder import (
    PHASH_NEAR_DUPLICATE_DISTANCE,
    build_dataset,
    compute_checksum,
    detect_duplicates,
    split_examples,
    validate_examples,
    verify_no_leakage,
)
from app.datasets.schemas import DatasetExample, LabelSource, Split


def make_example(
    example_id: str,
    label: str = "level-2",
    group: str | None = None,
    source: LabelSource = LabelSource.LABORATORY_MEASUREMENT,
    phash: str | None = None,
    lab: tuple[float, float, float] = (79.2, -15.5, -27.7),
    quality: str = "USABLE",
) -> DatasetExample:
    return DatasetExample(
        id=example_id,
        sample_id=group or f"sample-{example_id}",
        sample_image_id=f"image-{example_id}",
        label_level_id=label,
        label_text=label,
        label_concentration=0.5,
        label_unit="ppm",
        label_source=source,
        sample_type="bread",
        color_features={
            "lab_median": list(lab),
            "rgb_median": [120.0, 207.0, 247.0],
            "hsv_median": [199.0, 0.51, 0.97],
            "saturation_mean": 0.51,
            "brightness_mean": 0.97,
        },
        quality_verdict=quality,
        group_key=group or f"sample-{example_id}",
        perceptual_hash=phash,
    )


def distinct_phash(seed: str) -> str:
    """
    A 64-bit hex hash that is far from every other hash this helper makes.

    Arithmetic sequences are a trap here: `0x1111...` and `0x1113...` differ
    by only 5 bits and the builder correctly calls them near-duplicates. A
    hash digest spreads the bits, so unrelated fixtures stay unrelated.
    """
    import hashlib

    return hashlib.sha256(seed.encode()).hexdigest()[:16]


def make_balanced_set(
    per_class: int = 8,
    classes: tuple[str, ...] = ("level-0", "level-2", "level-4"),
    source: LabelSource = LabelSource.LABORATORY_MEASUREMENT,
) -> list[DatasetExample]:
    """A set large enough and varied enough to pass the dataset-level checks."""
    examples: list[DatasetExample] = []
    for class_index, label in enumerate(classes):
        for n in range(per_class):
            examples.append(
                make_example(
                    f"{label}-{n}",
                    label=label,
                    group=f"group-{label}-{n}",
                    source=source,
                    phash=distinct_phash(f"{label}-{n}"),
                    lab=(50.0 + class_index * 10, -10.0 + class_index, -20.0 - class_index),
                )
            )
    return examples


class TestValidation:
    def test_drops_examples_with_no_label(self):
        good = make_example("a")
        bad = make_example("b")
        bad.label_level_id = None
        bad.label_concentration = None

        kept, issues = validate_examples([good, bad])

        assert [e.id for e in kept] == ["a"]
        assert any(i.code == "missing_label" for i in issues)

    def test_drops_examples_with_no_colour_measurement(self):
        good = make_example("a")
        bad = make_example("b")
        bad.color_features = {"rgb_median": [1, 2, 3]}  # no lab_median

        kept, issues = validate_examples([good, bad])

        assert [e.id for e in kept] == ["a"]
        assert any(i.code == "missing_color_features" for i in issues)

    def test_drops_examples_from_unusable_images(self):
        # The pipeline already judged the colour unreliable. Training on it
        # would teach the model from a measurement the system itself rejects.
        kept, issues = validate_examples(
            [make_example("a"), make_example("b", quality="UNUSABLE")]
        )

        assert [e.id for e in kept] == ["a"]
        assert any(i.code == "unusable_image_quality" for i in issues)


class TestDuplicateDetection:
    def test_removes_exact_duplicates(self):
        shared = "aaaaaaaaaaaaaaaa"
        kept, issues = detect_duplicates(
            [
                make_example("a", phash=shared),
                make_example("b", phash=shared),
                make_example("c", phash="bbbbbbbbbbbbbbbb"),
            ]
        )

        assert len(kept) == 2
        assert any(i.code == "exact_duplicate_images" for i in issues)

    def test_keeps_the_strongest_label_among_duplicates(self):
        shared = "aaaaaaaaaaaaaaaa"
        kept, _ = detect_duplicates(
            [
                make_example("weak", phash=shared, source=LabelSource.TECHNICIAN_ANNOTATION),
                make_example("strong", phash=shared, source=LabelSource.LABORATORY_MEASUREMENT),
            ]
        )

        assert [e.id for e in kept] == ["strong"]

    def test_removes_near_duplicates(self):
        # Two hashes differing by a single bit: the same photograph re-encoded.
        kept, issues = detect_duplicates(
            [
                make_example("a", phash="ffffffffffffffff"),
                make_example("b", phash="fffffffffffffffe"),
            ]
        )

        assert len(kept) == 1
        assert any(i.code == "near_duplicate_images" for i in issues)

    def test_keeps_genuinely_different_images(self):
        kept, _ = detect_duplicates(
            [
                make_example("a", phash="0000000000000000"),
                make_example("b", phash="ffffffffffffffff"),
            ]
        )
        assert len(kept) == 2

    def test_flags_near_duplicates_across_different_samples(self):
        # The same photograph registered against two samples. Either the
        # grouping is wrong or an image was reused — both are data problems.
        _, issues = detect_duplicates(
            [
                make_example("a", group="sample-1", phash="ffffffffffffffff"),
                make_example("b", group="sample-2", phash="fffffffffffffffe"),
            ]
        )

        critical = [i for i in issues if i.severity == "critical"]
        assert any(i.code == "cross_sample_near_duplicates" for i in critical)

    def test_keeps_unhashed_examples_but_warns(self):
        kept, issues = detect_duplicates([make_example("a", phash=None)])

        assert len(kept) == 1
        assert any(i.code == "unhashed_images" for i in issues)

    def test_threshold_is_the_documented_value(self):
        # Guards against someone loosening this silently; at a high enough
        # threshold every image is a "duplicate" of every other.
        assert PHASH_NEAR_DUPLICATE_DISTANCE == 5


class TestSplitting:
    def test_no_group_ever_spans_two_splits(self):
        """
        The property the entire test score rests on.

        Four photographs of each tube — exactly the situation that produces a
        flattering, meaningless accuracy figure if the split is naive.
        """
        examples = [
            make_example(
                f"g{group}-{shot}",
                label=f"level-{group % 3}",
                group=f"group-{group}",
                phash=distinct_phash(f"g{group}-shot{shot}"),
            )
            for group in range(12)
            for shot in range(4)
        ]

        assignment, _ = split_examples(examples)

        splits_per_group: dict[str, set[str]] = {}
        for example in examples:
            splits_per_group.setdefault(example.group_key, set()).add(
                assignment[example.id]
            )

        for group, splits in splits_per_group.items():
            assert len(splits) == 1, f"{group} landed in {splits}"

        assert verify_no_leakage(examples, assignment) == []

    def test_verify_no_leakage_catches_a_manual_violation(self):
        # Prove the verifier actually detects leakage rather than always
        # returning clean.
        examples = [
            make_example("a", group="shared"),
            make_example("b", group="shared"),
        ]
        bad_assignment = {"a": "train", "b": "test"}

        issues = verify_no_leakage(examples, bad_assignment)

        assert len(issues) == 1
        assert issues[0].code == "split_leakage"
        assert issues[0].severity == "critical"

    def test_assignment_is_deterministic(self):
        examples = make_balanced_set()

        first, _ = split_examples(examples, seed=99)
        second, _ = split_examples(examples, seed=99)

        assert first == second

    def test_different_seeds_can_produce_different_assignments(self):
        examples = make_balanced_set(per_class=10)

        a, _ = split_examples(examples, seed=1)
        b, _ = split_examples(examples, seed=2)

        # Not guaranteed different, but with 30 groups it would be a
        # remarkable coincidence — and identical output would suggest the
        # seed is being ignored.
        assert a != b

    def test_warns_when_too_few_groups_to_split_evenly(self):
        # Three groups cannot be divided 60/20/20 without splitting one.
        examples = [
            make_example(f"g{g}-{n}", group=f"group-{g}", label=f"level-{g}")
            for g in range(3)
            for n in range(10)
        ]

        _, issues = split_examples(examples)

        assert any(i.code in ("uneven_split", "empty_split") for i in issues)

    def test_reports_an_empty_split(self):
        examples = [make_example("a"), make_example("b")]

        _, issues = split_examples(examples)

        empty = [i for i in issues if i.code == "empty_split"]
        assert empty and empty[0].severity == "critical"


class TestDatasetAssessment:
    def test_refuses_a_dataset_with_too_few_examples(self):
        dataset, issues = build_dataset(make_balanced_set(per_class=2), "method-1")

        assert dataset is None
        assert any(i.code == "insufficient_examples" for i in issues)

    def test_refuses_a_single_class_dataset(self):
        dataset, issues = build_dataset(
            make_balanced_set(per_class=40, classes=("level-2",)), "method-1"
        )

        assert dataset is None
        assert any(i.code == "insufficient_classes" for i in issues)

    def test_refuses_a_dataset_with_no_measured_ground_truth(self):
        """
        The central honesty check.

        A set labelled entirely by technicians trains a model to agree with
        technicians. That is not the same as measuring bromate, and the
        builder refuses rather than producing a model that cannot be
        distinguished from one that works.
        """
        dataset, issues = build_dataset(
            make_balanced_set(source=LabelSource.TECHNICIAN_ANNOTATION), "method-1"
        )

        assert dataset is None
        blocker = next(i for i in issues if i.code == "no_measured_ground_truth")
        assert blocker.severity == "critical"
        assert "technician" in blocker.message.lower()

    def test_warns_when_measured_ground_truth_is_sparse(self):
        examples = make_balanced_set(per_class=10)
        # Only 3 of 30 backed by a measurement.
        for example in examples[3:]:
            example.label_source = LabelSource.TECHNICIAN_ANNOTATION

        dataset, issues = build_dataset(examples, "method-1")

        assert dataset is not None
        assert any(i.code == "sparse_measured_ground_truth" for i in issues)

    def test_warns_about_class_imbalance(self):
        examples = make_balanced_set(per_class=30, classes=("level-0",))
        examples += make_balanced_set(per_class=2, classes=("level-4",))

        _, issues = build_dataset(examples, "method-1")

        assert any(i.code == "class_imbalance" for i in issues)

    def test_warns_about_thin_classes(self):
        examples = make_balanced_set(per_class=14, classes=("level-0", "level-2"))
        examples += make_balanced_set(per_class=3, classes=("level-4",))

        _, issues = build_dataset(examples, "method-1")

        assert any(i.code == "thin_classes" for i in issues)

    def test_warns_when_one_sample_dominates(self):
        examples = make_balanced_set(per_class=8, classes=("level-0", "level-2"))
        # 20 more photographs, all of one tube.
        examples += [
            make_example(
                f"dom-{n}",
                label="level-4",
                group="one-tube",
                phash=distinct_phash(f"dominant-{n}"),
            )
            for n in range(20)
        ]

        _, issues = build_dataset(examples, "method-1")

        assert any(i.code == "dominant_sample_group" for i in issues)


class TestBuildDataset:
    def test_builds_a_usable_dataset(self):
        dataset, issues = build_dataset(make_balanced_set(per_class=10), "method-1")

        assert dataset is not None
        assert dataset.example_count == 30
        assert dataset.train_count > 0
        assert dataset.validation_count > 0
        assert dataset.test_count > 0
        assert dataset.train_count + dataset.validation_count + dataset.test_count == 30
        assert not [i for i in issues if i.severity == "critical"]

    def test_records_the_class_and_source_distribution(self):
        dataset, _ = build_dataset(make_balanced_set(per_class=10), "method-1")

        assert dataset is not None
        assert dataset.class_distribution == {
            "level-0": 10,
            "level-2": 10,
            "level-4": 10,
        }
        assert dataset.label_source_distribution["LABORATORY_MEASUREMENT"] == 30

    def test_records_the_quality_report(self):
        dataset, _ = build_dataset(make_balanced_set(per_class=10), "method-1")

        assert dataset is not None
        report = dataset.quality_report
        assert report["submitted_examples"] == 30
        assert report["usable_examples"] == 30
        assert report["sample_groups"] == 30
        # The weights used must travel with the dataset, so a later reader can
        # see how annotations were weighted against measurements.
        assert report["label_source_weights"]["TECHNICIAN_ANNOTATION"] < 1.0

    def test_checksum_changes_when_a_label_changes(self):
        examples = make_balanced_set(per_class=10)
        assignment, _ = split_examples(examples)

        before = compute_checksum(examples, assignment)
        examples[0].label_level_id = "level-9"
        after = compute_checksum(examples, assignment)

        assert before != after

    def test_checksum_is_stable_across_input_ordering(self):
        examples = make_balanced_set(per_class=10)
        assignment, _ = split_examples(examples)

        forward = compute_checksum(examples, assignment)
        backward = compute_checksum(list(reversed(examples)), assignment)

        assert forward == backward

    def test_ids_for_split_returns_only_that_split(self):
        dataset, _ = build_dataset(make_balanced_set(per_class=10), "method-1")

        assert dataset is not None
        train = set(dataset.ids_for(Split.TRAIN))
        test = set(dataset.ids_for(Split.TEST))

        assert train and test
        assert not (train & test)


class TestFeatureVector:
    def test_flattens_indexed_features_in_order(self):
        example = make_example("a", lab=(50.0, 10.0, -20.0))

        vector = example.feature_vector(
            ["lab_median.0", "lab_median.1", "lab_median.2", "saturation_mean"]
        )

        assert vector == [50.0, 10.0, -20.0, 0.51]

    def test_returns_none_when_a_feature_is_missing(self):
        # Dropping the example is correct; zero-filling would feed the model
        # a measurement that was never taken.
        example = make_example("a")
        assert example.feature_vector(["lab_median.0", "not_recorded"]) is None

    def test_returns_none_for_an_out_of_range_index(self):
        example = make_example("a")
        assert example.feature_vector(["lab_median.7"]) is None

    @pytest.mark.parametrize(
        ("source", "expected"),
        [
            (LabelSource.LABORATORY_MEASUREMENT, 1.0),
            (LabelSource.REFERENCE_STANDARD, 1.0),
            (LabelSource.TECHNICIAN_ANNOTATION, 0.4),
            (LabelSource.SYNTHETIC_FIXTURE, 0.1),
        ],
    )
    def test_weight_follows_label_source(self, source, expected):
        assert make_example("a", source=source).weight == expected
