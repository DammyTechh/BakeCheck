-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0003 — Test methods, reference charts, reference levels                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- A reference level's concentration is only meaningful together with its
-- method, matrix and unit. Nothing in this schema treats "ppm" as a universal,
-- method-independent quantity.

BEGIN;

-- ── test_methods ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_methods (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL laboratory_id = platform-wide method visible to every laboratory.
  laboratory_id       uuid REFERENCES laboratories (id) ON DELETE CASCADE,
  code                text NOT NULL,
  name                text NOT NULL,
  -- What the method actually looks for, e.g. 'potassium bromate (as BrO3-)'.
  target_analyte      text NOT NULL,
  description         text,
  -- Citation / SOP reference for the procedure. Free text on purpose: we do
  -- not invent or validate protocols here.
  procedure_reference text,
  -- Sample matrix the method was developed for, e.g. 'bread crumb extract'.
  applicable_matrix   text NOT NULL,
  -- Reagent / preparation notes supplied by the laboratory, not by this system.
  reagent_notes       text,
  method_version      text NOT NULL DEFAULT '1.0.0',
  -- Unit every reference level under this method must use.
  concentration_unit  text NOT NULL DEFAULT 'ppm',
  -- Limits the laboratory has established for the method. NULL = not established.
  limit_of_detection      numeric(14, 6),
  limit_of_quantitation   numeric(14, 6),
  validation_status   validation_status NOT NULL DEFAULT 'DRAFT',
  validated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  validated_at        timestamptz,
  -- Short note on what has and has not been established for this method.
  validation_notes    text,
  is_active           boolean NOT NULL DEFAULT true,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT test_methods_code_fmt_chk CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
  CONSTRAINT test_methods_unit_len_chk CHECK (char_length(concentration_unit) BETWEEN 1 AND 32),
  CONSTRAINT test_methods_lod_chk CHECK (limit_of_detection IS NULL OR limit_of_detection >= 0),
  CONSTRAINT test_methods_loq_chk CHECK (limit_of_quantitation IS NULL OR limit_of_quantitation >= 0),
  -- A method may only be marked VALIDATED with an attributed reviewer.
  CONSTRAINT test_methods_validated_chk
    CHECK (validation_status <> 'VALIDATED' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL))
);

-- Code is unique per laboratory; platform methods (NULL lab) share one namespace.
CREATE UNIQUE INDEX IF NOT EXISTS test_methods_lab_code_uniq
  ON test_methods (laboratory_id, code, method_version)
  WHERE laboratory_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS test_methods_global_code_uniq
  ON test_methods (code, method_version)
  WHERE laboratory_id IS NULL;
