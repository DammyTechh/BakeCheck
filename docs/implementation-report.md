# Implementation report — backend

Status of the BreadGuard AI backend as built, separated into what is tested,
what is prototype-only, and what depends on inputs this system cannot supply.

**Date:** 2026-10-13
**Scope:** Backend only. The React frontend is not yet built.

---

## Verification summary

Everything below was run, not assumed.

Run `./infrastructure/scripts/verify-all.sh` (add `RUN_E2E=1` with services
up) to reproduce all of it in one command.

| Check | Result | Covers |
|---|---|---|
| `tsc --noEmit` | **clean** | API source and tests, both tsconfigs |
| `eslint` | **clean** | API source and tests |
| Node (`jest`) | **127 passed** | Security primitives, config, env parsing, uploads, SQL-injection guard, training worker |
| `nest build` | **clean** | Production build |
| `npm audit --omit=dev` | **0 vulnerabilities** | Production dependency tree |
| `ruff` | **clean** | AI service source and tests |
| `mypy` | **clean** | AI service source, against `services/ai/mypy.ini` |
| Python (`pytest`) | **139 passed** | Colorimetry, vision pipeline, quality, matching, registry, datasets, training, evaluation, learning loop |
| Migration status | **7 applied, 0 pending** | Schema |
| End to end (`e2e-smoke.sh`) | **59 passed** | Full workflow against live API + AI service + Postgres |
| Learning loop | **run on live services** | Training job → worker → model → approval → mode flip → rollback |

**Dependency versions are pinned exactly** in both `package.json` and
`requirements.txt`. A clean `npm install` (no lockfile), `npm ci`, and a fresh
Python virtualenv were each verified to reproduce the tested tree and pass.

---

## 1. Tested and working

### Database
- 19 tables across 6 migrations; all apply cleanly from empty
- Migration runner with per-file checksums — refuses to proceed if an applied
  migration was edited, which means the database and repository have diverged
- Idempotent seed: 2 laboratories, 3 accounts, 1 method, 1 chart with 6 levels,
  3 sample fixtures
- RLS policies on 13 tables, evaluated from transaction-local session variables

### Authentication and authorisation
- Argon2id (19 MiB / t=2 / p=1), with `needsRehash` migration on login
- JWT access tokens; user row re-read per request so suspension takes effect
  immediately
- Refresh rotation with family-wide revocation on reuse detection
- Account enumeration resistance — verified: unknown email and wrong password
  return the same code
- Lockout after 8 failed attempts
- Capability model with per-laboratory role evaluation
- Cross-laboratory access returns 404, not 403 — verified for samples,
  analyses, images and list endpoints

### Image intake
- Format determined by magic bytes; declared Content-Type never trusted
  (verified: text file sent as `image/png` is rejected)
- SVG rejected outright (verified)
- Decompression-bomb guard: header pixel check before decode, plus a
  decode-time cap
