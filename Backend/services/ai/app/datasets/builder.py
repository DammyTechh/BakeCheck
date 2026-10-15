"""
Dataset construction: selection, quality validation, leakage control, splits.

This is the stage that decides whether a trained model means anything. A
model is only as honest as the dataset behind it, and the two ways datasets
lie are:

  1. **Leakage** — near-duplicate images of the same physical sample landing
     on both sides of the train/test boundary. The test score then measures
     memorisation, not generalisation, and it looks excellent.

  2. **Mislabelled authority** — treating a technician's reading of a colour
     as equivalent to an instrument measurement. The model learns to agree
     with people, including when they are wrong.

Both are handled structurally here rather than left to discipline: splitting
groups by physical sample, and `label_source` travelling with every example
so the trainer can weight and the evaluator can slice on it.
"""
from __future__ import annotations

import hashlib
import json
import logging
from collections import Counter, defaultdict
from datetime import UTC, datetime

from .schemas import (
    LABEL_SOURCE_WEIGHTS,
    DatasetExample,
    DatasetVersion,
    LabelSource,
    QualityIssue,
    Split,
)

logger = logging.getLogger(__name__)


# ── Thresholds ───────────────────────────────────────────────────────────────
# Conservative engineering floors, not statistical guarantees. Clearing them
# means a dataset is not obviously unusable; it does not make it sufficient.

#: Below this, every metric computed from the dataset is noise.
MIN_TOTAL_EXAMPLES = 30
#: A class with fewer than this cannot have its performance estimated.
MIN_EXAMPLES_PER_CLASS = 5
#: A classifier needs something to discriminate between.
MIN_DISTINCT_CLASSES = 2
#: Hamming distance between 64-bit perceptual hashes below which two images
#: are treated as near-duplicates. 5 is the usual working threshold: identical
#: images score 0, re-encodes and minor crops score 1 to 4.
PHASH_NEAR_DUPLICATE_DISTANCE = 5
#: Warn when the largest class is this many times the smallest.
CLASS_IMBALANCE_WARN_RATIO = 10.0


def _hamming_distance(hex_a: str, hex_b: str) -> int | None:
    """
    Bit distance between two hex-encoded perceptual hashes.

    Returns None when either hash is missing or malformed, so a bad value
    degrades to "cannot compare" rather than to a false "identical".
    """
    if not hex_a or not hex_b:
        return None
    try:
        return bin(int(hex_a, 16) ^ int(hex_b, 16)).count("1")
    except ValueError:
        return None


def validate_examples(
    examples: list[DatasetExample],
) -> tuple[list[DatasetExample], list[QualityIssue]]:
    """
    Drop examples that cannot support training, and report why.

    Exclusions are returned as issues rather than silently applied: an
    administrator looking at a dataset version should be able to see what was
    left out and decide whether that is acceptable.
    """
    issues: list[QualityIssue] = []
    kept: list[DatasetExample] = []

    missing_label: list[str] = []
    missing_features: list[str] = []
    unusable_quality: list[str] = []

    for example in examples:
        if not example.label_level_id and example.label_concentration is None:
            missing_label.append(example.id)
            continue

        # The colour measurement is the entire input. Without a Lab median
        # there is nothing to learn from.
        lab = example.color_features.get("lab_median")
        if not isinstance(lab, (list, tuple)) or len(lab) != 3:
            missing_features.append(example.id)
            continue

        # An image the pipeline judged unusable produced a colour measurement
        # that should not be trusted as a training signal.
        if example.quality_verdict == "UNUSABLE":
            unusable_quality.append(example.id)
            continue

        kept.append(example)

    if missing_label:
        issues.append(
            QualityIssue(
                "missing_label",
                "warning",
                f"{len(missing_label)} example(s) had neither a reference level "
                "nor a concentration and were excluded.",
                missing_label,
            )
        )
    if missing_features:
        issues.append(
            QualityIssue(
                "missing_color_features",
                "warning",
                f"{len(missing_features)} example(s) had no usable CIELAB "
                "measurement and were excluded.",
                missing_features,
            )
        )
    if unusable_quality:
        issues.append(
            QualityIssue(
                "unusable_image_quality",
                "warning",
                f"{len(unusable_quality)} example(s) came from images the "
                "pipeline judged unusable and were excluded.",
                unusable_quality,
            )
        )

    return kept, issues


