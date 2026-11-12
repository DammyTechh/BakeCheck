-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0008 — Rebuild the illustrative chart from the laboratory's ppm scale     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- The chart shipped in October carried six levels read off an illustration,
-- with concentrations of 0, 0.1, 0.5, 1, 5 and 10 ppm and labels of its own
-- invention ("High Level", "Very High Level").
--
-- On 16 October 2026 the laboratory supplied its actual reporting scale:
-- sixteen points, 0 "Negative" through 1000 "Extremely High". The seed was
-- rewritten to match, but a seed only runs when somebody remembers to run it,
-- and this one was not run. Production therefore kept showing 0.1 and 0.5 ppm
-- against labels whose words mean 200 and 250 ppm on the real scale — a
-- reading overstated by roughly 25x to anyone holding that scale.
--
-- Reference data the application's correctness depends on does not belong
-- behind a manual step, so it moves here. Migrations already run as their own
-- job on deploy.
--
-- Idempotent, and safe on a database that has never been seeded: if no
-- illustrative chart exists yet, this does nothing and the seed creates the
-- sixteen levels itself.
--
-- The colours are still interpolated from the illustration and the chart
-- stays ILLUSTRATIVE. Only the concentrations and wording are the
-- laboratory's. Replacing the colours needs photographs of prepared
-- standards; see docs/prototype-limitations.md 1b.

BEGIN;

CREATE TEMP TABLE scale_levels (
  sort_order int PRIMARY KEY,
  concentration_value numeric(14, 6) NOT NULL,
  label text NOT NULL,
  rgb_r int NOT NULL,
  rgb_g int NOT NULL,
  rgb_b int NOT NULL,
  lab_l double precision NOT NULL,
  lab_a double precision NOT NULL,
  lab_b double precision NOT NULL
) ON COMMIT DROP;

INSERT INTO scale_levels
  (sort_order, concentration_value, label, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b)
VALUES
    (0, 0, 'Negative', 240, 240, 240, 94.7962, -0.0, 0.0),
    (1, 10, 'Trace', 231, 239, 241, 93.8364, -2.0934, -2.1793),
    (2, 20, 'Scanty', 222, 237, 243, 92.8766, -4.1868, -4.3587),
    (3, 30, 'Very Low', 212, 236, 244, 91.9168, -6.2801, -6.538),
    (4, 40, 'Low', 185, 226, 245, 87.6883, -9.3661, -13.5964),
    (5, 50, 'Mild', 155, 217, 246, 83.4597, -12.452, -20.6547),
    (6, 100, 'Moderate', 120, 207, 247, 79.2311, -15.538, -27.713),
    (7, 150, 'Moderately High', 98, 181, 245, 71.1288, -6.7212, -39.4205),
    (8, 200, 'High', 69, 156, 243, 63.0265, 2.0957, -51.1279),
    (9, 250, 'Very High', 1, 132, 241, 54.9243, 10.9125, -62.8354),
    (10, 300, 'Heavy', 16, 100, 212, 44.2734, 20.1442, -63.7356),
    (11, 350, 'Very Heavy', 14, 69, 184, 33.6226, 29.3759, -64.6358),
    (12, 400, 'Severe', 1, 38, 156, 22.9717, 38.6075, -65.5359),
    (13, 450, 'Very Severe', 2, 28, 141, 19.0517, 39.3299, -62.7991),
    (14, 500, 'Intense', 3, 17, 126, 15.1317, 40.0522, -60.0623),
    (15, 1000, 'Extremely High', 2, 5, 112, 11.2116, 40.7745, -57.3255);

-- Every illustrative bromate chart in the database. There is one in practice;
-- written as a set so a second environment's copy is not left behind.
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
  target.id, s.label, s.concentration_value, 'ppm',
  s.sort_order, s.rgb_r, s.rgb_g, s.rgb_b, s.lab_l, s.lab_a, s.lab_b, 0,
  -- An interpolated level was read from no region of any image. The ROI
  -- check rejects a zero-sized region, correctly: "no region" and "a region
  -- of no size" are different claims.
  NULL, NULL, NULL, NULL,
  'MANUAL_ENTRY', 'ILLUSTRATIVE',
  'Concentration and wording from the laboratory scale of 16 October 2026. '
  || 'Colour interpolated from an illustration, not measured.'
FROM target CROSS JOIN scale_levels s
ON CONFLICT (reference_chart_id, sort_order) DO UPDATE SET
  label               = EXCLUDED.label,
  concentration_value = EXCLUDED.concentration_value,
  concentration_unit  = EXCLUDED.concentration_unit,
  rgb_r = EXCLUDED.rgb_r, rgb_g = EXCLUDED.rgb_g, rgb_b = EXCLUDED.rgb_b,
  lab_l = EXCLUDED.lab_l, lab_a = EXCLUDED.lab_a, lab_b = EXCLUDED.lab_b,
  notes = EXCLUDED.notes;

-- The old chart had six levels. If any environment ever had MORE than
-- sixteen, the extras would linger and still be matchable, so they go.
DELETE FROM reference_levels
WHERE sort_order > 15
  AND reference_chart_id IN (
    SELECT id FROM reference_charts WHERE validation_status = 'ILLUSTRATIVE'
  );

COMMIT;
