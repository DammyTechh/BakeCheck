# Deploying BakeCheck

Backend → **Render** (Node API + Python vision service + Postgres).
Frontend → **Vercel** (React).

Do them in that order: the frontend needs the API's URL, and the API needs the
frontend's origin for CORS. You will come back and fill in one value on each
side at the end.

---

## 0. Push to GitHub

Both platforms deploy from a repository.

```bash
git init                     # if this is not already a repo
git add -A
git commit -m "BakeCheck"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env`. Check nothing secret is staged:

```bash
git ls-files | findstr /i ".env"      # should list only .env.example
```

---

## 1. Storage: a Supabase bucket

Render's filesystem is wiped on every deploy, so uploaded photographs must go
to object storage. You already have a Supabase project.

1. Supabase → **Storage** → **New bucket**
   - Name: `sample-images`
   - **Private** (not public). The API issues short-lived signed URLs.
2. Supabase → **Settings → API**, copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

The service-role key bypasses every access rule in the project. It belongs
only in Render's environment, never in the frontend, never in the repository.

---

## 2. Backend on Render

Render → **New** → **Blueprint** → pick your repository. It reads
`render.yaml` and creates four things: the Postgres database, the private AI
service, the public API, and a migration job.

It will prompt for the values marked `sync: false`:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
| `CORS_ORIGINS` | leave blank for now — step 4 |
| `APP_BASE_URL` | leave blank for now — step 4 |
| `REFRESH_COOKIE_DOMAIN` | leave blank |
| `RESEND_API_KEY`, `EMAIL_FROM` | leave blank (email stays disabled) |

Everything else — JWT secrets, the internal key shared between the API and the
AI service, the database URL — Render generates and wires up on its own.

**The first build takes a while.** The AI image installs OpenCV, NumPy, SciPy
and scikit-learn.

### Then run the migrations

The schema is not created automatically — an app that migrates on boot races
itself the moment it has more than one instance.

Render → **breadguard-migrate** → **Trigger run**. It should finish with
`7 total, 0 pending`.

### Create the first accounts

The migration job only builds the schema. To get demonstration accounts and
the reference chart, open **breadguard-api → Shell** and run:

```bash
node dist/database/cli/seed.js
```

It prints three passwords **once**. Write them down.

### Check it

```
https://breadguard-api.onrender.com/health/ready
```

Expect `"database": true` and `"aiService": true`. Copy this API URL.

> On Render's free and starter plans the API sleeps when idle and takes
> ~50 seconds to wake. Before your showcase, load the health URL once and let
> it warm up.

---

## 3. Frontend on Vercel

Vercel → **Add New** → **Project** → pick the same repository.

| Setting | Value |
|---|---|
| **Root Directory** | `apps/web` ← this one matters most |
| Framework Preset | Vite (detected) |
| Build / Output / Install | leave as detected — `vercel.json` sets them |

Add one environment variable:

| Name | Value |
|---|---|
| `VITE_API_URL` | your Render API URL, e.g. `https://breadguard-api.onrender.com` |

No trailing slash. The app appends `/api/v1` itself.

`VITE_` variables are baked in at build time, so **changing this later needs a
redeploy**, not just a restart.

Deploy, then copy the resulting URL, e.g. `https://bakecheck.vercel.app`.

---

## 4. Close the loop: tell the API about the frontend

The browser will not send credentials to an API that has not named its origin.

Render → **breadguard-api** → **Environment**:

| Variable | Value |
|---|---|
| `CORS_ORIGINS` | `https://bakecheck.vercel.app` |
| `APP_BASE_URL` | `https://bakecheck.vercel.app` |

Exact origin, `https://`, no trailing slash, no wildcard — the API refuses
wildcards in production, because a wildcard combined with credentials is
unsafe. Save; Render redeploys.

---

## 5. Verify

1. Open the Vercel URL. The sign-in page loads.
2. Sign in with a seeded account.
3. **Analyse a sample** → upload a tube photograph.
4. The result shows a colour band and a ΔE, with concentration and confidence
   blank — that is correct, see below.

If sign-in fails, open the browser console:

| What you see | What it means |
|---|---|
| CORS error | `CORS_ORIGINS` does not exactly match the Vercel URL |
| 404 on `/api/v1/...` | `VITE_API_URL` is wrong, or has a trailing slash |
| Request hangs ~50 s then works | Render instance waking from sleep |
| 401 straight after signing in | `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` are required for a cross-site frontend; both are already set in `render.yaml` |

---

## What the demonstration will and will not show

Worth being straight about this before you present it, because someone will
ask.

**It will show** a photograph measured for colour, matched to the nearest band
on the reference chart, with the perceptual distance (ΔE) to that band and to
the next nearest — plus an image-quality verdict and the reasons behind it.
That part is real and the arithmetic is tested.

**It will not show a bromate concentration in ppm**, and `confidence` stays
blank. Not a missing feature — the system refuses to state either until two
things exist:

- a reference chart measured from **prepared standards of known
  concentration**, replacing the current one, which was sampled from an
  illustration and is marked `ILLUSTRATIVE`;
- a test method validated by the laboratory, replacing the seeded one, which
  is marked `DRAFT`.

Until then every result is labelled a screening observation. The interface
says so on the analysis screen, and the API will not emit a number it cannot
support. `docs/prototype-limitations.md` has the full list.

---

## Local reference

```bash
docker compose up -d --build
docker compose run --rm migrate
docker compose run --rm seed
```

Postgres publishes on `127.0.0.1:5433`. If something already holds port 3000,
set `API_PORT` before starting:

```powershell
$env:API_PORT = "3100"
```

Running the frontend against a local API:

```bash
cd apps/web
npm install
npm run dev          # http://localhost:5173
```

Use `http://localhost:5173`, not `http://127.0.0.1:5173` — they are different
origins to a browser, and only the first is in the CORS allowlist.