def detect_duplicates(
    examples: list[DatasetExample],
) -> tuple[list[DatasetExample], list[QualityIssue]]:
    """
    Remove exact and near-duplicate images, keeping one representative each.

    Two images of the same tube are not two independent observations. Left in,
    they inflate the apparent dataset size and — if they land in different
    splits — the apparent accuracy.

    Exact duplicates are caught by identical perceptual hash; near-duplicates
    by Hamming distance. Comparison is O(n²), which is fine at the scale this
    system will realistically reach (hundreds, not millions) and avoids the
    false negatives an LSH index would introduce.
    """
    issues: list[QualityIssue] = []

    by_hash: dict[str, list[DatasetExample]] = defaultdict(list)
    without_hash: list[DatasetExample] = []

    for example in examples:
        if example.perceptual_hash:
            by_hash[example.perceptual_hash].append(example)
        else:
            without_hash.append(example)

    exact_duplicates: list[str] = []
    representatives: list[DatasetExample] = []

    for _hash, group in by_hash.items():
        # Keep the strongest label when the same image appears more than once.
        group.sort(key=lambda e: (-e.weight, e.id))
        representatives.append(group[0])
        exact_duplicates.extend(e.id for e in group[1:])

    if exact_duplicates:
        issues.append(
            QualityIssue(
                "exact_duplicate_images",
                "warning",
                f"{len(exact_duplicates)} example(s) shared a perceptual hash "
                "with another and were excluded as duplicates.",
                exact_duplicates,
            )
        )

    # Near-duplicates among the surviving representatives.
    near_duplicates: list[str] = []
    cross_group_pairs: list[str] = []
    accepted: list[DatasetExample] = []

    for candidate in representatives:
        collision = None
        for existing in accepted:
            distance = _hamming_distance(
                candidate.perceptual_hash or "", existing.perceptual_hash or ""
            )
            if distance is not None and distance <= PHASH_NEAR_DUPLICATE_DISTANCE:
                collision = (existing, distance)
                break

        if collision is None:
            accepted.append(candidate)
            continue

        existing, distance = collision
        near_duplicates.append(candidate.id)

        # A near-duplicate pair spanning two different samples is worth
        # flagging separately: either the group keys are wrong, or the same
        # photograph was registered against two samples. Both are data
        # problems a reviewer should see.
        if existing.group_key != candidate.group_key:
            cross_group_pairs.append(
                f"{candidate.id}~{existing.id} (distance {distance}, "
                f"groups {candidate.group_key} / {existing.group_key})"
            )

    if near_duplicates:
        issues.append(
            QualityIssue(
                "near_duplicate_images",
                "warning",
                f"{len(near_duplicates)} example(s) were within "
                f"{PHASH_NEAR_DUPLICATE_DISTANCE} bits of another image and "
                "were excluded.",
                near_duplicates,
            )
        )

    if cross_group_pairs:
        issues.append(
            QualityIssue(
                "cross_sample_near_duplicates",
                "critical",
                "Near-identical images are registered against different "
                "samples. Either the grouping is wrong or one photograph was "
                "used twice: "
                + "; ".join(cross_group_pairs[:5])
                + ("…" if len(cross_group_pairs) > 5 else ""),
                [],
            )
        )

    # Examples with no perceptual hash cannot be checked. Keep them — dropping
    # usable data over a missing optional field would be worse — but say so.
    if without_hash:
        issues.append(
            QualityIssue(
                "unhashed_images",
                "warning",
                f"{len(without_hash)} example(s) carried no perceptual hash "
                "and could not be checked for duplication.",
                [e.id for e in without_hash],
            )
        )

    return accepted + without_hash, issues


