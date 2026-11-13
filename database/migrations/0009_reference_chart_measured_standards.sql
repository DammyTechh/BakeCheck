-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0009 — Replace the chart's colours with measured prepared standards      ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Until now the chart carried the laboratory's concentrations against colours
-- INTERPOLATED from an illustration. On 13 November 2026 the laboratory
-- photographed fifteen prepared standards of known concentration, so every
-- colour below is measured from a real tube at a real concentration. That is
-- the thing the chart has been missing since it was built.
--
-- It stays ILLUSTRATIVE. The reason is the photography, not the chemistry:
-- the fifteen shots were taken at different times, by different hands, under
-- different light, with no grey card in any frame. Each was white balanced
-- against the paper behind the tube, which is a partial correction and not a
-- calibration.
--
-- That shows up in the numbers, and is left visible rather than smoothed:
--
--   * four steps are NON-MONOTONIC -- 200, 250, 350 and 500 ppm each
--     photographed LIGHTER than the level below them;
--   * three adjacent pairs sit within dE2000 5, which is close to
--     indistinguishable: 20/30 (3.6), 50/100 (2.4), 400/500 (4.8).
--
-- Both patterns track the shooting conditions, not the dilution series.
--
-- 450 ppm ("Very Severe") is NOT in this chart: no standard was supplied for
-- it. The scale still defines the word for a measured 450 ppm, but no colour
-- can match to it, and inventing one by interpolating its neighbours is
-- exactly what this migration exists to undo.
--
-- To make this VALIDATED: re-photograph all sixteen standards in one session,
-- one camera, fixed lighting, grey card in every frame.

BEGIN;

CREATE TEMP TABLE measured (
  sort_order int PRIMARY KEY,
  concentration_value numeric(14, 6) NOT NULL,
  label text NOT NULL,
  rgb_r int NOT NULL, rgb_g int NOT NULL, rgb_b int NOT NULL,
  lab_l double precision NOT NULL,
  lab_a double precision NOT NULL,
  lab_b double precision NOT NULL
) ON COMMIT DROP;

INSERT INTO measured
  (sort_order, concentration_value, label, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b)
VALUES
    (0, 0, 'Negative', 191, 193, 192, 77.888, -0.8777, 0.2588),
    (1, 10, 'Trace', 120, 130, 160, 54.5492, 3.2377, -17.2085),
    (2, 20, 'Scanty', 81, 100, 153, 43.0075, 7.806, -31.1651),
    (3, 30, 'Very Low', 92, 104, 145, 44.5464, 6.0254, -23.9402),
    (4, 40, 'Low', 80, 101, 177, 44.4985, 14.7033, -42.9788),
    (5, 50, 'Mild', 19, 14, 163, 20.4242, 52.9229, -74.0336),
    (6, 100, 'Moderate', 21, 14, 145, 17.9961, 47.7397, -66.9973),
    (7, 150, 'Moderately High', 23, 30, 111, 16.7868, 27.918, -47.3976),
    (8, 200, 'High', 34, 50, 123, 23.8387, 20.1905, -43.531),
    (9, 250, 'Very High', 52, 64, 101, 27.6717, 6.2943, -23.2982),
    (10, 300, 'Heavy', 20, 34, 56, 13.0967, 2.0313, -16.1097),
    (11, 350, 'Very Heavy', 57, 65, 94, 28.0027, 4.8634, -18.2485),
    (12, 400, 'Severe', 31, 43, 67, 17.5721, 2.8262, -16.7077),
    (13, 500, 'Intense', 34, 51, 70, 20.6339, -0.7969, -13.9708),
    (14, 1000, 'Extremely High', 4, 8, 19, 2.2264, 0.8249, -5.4606);

WITH target AS (
  SELECT id FROM reference_charts WHERE validation_status = 'ILLUSTRATIVE'
)
INSERT INTO reference_levels (
  reference_chart_id, label, concentration_value, concentration_unit,
  sort_order, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b, lab_std,
  roi_x, roi_y, roi_width, roi_height,
  color_source, validation_status, notes
)
SELECT
  target.id, m.label, m.concentration_value, 'ppm',
  m.sort_order, m.rgb_r, m.rgb_g, m.rgb_b, m.lab_l, m.lab_a, m.lab_b, 0,
  NULL, NULL, NULL, NULL,
  -- Sampled from a photograph of a prepared standard, which is what this
  -- enum value means. The previous colours were MANUAL_ENTRY because they
  -- were interpolated.
  'IMAGE_SAMPLED', 'ILLUSTRATIVE',
  'Measured from a prepared standard photographed 13 November 2026. '
  || 'White balanced against the paper backing; no grey card in frame.'
FROM target CROSS JOIN measured m
ON CONFLICT (reference_chart_id, sort_order) DO UPDATE SET
  label               = EXCLUDED.label,
  concentration_value = EXCLUDED.concentration_value,
  concentration_unit  = EXCLUDED.concentration_unit,
  rgb_r = EXCLUDED.rgb_r, rgb_g = EXCLUDED.rgb_g, rgb_b = EXCLUDED.rgb_b,
  lab_l = EXCLUDED.lab_l, lab_a = EXCLUDED.lab_a, lab_b = EXCLUDED.lab_b,
  color_source = EXCLUDED.color_source,
  notes = EXCLUDED.notes;

-- 0008 wrote sixteen levels. This chart has fifteen, because 450 ppm was not
-- photographed. The sixteenth row must go rather than linger with its old
-- interpolated colour, which would otherwise stay matchable.
DELETE FROM reference_levels
WHERE sort_order > 14
  AND reference_chart_id IN (
    SELECT id FROM reference_charts WHERE validation_status = 'ILLUSTRATIVE'
  );

COMMIT;
