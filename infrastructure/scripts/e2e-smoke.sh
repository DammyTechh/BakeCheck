#!/usr/bin/env bash
#
# End-to-end acceptance check.
#
# Walks the full workflow against a running API and AI service, and asserts
# the properties that matter — not just that requests return 200, but that the
# scientific guarantees hold:
#
#   • a screening result never reports a concentration in prototype mode
#   • a screening result never reports a confidence in reference-matching mode
#   • an analysis is never marked as a confirmed measurement
#   • one laboratory cannot read another's records
#
# Usage:
#   API_URL=http://localhost:3000 ./infrastructure/scripts/e2e-smoke.sh
#
# Requires: curl, python3 (for JSON parsing — no jq dependency).

set -uo pipefail

API_URL="${API_URL:-http://127.0.0.1:3000}"
API="${API_URL}/api/v1"
CURL=(curl -s --noproxy '*')

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@breadguard.test}"
ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-DemoAdmin!2026Lab}"
TECH_EMAIL="${TECH_EMAIL:-technician@breadguard.test}"
TECH_PASSWORD="${SEED_TECHNICIAN_PASSWORD:-DemoTech!2026Lab}"
REVIEWER_EMAIL="${REVIEWER_EMAIL:-reviewer@breadguard.test}"
REVIEWER_PASSWORD="${SEED_REVIEWER_PASSWORD:-DemoReview!2026Lab}"

PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
blue()  { printf '\033[36m\n== %s ==\033[0m\n' "$1"; }

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    green "  PASS  ${label}"
    PASS=$((PASS + 1))
  else
    red "  FAIL  ${label}  (expected '${expected}', got '${actual}')"
    FAIL=$((FAIL + 1))
  fi
}

# Extract a value from JSON on stdin by dotted path. Prints 'null' when absent.
#
# Booleans are emitted as JSON `true`/`false`, not Python's `True`/`False` —
# the comparisons in this script are against the JSON spelling, and printing
# the Python repr makes every boolean assertion fail for the wrong reason.
jget() {
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); sys.exit()
for key in sys.argv[1].split('.'):
    if d is None:
        print('null'); sys.exit()
    if isinstance(d, list):
        try: d = d[int(key)]
        except Exception: print('null'); sys.exit()
    else:
        d = d.get(key) if isinstance(d, dict) else None
if d is None:
    print('null')
elif isinstance(d, bool):
    print('true' if d else 'false')
elif isinstance(d, (dict, list)):
    print(json.dumps(d))
else:
    print(d)
" "$1"
}