def assess_dataset(examples: list[DatasetExample]) -> list[QualityIssue]:
    """
    Dataset-level checks that only make sense once the set is assembled.

    These are reported, not enforced — the caller decides whether a critical
    issue blocks training. Separating "what is wrong" from "what to do about
    it" keeps the policy in one place.
    """
    issues: list[QualityIssue] = []

    if len(examples) < MIN_TOTAL_EXAMPLES:
        issues.append(
            QualityIssue(
                "insufficient_examples",
                "critical",
                f"{len(examples)} usable example(s); at least "
                f"{MIN_TOTAL_EXAMPLES} are needed before any metric is "
                "meaningful.",
            )
        )

    class_counts = Counter(e.label for e in examples)

    if len(class_counts) < MIN_DISTINCT_CLASSES:
        issues.append(
            QualityIssue(
                "insufficient_classes",
                "critical",
                f"{len(class_counts)} distinct label(s). A classifier needs at "
                "least two to discriminate between.",
            )
        )

    thin_classes = [
        label for label, count in class_counts.items() if count < MIN_EXAMPLES_PER_CLASS
    ]
    if thin_classes:
        issues.append(
            QualityIssue(
                "thin_classes",
                "warning",
                f"{len(thin_classes)} class(es) have fewer than "
                f"{MIN_EXAMPLES_PER_CLASS} examples, so their per-class "
                f"performance cannot be estimated: {', '.join(sorted(thin_classes)[:6])}",
            )
        )

    if class_counts:
        largest = max(class_counts.values())
        smallest = min(class_counts.values())
        if smallest > 0 and largest / smallest >= CLASS_IMBALANCE_WARN_RATIO:
            issues.append(
                QualityIssue(
                    "class_imbalance",
                    "warning",
                    f"The largest class has {largest} examples and the "
                    f"smallest {smallest} ({largest / smallest:.0f}×). Overall "
                    "accuracy will be misleading; judge this model on macro F1.",
                )
            )

    # The honesty check. A dataset labelled entirely by technician opinion
    # trains a model to reproduce that opinion, which is not the same as
    # measuring bromate.
    source_counts = Counter(e.label_source for e in examples)
    measured = source_counts.get(LabelSource.LABORATORY_MEASUREMENT, 0) + source_counts.get(
        LabelSource.REFERENCE_STANDARD, 0
    )
    if examples and measured == 0:
        issues.append(
            QualityIssue(
                "no_measured_ground_truth",
                "critical",
                "No example is backed by a laboratory measurement or a "
                "reference standard. A model trained on technician "
                "annotations alone learns to agree with technicians, not to "
                "measure concentration.",
            )
        )
    elif examples and measured / len(examples) < 0.25:
        issues.append(
            QualityIssue(
                "sparse_measured_ground_truth",
                "warning",
                f"Only {measured} of {len(examples)} examples "
                f"({measured / len(examples):.0%}) are backed by a measurement. "
                "Treat any resulting performance figure with caution.",
            )
        )

    # One sample contributing most of the data means the model may be learning
    # that sample rather than the chemistry.
    group_counts = Counter(e.group_key for e in examples)
    if group_counts:
        largest_group = max(group_counts.values())
        if examples and largest_group / len(examples) > 0.3:
            issues.append(
                QualityIssue(
                    "dominant_sample_group",
                    "warning",
                    f"One physical sample accounts for {largest_group} of "
                    f"{len(examples)} examples "
                    f"({largest_group / len(examples):.0%}). The model may "
                    "learn that sample rather than the measurement.",
                )
            )

    return issues


def split_examples(
    examples: list[DatasetExample],
    test_fraction: float = 0.2,
    validation_fraction: float = 0.2,
    seed: int = 20261011,
) -> tuple[dict[str, str], list[QualityIssue]]:
    """
    Assign examples to train / validation / test, grouped by physical sample.

    **Every example sharing a `group_key` goes to the same split.** This is
    the single most important property of the whole pipeline: two photographs
    of one tube are not independent, and letting them straddle the boundary
    produces a test score that measures memorisation.

    Groups are assigned largest-first to the split furthest below its target,
    which keeps the proportions close without ever splitting a group. The
    assignment is deterministic given the same inputs and seed, so a dataset
    version can be rebuilt exactly.
    """
    issues: list[QualityIssue] = []

    groups: dict[str, list[DatasetExample]] = defaultdict(list)
    for example in examples:
        groups[example.group_key].append(example)

    total = len(examples)
    targets = {
        Split.TEST: total * test_fraction,
        Split.VALIDATION: total * validation_fraction,
        Split.TRAIN: total * (1.0 - test_fraction - validation_fraction),
    }
    assigned_counts = {split: 0 for split in targets}
    assignment: dict[str, str] = {}

    # Deterministic order: by size descending, then by key. A hash of the key
    # mixed with the seed breaks ties stably without importing `random`, so
    # the result does not depend on Python's hash randomisation.
    def sort_key(item: tuple[str, list[DatasetExample]]) -> tuple[int, str]:
        key, members = item
        tiebreak = hashlib.sha256(f"{seed}:{key}".encode()).hexdigest()
        return (-len(members), tiebreak)

    # The key is only needed for ordering, which sort_key already applied.
    for _group_key, members in sorted(groups.items(), key=sort_key):
        # Place this group where the shortfall against target is largest.
        deficits = {
            split: targets[split] - assigned_counts[split] for split in targets
        }
        chosen = max(deficits, key=lambda s: (deficits[s], s.value))

        for member in members:
            assignment[member.id] = chosen.value
        assigned_counts[chosen] += len(members)

    # With few groups, the realised proportions can drift a long way from the
    # requested ones. That is correct behaviour — never split a group — but
    # the administrator should know.
    if total:
        realised_test = assigned_counts[Split.TEST] / total
        if abs(realised_test - test_fraction) > 0.15:
            issues.append(
                QualityIssue(
                    "uneven_split",
                    "warning",
                    f"The test split holds {realised_test:.0%} of examples "
                    f"against a {test_fraction:.0%} target. With "
                    f"{len(groups)} sample group(s), proportions cannot be "
                    "matched more closely without splitting a group, which "
                    "would leak data between train and test.",
                )
            )

    for split in (Split.TRAIN, Split.VALIDATION, Split.TEST):
        if assigned_counts[split] == 0:
            issues.append(
                QualityIssue(
                    "empty_split",
                    "critical",
                    f"The {split.value} split is empty. There are too few "
                    f"distinct sample groups ({len(groups)}) to form three "
                    "non-overlapping splits.",
                )
            )

    return assignment, issues


