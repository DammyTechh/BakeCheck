-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0002 — Users, laboratories, memberships, sessions, audit log              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ── users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext NOT NULL,
  password_hash       text NOT NULL,          -- Argon2id encoded string
  full_name           text NOT NULL,
  job_title           text,
  -- Platform-wide role. Laboratory-scoped permissions come from memberships.
  role                user_role NOT NULL DEFAULT 'LAB_TECHNICIAN',
  status              account_status NOT NULL DEFAULT 'ACTIVE',
  -- Prototype runs with verification disabled; the column exists so enabling
  -- it later is a config change rather than a migration.
  email_verified_at   timestamptz,
  last_login_at       timestamptz,
  -- Incremented on password change / forced logout to invalidate live tokens.
  token_version       integer NOT NULL DEFAULT 0,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_format_chk CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_full_name_len_chk CHECK (char_length(full_name) BETWEEN 1 AND 200),
  CONSTRAINT users_token_version_chk  CHECK (token_version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (email);
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);
CREATE INDEX IF NOT EXISTS users_role_idx   ON users (role);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN users.token_version IS
  'Bumped to revoke every outstanding access token for this user at once.';

-- ── laboratories ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS laboratories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-facing short code, e.g. "LAG-CENTRAL-01". Unique across the platform.
  code            text NOT NULL,
  name            text NOT NULL,
  contact_email   citext,
  contact_phone   text,
  address_line1   text,
  address_line2   text,
  city            text,
  region          text,
  country         text,
  postal_code     text,
  -- Free-form accreditation reference (e.g. ISO 17025 cert number). Not validated.
  accreditation_ref text,
  status          laboratory_status NOT NULL DEFAULT 'ACTIVE',
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT laboratories_code_fmt_chk CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  CONSTRAINT laboratories_name_len_chk CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS laboratories_code_uniq ON laboratories (code);
CREATE INDEX IF NOT EXISTS laboratories_status_idx ON laboratories (status);

DROP TRIGGER IF EXISTS laboratories_set_updated_at ON laboratories;
CREATE TRIGGER laboratories_set_updated_at
  BEFORE UPDATE ON laboratories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── laboratory_memberships ──────────────────────────────────────────────────
-- The authorization spine: every laboratory-scoped check resolves through here.
CREATE TABLE IF NOT EXISTS laboratory_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id   uuid NOT NULL REFERENCES laboratories (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            user_role NOT NULL DEFAULT 'LAB_TECHNICIAN',
  status          membership_status NOT NULL DEFAULT 'ACTIVE',
  invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  invited_at      timestamptz,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- One membership row per (lab, user). Re-invites update the existing row.
  CONSTRAINT laboratory_memberships_uniq UNIQUE (laboratory_id, user_id),
  CONSTRAINT laboratory_memberships_revoked_chk
    CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS lab_memberships_user_idx ON laboratory_memberships (user_id, status);
CREATE INDEX IF NOT EXISTS lab_memberships_lab_idx  ON laboratory_memberships (laboratory_id, status);

DROP TRIGGER IF EXISTS lab_memberships_set_updated_at ON laboratory_memberships;
CREATE TRIGGER lab_memberships_set_updated_at
  BEFORE UPDATE ON laboratory_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── refresh_tokens ──────────────────────────────────────────────────────────
-- Only a SHA-256 hash of the token is stored; the raw value never touches the DB.
-- Rotation: on refresh the old row is marked rotated and linked to its successor,
-- which makes replay of a consumed token detectable.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash      text NOT NULL,
  -- Groups every token descended from one login, so a detected replay can
  -- revoke the whole chain.
  family_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  replaced_by     uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent      text,
  ip_address      inet,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refresh_tokens_hash_uniq UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE refresh_tokens IS
  'Hashed refresh tokens. Rotation marks the old row revoked and sets replaced_by; '
  'presenting an already-rotated token revokes the entire family_id.';

-- ── audit_logs ──────────────────────────────────────────────────────────────
-- Append-only by convention; the application never issues UPDATE or DELETE here.
CREATE TABLE IF NOT EXISTS audit_logs (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_email     citext,                    -- denormalised so the trail survives deletion
  laboratory_id   uuid REFERENCES laboratories (id) ON DELETE SET NULL,
  action          text NOT NULL,             -- e.g. 'auth.login', 'sample.create'
  resource_type   text,
  resource_id     text,
  outcome         text NOT NULL DEFAULT 'SUCCESS',
  correlation_id  uuid,
  ip_address      inet,
  user_agent      text,
  -- Metadata is written through a redaction helper in the API; it must never
  -- contain passwords, tokens, or raw image bytes.
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_logs_outcome_chk CHECK (outcome IN ('SUCCESS', 'FAILURE', 'DENIED'))
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_lab_idx    ON audit_logs (laboratory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_corr_idx   ON audit_logs (correlation_id);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id);

COMMIT;