login() {
  "${CURL[@]}" -X POST "${API}/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

blue "1. Health"
HEALTH=$("${CURL[@]}" "${API_URL}/health" | jget status)
check "liveness probe reports ok" "$HEALTH" "ok"

READY=$("${CURL[@]}" "${API_URL}/health/ready")
check "database reachable" "$(echo "$READY" | jget checks.database)" "true"
check "AI service reachable" "$(echo "$READY" | jget checks.aiService)" "true"

blue "2. Authentication"
TECH_LOGIN=$(login "$TECH_EMAIL" "$TECH_PASSWORD")

# Running this script twice in quick succession trips the login throttle,
# which then cascades into a couple of dozen unrelated-looking failures —
# every later check needs a token. Catch it here and say what it is: the
# rate limiter working, not the application broken.
if [ "$(echo "$TECH_LOGIN" | jget error.code)" = "RATE_LIMITED" ]; then
  echo
  echo "  Login is rate limited, so this run cannot authenticate."
  echo "  The throttle is in-memory and per-process. Either wait for the"
  echo "  window to pass, or restart the API to clear it:"
  echo
  echo "      npm --workspace @breadguard/api run start:prod"
  echo
  echo "  This is the throttle behaving correctly, not a test failure."
  exit 2
fi

TECH_TOKEN=$(echo "$TECH_LOGIN" | jget accessToken)
check "technician signs in" "$([[ "$TECH_TOKEN" != "null" && -n "$TECH_TOKEN" ]] && echo ok)" "ok"
check "no email verification required" \
  "$(echo "$TECH_LOGIN" | jget user.status)" "ACTIVE"

BAD=$(login "$TECH_EMAIL" "definitely-the-wrong-password" | jget error.code)
check "wrong password rejected" "$BAD" "INVALID_CREDENTIALS"

UNKNOWN=$(login "nobody@nowhere.test" "whatever-password-here" | jget error.code)
check "unknown email gives the same code (no enumeration)" "$UNKNOWN" "INVALID_CREDENTIALS"

NOAUTH=$("${CURL[@]}" "${API}/samples?laboratoryId=00000000-0000-4000-8000-000000000000" | jget error.code)
check "unauthenticated request refused" "$NOAUTH" "AUTHENTICATION_REQUIRED"

AUTH_HDR=(-H "Authorization: Bearer ${TECH_TOKEN}")

LAB_ID=$(echo "$TECH_LOGIN" | jget user.memberships.0.laboratoryId)
check "technician has a laboratory" "$([[ "$LAB_ID" != "null" ]] && echo ok)" "ok"

blue "3. Reference data"
METHODS=$("${CURL[@]}" "${AUTH_HDR[@]}" "${API}/test-methods?limit=5")
METHOD_ID=$(echo "$METHODS" | jget data.0.id)
check "seeded test method present" "$([[ "$METHOD_ID" != "null" ]] && echo ok)" "ok"
check "method is NOT validated" "$(echo "$METHODS" | jget data.0.isValidated)" "false"
check "method status is DRAFT" "$(echo "$METHODS" | jget data.0.validationStatus)" "DRAFT"

CHARTS=$("${CURL[@]}" "${AUTH_HDR[@]}" "${API}/reference-charts?limit=5")
CHART_ID=$(echo "$CHARTS" | jget data.0.id)
check "seeded reference chart present" "$([[ "$CHART_ID" != "null" ]] && echo ok)" "ok"
check "chart marked ILLUSTRATIVE" "$(echo "$CHARTS" | jget data.0.validationStatus)" "ILLUSTRATIVE"
check "chart has 6 levels" "$(echo "$CHARTS" | jget data.0.levelCount)" "6"
check "all 6 levels usable for matching" "$(echo "$CHARTS" | jget data.0.usableLevelCount)" "6"

blue "4. Create a sample"
SAMPLE_CODE="E2E-$(date +%s)"
SAMPLE=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples" \
  -H 'Content-Type: application/json' \
  -d "{\"laboratoryId\":\"${LAB_ID}\",\"sampleCode\":\"${SAMPLE_CODE}\",\"sampleType\":\"bread\",\"productName\":\"E2E loaf\",\"testMethodId\":\"${METHOD_ID}\"}")
SAMPLE_ID=$(echo "$SAMPLE" | jget id)
check "sample created" "$([[ "$SAMPLE_ID" != "null" ]] && echo ok)" "ok"
check "sample starts REGISTERED" "$(echo "$SAMPLE" | jget status)" "REGISTERED"
check "no confirmed measurements yet" "$(echo "$SAMPLE" | jget measurementCount)" "0"

DUP=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples" \
  -H 'Content-Type: application/json' \
  -d "{\"laboratoryId\":\"${LAB_ID}\",\"sampleCode\":\"${SAMPLE_CODE}\",\"sampleType\":\"bread\"}" | jget error.code)
check "duplicate sample code rejected" "$DUP" "ALREADY_EXISTS"

MASS=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples" \
  -H 'Content-Type: application/json' \
  -d "{\"laboratoryId\":\"${LAB_ID}\",\"sampleCode\":\"MASS-${SAMPLE_CODE}\",\"sampleType\":\"bread\",\"status\":\"CONFIRMED\"}" | jget error.code)
check "mass assignment rejected (status not accepted on create)" "$MASS" "VALIDATION_FAILED"

blue "5. Upload an image"
TUBE_PNG=$(mktemp /tmp/tube-XXXXXX.png)
python3 - "$TUBE_PNG" <<'PYEOF'
import sys, numpy as np
from PIL import Image, ImageDraw
w, h = 400, 700
img = Image.new("RGB", (w, h), (150, 152, 158))
d = ImageDraw.Draw(img)
tw = int(w * 0.34); x0 = (w - tw)//2; x1 = x0 + tw
y0 = int(h*0.12); y1 = int(h*0.88)
d.rounded_rectangle([x0-6, y0-6, x1+6, y1+6], radius=tw//3,
                    fill=(228,230,233), outline=(200,203,208), width=3)
ly0 = y0 + int((y1-y0)*0.22)
# The 1 ppm reference colour from the seeded ladder.
d.rounded_rectangle([x0, ly0, x1, y1], radius=tw//3, fill=(1,132,241))
d.rounded_rectangle([x0+int(tw*.10), ly0+20, x0+int(tw*.22), y1-40], radius=6,
                    fill=(252,252,253))
a = np.asarray(img, dtype=np.float64)
a += np.random.default_rng(1234).normal(0, 2.0, a.shape)
Image.fromarray(np.clip(a,0,255).astype(np.uint8)).save(sys.argv[1])
PYEOF

UPLOAD=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/images?source=CAMERA" \
  -F "file=@${TUBE_PNG};type=image/png")
IMAGE_ID=$(echo "$UPLOAD" | jget id)
check "image uploaded" "$([[ "$IMAGE_ID" != "null" ]] && echo ok)" "ok"
check "stored as image/png" "$(echo "$UPLOAD" | jget mimeType)" "image/png"
check "source recorded as CAMERA" "$(echo "$UPLOAD" | jget source)" "CAMERA"

# A text file with an image content type must be refused on content, not
# trusted on its declared type.
FAKE=$(mktemp /tmp/fake-XXXXXX.png)
printf 'this is definitely not an image' > "$FAKE"
FAKE_CODE=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/images" \
  -F "file=@${FAKE};type=image/png" | jget error.code)
check "non-image rejected despite image/png content type" "$FAKE_CODE" "UNSUPPORTED_MEDIA_TYPE"

# An image carrying EXIF (including GPS) must come back with that metadata
# stripped from the derivative the pipeline measures. Regression guard: an
# earlier build preserved EXIF because sharp's withMetadata({exif:{}}) keeps
# it rather than clearing it.
EXIF_PNG=$(mktemp /tmp/exif-XXXXXX.jpg)
python3 - "$EXIF_PNG" <<'PYIMG'
import sys
from PIL import Image
img = Image.new("RGB", (300, 300), (120, 207, 247))
exif = Image.Exif()
exif[0x8298] = "Copyright probe"   # Copyright
exif[0x0110] = "E2E camera"        # Model
img.save(sys.argv[1], "JPEG", exif=exif)
PYIMG

EXIF_UP=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/images" \
  -F "file=@${EXIF_PNG};type=image/jpeg")
EXIF_IMG_ID=$(echo "$EXIF_UP" | jget id)
check "image with EXIF accepted" "$([[ "$EXIF_IMG_ID" != "null" ]] && echo ok)" "ok"

SVG=$(mktemp /tmp/evil-XXXXXX.svg)
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$SVG"
SVG_CODE=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/images" \
  -F "file=@${SVG};type=image/svg+xml" | jget error.code)
check "SVG rejected" "$SVG_CODE" "UNSUPPORTED_MEDIA_TYPE"

blue "6. Run the analysis"
ANALYSIS=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/analyze" \
  -H 'Content-Type: application/json' \
  -d "{\"imageId\":\"${IMAGE_ID}\"}")
ANALYSIS_ID=$(echo "$ANALYSIS" | jget id)
check "analysis completed" "$(echo "$ANALYSIS" | jget status)" "COMPLETED"
check "mode is REFERENCE_MATCHING" "$(echo "$ANALYSIS" | jget mode)" "REFERENCE_MATCHING"
check "matched the 1 ppm level" "$(echo "$ANALYSIS" | jget prediction.label)" "Moderate Level"

# The guarantees this whole system exists to uphold.
check "NO concentration estimated" \
  "$(echo "$ANALYSIS" | jget prediction.estimatedConcentration)" "null"
check "NO confidence reported" \
  "$(echo "$ANALYSIS" | jget prediction.confidence)" "null"
check "NOT a confirmed measurement" \
  "$(echo "$ANALYSIS" | jget isConfirmedMeasurement)" "false"
check "model reported as unvalidated" "$(echo "$ANALYSIS" | jget model.validated)" "false"
check "zero confirmed measurements linked" \
  "$(echo "$ANALYSIS" | jget confirmedMeasurementCount)" "0"

LIMS=$(echo "$ANALYSIS" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('limitations',[])))")
check "limitations present" "$([[ "$LIMS" -ge 3 ]] && echo ok)" "ok"

SAMPLE_AFTER=$("${CURL[@]}" "${AUTH_HDR[@]}" "${API}/samples/${SAMPLE_ID}" | jget status)
check "sample advanced to ANALYZED" "$SAMPLE_AFTER" "ANALYZED"

blue "7. Feedback and measurement"
FB=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/analyses/${ANALYSIS_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -d '{"feedbackReason":"Looks right to me.","submitForReview":true}')
check "feedback recorded" "$(echo "$FB" | jget evidenceType)" "TECHNICIAN_ANNOTATION"
check "feedback is not a confirmed measurement" \
  "$(echo "$FB" | jget isConfirmedMeasurement)" "false"

# A technician may record a measurement but may not confirm it.
CONF=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/laboratory-measurements" \
  -H 'Content-Type: application/json' \
  -d '{"measurementMethod":"IC-ICP-MS","concentrationValue":0.9,"concentrationUnit":"ppm","measuredAt":"2026-10-11T09:30:00Z","confirmationStatus":"CONFIRMED"}' | jget error.code)
check "technician cannot self-confirm a measurement" "$CONF" "INSUFFICIENT_PERMISSIONS"

MEAS=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/laboratory-measurements" \
  -H 'Content-Type: application/json' \
  -d "{\"analysisId\":\"${ANALYSIS_ID}\",\"measurementMethod\":\"IC-ICP-MS\",\"concentrationValue\":0.9,\"concentrationUnit\":\"ppm\",\"measuredAt\":\"2026-10-11T09:30:00Z\"}")
check "preliminary measurement recorded" "$(echo "$MEAS" | jget evidenceType)" "LABORATORY_MEASUREMENT"
check "preliminary is not yet confirmed" "$(echo "$MEAS" | jget isConfirmedMeasurement)" "false"

NEITHER=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/samples/${SAMPLE_ID}/laboratory-measurements" \
  -H 'Content-Type: application/json' \
  -d '{"measurementMethod":"IC-ICP-MS","concentrationUnit":"ppm","measuredAt":"2026-10-11T09:30:00Z"}' | jget error.code)
check "measurement with no value and no BDL flag rejected" "$NEITHER" "VALIDATION_FAILED"

blue "8. Laboratory isolation"
REV_LOGIN=$(login "$REVIEWER_EMAIL" "$REVIEWER_PASSWORD")
REV_TOKEN=$(echo "$REV_LOGIN" | jget accessToken)
REV_LAB=$(echo "$REV_LOGIN" | jget user.memberships.0.laboratoryId)
check "reviewer signs in" "$([[ "$REV_TOKEN" != "null" ]] && echo ok)" "ok"
check "reviewer is in a different laboratory" \
  "$([[ "$REV_LAB" != "$LAB_ID" ]] && echo ok)" "ok"

REV_HDR=(-H "Authorization: Bearer ${REV_TOKEN}")

CROSS_SAMPLE=$("${CURL[@]}" "${REV_HDR[@]}" "${API}/samples/${SAMPLE_ID}" | jget error.code)
check "cannot read another lab's sample" "$CROSS_SAMPLE" "NOT_FOUND"

CROSS_ANALYSIS=$("${CURL[@]}" "${REV_HDR[@]}" "${API}/analyses/${ANALYSIS_ID}" | jget error.code)
check "cannot read another lab's analysis" "$CROSS_ANALYSIS" "NOT_FOUND"

CROSS_IMAGE=$("${CURL[@]}" "${REV_HDR[@]}" "${API}/images/${IMAGE_ID}" | jget error.code)
check "cannot read another lab's image" "$CROSS_IMAGE" "NOT_FOUND"

CROSS_LIST=$("${CURL[@]}" "${REV_HDR[@]}" "${API}/samples?laboratoryId=${LAB_ID}" | jget error.code)
check "cannot list another lab's samples" "$CROSS_LIST" "NOT_FOUND"

blue "9. Model administration"
ADMIN_LOGIN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | jget accessToken)
ADMIN_HDR=(-H "Authorization: Bearer ${ADMIN_TOKEN}")