CREATE INDEX IF NOT EXISTS test_methods_lab_idx    ON test_methods (laboratory_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS test_methods_status_idx ON test_methods (validation_status);

DROP TRIGGER IF EXISTS test_methods_set_updated_at ON test_methods;
CREATE TRIGGER test_methods_set_updated_at
  BEFORE UPDATE ON test_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN test_methods.validation_status IS
  'DRAFT/ILLUSTRATIVE methods may be used for screening but every result derived '
  'from them is flagged unvalidated by the API.';

-- ── reference_charts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reference_charts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_method_id    uuid NOT NULL REFERENCES test_methods (id) ON DELETE RESTRICT,
  laboratory_id     uuid REFERENCES laboratories (id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text,
  -- Where the chart came from: a vendor insert, a photograph, an illustration.
  source            text,
  source_url        text,
  -- Colour values in this chart were measured under these conditions, if known.
  illuminant        text,              -- e.g. 'D65', NULL when unknown
  capture_device    text,
  version           integer NOT NULL DEFAULT 1,
  -- ILLUSTRATIVE is the honest default for a chart built from a picture.
  validation_status validation_status NOT NULL DEFAULT 'ILLUSTRATIVE',
  validated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  validated_at      timestamptz,
  -- Optional stored image of the chart itself (see sample_images.source).
  chart_image_id    uuid,              -- FK added in 0004 once sample_images exists
  -- Set when this chart replaces an earlier version. History is never deleted.
  supersedes_id     uuid REFERENCES reference_charts (id) ON DELETE SET NULL,
  is_active         boolean NOT NULL DEFAULT true,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reference_charts_version_chk CHECK (version >= 1),
  CONSTRAINT reference_charts_name_len_chk CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT reference_charts_validated_chk
    CHECK (validation_status <> 'VALIDATED' OR (validated_by IS NOT NULL AND validated_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_charts_method_name_version_uniq
  ON reference_charts (test_method_id, name, version);
CREATE INDEX IF NOT EXISTS reference_charts_method_idx ON reference_charts (test_method_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS reference_charts_lab_idx    ON reference_charts (laboratory_id);

DROP TRIGGER IF EXISTS reference_charts_set_updated_at ON reference_charts;
CREATE TRIGGER reference_charts_set_updated_at
  BEFORE UPDATE ON reference_charts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── reference_levels ────────────────────────────────────────────────────────
-- One row per labelled step on a chart (0 ppm, 0.1 ppm, …).
CREATE TABLE IF NOT EXISTS reference_levels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_chart_id  uuid NOT NULL REFERENCES reference_charts (id) ON DELETE CASCADE,
  label               text NOT NULL,          -- 'No Bromate', 'Trace Amount', …
  -- Nominal concentration for this step, in the parent method's unit.
  concentration_value numeric(14, 6),
  concentration_unit  text NOT NULL DEFAULT 'ppm',
  -- Ordering index so the UI and the matcher agree on the step sequence.
  sort_order          integer NOT NULL,

  -- Reference colour. sRGB 0-255 and CIELAB are both stored: RGB for display,
  -- Lab for perceptual distance. Lab is the value the matcher actually uses.
  rgb_r               smallint,
  rgb_g               smallint,
  rgb_b               smallint,
  lab_l               numeric(8, 4),
  lab_a               numeric(8, 4),
  lab_b               numeric(8, 4),
  -- Spread observed across the reference patch, used to widen match tolerance.
  lab_std             numeric(8, 4),

  -- Optional rectangle on the chart image this colour was sampled from.
  roi_x               integer,
  roi_y               integer,
  roi_width           integer,
  roi_height          integer,

  -- How the colour got here: sampled from an image, or typed in by a human.
  color_source        text NOT NULL DEFAULT 'IMAGE_SAMPLED',
  validation_status   validation_status NOT NULL DEFAULT 'ILLUSTRATIVE',
  notes               text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reference_levels_conc_chk
    CHECK (concentration_value IS NULL OR concentration_value >= 0),
  CONSTRAINT reference_levels_rgb_chk CHECK (
    (rgb_r IS NULL OR rgb_r BETWEEN 0 AND 255) AND
    (rgb_g IS NULL OR rgb_g BETWEEN 0 AND 255) AND
    (rgb_b IS NULL OR rgb_b BETWEEN 0 AND 255)
  ),
  CONSTRAINT reference_levels_lab_l_chk CHECK (lab_l IS NULL OR lab_l BETWEEN 0 AND 100),
  CONSTRAINT reference_levels_lab_ab_chk CHECK (
    (lab_a IS NULL OR lab_a BETWEEN -128 AND 128) AND
    (lab_b IS NULL OR lab_b BETWEEN -128 AND 128)
  ),
  CONSTRAINT reference_levels_roi_chk CHECK (
    (roi_x IS NULL AND roi_y IS NULL AND roi_width IS NULL AND roi_height IS NULL)
    OR (roi_x >= 0 AND roi_y >= 0 AND roi_width > 0 AND roi_height > 0)
  ),
  CONSTRAINT reference_levels_color_source_chk
    CHECK (color_source IN ('IMAGE_SAMPLED', 'MANUAL_ENTRY', 'INSTRUMENT_MEASURED')),
  -- A level is only usable for matching if it carries a CIELAB value.
  CONSTRAINT reference_levels_lab_complete_chk CHECK (
    (lab_l IS NULL AND lab_a IS NULL AND lab_b IS NULL)
    OR (lab_l IS NOT NULL AND lab_a IS NOT NULL AND lab_b IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_levels_chart_order_uniq
  ON reference_levels (reference_chart_id, sort_order);
CREATE INDEX IF NOT EXISTS reference_levels_chart_idx ON reference_levels (reference_chart_id);

DROP TRIGGER IF EXISTS reference_levels_set_updated_at ON reference_levels;
CREATE TRIGGER reference_levels_set_updated_at
  BEFORE UPDATE ON reference_levels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN reference_levels.color_source IS
  'IMAGE_SAMPLED means the value was read off a picture — that is not a '
  'calibrated colorimetric measurement and must not be treated as one.';

COMMIT;
