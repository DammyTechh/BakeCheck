# Security

## Threat model

Who this is defended against, and what matters most.

| Threat | Control |
|---|---|
| Credential stuffing | Argon2id, lockout after 8 failures, auth rate limiting |
| Account enumeration | Identical response and comparable timing for unknown email vs wrong password |
| Token theft (XSS) | Refresh token in an HttpOnly cookie; JS cannot read it |
| Token replay | Rotation on every refresh; reuse revokes the whole session family |
| Cross-laboratory access | Guards + RLS; unauthorised reads return 404, not 403 |
| Privilege escalation | Role never accepted from a request body; per-laboratory role evaluation |
| Malicious uploads | Signature sniffing, bounded decode, re-encode, SVG rejected |
| Decompression bombs | Header pixel-count check before decode, plus a decode-time cap |
| SQL injection | Parameterised queries throughout; ORDER BY from a whitelist |
| Data exfiltration via logs | Field redaction in logs and in audit metadata |
| Internal service exposure | Private network + shared key, compared in constant time |

---

## Authentication

**Argon2id**, 19 MiB / t=2 / p=1, per the OWASP Password Storage Cheat Sheet.
Memory cost is what makes GPU cracking expensive; lowering it to save RAM
defeats the point of choosing Argon2. Parameters are encoded in each hash, so
raising them later does not invalidate existing hashes —
`argon2.needsRehash` migrates users forward on successful login.

**Access tokens** are short-lived JWTs (15 min). The user row is re-read on
every request rather than trusted from the token: that costs one indexed query
but means a suspended account stops working immediately rather than lingering
until expiry.

**Refresh tokens** are 256 bits of CSPRNG output. Only a SHA-256 hash is
stored, so a database disclosure does not hand out usable sessions. SHA-256
rather than Argon2 is correct here — there is no low-entropy guess to slow
down, and this runs on every refresh.

**Rotation and reuse detection.** Every refresh revokes the presented token
and issues a successor, linked by `family_id`. Presenting an already-rotated
token means it leaked, so the entire family is revoked. This signs out the
legitimate user too; that is the intended trade-off.

**Password change** increments `token_version`, which invalidates every
outstanding access token, and revokes all refresh tokens. A password change
should end every session, including any the attacker holds.

---

## Authorisation

Two layers that must agree.

### Application

- Authentication is **global**; a route is protected unless it opts out with
  `@Public()`. Forgetting a decorator leaves a route locked, not open.
- `LaboratoryScopeGuard` runs before `PermissionsGuard` and records the
  caller's role *in the target laboratory*. Reversing them would evaluate a
  technician's capabilities using their role somewhere else.
- Capabilities are named for what they permit, in one table
  (`common/types/roles.ts`). Adding a role means editing one file.

### Database

RLS policies scope every row to the caller's laboratory, evaluated from
session variables set per transaction:

```sql
SELECT set_config('app.current_user_id', $1, true);   -- true = transaction-local
```

Bound parameters, so an identity string cannot be injected into the `SET`.
Transaction-local, so a pooled connection cannot carry one user's identity
into the next request.

### Deliberate separations of authority

- A technician may **record** a measurement but not mark it `CONFIRMED`.
- A reviewer may **not approve their own annotation** — checked on user id,
  not role, so even an administrator cannot wave through their own work.
- Marking reference data `VALIDATED` needs `reference:validate` and records
  who did it.
- The last administrator of a laboratory cannot be demoted or revoked.

---

## Upload handling

The main untrusted-input boundary. Checks run cheapest-first:

1. **Size** — before touching content.
2. **Signature** — magic bytes decide the format. The declared `Content-Type`
   and the filename are advisory at best and hostile at worst.
3. **Header dimensions** — a pixel-count check *before* decoding, because a
   small PNG can expand to gigabytes.
4. **Full decode** under a pixel cap, with `failOn: 'warning'` — a file that
   needs repair is not one to measure colour from.
5. **Re-encode** — produces a derivative with no EXIF, no colour-profile
   surprises and no trailing appended data.

**SVG is rejected outright.** It is a document format that can carry script
and fetch remote resources, and it has no place in a colour-measurement
pipeline.

> **A bug worth recording.** An earlier build called
> `.withMetadata({ exif: {} })` intending to clear EXIF. That call *preserves*
> metadata — GPS coordinates and device serials were being retained in the
> derivative. sharp strips metadata by default; the fix was to remove the
> call. There is now a test asserting the derivative has no EXIF, and an
> end-to-end check so it cannot silently return.

---

## Secrets

- All configuration comes from environment variables, validated by a zod
  schema at startup.
- Production adds assertions that catch the classic deployment mistakes:
  placeholder secrets, identical access/refresh secrets, insecure cookies,
  wildcard CORS, plain-HTTP origins. These are **fatal** — the process refuses
  to start.
- The Supabase service-role key bypasses RLS and is backend-only. It must
  never carry a `VITE_` or `NEXT_PUBLIC_` prefix.

### Redaction

`REDACTED_PATHS` scrubs credentials, tokens, cookies, API keys and EXIF/GPS
blocks from every log line at serialisation time, so a sensitive value cannot
reach a log file even if someone logs a whole request object by accident.

`redactMetadata()` does the same for audit metadata before it is persisted,
since that is queried later.

---

## Inter-service

The Python service is deployed as a **private service** with no public route.
That is the primary control. On top of it, every request carries
`x-internal-key`, compared with `secrets.compare_digest` so the check does not
leak the key through response timing.

An unauthenticated caller gets a bare 401 and learns nothing about whether the
header was missing, malformed or wrong.

---

## Error handling

One envelope for every error. Stack traces, SQL text and driver details are
logged server-side and never serialised in production.

Postgres errors are translated:

| Code | Response |
|---|---|
| `23505` unique violation | 409 `ALREADY_EXISTS` |
| `23503` FK violation | 400 `VALIDATION_FAILED` |
| `23514` check violation | 400 `VALIDATION_FAILED` |
| `42501` insufficient privilege | **404 `NOT_FOUND`** |

The last is deliberate: an RLS refusal must not be distinguishable from a
missing record, or it becomes a probe for other laboratories' data.

---

## Mass assignment

`ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so a
property not declared on the DTO is rejected outright rather than ignored.
Service layers additionally build `SET` clauses from an explicit column map,
so a client cannot reach `laboratory_id`, `created_by` or `role` through an
update endpoint.

Verified end to end: posting `status: CONFIRMED` to sample creation returns
`VALIDATION_FAILED`.

---

## Auditing

`audit_logs` is append-only by convention — the application never issues
`UPDATE` or `DELETE`, and no RLS policy permits them. The actor's email is
denormalised so the trail survives account deletion.

Writes never throw into the caller: an audit failure must not roll back a
legitimate operation or turn a success into a 500. Failures are logged loudly
instead, so a broken trail is visible.

---

## Known gaps

Stated rather than hidden:

- **No MFA.** Worth adding before handling regulated data.
- **No password-reset flow.** The email abstraction and template exist; the
  token issuance and endpoint do not.
- **No CSRF token.** The refresh cookie is `SameSite` and scoped to
  `/api/v1/auth`, and the API is otherwise bearer-authenticated, so the
  classic CSRF shape does not apply. A cookie-authenticated API would need
  one.
- **Rate limiting is per-instance** (in-memory). Multiple API instances
  multiply the effective limit. Redis-backed storage would fix this.
- **No automated dependency scanning in CI.** `npm audit --omit=dev` is clean
  today and should be wired into the pipeline.