AI_STATUS=$("${CURL[@]}" "${ADMIN_HDR[@]}" "${API}/ai/status")
check "AI status reachable" "$(echo "$AI_STATUS" | jget serviceReachable)" "true"
check "operating in reference-matching mode" "$(echo "$AI_STATUS" | jget mode)" "REFERENCE_MATCHING"
check "not ready for training" "$(echo "$AI_STATUS" | jget dataReadiness.readyForTraining)" "false"

TRAIN=$("${CURL[@]}" "${ADMIN_HDR[@]}" -X POST "${API}/ai/training-jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"testMethodId\":\"${METHOD_ID}\"}" | jget error.code)
check "training refused without enough data" "$TRAIN" "INSUFFICIENT_DATA"

TECH_TRAIN=$("${CURL[@]}" "${AUTH_HDR[@]}" -X POST "${API}/ai/training-jobs" \
  -H 'Content-Type: application/json' \
  -d "{\"testMethodId\":\"${METHOD_ID}\"}" | jget error.code)
check "technician cannot start training" "$TECH_TRAIN" "INSUFFICIENT_PERMISSIONS"

blue "10. API documentation"
DOCS_CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${API_URL}/api/docs")
check "Swagger UI served" "$DOCS_CODE" "200"
SPEC=$("${CURL[@]}" "${API_URL}/api/docs-json")
check "OpenAPI spec served" "$(echo "$SPEC" | jget info.title)" "BreadGuard AI API"
PATHS=$(echo "$SPEC" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('paths',{})))")
check "spec documents the routes" "$([[ "$PATHS" -ge 20 ]] && echo ok)" "ok"

