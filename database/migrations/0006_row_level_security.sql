-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0006 — Row Level Security                                                 ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- HOW RLS INTERACTS WITH THE API  (see docs/security.md for the long version)
--
-- The NestJS API connects as an application role and sets two GUCs per request,
-- inside the transaction, from the verified JWT:
--
--     SET LOCAL app.current_user_id = '<uuid>';
--     SET LOCAL app.current_user_role = 'LAB_TECHNICIAN';
--
-- The policies below then restrict every row to laboratories the user actually
-- belongs to. This is defence in depth, NOT the primary control: the API also
-- enforces laboratory scoping in its guards and queries. If the GUC is unset
-- (e.g. a migration or seed connection), current_app_user() returns NULL and
-- the policies deny everything — so maintenance work runs as the table owner,
-- which bypasses RLS by design.
--
-- The Supabase service-role key bypasses RLS entirely. It is backend-only and
-- must never be shipped to a browser.

BEGIN;

-- ── Helper functions ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_app_user()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_app_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '');
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_app_role() = 'SUPER_ADMIN';
$$;

-- True when the current user holds an ACTIVE membership in the given lab.
CREATE OR REPLACE FUNCTION has_lab_access(target_lab uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    target_lab IS NOT NULL
    AND (
      is_super_admin()
      OR EXISTS (
        SELECT 1
        FROM laboratory_memberships m
        WHERE m.laboratory_id = target_lab
          AND m.user_id = current_app_user()
          AND m.status = 'ACTIVE'
      )
    );
$$;

COMMENT ON FUNCTION has_lab_access(uuid) IS
  'Laboratory-level isolation predicate. SECURITY DEFINER so the membership '
  'lookup itself is not blocked by RLS on laboratory_memberships.';

-- ── Enable RLS ──────────────────────────────────────────────────────────────
ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE laboratories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE laboratory_memberships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE samples                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_images           ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE measured_color_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE laboratory_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_examples        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_charts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_methods            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs              ENABLE ROW LEVEL SECURITY;

-- ── users: a user sees themselves; super admins see everyone ────────────────
DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (id = current_app_user() OR is_super_admin());

DROP POLICY IF EXISTS users_self_update ON users;
CREATE POLICY users_self_update ON users
  FOR UPDATE
  USING (id = current_app_user() OR is_super_admin())
  WITH CHECK (id = current_app_user() OR is_super_admin());

-- ── laboratories: only labs you belong to ───────────────────────────────────
DROP POLICY IF EXISTS laboratories_member_select ON laboratories;
CREATE POLICY laboratories_member_select ON laboratories
  FOR SELECT
  USING (has_lab_access(id));

DROP POLICY IF EXISTS laboratories_admin_update ON laboratories;
CREATE POLICY laboratories_admin_update ON laboratories
  FOR UPDATE
  USING (
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM laboratory_memberships m
      WHERE m.laboratory_id = laboratories.id
        AND m.user_id = current_app_user()
        AND m.status = 'ACTIVE'
        AND m.role IN ('LAB_ADMIN', 'SUPER_ADMIN')
    )
  )
  WITH CHECK (true);

-- ── memberships: your own rows, or any row in a lab you belong to ───────────
DROP POLICY IF EXISTS memberships_select ON laboratory_memberships;
CREATE POLICY memberships_select ON laboratory_memberships
  FOR SELECT
  USING (user_id = current_app_user() OR has_lab_access(laboratory_id));

-- ── Laboratory-scoped tables: one uniform policy each ────────────────────────
DROP POLICY IF EXISTS samples_lab_isolation ON samples;
CREATE POLICY samples_lab_isolation ON samples
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

DROP POLICY IF EXISTS sample_images_lab_isolation ON sample_images;
CREATE POLICY sample_images_lab_isolation ON sample_images
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

DROP POLICY IF EXISTS analysis_lab_isolation ON analysis_results;
CREATE POLICY analysis_lab_isolation ON analysis_results
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

DROP POLICY IF EXISTS lab_meas_lab_isolation ON laboratory_measurements;
CREATE POLICY lab_meas_lab_isolation ON laboratory_measurements
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

DROP POLICY IF EXISTS annotations_lab_isolation ON annotations;
CREATE POLICY annotations_lab_isolation ON annotations
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

DROP POLICY IF EXISTS dataset_examples_lab_isolation ON dataset_examples;
CREATE POLICY dataset_examples_lab_isolation ON dataset_examples
  FOR ALL
  USING (has_lab_access(laboratory_id))
  WITH CHECK (has_lab_access(laboratory_id));

-- Colour features inherit isolation from their parent analysis.
DROP POLICY IF EXISTS mcf_lab_isolation ON measured_color_features;
CREATE POLICY mcf_lab_isolation ON measured_color_features
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM analysis_results a
      WHERE a.id = measured_color_features.analysis_id
        AND has_lab_access(a.laboratory_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM analysis_results a
      WHERE a.id = measured_color_features.analysis_id
        AND has_lab_access(a.laboratory_id)
    )
  );

-- ── Reference data: platform-wide rows (NULL lab) are readable by everyone ──
DROP POLICY IF EXISTS test_methods_visibility ON test_methods;
CREATE POLICY test_methods_visibility ON test_methods
  FOR SELECT
  USING (laboratory_id IS NULL OR has_lab_access(laboratory_id));

DROP POLICY IF EXISTS test_methods_write ON test_methods;
CREATE POLICY test_methods_write ON test_methods
  FOR ALL
  USING (is_super_admin() OR has_lab_access(laboratory_id))
  WITH CHECK (is_super_admin() OR has_lab_access(laboratory_id));

DROP POLICY IF EXISTS reference_charts_visibility ON reference_charts;
CREATE POLICY reference_charts_visibility ON reference_charts
  FOR SELECT
  USING (laboratory_id IS NULL OR has_lab_access(laboratory_id));

DROP POLICY IF EXISTS reference_charts_write ON reference_charts;
CREATE POLICY reference_charts_write ON reference_charts
  FOR ALL
  USING (is_super_admin() OR has_lab_access(laboratory_id))
  WITH CHECK (is_super_admin() OR has_lab_access(laboratory_id));

-- ── Audit log: readable within your lab, never updatable or deletable ───────
DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT
  USING (
    is_super_admin()
    OR (laboratory_id IS NOT NULL AND has_lab_access(laboratory_id))
    OR actor_user_id = current_app_user()
  );

DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT
  WITH CHECK (true);
-- Deliberately no UPDATE or DELETE policy: the trail is append-only.

COMMIT;
