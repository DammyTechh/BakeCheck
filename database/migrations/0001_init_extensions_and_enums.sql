-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0001 — Extensions, enums, and shared helpers                              ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- All timestamps in this schema are `timestamptz` and are stored in UTC.
-- This migration is additive only; it drops nothing.

BEGIN;

-- ── Extensions ──────────────────────────────────────────────────────────────
-- pgcrypto gives us gen_random_uuid(). Available on Supabase and stock PG 13+.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- citext lets us store emails case-insensitively without lower() everywhere.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Enums ───────────────────────────────────────────────────────────────────
-- Roles are global capability tiers. Laboratory-scoped roles live on
-- laboratory_memberships; a user can hold different roles in different labs.
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'SUPER_ADMIN',
    'LAB_ADMIN',
    'LAB_TECHNICIAN',
    'LAB_REVIEWER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE laboratory_status AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_status AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Validation status is deliberately shared by test methods, reference charts
-- and reference levels. `ILLUSTRATIVE` is the critical one: it marks reference
-- data that came from a picture rather than from calibrated measurement, and
-- the API refuses to report confirmed results against it.
DO $$ BEGIN
  CREATE TYPE validation_status AS ENUM (
    'DRAFT',
    'ILLUSTRATIVE',
    'REVIEWED',
    'VALIDATED',
    'ARCHIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sample_status AS ENUM (
    'REGISTERED',
    'PREPARED',
    'ANALYZED',
    'UNDER_REVIEW',
    'CONFIRMED',
    'REJECTED',
    'ARCHIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE analysis_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'REJECTED_QUALITY'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The mode records *how* a prediction was produced, so a stored result can
-- never be mistaken for something it is not.
DO $$ BEGIN
  CREATE TYPE analysis_mode AS ENUM (
    'REFERENCE_MATCHING',   -- transparent colour distance, no trained model
    'MODEL_INFERENCE',      -- a released, approved model produced the label
    'HYBRID'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE image_source AS ENUM ('UPLOAD', 'CAMERA', 'REFERENCE_CHART', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE quality_verdict AS ENUM ('USABLE', 'MARGINAL', 'UNUSABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Where a training label came from. Technician opinion and an instrument
-- measurement are NOT interchangeable and are never merged into one column.
DO $$ BEGIN
  CREATE TYPE label_source AS ENUM (
    'TECHNICIAN_ANNOTATION',
    'LABORATORY_MEASUREMENT',
    'REFERENCE_STANDARD',
    'SYNTHETIC_FIXTURE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE model_release_status AS ENUM (
    'TRAINING',
    'TRAINED',
    'EVALUATED',
    'APPROVED',
    'RELEASED',
    'ROLLED_BACK',
    'REJECTED',
    'FAILED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE training_job_status AS ENUM (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE confirmation_status AS ENUM ('PRELIMINARY', 'CONFIRMED', 'DISPUTED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Shared trigger: maintain updated_at ─────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger: stamps updated_at with the current UTC time.';

COMMIT;
