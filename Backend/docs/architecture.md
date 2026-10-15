# Architecture

## Service boundaries

Three processes, with responsibilities that do not overlap.

```
React (Vercel)  ──HTTPS/JWT──▶  Node API (public)  ──internal key──▶  Python AI (private)
                                       │
                                       ├──▶ PostgreSQL
                                       ├──▶ Object storage (private)
                                       └──▶ Resend (optional)
```

| Service | Owns | Does not |
|---|---|---|
| **Node API** | Auth, authorisation, laboratories, samples, image intake, business rules, auditing, orchestration | Process images |
| **Python AI** | Decoding, region detection, colour measurement, matching, inference | Know about users, laboratories or HTTP sessions |
| **Frontend** | Presentation, camera capture, region selection | Touch the database or the AI service |

The Python service holds no authorisation logic at all. It receives reference
levels as *data* in the request and returns a measurement. Everything about
who may see what is decided before it is called. That keeps the security model
in one place.

## Request flow: analysing a sample

```
POST /api/v1/samples/{id}/analyze
  │
  ├─ CorrelationIdMiddleware   assign/echo x-correlation-id
  ├─ ThrottlerGuard            reject floods before any work
  ├─ JwtAuthGuard              verify token, re-read user, load memberships
  ├─ LaboratoryScopeGuard      resolve laboratory, verify membership,
  │                            record the caller's role *in that laboratory*
  ├─ PermissionsGuard          check analysis:run against that role
  ├─ ValidationPipe            whitelist + reject unknown properties
  │
  └─ AnalysesService
       ├─ load sample, method, chart, levels
       ├─ INSERT analysis_results (status PROCESSING)   ← before the call
       ├─ fetch the normalised image derivative
       ├─ AiClientService.analyzeImage()                 ← timeout, retries, semaphore
       ├─ build limitations from real validation state
       ├─ UPDATE analysis_results + INSERT measured_color_features  (one transaction)
       └─ audit log
```

The pending row is written **before** the AI call so that a crash or timeout
leaves a visible `FAILED` record rather than silence.

## Guard order is load-bearing

`LaboratoryScopeGuard` runs **before** `PermissionsGuard`. It resolves which
laboratory a route targets and records the caller's role *there*.

A user may be `LAB_ADMIN` in one laboratory and `LAB_TECHNICIAN` in another.
Checking capabilities against the platform role would grant admin powers
everywhere. Reversing these two guards would be a privilege-escalation bug
that no type checker would catch.

## Two layers of isolation

1. **Application** — guards and explicit `laboratory_id` filters in every
   query.
2. **Database** — RLS policies (migration 0006), evaluated from session
   variables set per transaction with `SET LOCAL`.

Both must agree. The application layer is the primary control; RLS is the
backstop for a query that forgets its filter.

Unauthorised access returns **404, not 403**, everywhere. A 403 would confirm
that a record with that id exists in some other laboratory.

## Inter-service communication

- **Timeouts** — 30 s default. A timeout is **not** retried: the service is
  probably still working on the first request, and piling on makes an
  overloaded service worse.
- **Retries** — only for connection failures and 5xx, with exponential
  backoff and jitter. A 4xx is never retried; it will fail identically.
- **Concurrency** — a semaphore in the API caps in-flight analyses, matching a
  semaphore in the Python service. Both are needed: one bounds what is sent,
  the other bounds what is accepted.
- **Correlation IDs** — propagated end to end and written to `audit_logs`, so
  one user-visible failure can be traced across both services.

## Data model: the central distinction

Three tables record what look like similar things and are kept deliberately
apart:

| Table | What it holds | Strength |
|---|---|---|
| `analysis_results` | An image-derived estimate | Weakest. Never a measurement. |
| `annotations` | A technician's reading of a result | Informed opinion. |
| `laboratory_measurements` | An instrument result with method, uncertainty, provenance | The only confirmed concentration. |

Collapsing these would let a confident guess become ground truth — which is
how a model learns to reproduce human error at scale. `dataset_examples`
carries `label_source` so training can weight and filter on which kind of
evidence a label came from.

## Why the colour maths is duplicated

CIEDE2000 and the sRGB↔CIELAB conversions exist in **both** TypeScript and
Python. That is deliberate, not an oversight:

- the API must convert a manually entered RGB value without a round trip to
  the vision service;
- the vision service must convert measured pixels without a round trip to the
  API.

Both are asserted against the **same** test vectors, so they are proven to
agree rather than assumed to. See `infrastructure/scripts/generate_ciede2000_vectors.py`.

## Storage layout

```
laboratories/<labId>/samples/<sampleId>/<imageId>/original.<ext>
laboratories/<labId>/samples/<sampleId>/<imageId>/normalised.png
```

The **original** is kept byte-for-byte as the evidentiary record. The
**normalised derivative** — EXIF rotation applied, metadata stripped,
re-encoded losslessly as PNG — is what the vision service measures, so
measurements always refer to a known-clean image whose pixel coordinates match
the stored dimensions.
