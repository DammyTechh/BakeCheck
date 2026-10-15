# Data labelling

How an uploaded image becomes a training example — and the controls that stop
it happening by accident.

## The flow

```
upload → analysis → annotation → submitted for review
                                      │
                                      ▼
                        reviewed by SOMEONE ELSE
                                      │
                         ┌────────────┴────────────┐
                      APPROVED                  REJECTED
                         │                         │
                   dataset_example            recorded, unused
                         │
                   dataset_version (frozen, checksummed)
                         │
                      training
```

Nothing is implicit. An image sitting in storage is not training data; an
analysis is not training data; an annotation is not training data until a
second person approves it.

## Two kinds of evidence

This is the distinction the whole schema is built around.

| | Annotation | Laboratory measurement |
|---|---|---|
| What it is | A technician's reading of a colour | An instrument result |
| Has a concentration field | **No** | Yes |
| Carries uncertainty | No | Yes |
| `label_source` | `TECHNICIAN_ANNOTATION` | `LABORATORY_MEASUREMENT` |
| May be called confirmed | Never | When reviewed |

A technician looking at a tube is not measuring a concentration, so the
annotation DTO has no field for one. Collapsing the two would let a confident
guess become ground truth — which is how a model learns to reproduce human
error at scale.

Training code can filter and weight on `label_source`. A model trained only on
technician annotations has learned to agree with technicians, not to measure
bromate, and the data model keeps that visible.

## Controls

**Self-approval is blocked.** The check is on user id, not role:

```ts
if (annotation.annotated_by === actor.id) throw ApiError.forbidden(...)
```

Even a laboratory administrator cannot approve their own annotation.
Otherwise the review step is decorative.

**Usage authorisation is explicit.** `usage_authorized` defaults to false. A
laboratory must affirmatively permit an image to be used for training.

**Exclusion is recorded, not deleted.** `excluded` plus a required
`exclusion_reason` keeps the history of what was removed and why.

**Group keys prevent leakage.** `group_key` ties every example from one
physical sample together, so near-duplicate photographs of the same tube
cannot land on both sides of the train/test boundary. Without this, the test
score measures memorisation.

**Perceptual hashes catch near-duplicates** across samples, which is the other
way the same image sneaks into both splits.

## Dataset versions

A training run draws from a **frozen snapshot**: the ordered example ids, the
split assignment, the class distribution, a quality report and a content
checksum.

This makes a run reproducible and makes silent drift detectable. "The model
got worse" is only answerable if you can tell whether the data changed.

The class distribution is stored rather than computed on demand because class
imbalance is the thing most likely to make an evaluation misleading, and it
should be visible at the point of decision.

## Practical guidance

**What makes a good example**

- The image quality verdict was `USABLE`
- The region of interest was correct — check it, correct it if not
- A confirmed laboratory measurement exists for the same sample
- The preparation followed the method, and deviations are noted

**What does not**

- "The prediction looked about right"
- Images where the technician corrected the region but did not say why
- Anything from a sample whose preparation is unknown
- Examples from a single laboratory, single device, single lighting setup —
  these teach the model that setup, not the chemistry

**On volume**

Thirty approved examples is the floor for *attempting* training, not a
sufficient dataset. With six classes that is five per class, which supports no
meaningful estimate of per-class performance. Treat the first few hundred
examples as an exercise in building the pipeline, not in building a model.