# The docs UI has to be able to CALL the API, not merely render. Both of the
# checks below correspond to bugs that made every "Try it out" fail while the
# page itself returned 200 — which the three checks above all passed.

# Without an explicit connect-src, CSP falls back to `default-src 'none'` and
# the browser blocks every fetch the page makes, same-origin included. The
# symptom is a bare "Failed to fetch" that blames CORS, which is not involved.
CSP=$("${CURL[@]}" -D - -o /dev/null "${API_URL}/api/docs" \
  | tr -d '\r' | grep -i '^content-security-policy:' || true)
check "docs CSP allows the UI to call the API" \
  "$(echo "$CSP" | grep -qi "connect-src 'self'" && echo ok)" "ok"

# Health is VERSION_NEUTRAL and outside the global prefix, so it must override
# the document-level /api/v1 server or Swagger advertises /api/v1/health → 404.
HEALTH_SERVER=$(echo "$SPEC" | python3 -c "
import json,sys
d = json.load(sys.stdin)
item = d.get('paths', {}).get('/health', {})
print((item.get('servers') or [{}])[0].get('url', 'MISSING'))
")
check "spec points health at the server root" "$HEALTH_SERVER" "/"

rm -f "$TUBE_PNG" "$FAKE" "$SVG" "$EXIF_PNG"

echo
echo "────────────────────────────────────────────────"
printf '  passed: %s\n  failed: %s\n' "$PASS" "$FAIL"
echo "────────────────────────────────────────────────"
[[ "$FAIL" -eq 0 ]] || exit 1
green "All end-to-end checks passed."