- Truncated and corrupt files rejected
- EXIF stripped from the derivative (verified on the derivative's metadata)
- Original preserved byte-for-byte; normalised derivative measured
- SHA-256 duplicate detection, reported but not blocking

### Vision pipeline
- CIEDE2000 verified against 18 published vectors in **both** languages,
  cross-checked against scikit-image
- All six reference colours match their own level
- Measured colour within 5 ΔE of the true colour on synthetic tubes
- Glare masking verified — a specular strip does not shift the match
- Automatic tube detection, including the colourless-blank fallback
- Quality rejection verified for blur, under/overexposure, clipping, contrast
- A rejected image still returns its measurement, with no prediction

### Scientific guarantees
Each verified in both the Python suite and end to end:
- `estimatedConcentration` is null in prototype mode, for every ladder colour
- `confidence` is null in reference-matching mode — enforced by a database
  CHECK constraint, so no code path can route around it
- `isConfirmedMeasurement` is always false on an analysis
- Limitations are assembled per result from the real validation state
- A technician can record a measurement but cannot self-confirm it
- Training is refused without sufficient approved data

### API
- 30+ endpoints across 9 route groups
- Swagger UI at `/api/docs`, generated from the running application
- All OpenAPI prose in `apps/api/src/swagger/` — not inline in controllers
- Consistent error envelope with stable codes and correlation IDs
- Rate limiting verified (the limiter fired when the smoke test ran twice in
  one minute)
- Mass assignment rejected (verified: `status` on sample creation → 400)

### The learning loop

Run end to end against live API + AI service + Postgres, using the synthetic
seeder (`db:seed:training-demo`, 42 approved examples):

| Stage | Verified |
|---|---|
| Job queued via `POST /ai/training-jobs` | `QUEUED`, eligible/measurement-backed counts recorded |
| Worker claim | `FOR UPDATE SKIP LOCKED`; claimed within one 15 s poll |
| Example selection | Only `review_status = 'APPROVED' AND usage_authorized AND NOT excluded` |
| Dedup, group-aware split, train, evaluate | Completed; dataset + model + evaluation written in one transaction |
| Model landed | `status TRAINED`, `is_active = false`, `approved_by IS NULL` |
| Release decision | **`INSUFFICIENT_DATA` at macro F1 = 1.000** (see below) |
| Approval refused without justification | `INSUFFICIENT_DATA`, blockers listed, `overrideReason` demanded |
| Approval with `overrideReason` | Mode flipped `REFERENCE_MATCHING` → `MODEL_INFERENCE` in both the API and the running Python service |
| `validated` preserved as false | Concentration stayed `null` — approval for use is not scientific validation |
| Rollback | Service returned to the reference matcher; model `ROLLED_BACK`, reason stored |
| Audit trail | `training_job_create`, `training_completed`, `approve`, `rollback` |

**The result worth recording.** Training reached macro F1 = 1.000 and the
evaluator still refused to recommend release:

```
recommendation: INSUFFICIENT_DATA
  - the test set holds 8 examples, below the minimum of 30
  - these classes have fewer than 5 test examples, so their performance
    is not measured: …
  - macro F1 improves on the reference matcher by only +0.000, below the
    0.02 needed to justify replacing a transparent calculation
```

The third blocker is the substantive one. The synthetic data was generated
from the reference ladder, so the transparent calculation already scores
perfectly on it; replacing it with an opaque model would cost explainability
and buy nothing. A naive implementation would have reported a "100% accurate
model" — true about the metric, false about the result.

Proved in code by `services/ai/tests/test_learning_loop.py` (17 tests,
training → refusal → approval → mode flip → rollback, including that an
unapproved artifact cannot serve a result) and
`apps/api/test/training-worker.spec.ts` (23 tests on the statements the worker
issues). Both were mutation-checked: removing the approval gate in the
registry, and changing the worker's insert to `'RELEASED', true`, each make
the relevant tests fail.

---

## 2. Prototype-only

Implemented and working, but **not scientifically validated**.

| Feature | State |
|---|---|
| Reference chart | Colours extracted from an AI-generated illustration; marked `ILLUSTRATIVE` |
| Test method | Seeded as `DRAFT`; reagent and procedure recorded as `NOT SET` |
| Active model | `baseline-color-analysis` — colour distance, not a trained model |
| Quality thresholds | Conservative engineering heuristics, not a validated specification |
| Concentration estimation | Infrastructure present (`interpolate_concentration`); deliberately not called |

The matching maths is correct. Whether a colour *means* a concentration
depends on chemistry this system does not supply.

---

## 3. Implemented but not exercised end to end

Built, type-checked and reachable, but without the data or credentials to run
them through:

| Feature | Blocked on |
|---|---|
| Supabase storage driver | No Supabase project in this environment |
| Resend email delivery | No API key (degrades correctly to disabled — verified) |

The *refusal* paths for these are tested. The success paths are not, because
reaching them requires credentials that do not exist here.

Training, approval, rollback and dataset versioning were on this list until
the training worker was built. They have now been run end to end against live
services — see [the learning loop](#the-learning-loop) below. What remains
genuinely blocked is not the mechanism but the **data**: see
[section 5](#5-requires-validated-laboratory-data).

---

## 4. Not verified in this environment

Stated plainly rather than implied.

- **Docker images have still not been built end to end.** Docker Hub and every
  mirror tried (`mirror.gcr.io`, `public.ecr.aws`, `ghcr.io`, `quay.io`) are
  blocked by this sandbox's egress allowlist, so the `node:22-bookworm-slim`
  and `python:3.12-slim-bookworm` base images cannot be pulled. **A user
  building on Windows hit two real bugs here that this gap had hidden** — see
  [section 6](#found-when-a-user-first-built-the-docker-images). What has now
  been verified, with a running daemon and real BuildKit:
  - the failing `COPY` reproduced byte-for-byte and the fix proven, using
    `FROM scratch` stages that need no registry;
  - `.dockerignore` matching, via `docker build --output type=local` against
    the real repository — the build context now contains `.env.example` and no
    real `.env`, and no `node_modules`;
  - `docker compose --profile tools config` valid, with the AI service
    correctly publishing no ports;
  - every Dockerfile step replayed on the host filesystem (`npm ci` →
    `mkdir` → `nest build` → `npm prune`), and the resulting tree booted as
    the runtime image would hold it: prod-only root `node_modules`, an empty
    `apps/api/node_modules`, `/health` and `/health/ready` both ok, `sharp`
    resolving and decoding, and both Compose one-shot commands
    (`migrate.js status`, `seed.js`) running from it.

  That is considerably stronger than before, and still not the same thing as
  building the images. Treat the first `docker compose up --build` on a real
  machine as the test that matters.
- **`render.yaml` has not been deployed.** It is written against Render's
  blueprint schema but has not been applied to a real account.
- **No load or concurrency testing.** The semaphores and pool limits are
  reasoned about, not measured.
- **ESLint 8 is end-of-life.** It is a dev dependency only and works
  correctly; upgrading to 9 requires migrating to flat config, which is a
  deliberate change rather than a bundled one.

---

## 5. Requires validated laboratory data

Cannot be completed by software. A laboratory must supply:

1. The analytical method — reagent, preparation, dilution, reaction timing
2. Prepared standards of known concentration, measured under controlled
   conditions
3. Established limit of detection, limit of quantitation and measurement
   uncertainty
4. Confirmed measurements from a validated method, as training ground truth
5. Controlled imaging conditions, or a colour reference in frame

See `prototype-limitations.md`.

---

## 6. Bugs found and fixed during the build

Recorded because the fixes matter and the cause is instructive.

**EXIF was not being stripped.** `sharp.withMetadata({ exif: {} })` was used
intending to clear metadata. That call *preserves* it — GPS coordinates and
device serials were being retained in the derivative. sharp strips metadata by
default; the fix was to remove the call. Now covered by a unit test asserting
the derivative has no EXIF, plus an end-to-end check.

**The ROI detector was blind to colourless solutions.** Detection keyed on
colour saturation, so a 0 ppm blank — a legitimate and important measurement —
fell through to a central crop. Added a background-contrast strategy that
finds the tube by lightness. All six ladder colours now detect automatically.

**Three CIEDE2000 test expectations were wrong.** Hand-transcribed from the
Sharma paper. Cross-checking against scikit-image showed the *implementation*
was correct and the transcription was not. Expected values are now generated
by a script rather than copied by hand.

**Health probes were unreachable.** Excluded from the global prefix but still
behind URI versioning, so they sat at `/v1/health`. Marked `VERSION_NEUTRAL`.

**DTO class ordering crashed at require time.** `AnalyzeSampleDto` referenced
`RegionOfInterestDto` declared below it; `emitDecoratorMetadata` evaluates at
decoration time. Compiled cleanly, threw on boot. Reordered with a comment
explaining why.

### Found by the follow-up deep scan

**`training_jobs` had no Row Level Security.** It carries a `laboratory_id`
like every other laboratory-scoped table, but was the one table where RLS was
never enabled. The API filters correctly so it was not reachable through HTTP,
but it left the database-layer backstop missing on exactly one table. Fixed in
migration `0007`.

**Three foreign keys with CASCADE/RESTRICT deletes had no index.** Postgres
does not index the referencing side of a foreign key, so deleting a sample
sequentially scanned `annotations` and `dataset_examples`, and deleting a test
method scanned `analysis_results`. Migration `0007` adds those plus the FK
columns on real query paths — and deliberately leaves attribution columns
(`created_by`, `reviewed_by`, …) unindexed, since indexing all 41 would slow
every write to speed up queries nobody runs.

**A latent `None` arithmetic bug in `interpolate_concentration`.** mypy caught
`lower.concentration_value + …` on a `float | None`. Safe at runtime because of
an earlier filter, but invisible to the type checker and a real TypeError the
moment that filter changed. Now bound to local non-optional values first.

**`npm run openapi:export` referenced a script that did not exist.** The
package.json entry pointed at `src/swagger/export-openapi.ts`, which was never
written. Implemented; it builds the document from the real application without
binding a port (35 paths, 41 schemas).

**A dead `numpy` import and two imports buried inside a hot function.**
`pipeline.py` imported cv2 and `measure_sharpness` inside `run()`, re-running
module lookup on every analysis and hiding the dependency. Hoisted.

**`verify-all.sh` reported success while checks were failing.** Each check ran
inside a `( cd … && run … )` subshell, so its PASS/FAIL increments were lost
when that process exited. Verified by deliberately breaking the build: the
script now reports `failed: 4` and exits non-zero where it previously printed
"All checks passed".

### Found when a user first built the Docker images

These are the bugs the unbuilt-image gap was hiding. Both were reported from a
real `docker compose up --build` on Windows.

**The API image could not build at all.** npm workspaces *hoist* dependencies
to the root `node_modules`; a workspace only gets a nested `node_modules` when
a version conflict makes hoisting impossible, which never happens for this
tree. So `apps/api/node_modules` does not exist, and the Dockerfile's
`COPY --from=deps /app/apps/api/node_modules` failed the build outright:

```
failed to compute cache key: failed to calculate checksum of ref …:
  "/app/apps/api/node_modules": not found
```

Fixed with `mkdir -p apps/api/node_modules` in the `deps` and `build` stages.
Creating it empty rather than deleting the `COPY` is deliberate: if a future
dependency conflict *does* make npm nest something, the COPY still carries it
forward, whereas deleting the line would silently omit it and fail at runtime.
Reproduced and verified with real BuildKit — see section 4.

**Development secrets were entering the image build context.** `.dockerignore`
listed `node_modules` *and* `**/node_modules`, but only a bare `.env`. Docker
matches a bare pattern against the context root, so `/.env` was excluded while
`apps/api/.env` — which is where the development JWT secrets, database password
and AI internal key actually live — was copied into the `build` stage by
`COPY apps/api ./apps/api`. It did not reach the runtime image, which copies
only `dist`, `package.json` and `node_modules`, so the published image was
clean; but the secrets sat in a cached intermediate layer and would be exposed
by `--target build` or by anyone inspecting the build cache. Added `**/.env`
and `**/.env.*`, with the negations doubled so `.env.example` survives.
Verified by exporting the real build context with
`docker build --output type=local`.

**A third bug found while reviewing the same path:** the production safety
guard tested `!DATABASE_URL.includes('localhost')`, so a loopback address by
IP — `127.0.0.1` or `[::1]` — was treated as a remote database and the service
refused to start without `DATABASE_SSL=true`, pushing an operator into
enabling TLS against a server not listening for it. The substring test also
would have accepted `localhost.attacker.test` as local. Now parsed with `new
URL()` and compared against an explicit loopback list; five tests cover it.

### Found when "Try it out" failed on every endpoint in the Swagger UI

Two bugs, both of which made the documentation page useless while every
existing check on it passed.

**The app's own Content-Security-Policy blocked every request the docs page
made.** The CSP set `default-src 'none'` and never set `connect-src`. Any
directive a CSP omits falls back to `default-src`, so `connect-src` was
effectively `'none'` and the browser refused every fetch the page issued —
*including same-origin ones, where CORS is not involved at all*. Swagger UI
reports this as a bare `Failed to fetch` listing CORS and network failure as
the likely causes, neither of which is true, which makes it genuinely hard to
diagnose. Helmet's own defaults do not include `connect-src`, so it had to be
explicit. Now `connect-src 'self'`: the docs UI can call this API and nothing
else, so an injected script still cannot exfiltrate to another origin.

**The spec advertised the health endpoints under the wrong path.** The
document-level server is `/api/v1`, and Swagger joins that to each path — but
the health probes are deliberately `VERSION_NEUTRAL` and excluded from the
global prefix, because a load balancer should not need to know the API's
version to check liveness. So the UI called `/api/v1/health`, which 404s,
for an endpoint that works perfectly at `/health`. The health path items now
carry an OpenAPI per-path `servers` override of `/`.

**Why the existing tests missed both.** The smoke test asserted that
`/api/docs` returned 200, that the spec was served, and that it documented
enough routes. A page that renders perfectly and whose every request is
blocked by its own CSP passes all three. Verified the fix by driving the real
Swagger UI in headless Chromium — opening the health operation, clicking
*Try it out* and *Execute* — and confirming it requests `/health`, gets 200
with a real body, and logs no CSP violations. Reinstating the old CSP makes
that same check fail with `Refused to connect … "default-src 'none'"`, which
is exactly the user-visible symptom.

The smoke test now asserts both properties without needing a browser: that
the docs response carries `connect-src 'self'`, and that the spec points
`/health` at the server root. 57 checks became 59.

### Found when the AI image build timed out on a slow connection

The API image built successfully, confirming the earlier `COPY` fix. The AI
image failed:

```
ReadTimeoutError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443):
  Read timed out.
```

Not a code defect — the connection was genuinely slow (apt measured 200 kB/s
in the same build) — but the Dockerfile had no tolerance for it, in three
ways, all now fixed:

- **`pip install --upgrade pip` was the step that actually failed.** The base
  image already ships a recent pip, so it downloaded ~1.8 MB to gain nothing,
  and being the first network operation it was the first thing to time out.
  Removed.
- **pip's defaults are tuned for a datacentre** — 5 retries, 15-second socket
  timeout. Raised to `--retries 10 --timeout 120`.
- **A failed build threw away every wheel it had downloaded.** BuildKit caches
  only *completed* layers, so a timeout partway through ~130 MB of OpenCV,
  NumPy, SciPy and scikit-learn wheels meant the next attempt restarted from
  zero — on exactly the connection that could not finish it once. Now uses a
  BuildKit cache mount for pip's download cache (and therefore no
  `--no-cache-dir`), so each retry resumes. The cache lives outside the image,
  so final size is unaffected. No `# syntax=` directive was added: Docker's
  built-in frontend has supported cache mounts for years, and the directive
  would make the build pull a frontend image first — another download on the
  connection that is already the problem. Verified with `docker build --check`
  that the mount lints clean without it, and that a deliberately invalid mount
  type is still caught.

Test dependencies were also split out of the runtime image:
`requirements.txt` is now runtime-only and `requirements-dev.txt` adds pytest,
pytest-asyncio, httpx, ruff and mypy. A server image has no business shipping
a test runner. Pinning ruff and mypy there also makes `verify-all.sh`
reproducible rather than dependent on whatever happens to be installed.
Verified from a fresh virtualenv: the runtime set alone imports every
application module and has no pytest, and the dev set runs all 139 tests plus
ruff and mypy clean.

### Found when a user could not get past the database port

The compose stack published Postgres on `0.0.0.0:5432`, which is where a
locally installed Postgres already listens on most developer machines. The
collision stops the whole stack with an error that names no remedy:

```
Bind for 0.0.0.0:5432 failed: port is already allocated
```

Telling the user to set `POSTGRES_PORT` was not enough, because of a second
problem: **docker-compose reads only the `.env` beside `docker-compose.yml`**,
and this project also has `apps/api/.env`. Setting `POSTGRES_PORT` in the
per-app file has no effect on compose, and the symptom is the same port error
with a `.env` that looks correct. Confirmed by resolving the config with
`apps/api/.env` set to 5433: compose still reported `published: "5432"`.

Reproduced the whole thing locally with real Docker — a static `FROM scratch`
image standing in for the Postgres container, with TCP 5432 genuinely
occupied — and established that:

- the failure reproduces exactly as reported;
- setting `POSTGRES_PORT` in the **root** `.env` and re-running does fix it,
  and compose recreates the container with the new mapping, so `down` is not
  strictly required (an earlier guess that a stale container would keep the
  old binding was wrong and was discarded rather than shipped);
- the default now resolves to `127.0.0.1:5433 -> 5432` and the stack comes up
  with no `.env` at all while 5432 stays occupied.

The default is now `127.0.0.1:${POSTGRES_PORT:-5433}:5432`. Two changes in
one line: 5433 avoids the common collision out of the box, and binding to
loopback stops a development database with a known default password being
reachable from the rest of the network. Documented in README and
`.env.example`, including the root-`.env`-only rule.

### Found by reviewing a user's filled-in `.env`

**The two .env parsers disagreed, so the API and the CLIs could read different
databases from the same file.** The Nest application loads env through
`@nestjs/config`, which uses `dotenv`; `migrate` and `seed` run outside the
Nest context and used a hand-rolled loader. They diverged in two ways:

- *Inline comments were not stripped.* `JWT_ACCESS_TTL=900  # seconds` parsed
  as the literal string `900  # seconds` for the CLIs and as `900` for the
  API. Since nearly every line of `.env.example` carries an inline comment,
  this affected most values — and `.env.example` is the file users are told
  to copy, so the bug shipped in the template.
- *Duplicate keys resolved oppositely.* The hand-rolled loader kept the
  **first** assignment; dotenv keeps the **last**. A `.env` defining
  `DATABASE_URL` twice therefore pointed `migrate`/`seed` at one database and
  the API at another, with no error from either. Observed on a real file:
  the CLIs resolved `localhost`, the API resolved a hosted Supabase host —
  so a migration would have been applied to the wrong server silently.

The loader now mirrors dotenv's semantics exactly (unquoted values end at the
first `#`; matched quotes protect a `#`; an unterminated quote is literal;
last assignment wins) and warns loudly when a file assigns a key twice.
`apps/api/test/env-loading.spec.ts` asserts parity against dotenv's own output
across 24 cases rather than against hardcoded expectations, so the two cannot
drift apart again.

`.env.example` was also restructured: the Option A / Option B database block
invited exactly this duplicate, and now states that `DATABASE_URL` must be
defined once, documents percent-encoding for special characters in a password
(`@` → `%40`, `$` → `%24`), and notes that docker-compose ignores
`DATABASE_URL` altogether and builds its own from `POSTGRES_*`.

### Found while building and running the learning loop

**`mypy` was only clean because of `--ignore-missing-imports`.** The flag was
passed on the command line in `verify-all.sh`, which silences a *genuinely*
missing import as readily as an untyped third-party one — a typo in a module
name, or a dependency absent from `requirements.txt`, would have type-checked
clean. Replaced with a committed `services/ai/mypy.ini` naming each untyped
scientific library individually, plus `warn_unused_ignores` and
`enable_error_code = ignore-without-code`. That immediately found three
`# type: ignore` comments in `pipeline.py` that were no longer doing anything;
removed.

**Rollback told the operator the wrong thing.** `POST /ai/models/{id}/rollback`
returned only the model that was *now* active, so a caller who withdrew model
X received model Y with `isActive: true` — readable as "X is still live". Worse,
`analysisServiceConfirmed` was recorded in the audit log but absent from the
response, so the one person who needed to know the analysis service might still
be running the withdrawn model had no way to find out. The response now carries
`withdrawn`, `nowActive`, `analysisServiceConfirmed` and a `warning`.

**`e2e-smoke.sh` misreported a tripped rate limiter as 14 unrelated failures.**
Running it twice in quick succession exhausts the login throttle; every later
check then fails for want of a token, and the output points at analysis,
feedback and isolation rather than at the throttle. It now detects
`RATE_LIMITED` on the first login and exits with an explanation. The limiter
was behaving correctly — the script was not.

**Three wrong column names in the demo seeder, caught by running it.** It
assumed `laboratory_measurements.method`, `measured_concentration` and
`status`; the schema has `measurement_method`, `concentration_value` and
`confirmation_status`. Also `samples.description` (it is `notes`),
`sample_images.checksum_sha256` (it is `content_hash`), `user_role 'REVIEWER'`
(it is `LAB_REVIEWER`) and `test_methods.version` (it is `method_version`).
None would have been caught by type-checking; all surfaced on first execution.

---

## 7. Deliberate engineering decisions

| Decision | Reason | Where |
|---|---|---|
| NestJS 11 (CommonJS), not 12 (ESM) | 12 is ESM-only; migration cost and test-tooling risk outweighed the benefit, and overrides reach 0 vulnerabilities anyway | `adr/0001` |
| CIEDE2000, not CIE76 | CIE76 overstates saturated-blue differences by ~32% in this ladder's range | `ai-methodology.md` |
| Colour maths duplicated TS/Python | Neither service can round-trip to the other for one colour; both asserted against identical vectors | `architecture.md` |
| Median, not mean | Robust to the specular highlights glass tubes guarantee | `ai-methodology.md` |
| Quality assessed after extraction | Region uniformity is the best signal and is unknown until measured | `ai-methodology.md` |
| Timeouts not retried | The service is probably still working; retrying worsens overload | `ai-client.service.ts` |
| 404 for cross-laboratory access | A 403 confirms the record exists | `security.md` |
| Migrations not run on boot | An app that migrates on start races itself across replicas | `docker-compose.yml` |
| Both backend services on Render | OpenCV exceeds Vercel's bundle limit; splitting would add a public hop between private services | `deployment.md` |
| Worker polls Postgres, no broker | `FOR UPDATE SKIP LOCKED` is multi-instance-safe at this scale, with no Redis and no extra failure mode | `training-worker.service.ts` |
| Training is never retried | A failure is usually a data problem; retrying hides it behind repeated expensive runs | `training-worker.service.ts` |
| A refused dataset is `SUCCEEDED`, not `FAILED` | "Not enough data yet" is the expected state for a long time; recording it as failure would make the queue look broken | `training-worker.service.ts` |
| Models must beat the reference matcher by ≥ 0.02 macro F1 | Replacing a transparent calculation with an opaque model has to buy something | `evaluation/evaluator.py` |
| Approval and validation are separate flags | Approving a model to run is not certifying it scientifically; only `validated` unlocks a concentration | `registry/artifacts.py` |
| Training weights labels by source | A technician's annotation (0.4) is not an instrument reading (1.0) | `datasets/schemas.py` |
| Splits are grouped by sample | Two images of one tube in different splits would leak and inflate every metric | `datasets/builder.py` |

---

## 8. Known gaps

- No MFA
- No password-reset flow (abstraction and template exist; token issuance does not)
- Rate limiting is per-instance (in-memory); multiple instances multiply the limit
- No dependency scanning in CI
- Training job execution is queued but there is no worker consuming the queue
- No frontend

---

## 9. Next steps

1. **Frontend** — React dashboard, camera capture, analysis workspace,
   reference management, model administration
2. **Training worker** — consume `training_jobs`, build dataset versions, train,
   evaluate
3. **Password reset** — issue and verify tokens over the existing email
   abstraction
4. **CI** — run all three suites plus `npm audit` on every push
5. **Deploy** — apply `render.yaml`, create the Supabase bucket, build the
   images for real
