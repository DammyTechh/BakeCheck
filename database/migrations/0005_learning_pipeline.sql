-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0005 — Annotations, dataset versioning, model registry, evaluations      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- Nothing here lets an upload become training data on its own. An example
-- enters a dataset only after explicit review, and a model becomes active only
-- after explicit approval.

BEGIN;

-- ── annotations ─────────────────────────────────────────────────────────────
-- A technician's reading of an analysis. This is interpretation, not ground
-- truth; a measured value lives in laboratory_measurements.
CREATE TABLE IF NOT EXISTS annotations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id           uuid NOT NULL REFERENCES analysis_results (id) ON DELETE CASCADE,
  sample_id             uuid NOT NULL REFERENCES samples (id) ON DELETE CASCADE,
  laboratory_id         uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,

  -- The level the technician believes is correct.
  corrected_level_id    uuid REFERENCES reference_levels (id) ON DELETE SET NULL,
  -- True when the technician agrees with the pipeline's own match.
  agrees_with_prediction boolean,
  -- Corrected region, when the automatic ROI was wrong.
  roi_x                 integer,
  roi_y                 integer,
  roi_width             integer,
  roi_height            integer,

  -- Why the prediction was flagged: 'GLARE', 'WRONG_TUBE', 'COLOUR_DRIFT', …
  feedback_reason       text,
  -- Technician's own judgement of whether the image was good enough.
  quality_opinion       quality_verdict,
  flagged_unreliable    boolean NOT NULL DEFAULT false,
  notes                 text,

  -- Submitted for dataset review? Nothing is eligible until this is true.
  submitted_for_review  boolean NOT NULL DEFAULT false,
  review_status         review_status NOT NULL DEFAULT 'PENDING',
  reviewed_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  review_notes          text,

  annotated_by          uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT annotations_roi_chk CHECK (
    (roi_x IS NULL AND roi_y IS NULL AND roi_width IS NULL AND roi_height IS NULL)
    OR (roi_x >= 0 AND roi_y >= 0 AND roi_width > 0 AND roi_height > 0)
  ),
  CONSTRAINT annotations_reviewed_chk CHECK (
    review_status = 'PENDING' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS annotations_analysis_idx ON annotations (analysis_id);
CREATE INDEX IF NOT EXISTS annotations_lab_idx      ON annotations (laboratory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS annotations_review_idx   ON annotations (review_status)
  WHERE submitted_for_review;
CREATE INDEX IF NOT EXISTS annotations_author_idx   ON annotations (annotated_by);

DROP TRIGGER IF EXISTS annotations_set_updated_at ON annotations;
CREATE TRIGGER annotations_set_updated_at
  BEFORE UPDATE ON annotations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE annotations IS
  'Technician interpretation of a screening result. Carries label_source '
  'TECHNICIAN_ANNOTATION when promoted to a dataset example — weaker evidence '
  'than an instrument measurement.';

-- ── dataset_examples ────────────────────────────────────────────────────────
-- An approved, labelled training candidate. Created only by a reviewer action.
CREATE TABLE IF NOT EXISTS dataset_examples (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id           uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  sample_id               uuid NOT NULL REFERENCES samples (id) ON DELETE CASCADE,
  sample_image_id         uuid NOT NULL REFERENCES sample_images (id) ON DELETE RESTRICT,
  analysis_id             uuid REFERENCES analysis_results (id) ON DELETE SET NULL,
  annotation_id           uuid REFERENCES annotations (id) ON DELETE SET NULL,
  laboratory_measurement_id uuid REFERENCES laboratory_measurements (id) ON DELETE SET NULL,

  -- ── The label ─────────────────────────────────────────────────────────────
  test_method_id          uuid NOT NULL REFERENCES test_methods (id) ON DELETE RESTRICT,
  method_version          text NOT NULL,
  reference_chart_id      uuid REFERENCES reference_charts (id) ON DELETE SET NULL,
  reference_chart_version integer,
  label_level_id          uuid REFERENCES reference_levels (id) ON DELETE SET NULL,
  label_text              text,
  label_concentration     numeric(14, 6),
  label_unit              text,
  -- Where the label's authority comes from. Training code weights and filters
  -- on this: a technician's opinion is not an instrument reading.
  label_source            label_source NOT NULL,

  sample_type             text NOT NULL,
  -- Cached colour features so training does not need to re-process images.
  color_features          jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_verdict         quality_verdict,
  -- Grouping key for leakage control: every example from one physical sample
  -- must land in the same train/val/test split.
  group_key               text NOT NULL,
  perceptual_hash         text,

  -- ── Governance ────────────────────────────────────────────────────────────
  review_status           review_status NOT NULL DEFAULT 'PENDING',
  approved_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at             timestamptz,
  -- Does the laboratory permit this image to be used for training?
  usage_authorized        boolean NOT NULL DEFAULT false,
  usage_authorization_ref text,
  -- Excluded from training with a recorded reason, without deleting history.
  excluded                boolean NOT NULL DEFAULT false,
  exclusion_reason        text,
  provenance_notes        text,
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- An approved example must have an attributed approver.
  CONSTRAINT dataset_examples_approved_chk CHECK (
    review_status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  -- A measurement-sourced label must point at the measurement it came from.
  CONSTRAINT dataset_examples_measurement_chk CHECK (
    label_source <> 'LABORATORY_MEASUREMENT' OR laboratory_measurement_id IS NOT NULL
  ),
  -- A label needs either a reference level or a numeric concentration.
  CONSTRAINT dataset_examples_label_chk CHECK (
    label_level_id IS NOT NULL OR label_concentration IS NOT NULL
  ),
  CONSTRAINT dataset_examples_conc_unit_chk CHECK (
    label_concentration IS NULL OR label_unit IS NOT NULL
  ),
  CONSTRAINT dataset_examples_excluded_chk CHECK (
    excluded = false OR exclusion_reason IS NOT NULL
  )
);

-- One example per image per method: re-approving updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS dataset_examples_image_method_uniq
  ON dataset_examples (sample_image_id, test_method_id);
CREATE INDEX IF NOT EXISTS dataset_examples_lab_idx    ON dataset_examples (laboratory_id);
CREATE INDEX IF NOT EXISTS dataset_examples_method_idx ON dataset_examples (test_method_id);
CREATE INDEX IF NOT EXISTS dataset_examples_group_idx  ON dataset_examples (group_key);
CREATE INDEX IF NOT EXISTS dataset_examples_phash_idx  ON dataset_examples (perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;
-- The set training actually draws from.
CREATE INDEX IF NOT EXISTS dataset_examples_eligible_idx
  ON dataset_examples (test_method_id, label_source)
  WHERE review_status = 'APPROVED' AND usage_authorized AND NOT excluded;

DROP TRIGGER IF EXISTS dataset_examples_set_updated_at ON dataset_examples;
CREATE TRIGGER dataset_examples_set_updated_at
  BEFORE UPDATE ON dataset_examples
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── dataset_versions ────────────────────────────────────────────────────────
-- An immutable, named snapshot of the example set used for one training run.
CREATE TABLE IF NOT EXISTS dataset_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_method_id    uuid NOT NULL REFERENCES test_methods (id) ON DELETE RESTRICT,
  version           text NOT NULL,
  description       text,
  -- Frozen list of dataset_example ids plus their split assignment.
  example_ids       uuid[] NOT NULL DEFAULT '{}',
  split_assignment  jsonb NOT NULL DEFAULT '{}'::jsonb,
  example_count     integer NOT NULL DEFAULT 0,
  train_count       integer NOT NULL DEFAULT 0,
  validation_count  integer NOT NULL DEFAULT 0,
  test_count        integer NOT NULL DEFAULT 0,
  -- Per-label counts: makes class imbalance visible rather than buried.
  class_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Results of duplicate / near-duplicate / leakage checks for this snapshot.
  quality_report    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Checksum over the ordered example ids + labels: detects silent drift.
  content_checksum  text,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dataset_versions_uniq UNIQUE (test_method_id, version),
  CONSTRAINT dataset_versions_counts_chk CHECK (
    example_count >= 0 AND train_count >= 0 AND validation_count >= 0 AND test_count >= 0
  )
);

CREATE INDEX IF NOT EXISTS dataset_versions_method_idx
  ON dataset_versions (test_method_id, created_at DESC);

-- ── model_versions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_method_id      uuid REFERENCES test_methods (id) ON DELETE RESTRICT,
  -- Model family, e.g. 'baseline-color-analysis', 'lab-knn-classifier'.
  name                text NOT NULL,
  version             text NOT NULL,
  -- 'REFERENCE_MATCHER' needs no artifact; 'SKLEARN_CLASSIFIER' does.
  model_type          text NOT NULL,
  dataset_version_id  uuid REFERENCES dataset_versions (id) ON DELETE SET NULL,
  artifact_key        text,              -- private storage key for the .joblib
  artifact_checksum   text,              -- SHA-256 of the artifact
  artifact_size_bytes bigint,
  training_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Headline metrics copied from the governing evaluation, for quick listing.
  validation_metrics  jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_schema      jsonb NOT NULL DEFAULT '{}'::jsonb,

  status              model_release_status NOT NULL DEFAULT 'TRAINING',
  -- Exactly one model per (method, name) may be released; enforced by index.
  is_active           boolean NOT NULL DEFAULT false,
  -- Set only by an explicit human approval action.
  approved_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at         timestamptz,
  released_at         timestamptz,
  rolled_back_at      timestamptz,
  rollback_reason     text,
  -- The model this one replaced, so rollback has a defined target.
  previous_version_id uuid REFERENCES model_versions (id) ON DELETE SET NULL,
  -- Honest statement of what this model has and has not been shown to do.
  limitations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes               text,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_versions_uniq UNIQUE (name, version),
  CONSTRAINT model_versions_type_chk CHECK (
    model_type IN ('REFERENCE_MATCHER', 'SKLEARN_CLASSIFIER', 'SKLEARN_REGRESSOR')
  ),
  CONSTRAINT model_versions_checksum_chk CHECK (
    artifact_checksum IS NULL OR artifact_checksum ~ '^[a-f0-9]{64}$'
  ),
  -- A model cannot be active unless a human approved it.
  CONSTRAINT model_versions_active_requires_approval_chk CHECK (
    is_active = false OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  -- A trained model must carry the dataset it was trained on.
  CONSTRAINT model_versions_dataset_chk CHECK (
    model_type = 'REFERENCE_MATCHER' OR status IN ('TRAINING', 'FAILED')
    OR dataset_version_id IS NOT NULL
  )
);

-- At most one active model per (test method, model name).
CREATE UNIQUE INDEX IF NOT EXISTS model_versions_one_active_uniq
  ON model_versions (test_method_id, name)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS model_versions_method_idx ON model_versions (test_method_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_versions_status_idx ON model_versions (status);

DROP TRIGGER IF EXISTS model_versions_set_updated_at ON model_versions;
CREATE TRIGGER model_versions_set_updated_at
  BEFORE UPDATE ON model_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Deferred FK from 0004.
ALTER TABLE analysis_results
  DROP CONSTRAINT IF EXISTS analysis_results_model_version_fk;
ALTER TABLE analysis_results
  ADD CONSTRAINT analysis_results_model_version_fk
  FOREIGN KEY (model_version_id) REFERENCES model_versions (id) ON DELETE SET NULL;

-- ── model_evaluations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version_id    uuid NOT NULL REFERENCES model_versions (id) ON DELETE CASCADE,
  dataset_version_id  uuid REFERENCES dataset_versions (id) ON DELETE SET NULL,
  -- 'validation' | 'test' | 'holdout'
  split               text NOT NULL DEFAULT 'test',

  -- Accuracy is recorded but is never the release criterion on its own.
  accuracy            numeric(6, 5),
  macro_f1            numeric(6, 5),
  weighted_f1         numeric(6, 5),
  balanced_accuracy   numeric(6, 5),
  -- Regression metrics, when the model predicts a concentration.
  mae                 numeric(14, 6),
  rmse                numeric(14, 6),
  r2                  numeric(8, 5),
  -- Calibration, when there is enough data to estimate it. NULL otherwise.
  expected_calibration_error numeric(6, 5),
  brier_score         numeric(8, 5),

  confusion_matrix    jsonb NOT NULL DEFAULT '{}'::jsonb,
  per_class_metrics   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Metrics sliced by lighting / device / sample type, where feasible.
  subgroup_metrics    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Comparison against the currently released model, when one exists.
  baseline_comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_size         integer,
  -- Plain-language caveats shown to administrators before they approve.
  evaluation_limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 'APPROVE' | 'REJECT' | 'INSUFFICIENT_DATA' — a recommendation, not an action.
  release_recommendation text,
  decided_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decision_notes      text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT model_evaluations_split_chk CHECK (split IN ('validation', 'test', 'holdout')),
  CONSTRAINT model_evaluations_rec_chk CHECK (
    release_recommendation IS NULL
    OR release_recommendation IN ('APPROVE', 'REJECT', 'INSUFFICIENT_DATA')
  ),
  CONSTRAINT model_evaluations_sample_chk CHECK (sample_size IS NULL OR sample_size >= 0)
);

CREATE INDEX IF NOT EXISTS model_evaluations_model_idx
  ON model_evaluations (model_version_id, created_at DESC);

-- ── training_jobs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_method_id      uuid NOT NULL REFERENCES test_methods (id) ON DELETE RESTRICT,
  laboratory_id       uuid REFERENCES laboratories (id) ON DELETE SET NULL,
  dataset_version_id  uuid REFERENCES dataset_versions (id) ON DELETE SET NULL,
  model_version_id    uuid REFERENCES model_versions (id) ON DELETE SET NULL,
  status              training_job_status NOT NULL DEFAULT 'QUEUED',
  requested_params    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Progress / stage messages written as the job advances.
  progress            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code          text,
  error_message       text,
  correlation_id      uuid,
  requested_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS training_jobs_method_idx ON training_jobs (test_method_id, created_at DESC);
CREATE INDEX IF NOT EXISTS training_jobs_status_idx ON training_jobs (status);

DROP TRIGGER IF EXISTS training_jobs_set_updated_at ON training_jobs;
CREATE TRIGGER training_jobs_set_updated_at
  BEFORE UPDATE ON training_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