def verify_no_leakage(
    examples: list[DatasetExample], assignment: dict[str, str]
) -> list[QualityIssue]:
    """
    Independently confirm that no sample group spans two splits.

    `split_examples` is written so this cannot happen. This checks it anyway —
    the whole value of the test score rests on the property, so it is worth
    asserting rather than trusting.
    """
    group_splits: dict[str, set[str]] = defaultdict(set)
    for example in examples:
        split = assignment.get(example.id)
        if split:
            group_splits[example.group_key].add(split)

    straddling = {g: sorted(s) for g, s in group_splits.items() if len(s) > 1}

    if straddling:
        detail = "; ".join(f"{g} in {'+'.join(s)}" for g, s in list(straddling.items())[:5])
        return [
            QualityIssue(
                "split_leakage",
                "critical",
                f"{len(straddling)} sample group(s) span more than one split, "
                f"so the test score would measure memorisation: {detail}",
                [],
            )
        ]
    return []


def compute_checksum(
    examples: list[DatasetExample], assignment: dict[str, str]
) -> str:
    """
    A checksum over the ordered example ids, their labels and their splits.

    Lets a later run detect that a dataset version's contents changed —
    "the model got worse" is only answerable if you can tell whether the data
    moved.
    """
    payload = [
        {
            "id": e.id,
            "label": e.label,
            "source": e.label_source.value,
            "split": assignment.get(e.id),
        }
        for e in sorted(examples, key=lambda x: x.id)
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def build_dataset(
    examples: list[DatasetExample],
    test_method_id: str,
    version: str | None = None,
    test_fraction: float = 0.2,
    validation_fraction: float = 0.2,
    seed: int = 20261011,
) -> tuple[DatasetVersion | None, list[QualityIssue]]:
    """
    Assemble a frozen dataset version from approved examples.

    Returns `(None, issues)` when a critical problem makes the dataset
    unusable — too few examples, a single class, no measured ground truth,
    an empty split. Refusing is the correct outcome: a model trained on such
    a set would produce numbers that look like performance and are not.
    """
    all_issues: list[QualityIssue] = []

    validated, issues = validate_examples(examples)
    all_issues.extend(issues)

    deduplicated, issues = detect_duplicates(validated)
    all_issues.extend(issues)

    all_issues.extend(assess_dataset(deduplicated))

    assignment, issues = split_examples(
        deduplicated, test_fraction, validation_fraction, seed
    )
    all_issues.extend(issues)
    all_issues.extend(verify_no_leakage(deduplicated, assignment))

    blockers = [i for i in all_issues if i.severity == "critical"]
    if blockers:
        logger.warning(
            "Dataset build refused for method %s: %s",
            test_method_id,
            "; ".join(i.code for i in blockers),
        )
        return None, all_issues

    resolved_version = version or datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    split_counts = Counter(assignment.values())

    dataset = DatasetVersion(
        version=resolved_version,
        test_method_id=test_method_id,
        example_ids=sorted(e.id for e in deduplicated),
        split_assignment=assignment,
        class_distribution=dict(Counter(e.label for e in deduplicated)),
        label_source_distribution={
            source.value: count
            for source, count in Counter(e.label_source for e in deduplicated).items()
        },
        quality_report={
            "issues": [
                {
                    "code": i.code,
                    "severity": i.severity,
                    "message": i.message,
                    "affected_count": len(i.example_ids),
                }
                for i in all_issues
            ],
            "submitted_examples": len(examples),
            "usable_examples": len(deduplicated),
            "excluded_examples": len(examples) - len(deduplicated),
            "sample_groups": len({e.group_key for e in deduplicated}),
            "split_seed": seed,
            "near_duplicate_threshold_bits": PHASH_NEAR_DUPLICATE_DISTANCE,
            # Recorded with the dataset so a later analysis can see exactly
            # how a technician annotation was weighted against a measurement.
            "label_source_weights": {
                source.value: weight for source, weight in LABEL_SOURCE_WEIGHTS.items()
            },
            "built_at": datetime.now(UTC).isoformat(),
        },
        content_checksum=compute_checksum(deduplicated, assignment),
        train_count=split_counts.get(Split.TRAIN.value, 0),
        validation_count=split_counts.get(Split.VALIDATION.value, 0),
        test_count=split_counts.get(Split.TEST.value, 0),
    )

    logger.info(
        "Built dataset %s for method %s: %d examples across %d groups "
        "(train %d / val %d / test %d)",
        dataset.version,
        test_method_id,
        dataset.example_count,
        dataset.quality_report["sample_groups"],
        dataset.train_count,
        dataset.validation_count,
        dataset.test_count,
    )

    return dataset, all_issues
