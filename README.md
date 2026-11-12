# BreadGuard AI

Laboratory-assisted chemical screening platform. A technician photographs the
coloured solution produced by a laboratory test, and the system measures its
colour, compares it against a configured reference chart, and records the
result with its provenance.

> **What this does and does not claim**
>
> Every result derived from an image is a **screening estimate**, not a
> chemical measurement. The system does not supply the chemistry: the reagent,
> the sample preparation, the calibration and the detection limits all come
> from your laboratory's own validated method.
>
> **No output of this system should be used on its own to declare a sample
> safe, unsafe, compliant or non-compliant.**
>
> As shipped, it runs in reference-matching prototype mode against an
> *illustrative* colour chart, and no predictive model has been validated.
> See [`docs/prototype-limitations.md`](docs/prototype-limitations.md).

---

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Running without Docker](#running-without-docker)
- [Commands](#commands)
- [Demonstration accounts](#demonstration-accounts)
- [API documentation](#api-documentation)
- [Testing](#testing)
- [Watching the learning loop run](#watching-the-learning-loop-run)
- [Deployment](#deployment)
- [Repository layout](#repository-layout)
- [Further reading](#further-reading)

---

## Architecture

```
            ┌───────────────────────┐
            │  React frontend       │   (Vercel)
            └───────────┬───────────┘
                        │  HTTPS · REST · JWT
                        ▼
            ┌───────────────────────┐
            │  Node.js API          │   (Render · public)
            │  NestJS · TypeScript  │
            └───────────┬───────────┘
                        │
     ┌──────────────────┼──────────────────┬────────────────────┐
     ▼                  ▼                  ▼                    ▼
┌──────────┐  ┌───────────────────┐  ┌───────────┐   ┌──────────────────┐
│ Postgres │  │ Private object    │  │  Resend   │   │ Python AI service│
│ Supabase │  │ storage           │  │ (optional)│   │ FastAPI · OpenCV │
└──────────┘  └───────────────────┘  └───────────┘   │  (Render private)│
                                                      └──────────────────┘
```

**Responsibilities are separated and the boundary is enforced, not assumed:**

- The **Node API** owns authentication, authorisation, laboratories, samples,
  image intake, business rules, auditing and orchestration. It is the only
  public entry point.
- The **Python service** owns image processing, colour measurement, reference
  matching and inference. It is a private service with no public route, and it
  additionally requires a shared internal key on every request.
- The **frontend never** talks to the database or to the Python service.

---

## Quick start

### Prerequisites

- Docker and Docker Compose, **or** Node.js ≥ 20.11 and Python ≥ 3.12 with a
  local PostgreSQL 16
- `openssl` for generating secrets

> **Dependency versions are pinned exactly**, in both `package.json` and
> `requirements.txt` — no `^` or `>=` ranges anywhere. Installing reproduces
> the exact tree the test suite was verified against, so a fresh machine
> behaves identically to this one. Bump deliberately: change the version,
> reinstall, and re-run `verify-all.sh`.

### 1. Configure

```bash
cp .env.example .env
```

Generate real secrets — the application refuses to start in production with
placeholder values:

```bash
printf 'JWT_ACCESS_SECRET=%s\n'        "$(openssl rand -base64 48)" >> .env
printf 'JWT_REFRESH_SECRET=%s\n'       "$(openssl rand -base64 48)" >> .env
printf 'AI_SERVICE_INTERNAL_KEY=%s\n'  "$(openssl rand -hex 32)"    >> .env
```

> The access and refresh secrets **must differ**. An identical pair would let
> a refresh token be replayed as an access token.

### 2. Start

```bash
docker compose up -d --build
docker compose run --rm migrate    # apply schema migrations
docker compose run --rm seed       # create demonstration data
```

The seed prints three account passwords **once**. Note them, or set
`SEED_*_PASSWORD` in `.env` beforehand to choose them yourself.

**About the database port.** The container publishes Postgres on
**127.0.0.1:5433**, not 5432, because 5432 is where a locally installed
Postgres usually already listens — and that collision stops the whole stack:

```
Bind for 0.0.0.0:5432 failed: port is already allocated
```

If 5433 is also taken, change it in `.env` and match Option A's
`DATABASE_URL` port:

```dotenv
POSTGRES_PORT=5434
DATABASE_URL=postgresql://breadguard:<your-password>@localhost:5434/breadguard
```

Two things worth knowing, both of which cost real debugging time:

- **Compose reads only the `.env` beside `docker-compose.yml`**, at the
  repository root. It does *not* read `apps/api/.env`. Setting
  `POSTGRES_PORT` in the per-app file has no effect on Compose, and the
  symptom is the port error above with a `.env` that looks correct.
- Only the *host* port changes. Containers always reach each other on 5432
  over Compose's private network, so `api`→`postgres` traffic is unaffected.

If you hit the error and have just edited `.env`, run `docker compose down`
first so nothing from the failed attempt is reused, then bring it back up.

### 3. Verify

```bash
curl http://localhost:3000/health
./infrastructure/scripts/e2e-smoke.sh
```

The smoke script walks the full workflow and asserts the guarantees that
matter — including that a prototype-mode result reports no concentration and
no confidence, and that one laboratory cannot read another's records.

| Service     | URL                              |
|-------------|----------------------------------|
| API         | http://localhost:3000/api/v1     |
| Swagger UI  | http://localhost:3000/api/docs   |
| OpenAPI JSON| http://localhost:3000/api/docs-json |
| Health      | http://localhost:3000/health     |

---

## Running without Docker

Three terminals. **Postgres must be running first.**

```bash
# Terminal 1 — database (if not already running)
createdb breadguard
export DATABASE_URL=postgresql://localhost:5432/breadguard

# Terminal 2 — Python vision service
cd services/ai
python -m venv .venv && source .venv/bin/activate
# -dev pulls in requirements.txt plus pytest, ruff and mypy. Use plain
# `requirements.txt` for a runtime-only install, which is what the container does.
pip install -r requirements-dev.txt
AI_INTERNAL_KEY=$(openssl rand -hex 32) uvicorn app.main:app --port 8000

# Terminal 3 — Node API
npm install
cd apps/api
cp ../../.env .env          # ensure AI_SERVICE_INTERNAL_KEY matches terminal 2
npm run db:migrate
npm run db:seed
npm run start:dev
```

> `AI_SERVICE_INTERNAL_KEY` (API) and `AI_INTERNAL_KEY` (Python) **must be the
> same value**. A mismatch produces 401s from the vision service, which the
> API reports as a configuration error rather than a user error.

---

## Commands

All run from the repository root unless noted. Each lists what must already be
running.

### Database

| Command | Requires | What it does |
|---|---|---|
| `npm run db:migrate` | Postgres | Applies pending migrations |
| `npm run db:migrate:status` | Postgres | Shows applied / pending / drifted |
| `npm run db:seed` | Postgres, migrated | Creates demonstration data |
| `npm run db:reset -- --force` | Postgres | **Destroys all data** and recreates the schema |

Plus one that is deliberately not in the table above, because it writes data
that is not real:

```bash
npm --workspace @breadguard/api run db:seed:training-demo
npm --workspace @breadguard/api run db:seed:training-demo -- --purge
```

See [Watching the learning loop run](#watching-the-learning-loop-run).

The migration runner records a checksum per file and **refuses to continue if
an already-applied migration has been edited** — that means the database and
the repository have silently diverged. Write a new migration instead.

### API

| Command | Requires | What it does |
|---|---|---|
| `npm run dev:api` | Postgres, AI service | Development server, watch mode |
| `npm run build:api` | — | Compiles to `apps/api/dist` |
| `npm run start:api` | Postgres, AI service, built | Runs the compiled server |
| `npm run test:api` | — | Unit tests (no database needed) |
| `npm run lint:api` | — | ESLint |

### Python service

```bash
cd services/ai
uvicorn app.main:app --reload --port 8000    # development
python -m pytest                              # tests (no services needed)
python -m pytest -v --tb=short                # verbose
```

### End to end

```bash
./infrastructure/scripts/e2e-smoke.sh         # requires API + AI + Postgres
```

---

## Demonstration accounts

Created by `npm run db:seed`. **Fictional identities, development only.**

| Email | Role | Laboratory |
|---|---|---|
| `admin@breadguard.test` | LAB_ADMIN | DEMO-LAB-01 |
| `technician@breadguard.test` | LAB_TECHNICIAN | DEMO-LAB-01 |
| `reviewer@breadguard.test` | LAB_REVIEWER | DEMO-LAB-02 |

Passwords come from `SEED_ADMIN_PASSWORD`, `SEED_TECHNICIAN_PASSWORD` and
`SEED_REVIEWER_PASSWORD`, or are generated randomly and printed once.

Two laboratories exist on purpose: the reviewer is in a *different* one, which
is what makes cross-laboratory isolation testable rather than merely claimed.

**Email verification is not required.** The prototype is fully usable with no
mail provider configured.

---

## API documentation

Swagger UI is served at `/api/docs` and generated from the running
application, so paths and schemas always match the code.

The prose — summaries, descriptions, examples, documented error cases — lives
in [`apps/api/src/swagger/`](apps/api/src/swagger/), **not** inline in the
controllers. Each route group has one file of composed decorators, so handlers
stay readable and the documentation has one place to live. See
[`apps/api/src/swagger/README.md`](apps/api/src/swagger/README.md).

Export the spec without starting a server:

```bash
cd apps/api && npm run openapi:export
```

---

## Testing

**One command runs everything:**

```bash
./infrastructure/scripts/verify-all.sh            # static analysis + all tests
RUN_E2E=1 ./infrastructure/scripts/verify-all.sh  # also the end-to-end workflow
```

It exits non-zero on any failure, so it drops straight into CI.

Individually:

```bash
npm run test:api                       # 127 tests — security, config, uploads, SQL safety, worker
cd apps/api && npm run verify          # typecheck + lint + tests
cd services/ai && python -m pytest     # 139 tests — colorimetry, vision, pipeline, learning loop
cd services/ai && python -m ruff check app tests
cd services/ai && python -m mypy app   # config in services/ai/mypy.ini
./infrastructure/scripts/e2e-smoke.sh  # 59 checks — full workflow, live services
```

`mypy` takes no `--ignore-missing-imports`: [`services/ai/mypy.ini`](services/ai/mypy.ini)
names the untyped scientific libraries one at a time, so a genuinely missing
import — a typo, or a dependency absent from `requirements.txt` — still fails.

Running `e2e-smoke.sh` twice in quick succession trips the login throttle. The
script detects that and says so, rather than reporting two dozen unrelated
failures; restart the API to clear it, since the throttle is in-memory.

The two CIEDE2000 implementations (TypeScript and Python) are asserted against
**the same test vectors**, so they are proven to agree rather than assumed to.
Expected values are generated from an independent implementation — see
[`infrastructure/scripts/generate_ciede2000_vectors.py`](infrastructure/scripts/generate_ciede2000_vectors.py)
and the note there about why they are not transcribed by hand.

`test/sql-safety.spec.ts` is a static guard rather than a behavioural test: it
parses every `db.query` call site and asserts that nothing but a
server-controlled fragment is ever interpolated into SQL. Dynamic `SET` and
`WHERE` clauses are safe today; this is what stops that silently changing.

---

## Watching the learning loop run

The system learns, but only along a path that a human has to walk with it:

```
 image → analysis → annotation → review → APPROVED dataset_example
                                                      │
                            POST /ai/training-jobs ────┤
                                                      ▼
                          worker claims the job (FOR UPDATE SKIP LOCKED)
                                                      │
                            dedup → group-aware split → train → evaluate
                                                      ▼
                            model_versions: status TRAINED, is_active false
                                                      │
                            POST /ai/models/{id}/approve  ← a human, audited
                                                      ▼
                          analysis mode flips REFERENCE_MATCHING → MODEL_INFERENCE
```

Nothing in that chain happens on its own. An uploaded image is invisible to
training until somebody approves it (`review_status = 'APPROVED' AND
usage_authorized AND NOT excluded`), and a trained model is inert until
somebody approves *it* — enforced in the worker, in the API, by
`model_versions_active_requires_approval_chk` in the schema, and again by the
AI service's registry, which refuses to load an artifact not marked approved.

### Seeing it work before real data exists

Until a laboratory has produced tens of confirmed measurements, the whole loop
is unobservable. That is a bad reason to ship it untested, so there is a
seeder — and it is loud about what it does:

```bash
npm --workspace @breadguard/api run db:seed:training-demo   # 42 examples
# POST /ai/training-jobs, wait ~15s for the worker, then read the job
npm --workspace @breadguard/api run db:seed:training-demo -- --purge
```

It writes rows into `laboratory_measurements` that **are not measurements** —
numbers generated from the illustrative ladder with added noise. Every row is
stamped `SYNTHETIC_DEMONSTRATION`, carries a plain-English provenance warning,
and is removable by that stamp. It refuses to run with `NODE_ENV=production`.

### What it produces, and why that is the point

A real run on that data trains successfully and reports **macro F1 = 1.000**,
then refuses to recommend release:

```
status:          SUCCEEDED
recommendation:  INSUFFICIENT_DATA
awaiting approval: true

BLOCKERS:
  - the test set holds 8 examples, below the minimum of 30
  - these classes have fewer than 5 test examples, so their performance
    is not measured: …
  - macro F1 improves on the reference matcher by only +0.000, below the
    0.02 needed to justify replacing a transparent calculation
```

A perfect score, and the answer is still no. The third blocker is the one that
matters: the data was generated from the reference ladder, so the transparent
calculation already scores perfectly on it, and swapping it for an opaque
model buys nothing while costing explainability. A system that reported
"100% accurate AI model" here would be telling the truth about the metric and
lying about the result.

Approval is still possible, but it has to be an attributable decision: the API
refuses it outright unless the caller supplies `overrideReason`, which is
written to the audit log alongside the blockers it overrode.

Rollback returns both ends of the switch and an `analysisServiceConfirmed`
flag — because the operator who just withdrew a model is exactly the person
who needs to know if the analysis service did not confirm it.

The loop is proved in two places: `services/ai/tests/test_learning_loop.py`
drives training → refusal → approval → mode flip → rollback end to end, and
`apps/api/test/training-worker.spec.ts` asserts the statements the worker
issues, including that it never writes `is_active = true`.

---

## Deployment

**Backend → Render. Frontend → Vercel.**

The Python service cannot run on Vercel: OpenCV plus NumPy and scikit-learn
exceeds the serverless bundle limit, analysis is CPU-bound and runs for
seconds, and a cold start would reload the model every invocation.

[`render.yaml`](render.yaml) is a complete blueprint — database, private AI
service and public API, with the internal key generated once and shared
between the two services automatically.

Full instructions, including the Supabase storage setup and a production
checklist, are in [`docs/deployment.md`](docs/deployment.md).

---

## Repository layout

```
breadguard-ai/
├── apps/api/                   Node.js REST API (NestJS)
│   ├── src/
│   │   ├── common/             Guards, filters, errors, colour maths
│   │   ├── config/             Validated configuration
│   │   ├── database/           Pool, migration runner, seed
│   │   ├── integrations/       Python client, object storage
│   │   ├── modules/            Feature modules
│   │   └── swagger/            ← all OpenAPI documentation
│   └── test/
├── services/ai/                Python vision service (FastAPI)
│   ├── app/
│   │   ├── vision/             Validation, ROI detection, quality
│   │   ├── colorimetry/        Colour conversion, feature extraction
│   │   ├── reference_matching/ CIEDE2000 matching
│   │   ├── models/             Model interface and registry
│   │   └── schemas/            Pydantic contracts
│   └── tests/
├── database/
│   ├── migrations/             SQL — the source of truth for the schema
│   └── seeds/                  Extracted reference colours
├── infrastructure/scripts/     Smoke test, colour extraction tools
└── docs/                       Architecture, methodology, limitations
```

---

## Further reading

| Document | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Service boundaries and request flow |
| [`docs/ai-methodology.md`](docs/ai-methodology.md) | How the vision pipeline works, and what it cannot establish |
| [`docs/prototype-limitations.md`](docs/prototype-limitations.md) | **Read before using this with real samples** |
| [`docs/security.md`](docs/security.md) | Threat model, RLS, production checklist |
| [`docs/deployment.md`](docs/deployment.md) | Render and Vercel setup |
| [`docs/data-labeling.md`](docs/data-labeling.md) | Human-in-the-loop workflow |
| [`docs/model-validation.md`](docs/model-validation.md) | What must hold before a model is released |
| [`docs/adr/`](docs/adr/) | Architecture decision records |

---

## Which version am I running?

Three rounds of debugging were once spent on a fix that had been shipped but
never actually landed, because the delivered archive extracted into a nested
subfolder and left the working copy untouched. If something that was supposed
to be fixed still fails, check this first:

```powershell
type VERSION                      # commit and build stamp
findstr 5433 docker-compose.yml   # should print the postgres ports line
```

If `findstr` prints nothing, you are running an older copy of the repository
and the database port fix is not in it.
