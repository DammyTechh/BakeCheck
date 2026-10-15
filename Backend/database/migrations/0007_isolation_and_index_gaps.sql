-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0007 — Close an isolation gap and index the FKs that matter               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Two findings from an audit of the live schema:
--
--   1. `training_jobs` carries a laboratory_id but had no RLS, unlike every
--      other laboratory-scoped table. The API already filters correctly, so
--      this was never exploitable through the HTTP surface — but it left the
--      database-layer backstop missing on exactly one table, which is the
--      kind of inconsistency that becomes a hole later.
--
--   2. Several foreign keys had no supporting index. Postgres does not index
--      the referencing side of a foreign key automatically, so a DELETE on
--      the parent has to sequentially scan the child to enforce the
--      constraint — and these columns are also joined on in ordinary reads.
--
-- Deliberately NOT indexed: created_by, validated_by, approved_by,
-- reviewed_by, invited_by and similar attribution columns. They are written
-- once, almost never filtered on, and all carry ON DELETE SET NULL, so there
-- is no cascade scan to avoid. Indexing all 41 unindexed FKs would slow every
-- write to speed up queries nobody runs.

BEGIN;

-- ── 1. Row Level Security for training_jobs ─────────────────────────────────
ALTER TABLE training_jobs ENABLE ROW LEVEL SECURITY;

-- A training job may be platform-wide (laboratory_id NULL) when it trains on
-- a platform method, so NULL is readable by any authenticated user, matching
-- how test_methods and reference_charts already behave.
DROP POLICY IF EXISTS training_jobs_lab_isolation ON training_jobs;
CREATE POLICY training_jobs_lab_isolation ON training_jobs
  FOR ALL
  USING (laboratory_id IS NULL OR has_lab_access(laboratory_id))
  WITH CHECK (laboratory_id IS NULL OR has_lab_access(laboratory_id));

COMMENT ON POLICY training_jobs_lab_isolation ON training_jobs IS
  'Matches the isolation policy on every other laboratory-scoped table. '
  'NULL laboratory_id means a platform-wide training run.';

-- ── 2. Indexes for FKs with CASCADE or RESTRICT deletes ─────────────────────
-- Without these, deleting a sample sequentially scans annotations and
-- dataset_examples, and deleting a test method scans analysis_results.

CREATE INDEX IF NOT EXISTS annotations_sample_idx
  ON annotations (sample_id);

CREATE INDEX IF NOT EXISTS dataset_examples_sample_idx
  ON dataset_examples (sample_id);

CREATE INDEX IF NOT EXISTS analysis_results_method_idx
  ON analysis_results (test_method_id);

-- ── 3. Indexes for columns on real query paths ──────────────────────────────

-- Joined on every analysis read, to resolve the matched level and the chart.
CREATE INDEX IF NOT EXISTS analysis_results_predicted_level_idx
  ON analysis_results (predicted_level_id)
  WHERE predicted_level_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS analysis_results_chart_idx
  ON analysis_results (reference_chart_id)
  WHERE reference_chart_id IS NOT NULL;

-- Scanned when assembling a dataset version and when checking eligibility.
CREATE INDEX IF NOT EXISTS dataset_examples_analysis_idx
  ON dataset_examples (analysis_id)
  WHERE analysis_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dataset_examples_measurement_idx
  ON dataset_examples (laboratory_measurement_id)
  WHERE laboratory_measurement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dataset_examples_label_level_idx
  ON dataset_examples (label_level_id)
  WHERE label_level_id IS NOT NULL;

-- The corrected level a technician chose; read when reviewing feedback.
CREATE INDEX IF NOT EXISTS annotations_corrected_level_idx
  ON annotations (corrected_level_id)
  WHERE corrected_level_id IS NOT NULL;

-- Training job listings filter by laboratory and by the model they produced.
CREATE INDEX IF NOT EXISTS training_jobs_lab_idx
  ON training_jobs (laboratory_id)
  WHERE laboratory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS training_jobs_model_idx
  ON training_jobs (model_version_id)
  WHERE model_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS training_jobs_dataset_idx
  ON training_jobs (dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

-- Model registry: walking the predecessor chain for rollback, and joining a
-- model to the dataset it was trained on.
CREATE INDEX IF NOT EXISTS model_versions_previous_idx
  ON model_versions (previous_version_id)
  WHERE previous_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_versions_dataset_idx
  ON model_versions (dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_evaluations_dataset_idx
  ON model_evaluations (dataset_version_id)
  WHERE dataset_version_id IS NOT NULL;

-- Chart versioning: following `supersedes` to find the history of a chart.
CREATE INDEX IF NOT EXISTS reference_charts_supersedes_idx
  ON reference_charts (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Derivative images point back at their original.
CREATE INDEX IF NOT EXISTS sample_images_derived_from_idx
  ON sample_images (derived_from_id)
  WHERE derived_from_id IS NOT NULL;

-- Refresh-token rotation follows replaced_by when auditing a session family.
CREATE INDEX IF NOT EXISTS refresh_tokens_replaced_by_idx
  ON refresh_tokens (replaced_by)
  WHERE replaced_by IS NOT NULL;

-- Samples are routinely filtered by the technician who registered them.
CREATE INDEX IF NOT EXISTS samples_technician_idx
  ON samples (technician_id)
  WHERE technician_id IS NOT NULL;

COMMIT;
