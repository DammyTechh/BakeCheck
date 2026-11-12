#!/usr/bin/env bash
#
# Full verification: every static check and every test suite, in one command.
#
# Run this before committing, before deploying, and after changing any
# dependency version. It is the same set of checks that were run to sign off
# the backend.
#
#   ./infrastructure/scripts/verify-all.sh            # static + unit tests
#   RUN_E2E=1 ./infrastructure/scripts/verify-all.sh  # also end-to-end
#
# The end-to-end stage needs Postgres, the API and the AI service running.
# Everything else runs standalone.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

PASS=0
FAIL=0
SKIP=0

bold()  { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
skip()  { printf '  \033[33m-\033[0m %s (skipped: %s)\n' "$1" "$2"; SKIP=$((SKIP+1)); }

# Runs a command in a given directory, reporting pass/fail and showing output
# only on failure.
#
# The directory is an argument rather than a surrounding subshell: a `( cd … )`
# wrapper runs `run` in a child process, so its PASS/FAIL increments are lost
# when that process exits — and the summary then reports success even when a
# check failed. This keeps all counting in the parent shell.
run_in() {
  local dir="$1"; local label="$2"; shift 2
  local output status
  output=$(cd "$dir" && "$@" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    ok "$label"
  else
    bad "$label"
    printf '%s\n' "$output" | tail -25 | sed 's/^/      /'
  fi
}

# Same, from the repository root.
run() { run_in . "$@"; }

bold "Node API — static analysis"
run_in apps/api "TypeScript type check"        npx tsc --noEmit -p tsconfig.json
run_in apps/api "TypeScript build config"      npx tsc --noEmit -p tsconfig.build.json
run_in apps/api "ESLint (src + test)"          npx eslint "src/**/*.ts" "test/**/*.ts" --max-warnings 0

bold "Node API — tests"
run_in apps/api "Jest suite"                   npx jest --silent

bold "Node API — build"
run_in apps/api "nest build"                   npm run build

bold "Dependencies"
run "npm audit (production tree)"                   npm audit --omit=dev --audit-level=low

bold "Python AI service — static analysis"
if command -v ruff >/dev/null 2>&1 || python3 -m ruff --version >/dev/null 2>&1; then
  run_in services/ai "Ruff lint"               python3 -m ruff check app tests
else
  skip "Ruff lint" "pip install -r services/ai/requirements-dev.txt"
fi

if python3 -m mypy --version >/dev/null 2>&1; then
  # No --ignore-missing-imports: services/ai/mypy.ini names the untyped
  # libraries one by one, so an import that is genuinely missing still fails.
  run_in services/ai "mypy type check"         python3 -m mypy app
else
  skip "mypy type check" "pip install -r services/ai/requirements-dev.txt"
fi

bold "Python AI service — tests"
run_in services/ai "pytest suite"              python3 -m pytest -q

bold "Database"
if [ -n "${DATABASE_URL:-}" ] || [ -f apps/api/.env ]; then
  run_in apps/api "Migration status"           npx ts-node -T src/database/cli/migrate.ts status
else
  skip "Migration status" "no DATABASE_URL and no apps/api/.env"
fi

bold "End to end"
if [ "${RUN_E2E:-0}" = "1" ]; then
  run "Workflow smoke test"                         ./infrastructure/scripts/e2e-smoke.sh
else
  skip "Workflow smoke test" "set RUN_E2E=1, with services running"
fi

printf '\n────────────────────────────────────────\n'
printf '  passed: %s   failed: %s   skipped: %s\n' "$PASS" "$FAIL" "$SKIP"
printf '────────────────────────────────────────\n'

if [ "$FAIL" -ne 0 ]; then
  printf '\033[31mVerification failed.\033[0m\n'
  exit 1
fi
printf '\033[32mAll checks passed.\033[0m\n'
