-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0004 — Samples, images, analyses, colour features, measurements          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── samples ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS samples (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id     uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  -- Laboratory's own sample identifier, unique within that laboratory.
  sample_code       text NOT NULL,
  sample_type       text NOT NULL,           -- 'bread', 'flour', 'dough', …
  product_name      text,
  batch_reference   text,
  manufacturer      text,
  collected_at      timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- The technician who registered / prepared the sample.
  technician_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  test_method_id    uuid REFERENCES test_methods (id) ON DELETE RESTRICT,
  -- Preparation details recorded by the laboratory; this system supplies none.
  preparation_notes text,
  dilution_factor   numeric(12, 6),
  status            sample_status NOT NULL DEFAULT 'REGISTERED',
  notes             text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT samples_code_len_chk CHECK (char_length(sample_code) BETWEEN 1 AND 100),
  CONSTRAINT samples_dilution_chk CHECK (dilution_factor IS NULL OR dilution_factor > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS samples_lab_code_uniq ON samples (laboratory_id, sample_code);
CREATE INDEX IF NOT EXISTS samples_lab_created_idx ON samples (laboratory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS samples_status_idx      ON samples (laboratory_id, status);
CREATE INDEX IF NOT EXISTS samples_method_idx      ON samples (test_method_id);
CREATE INDEX IF NOT EXISTS samples_type_idx        ON samples (laboratory_id, sample_type);

DROP TRIGGER IF EXISTS samples_set_updated_at ON samples;
CREATE TRIGGER samples_set_updated_at
  BEFORE UPDATE ON samples
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── sample_images ───────────────────────────────────────────────────────────
-- The original bytes are preserved as evidence. Derivatives (normalised copies,
-- crops) are separate rows pointing back via derived_from_id.
CREATE TABLE IF NOT EXISTS sample_images (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id         uuid REFERENCES samples (id) ON DELETE CASCADE,
  laboratory_id     uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  -- Private object key. Never a public URL; access goes through a signed URL
  -- or the authenticated download endpoint.
  storage_key       text NOT NULL,
  storage_driver    text NOT NULL DEFAULT 'local',
  original_filename text,
  -- Content type determined by sniffing the file signature, not by the client.
  mime_type         text NOT NULL,
  byte_size         bigint NOT NULL,
  width             integer,
  height            integer,
  -- SHA-256 of the stored bytes, for duplicate detection and integrity.
  content_hash      text NOT NULL,
  -- Perceptual hash, used for near-duplicate / leakage detection at train time.
  perceptual_hash   text,
  source            image_source NOT NULL DEFAULT 'UPLOAD',
  derived_from_id   uuid REFERENCES sample_images (id) ON DELETE SET NULL,
  -- EXIF subset retained after stripping anything sensitive (GPS, serials).
  capture_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sample_images_size_chk   CHECK (byte_size > 0),
  CONSTRAINT sample_images_dims_chk   CHECK (
    (width IS NULL AND height IS NULL) OR (width > 0 AND height > 0)
  ),
  CONSTRAINT sample_images_hash_chk   CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sample_images_driver_chk CHECK (storage_driver IN ('local', 'supabase')),
  CONSTRAINT sample_images_mime_chk   CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

CREATE UNIQUE INDEX IF NOT EXISTS sample_images_storage_key_uniq ON sample_images (storage_key);
CREATE INDEX IF NOT EXISTS sample_images_sample_idx ON sample_images (sample_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sample_images_lab_idx    ON sample_images (laboratory_id);
-- Duplicate detection is scoped per laboratory, not globally.
CREATE INDEX IF NOT EXISTS sample_images_hash_idx   ON sample_images (laboratory_id, content_hash);
CREATE INDEX IF NOT EXISTS sample_images_phash_idx  ON sample_images (perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;

COMMENT ON COLUMN sample_images.storage_key IS
  'Private object key. Access is mediated by the API; no permanent public URL exists.';

-- Deferred FK from 0003: a reference chart may point at its stored chart image.
ALTER TABLE reference_charts
  DROP CONSTRAINT IF EXISTS reference_charts_chart_image_fk;
ALTER TABLE reference_charts
  ADD CONSTRAINT reference_charts_chart_image_fk
  FOREIGN KEY (chart_image_id) REFERENCES sample_images (id) ON DELETE SET NULL;

-- ── analysis_results ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id           uuid NOT NULL REFERENCES samples (id) ON DELETE CASCADE,
  sample_image_id     uuid NOT NULL REFERENCES sample_images (id) ON DELETE RESTRICT,
  laboratory_id       uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  test_method_id      uuid NOT NULL REFERENCES test_methods (id) ON DELETE RESTRICT,
  reference_chart_id  uuid REFERENCES reference_charts (id) ON DELETE SET NULL,

  status              analysis_status NOT NULL DEFAULT 'PENDING',
  -- How this result was produced. Stored, not inferred, so an old record can
  -- never be re-read as something stronger than it was.
  mode                analysis_mode NOT NULL DEFAULT 'REFERENCE_MATCHING',

  -- ── Prediction ────────────────────────────────────────────────────────────
  -- The matched reference step, if any.
  predicted_level_id  uuid REFERENCES reference_levels (id) ON DELETE SET NULL,
  predicted_label     text,
  -- NULL whenever the pipeline cannot justify a number. Never back-filled with
  -- a guess, and never populated from an unvalidated chart match alone.
  estimated_concentration numeric(14, 6),
  concentration_unit  text,
  -- Model confidence in [0,1]. NULL in reference-matching mode, where a colour
  -- distance is not a probability.
  confidence          numeric(6, 5),
  -- Perceptual distance (CIEDE2000) to the matched reference colour.
  color_distance      numeric(10, 4),
  -- Runner-up levels: [{reference_level_id, label, distance}, …]
  alternatives        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when the measured colour sits outside the chart's covered range.
  out_of_range        boolean NOT NULL DEFAULT false,

  -- ── Image quality ─────────────────────────────────────────────────────────
  quality_verdict     quality_verdict,
  quality_score       numeric(6, 5),
  quality_warnings    jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ── Provenance ────────────────────────────────────────────────────────────
  model_version_id    uuid,                   -- FK added in 0005
  model_name          text,
  model_version       text,
  -- Denormalised at write time: was the producing model/method validated *then*?
  model_validated     boolean NOT NULL DEFAULT false,
  method_version      text,
  reference_chart_version integer,
  pipeline_version    text,
  -- Human-readable limitations surfaced verbatim in the UI and API.
  limitations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Timings, ROI mode, service build info, etc.
  inference_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id      uuid,
  error_code          text,
  error_message       text,

  requested_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  started_at          timestamptz,
  completed_at        timestamptz,
  duration_ms         integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analysis_confidence_chk CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  CONSTRAINT analysis_quality_score_chk CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
  CONSTRAINT analysis_distance_chk  CHECK (color_distance IS NULL OR color_distance >= 0),
  CONSTRAINT analysis_conc_chk      CHECK (estimated_concentration IS NULL OR estimated_concentration >= 0),
  -- A concentration estimate is meaningless without its unit.
  CONSTRAINT analysis_conc_unit_chk CHECK (
    estimated_concentration IS NULL OR concentration_unit IS NOT NULL
  ),
  -- Reference matching is a distance, not a probability: it may not carry a
  -- model confidence. This is enforced in the database so no code path can
  -- dress a colour distance up as model certainty.
  CONSTRAINT analysis_mode_confidence_chk CHECK (
    mode <> 'REFERENCE_MATCHING' OR confidence IS NULL
  ),
  CONSTRAINT analysis_duration_chk CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS analysis_sample_idx  ON analysis_results (sample_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_lab_idx     ON analysis_results (laboratory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_image_idx   ON analysis_results (sample_image_id);
CREATE INDEX IF NOT EXISTS analysis_status_idx  ON analysis_results (laboratory_id, status);
CREATE INDEX IF NOT EXISTS analysis_model_idx   ON analysis_results (model_version_id);
CREATE INDEX IF NOT EXISTS analysis_corr_idx    ON analysis_results (correlation_id);

DROP TRIGGER IF EXISTS analysis_results_set_updated_at ON analysis_results;
CREATE TRIGGER analysis_results_set_updated_at
  BEFORE UPDATE ON analysis_results
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE analysis_results IS
  'An image-derived screening estimate. Never a chemically confirmed result — '
  'confirmation lives in laboratory_measurements.';

-- ── measured_color_features ─────────────────────────────────────────────────
-- One row per analysis: exactly what the vision pipeline measured, plus the
-- configuration that produced it, so a result can be reproduced or audited.
CREATE TABLE IF NOT EXISTS measured_color_features (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id       uuid NOT NULL REFERENCES analysis_results (id) ON DELETE CASCADE,
  sample_image_id   uuid NOT NULL REFERENCES sample_images (id) ON DELETE CASCADE,

  -- Region the measurement came from, in pixels on the stored image.
  roi_x             integer NOT NULL,
  roi_y             integer NOT NULL,
  roi_width         integer NOT NULL,
  roi_height        integer NOT NULL,
  -- AUTO_TUBE_DETECTION | MANUAL_SELECTION | CENTER_FALLBACK
  roi_mode          text NOT NULL,
  roi_confidence    numeric(6, 5),
  -- Pixels that survived masking (glass edges, glare, background).
  pixel_count       integer NOT NULL,
  masked_fraction   numeric(6, 5),

  -- Medians are stored rather than means: robust to specular highlights.
  rgb_median        smallint[] NOT NULL,
  rgb_mean          numeric(8, 3)[],
  rgb_std           numeric(8, 3)[],
  hsv_median        numeric(8, 3)[],
  lab_median        numeric(8, 4)[] NOT NULL,
  lab_mean          numeric(8, 4)[],
  lab_std           numeric(8, 4)[],
  -- Interquartile range per Lab channel: how uniform the region actually was.
  lab_iqr           numeric(8, 4)[],

  saturation_mean   numeric(8, 4),
  brightness_mean   numeric(8, 4),
  contrast_score    numeric(8, 4),
  -- Variance of Laplacian — the blur indicator.
  sharpness_score   numeric(12, 4),
  -- Fraction of pixels at 0 or 255 in any channel.
  clipping_fraction numeric(6, 5),
  -- Estimated background colour outside the ROI, for illumination context.
  background_lab    numeric(8, 4)[],
  illumination_notes jsonb NOT NULL DEFAULT '{}'::jsonb,

  color_space       text NOT NULL DEFAULT 'sRGB',
  -- Exact pipeline parameters used. Changing these changes the numbers, so
  -- they are stored with the measurement.
  extraction_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipeline_version  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mcf_roi_chk CHECK (roi_x >= 0 AND roi_y >= 0 AND roi_width > 0 AND roi_height > 0),
  CONSTRAINT mcf_pixels_chk CHECK (pixel_count > 0),
  CONSTRAINT mcf_roi_mode_chk CHECK (
    roi_mode IN ('AUTO_TUBE_DETECTION', 'MANUAL_SELECTION', 'CENTER_FALLBACK')
  ),
  CONSTRAINT mcf_rgb_len_chk CHECK (array_length(rgb_median, 1) = 3),
  CONSTRAINT mcf_lab_len_chk CHECK (array_length(lab_median, 1) = 3),
  CONSTRAINT mcf_masked_chk CHECK (masked_fraction IS NULL OR masked_fraction BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS mcf_analysis_uniq ON measured_color_features (analysis_id);
CREATE INDEX IF NOT EXISTS mcf_image_idx ON measured_color_features (sample_image_id);

-- ── laboratory_measurements ─────────────────────────────────────────────────
-- Instrument results. Structurally separate from analysis_results so that a
-- confirmed measurement can never be confused with an image estimate.
CREATE TABLE IF NOT EXISTS laboratory_measurements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id           uuid NOT NULL REFERENCES samples (id) ON DELETE CASCADE,
  laboratory_id       uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  -- Optional link to the screening result this measurement confirms or refutes.
  analysis_id         uuid REFERENCES analysis_results (id) ON DELETE SET NULL,

  -- The analytical method actually used, e.g. 'IC-ICP-MS'. Free text: the
  -- confirmatory technique need not be one of this platform's test_methods.
  measurement_method  text NOT NULL,
  instrument          text,
  concentration_value numeric(14, 6),
  concentration_unit  text NOT NULL,
  -- Reported uncertainty / detection limits for this specific measurement.
  uncertainty         numeric(14, 6),
  detection_limit     numeric(14, 6),
  -- True when the analyte was below the detection limit (value then NULL).
  below_detection_limit boolean NOT NULL DEFAULT false,

  measured_at         timestamptz NOT NULL,
  measured_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  confirmation_status confirmation_status NOT NULL DEFAULT 'PRELIMINARY',
  -- Where the number came from: internal run, external lab, certificate ref.
  provenance          text,
  certificate_ref     text,
  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lab_meas_conc_chk CHECK (concentration_value IS NULL OR concentration_value >= 0),
  CONSTRAINT lab_meas_uncert_chk CHECK (uncertainty IS NULL OR uncertainty >= 0),
  -- Either a value, or an explicit below-detection-limit flag. Not neither.
  CONSTRAINT lab_meas_value_present_chk CHECK (
    concentration_value IS NOT NULL OR below_detection_limit = true
  ),
  -- CONFIRMED requires an attributed reviewer.
  CONSTRAINT lab_meas_confirmed_chk CHECK (
    confirmation_status <> 'CONFIRMED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS lab_meas_sample_idx   ON laboratory_measurements (sample_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS lab_meas_lab_idx      ON laboratory_measurements (laboratory_id);
CREATE INDEX IF NOT EXISTS lab_meas_analysis_idx ON laboratory_measurements (analysis_id);
CREATE INDEX IF NOT EXISTS lab_meas_status_idx   ON laboratory_measurements (confirmation_status);

DROP TRIGGER IF EXISTS lab_meas_set_updated_at ON laboratory_measurements;
CREATE TRIGGER lab_meas_set_updated_at
  BEFORE UPDATE ON laboratory_measurements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE laboratory_measurements IS
  'Independently measured results. The only table in this schema that may be '
  'described as a confirmed concentration.';

COMMIT;
