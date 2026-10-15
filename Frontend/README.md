# BakeCheck — web

React interface for the BakeCheck bromate screening platform. Talks to the
BakeCheck API, which lives in its own repository and deploys separately.

- **Frontend (this repo)** → Vercel
- **Backend (API + vision service + Postgres)** → Render

Deploy the backend first: this app needs its URL, and the API needs this
app's origin for CORS. You will set one value on each side.

---

## Run it locally

```bash
npm install
cp .env.example .env.local        # point VITE_API_URL at your API
npm run dev                       # http://localhost:5173
```

Use `http://localhost:5173`, not `http://127.0.0.1:5173`. A browser treats
those as different origins and only the first is in the API's CORS allowlist.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Type-check, then build to `dist/` |
| `npm run verify` | Type-check, lint and test — run before pushing |

---

## Deploy to Vercel

Vercel → **Add New** → **Project** → pick this repository.

| Setting | Value |
|---|---|
| Root Directory | `.` — this repository *is* the app |
| Framework Preset | Vite (detected) |
| Build / Output / Install | leave as detected; `vercel.json` sets them |

Add one environment variable:

| Name | Value |
|---|---|
| `VITE_API_URL` | your API URL, e.g. `https://breadguard-api.onrender.com` |

No trailing slash — the app appends `/api/v1` itself.

`VITE_` variables are compiled into the bundle at build time, so changing this
later needs a **redeploy**, not a restart.

Deploy, copy the resulting URL, then go to the backend repository and set
`CORS_ORIGINS` and `APP_BASE_URL` to that exact origin. Without that the
browser will not send credentials and sign-in fails.

---

## If something does not work

| What you see | What it means |
|---|---|
| CORS error in the console | `CORS_ORIGINS` on the API does not exactly match this app's URL |
| 404 on `/api/v1/...` | `VITE_API_URL` is wrong, or has a trailing slash |
| First request hangs ~50 s | A Render free/starter instance waking from sleep |
| 401 immediately after signing in | The API needs `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` for a cross-site frontend |

---

## How this is built

React 19, Vite, TypeScript. React Query for server state, React Router for
routing. No UI framework: the primitives in `src/components/ui.tsx` are the
whole component library, and anything used once lives with its screen.

**Design.** Archivo for text, IBM Plex Mono for codes and numbers only. A
fixed 4 / 8 / 12 / 16 / 24 / 32 spacing scale — nothing in between. Brand navy
and teal sampled from the logo, plus neutrals; the three status colours exist
only to carry meaning about a result, and each is always paired with a word
rather than standing alone.

**Icons are drawn, not loaded.** `src/components/icon-paths.ts` holds 37 icons
on one 24×24 grid at one stroke weight. An icon font renders its ligature as
literal text until it arrives, so on a slow connection buttons read
"photo_camera" — which is what happened here the first time. Inline SVG cannot
half-load.

**What the interface will not claim.** In screening mode the API returns
`null` for both concentration and confidence, so the result screen shows the
nearest colour band, its CIEDE2000 distance, the next nearest band and an
image-quality verdict — and says what would be required to turn that into a
concentration. `src/lib/claims.ts` holds that logic and is the most-tested
file here; it decides what may be displayed, from what the API actually
asserted.
